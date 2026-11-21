// The routines tables' rows (0200_routines.sql) and the statements more than one writer shares: a slot's insert, the
// alarm counter and the Activity line a close writes. Every slot write names its from-states (p4-w2.md section 6's
// transition table), so a state only moves forward.
import { recordActivity } from '../activity/store.ts'
import { ACTIVITY_TEMPLATES } from '../activity/templates.ts'
import type { ActivityTemplateId } from '../activity/templates.ts'
import type { FieldValues } from '../activity/fields.ts'

export interface RoutineRow {
  id: string
  origin: 'system' | 'team'
  kind: string
  name: string
  instruction: string
  prompt_ref: string | null
  days_mask: number
  hour: number
  minute: number
  missed: 'skip' | 'catch_up'
  catch_up_within_min: number
  need: number
  enabled: number
  deleted_at_ms: number | null
  creator_id: string
  source_chat_id: string | null
  checked_until_ms: number
  last_slot_key: string | null
  created_at_ms: number
  updated_at_ms: number
  rev: number
}

export type SlotState = 'claimed' | 'started' | 'ended' | 'lost' | 'missed' | 'skipped' | 'refused'

export interface SlotRow {
  slot_key: string
  routine_id: string
  kind: 'scheduled' | 'manual'
  local_date: string
  local_time: string | null
  tz: string
  due_at_ms: number
  deadline_ms: number
  state: SlotState
  reason: string | null
  chat_id: string
  client_key: string
  prompt_text: string
  submit_json: string
  routine_rev: number
  creator_id: string
  requested_by: string | null
  submit_failures: number
  next_attempt_ms: number
  run_id: string | null
  turn_id: string | null
  outcome: string | null
  failure: string | null
  result_text: string | null
  claimed_at_ms: number
  started_at_ms: number | null
  ended_at_ms: number | null
}

/** A new slot row's values (the tick's decision or a Run now). */
export interface NewSlot {
  slot_key: string
  routine_id: string
  kind: 'scheduled' | 'manual'
  local_date: string
  local_time: string | null
  tz: string
  due_at_ms: number
  deadline_ms: number
  state: 'claimed' | 'missed' | 'skipped'
  reason: string | null
  chat_id: string
  client_key: string
  prompt_text: string
  submit_json: string
  routine_rev: number
  creator_id: string
  requested_by: string | null
  claimed_at_ms: number
}

const SLOT_COLUMNS = [
  'slot_key', 'routine_id', 'kind', 'local_date', 'local_time', 'tz', 'due_at_ms', 'deadline_ms', 'state', 'reason',
  'chat_id', 'client_key', 'prompt_text', 'submit_json', 'routine_rev', 'creator_id', 'requested_by', 'claimed_at_ms',
] as const satisfies readonly (keyof NewSlot)[]

const values = (s: NewSlot) => SLOT_COLUMNS.map(c => s[c])

/**
 * A slot's insert, only while `gate` (an SQL condition with its params) holds; an existing key is left as it is. `ON
 * CONFLICT DO NOTHING` (no target) rather than the brief's `INSERT OR IGNORE`: it skips only a uniqueness conflict (the
 * key, or a second open Run now), while a CHECK or NOT NULL failure still aborts the batch (W4's store made the same
 * call).
 */
export function slotInsert(db: D1Database, s: NewSlot, gate: { sql: string; params: (string | number)[] }): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO routine_slots (${SLOT_COLUMNS.join(', ')}) SELECT ${SLOT_COLUMNS.map(() => '?').join(', ')} WHERE ${gate.sql} ON CONFLICT DO NOTHING`)
    .bind(...values(s), ...gate.params)
}

/** Records one of the tick's invariant alarms (the routines signal is red for 24 hours after). */
export const alertStatement = (db: D1Database, code: 'key_reused' | 'tz_invalid', nowMs: number): D1PreparedStatement =>
  db.prepare('INSERT INTO routine_alerts (code, last_at_ms, count) VALUES (?, ?, 1) ON CONFLICT (code) DO UPDATE SET last_at_ms = excluded.last_at_ms, count = count + 1')
    .bind(code, nowMs)

/** A slot's own Activity line (source `routine-slot`): fixed words, the run as its trace, shown from the routine's stage. */
export function slotLine(db: D1Database, l: { template: ActivityTemplateId; fields?: FieldValues; key: string; need: number; runId: string | null; atMs: number }): D1PreparedStatement {
  return recordActivity(db, {
    template: l.template, fields: l.fields ?? {}, kind: ACTIVITY_TEMPLATES[l.template].kind, minStage: l.need as 0 | 1 | 2, atMs: l.atMs, ...(l.runId ? { trace: l.runId } : {}),
  }, { source: 'routine-slot', key: l.key })
}
