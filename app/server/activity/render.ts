// Activity read-side (p4-w4 revision 3.2): a stored line is a template id, fields and member ids. Here each becomes the
// `ActivityLine` the screen shows, with names from the members table read in the same request. A member who is
// pseudonymised (no name) or gone shows as "A former member"; a removed member who isn't deleted keeps their name. The
// served `actorId` stays the id (C2).
import type { ActivityLine } from '../../shared/contract/activity.ts'
import type { Instant } from '../../shared/contract/common.ts'
import { ACTIVITY_TEMPLATES, isActivityTemplate } from './templates.ts'

export const FORMER = 'A former member'

/** One `activity_lines` row. */
export interface LineRow {
  n: number
  id: string
  at_ms: number
  kind: 'read' | 'change' | 'needs' | 'problem'
  min_stage: 0 | 1 | 2 | null
  template: string
  fields_json: string
  actor_id: string | null
  subject_id: string | null
  trace: string | null
}

const STAGE = ['Watch', 'Act', 'Run'] as const
export const instantOf = (ms: number): Instant => ({ iso: new Date(ms).toISOString(), ms })

/** The template's `{slot}` filled in one pass (a value is never read again as a slot, so a name holding `{items}` stays text). */
export function fill(text: string, slots: Readonly<Record<string, string>>): string {
  return text.replace(/\{([a-z]+)(?::([a-z]+))?\}/g, (token, key: string, noun?: string) => {
    if (!Object.hasOwn(slots, key)) throw new Error(`slot ${token} has no value`)
    // `{key:noun}` is the count with its noun, singular for exactly 1: "0 things", "1 thing", "2 things".
    return noun === undefined ? slots[key] : `${slots[key]} ${slots[key] === '1' ? noun : `${noun}s`}`
  })
}

/** A member's name for a slot: the current one with braces removed, or "A former member" when they have none. */
export const nameOf = (id: string, names: ReadonlyMap<string, string>): string => (names.get(id) ?? FORMER).replace(/[{}]/g, '')

/** `names` holds the current name of each member who has one; a missing id is a former member. */
export function renderLine(row: LineRow, names: ReadonlyMap<string, string>): ActivityLine {
  if (!isActivityTemplate(row.template)) throw new Error(`unknown activity template ${row.template}`)
  const t = ACTIVITY_TEMPLATES[row.template]
  const fields = JSON.parse(row.fields_json) as Record<string, string | number>
  const slots: Record<string, string> = {}
  // A slot exists only for an id the row has: a template that names {actor} on a row without one fails loud in `fill`,
  // never reads "A former member". The name has no braces, so it can't carry a `{slot}` into any text.
  if (row.actor_id !== null) slots.actor = nameOf(row.actor_id, names)
  if (row.subject_id !== null) slots.subject = nameOf(row.subject_id, names)
  for (const [k, v] of Object.entries(fields)) slots[k] = String(v)
  const at = instantOf(row.at_ms)
  const who = fill(t.who, slots)
  // `by` goes through fmtProse, which reads `{key:time}` tokens: a name has no braces (nameOf).
  const by = { text: `${who}, at {at:time}`, times: { at } }
  return {
    at, kind: row.kind, ...(row.min_stage === null ? {} : { minStage: STAGE[row.min_stage] }),
    text: fill(t.text, slots), who, ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
    why: fill(t.why, slots), result: fill(t.result, slots), by, ...(row.trace === null ? {} : { trace: row.trace }),
  }
}
