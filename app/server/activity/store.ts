// Activity's writer (p4-w4 section 1). `recordActivity` returns one insert for the producer to put in its
// own `DB.batch`, so a line commits with the change it describes or not at all, and a repeat of the same
// `(source, key)` writes one line (`ON CONFLICT DO NOTHING`: only that duplicate is ignored, a CHECK or NOT NULL
// failure still aborts the batch; the brief said `INSERT OR IGNORE`, which would swallow those too). It stores ids and fields, never a name (see fields.ts); the table is append-only
// (0230's trigger). Nothing here deletes: retention is P8's.
import { checkFields, TemplateError } from './fields.ts'
import type { FieldValues } from './fields.ts'
import { ACTIVITY_TEMPLATES, isActivityTemplate, memberSlots } from './templates.ts'
import type { ActivityKind, ActivityTemplateId } from './templates.ts'

export interface ActivityInput {
  template: ActivityTemplateId
  fields: FieldValues
  kind: ActivityKind
  /** Shown only from this stage up. */
  minStage?: 0 | 1 | 2
  /** The member who did it; absent for the agent or the system. Required when the template names an `{actor}`. */
  actorId?: string
  /** A second member the line names. Required exactly when the template has a `{subject}` slot. */
  subjectId?: string
  /** A run id the team may open. */
  trace?: string
  atMs: number
}

const TRACE = /^[A-Za-z0-9_-]{1,64}$/
const MEMBER_ID = /^m_[A-Za-z0-9_-]{1,64}$/

/** Throws a `TemplateError` for anything the table or the rules don't allow; nothing is written then. */
export function checkActivity(line: ActivityInput, at: { source: string; key: string }): void {
  if (!isActivityTemplate(line.template)) throw new TemplateError(`unknown activity template ${String(line.template)}`)
  const t = ACTIVITY_TEMPLATES[line.template]
  checkFields(line.template, t.fields, line.fields)
  if (at.source !== t.source) throw new TemplateError(`template ${line.template} belongs to source ${t.source}, not ${at.source}`)
  if (at.key.length === 0) throw new TemplateError('an activity line needs a key')
  const slots = memberSlots(t)
  if (slots.actor !== (line.actorId !== undefined)) throw new TemplateError(`template ${line.template} ${slots.actor ? 'needs' : "doesn't take"} an actor`)
  if (slots.subject !== (line.subjectId !== undefined)) throw new TemplateError(`template ${line.template} ${slots.subject ? 'needs' : "doesn't take"} a subject`)
  for (const id of [line.actorId, line.subjectId]) if (id !== undefined && !MEMBER_ID.test(id)) throw new TemplateError('actor and subject are member ids')
  if (line.minStage !== undefined && ![0, 1, 2].includes(line.minStage)) throw new TemplateError('minStage is 0, 1 or 2')
  if (line.trace !== undefined && !TRACE.test(line.trace)) throw new TemplateError('trace is a run id')
  if (line.kind !== t.kind) throw new TemplateError(`template ${line.template} is a ${t.kind} line`)
  if (!Number.isSafeInteger(line.atMs)) throw new TemplateError('atMs must be an integer')
}

/** The writer's statement, exported so a test can bind it directly against the table's CHECKs. */
export const ACTIVITY_INSERT_SQL =
  'INSERT INTO activity_lines (id, at_ms, kind, min_stage, template, fields_json, actor_id, subject_id, trace, source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, source_key) DO NOTHING'

export function recordActivity(db: D1Database, line: ActivityInput, at: { source: string; key: string }): D1PreparedStatement {
  checkActivity(line, at)
  return db
    .prepare(ACTIVITY_INSERT_SQL)
    .bind(
      `a_${crypto.randomUUID().replaceAll('-', '')}`, line.atMs, line.kind, line.minStage ?? null, line.template, JSON.stringify(line.fields),
      line.actorId ?? null, line.subjectId ?? null, line.trace ?? null, at.source, at.key,
    )
}
