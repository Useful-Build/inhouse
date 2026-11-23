// A routine's writes and reads (p4-w2.md sections 7 to 9), shared by the routine tools (PR 1) and routes 52 to 56 (PR 2).
// Each write is one `rev`-guarded statement that bumps `rev`, with its audit line in the same batch (guarded on the row
// the write stamped, as P2's writer does); a schedule or on/off change moves the cursor to now (no backfill). Who may
// change a routine (its creator or an active Admin) is part of the statement, so a refused write changes nothing.
import { stripFixed } from '../today/words.ts'
import { AuditArgsSchema } from '../../shared/contract/audit.ts'
import { MAX_TEAM_ROUTINES } from '../../shared/contract/keys.ts'
import type { AuditArgs } from '../../shared/contract/audit.ts'
import type { RoutineRunOutcome } from '../../shared/contract/routines.ts'
import { recordActivity } from '../activity/store.ts'
import type { ActivityTemplateId } from '../activity/templates.ts'
import { writeStamp } from '../db/ids.ts'
import { brandFacts, submitSettings } from './brand.ts'
import type { BrandFacts } from './brand.ts'
import { CLIENT_KEY, manualSlotKey, newRoutineId } from './keys.ts'
import { renderSlot } from './render.ts'
import { slotInsert } from './rows.ts'
import type { RoutineRow, SlotRow } from './rows.ts'
import { intlZone } from './slots.ts'
import { ON_TIME_MS } from './limits.ts'
import { routinesSignal } from './signal.ts'

export interface At {
  actorId: string
  requestId: string
  nowMs: number
  /**
   * The Inhouse team's grant id: Inhouse may change any routine (OC 5) while that grant is live, checked again inside the
   * write's statement (the matrix's check ran before the handler, and a grant can end in between).
   */
  inhouseGrant?: string
}

type Gate = { sql: string; params: (string | number)[] }

/** An audit line on a routine (target kind `routine`), only while `guard` holds: a write that matched no row writes none. */
function routineAudit(db: D1Database, at: At, args: AuditArgs, routineId: string, guard: Gate): D1PreparedStatement {
  const { action, ...rest } = AuditArgsSchema.parse(args)
  return db.prepare(
    `INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id)
      SELECT ?, ?, ?, 'routine', ?, ?, ? WHERE ${guard.sql}`,
  ).bind(at.nowMs, at.actorId, action, routineId, JSON.stringify(rest), at.requestId, ...guard.params)
}

const stamped = (id: string, stamp: string): Gate => ({ sql: 'EXISTS (SELECT 1 FROM routines WHERE id = ? AND req_id = ?)', params: [id, stamp] })

/**
 * A person's Activity line for a routine write (source `routine`, fixed words, the person as `actorId`), in the write's
 * own batch and guarded like its audit line, so it commits exactly when the write changed the row.
 */
const personLine = (db: D1Database, template: ActivityTemplateId, at: At, key: string, guard?: Gate) =>
  recordActivity(db, { template, fields: {}, kind: 'change', actorId: at.actorId, atMs: at.nowMs }, { source: 'routine', key }, guard)

/** The Inhouse team under a grant, the creator, or an active Admin, inside the statement. Params: `manageParams(at)`. */
const MAY_MANAGE = `(EXISTS (SELECT 1 FROM support_grants WHERE id = ? AND ended_at_ms IS NULL AND ends_at_ms > ?) OR creator_id = ?
  OR EXISTS (SELECT 1 FROM members WHERE id = ? AND kind = 'person' AND role = 'admin' AND status = 'active'))`
/** No grant names the empty id, so a person's write never passes the grant arm. */
const manageParams = (at: At): (string | number)[] => [at.inhouseGrant ?? '', at.nowMs, at.actorId, at.actorId]

/** The row a write's `RETURNING *` gave back: no read after the commit, so a committed write never answers an error. */
function written(r: D1Result, what: string): RoutineRow {
  const row = (r.results as RoutineRow[] | undefined)?.[0]
  if (!row) throw new Error(`${what}: the write returned no row`)
  return row
}

export const readRoutine = (db: D1Database, id: string): Promise<RoutineRow | null> =>
  db.prepare('SELECT * FROM routines WHERE id = ?').bind(id).first<RoutineRow>()

export async function mayManage(db: D1Database, r: RoutineRow, at: Pick<At, 'actorId' | 'inhouseGrant' | 'nowMs'>): Promise<boolean> {
  if (r.creator_id === at.actorId) return true
  return (await db.prepare(
    `SELECT 1 AS ok WHERE EXISTS (SELECT 1 FROM support_grants WHERE id = ? AND ended_at_ms IS NULL AND ends_at_ms > ?)
      OR EXISTS (SELECT 1 FROM members WHERE id = ? AND kind = 'person' AND role = 'admin' AND status = 'active')`,
  ).bind(at.inhouseGrant ?? '', at.nowMs, at.actorId).first()) !== null
}

export type WriteOutcome = { ok: RoutineRow } | { conflict: RoutineRow } | { refused: 'not_found' | 'not_allowed' | 'stage' | 'routine_limit' }

/** Why a guarded write matched nothing: gone, a newer `rev`, or not this person's to change. */
async function whyNot(db: D1Database, id: string, ifRev: number, at: At, deleted: 'live' | 'deleted'): Promise<WriteOutcome> {
  const now = await readRoutine(db, id)
  if (!now || (deleted === 'live') !== (now.deleted_at_ms === null)) return { refused: 'not_found' }
  if (now.rev !== ifRev) return { conflict: now }
  return (await mayManage(db, now, at)) ? { conflict: now } : { refused: 'not_allowed' }
}

export interface NewRoutine {
  name: string
  instruction: string
  days_mask: number
  hour: number
  minute: number
  missed: 'skip' | 'catch_up'
}

const LIVE_TEAM_COUNT = "SELECT COUNT(*) AS n FROM routines WHERE origin = 'team' AND deleted_at_ms IS NULL"

/**
 * A team routine (section 8): needs Act or Run (section 7), `need` 1, the cursor at now. Refused at the cap: the count is
 * part of the insert's statement, so two creates at once can't both take the last slot, and its lines are guarded on it.
 * `tz`: the brand's zone, read before the write with the stage, so a caller answers the next run with no read after the commit.
 */
export async function createRoutine(db: D1Database, n: NewRoutine, at: At, sourceChatId: string | null): Promise<{ ok: RoutineRow; tz: BrandFacts['tz'] } | { refused: 'stage' | 'routine_limit' }> {
  const brand = await brandFacts(db)
  if (brand.stage < 1) return { refused: 'stage' }
  const id = newRoutineId()
  const stamp = writeStamp(at.requestId)
  const [made] = await db.batch([
    db.prepare(
      `INSERT INTO routines (id, origin, kind, name, instruction, prompt_ref, days_mask, hour, minute, missed, need, enabled,
          creator_id, source_chat_id, checked_until_ms, created_at_ms, updated_at_ms, rev, req_id)
        SELECT ?, 'team', 'agent', ?, ?, NULL, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, 1, ?
        WHERE (${LIVE_TEAM_COUNT}) < ? RETURNING *`,
    ).bind(id, n.name, n.instruction, n.days_mask, n.hour, n.minute, n.missed, at.actorId, sourceChatId, at.nowMs, at.nowMs, at.nowMs, stamp, MAX_TEAM_ROUTINES),
    routineAudit(db, at, { action: 'routine.created', routineId: id, need: 1 }, id, stamped(id, stamp)),
    personLine(db, 'routine_made', at, `${id}|created`, stamped(id, stamp)),
  ])
  if (made.meta.changes === 0) return { refused: 'routine_limit' }
  return { ok: written(made, 'createRoutine'), tz: brand.tz }
}

export interface RoutinePatch {
  instruction?: string
  days_mask?: number
  hour?: number
  minute?: number
  missed?: 'skip' | 'catch_up'
  enabled?: boolean
}

export type UpdateOutcome = WriteOutcome | { refused: 'system_instruction' }

/**
 * An edit by the creator or an Admin, against `ifRev`. `routine.updated` names what changed besides on/off; a change of
 * on/off is its own `routine.enabled` line (#237 review). An edit that changes nothing writes nothing. A system routine
 * runs its `prompt_ref`, never its instruction, so an instruction for one is refused (#312 review L3); its schedule,
 * missed-run rule and switch stay editable.
 */
export async function updateRoutine(db: D1Database, id: string, ifRev: number, p: RoutinePatch, at: At): Promise<UpdateOutcome> {
  const r = await readRoutine(db, id)
  if (!r || r.deleted_at_ms !== null) return { refused: 'not_found' }
  if (r.origin === 'system' && p.instruction !== undefined) return { refused: 'system_instruction' }
  const next = {
    instruction: p.instruction ?? r.instruction, days_mask: p.days_mask ?? r.days_mask, hour: p.hour ?? r.hour,
    minute: p.minute ?? r.minute, missed: p.missed ?? r.missed, enabled: p.enabled === undefined ? r.enabled : p.enabled ? 1 : 0,
  }
  const changed: ('instruction' | 'schedule' | 'missed')[] = []
  if (next.instruction !== r.instruction) changed.push('instruction')
  if (next.days_mask !== r.days_mask || next.hour !== r.hour || next.minute !== r.minute) changed.push('schedule')
  if (next.missed !== r.missed) changed.push('missed')
  const enabledChanged = next.enabled !== r.enabled
  if (changed.length === 0 && !enabledChanged) {
    if (r.rev !== ifRev) return { conflict: r }
    return (await mayManage(db, r, at)) ? { ok: r } : { refused: 'not_allowed' }
  }
  const stamp = writeStamp(at.requestId)
  const resetCursor = changed.includes('schedule') || enabledChanged ? 1 : 0
  const stmts = [
    db.prepare(
      `UPDATE routines SET instruction = ?, days_mask = ?, hour = ?, minute = ?, missed = ?, enabled = ?,
          checked_until_ms = CASE WHEN ? = 1 THEN ? ELSE checked_until_ms END, updated_at_ms = ?, rev = rev + 1, req_id = ?
        WHERE id = ? AND rev = ? AND deleted_at_ms IS NULL AND ${MAY_MANAGE} RETURNING *`,
    ).bind(next.instruction, next.days_mask, next.hour, next.minute, next.missed, next.enabled, resetCursor, at.nowMs, at.nowMs, stamp, id, ifRev, ...manageParams(at)),
  ]
  if (changed.length > 0) stmts.push(routineAudit(db, at, { action: 'routine.updated', routineId: id, changed }, id, stamped(id, stamp)))
  if (enabledChanged) stmts.push(routineAudit(db, at, { action: 'routine.enabled', routineId: id, on: next.enabled === 1 }, id, stamped(id, stamp)))
  stmts.push(personLine(db, 'routine_changed', at, `${id}|rev${ifRev + 1}`, stamped(id, stamp)))
  const [res] = await db.batch(stmts)
  if (res.meta.changes === 0) return whyNot(db, id, ifRev, at, 'live')
  return { ok: written(res, 'updateRoutine') }
}

/** A soft delete by the creator or an Admin, against `ifRev` (Undo is route 56's restore). */
export async function deleteRoutine(db: D1Database, id: string, ifRev: number, at: At): Promise<WriteOutcome> {
  const stamp = writeStamp(at.requestId)
  const [res] = await db.batch([
    db.prepare(
      `UPDATE routines SET deleted_at_ms = ?, updated_at_ms = ?, rev = rev + 1, req_id = ?
        WHERE id = ? AND rev = ? AND deleted_at_ms IS NULL AND ${MAY_MANAGE} RETURNING *`,
    ).bind(at.nowMs, at.nowMs, stamp, id, ifRev, ...manageParams(at)),
    routineAudit(db, at, { action: 'routine.deleted', routineId: id }, id, stamped(id, stamp)),
    personLine(db, 'routine_deleted', at, `${id}|rev${ifRev + 1}`, stamped(id, stamp)),
  ])
  if (res.meta.changes === 0) return whyNot(db, id, ifRev, at, 'live')
  return { ok: written(res, 'deleteRoutine') }
}

/**
 * Undo of a delete (route 56) by the creator or an Admin, against `ifRev`: back with its cursor at now (no backfill). A
 * team routine is refused at the cap (#312 review), counted in the statement as `createRoutine` does; a system one isn't.
 */
export async function restoreRoutine(db: D1Database, id: string, ifRev: number, at: At): Promise<WriteOutcome> {
  const stamp = writeStamp(at.requestId)
  const [res] = await db.batch([
    db.prepare(
      `UPDATE routines SET deleted_at_ms = NULL, checked_until_ms = ?, updated_at_ms = ?, rev = rev + 1, req_id = ?
        WHERE id = ? AND rev = ? AND deleted_at_ms IS NOT NULL AND ${MAY_MANAGE}
          AND (origin = 'system' OR (${LIVE_TEAM_COUNT}) < ?) RETURNING *`,
    ).bind(at.nowMs, at.nowMs, stamp, id, ifRev, ...manageParams(at), MAX_TEAM_ROUTINES),
    routineAudit(db, at, { action: 'routine.restored', routineId: id }, id, stamped(id, stamp)),
    personLine(db, 'routine_restored', at, `${id}|rev${ifRev + 1}`, stamped(id, stamp)),
  ])
  if (res.meta.changes === 0) {
    const o = await whyNot(db, id, ifRev, at, 'deleted')
    // Still deleted, at this rev and this person's to restore (whyNot answers `conflict` at the same rev only then), yet
    // not restored: the cap is the only clause left, so no second count (which could race the statement's).
    if ('conflict' in o && o.conflict.rev === ifRev && o.conflict.origin === 'team') return { refused: 'routine_limit' }
    return o
  }
  return { ok: written(res, 'restoreRoutine') }
}

export type RunNowOutcome =
  | { ok: SlotRow }
  | { conflict: SlotRow }
  | { refused: 'not_found' | 'stage' | 'unavailable' }
  | { refused: 'settings'; code: string; reason?: string }

/**
 * Run now (route 54 and `routine_run_now`, section 9): never submits itself. One `claimed` manual row (key
 * `now|<id>|<clientKey>`, due now, 10 minutes to start), then the caller pokes the tick, which submits it like any slot.
 * The same `clientKey` again answers the same row; another open Run now of the routine answers it as a conflict
 * (`run_open`). A disabled routine may run (OC 10); a deleted one is not found; a team routine below its stage is refused.
 */
export async function runNow(db: D1Database, routineId: string, clientKey: string, at: At): Promise<RunNowOutcome> {
  if (!CLIENT_KEY.test(clientKey)) throw new Error('runNow: a client key is 8 to 64 of A-Z a-z 0-9 _ -')
  const key = manualSlotKey(routineId, clientKey)
  const existing = await db.prepare('SELECT * FROM routine_slots WHERE slot_key = ?').bind(key).first<SlotRow>()
  if (existing) return { ok: existing }
  const r = await readRoutine(db, routineId)
  if (!r || r.deleted_at_ms !== null) return { refused: 'not_found' }
  const brand = await brandFacts(db)
  if (r.origin === 'team' && brand.stage < r.need) return { refused: 'stage' }
  if (typeof brand.tz !== 'string') return { refused: 'unavailable' }
  const settings = await submitSettings(db)
  if ('refused' in settings) return { refused: 'settings', code: settings.refused.code, ...(settings.refused.reason ? { reason: settings.refused.reason } : {}) }
  const slot = await renderSlot(r, settings, {
    slot_key: key, kind: 'manual', local_date: intlZone(brand.tz)(at.nowMs).date, local_time: null, tz: brand.tz,
    due_at_ms: at.nowMs, deadline_ms: at.nowMs + ON_TIME_MS, state: 'claimed', reason: null, requested_by: at.actorId, claimed_at_ms: at.nowMs,
  })
  await db.batch([
    slotInsert(db, slot, { sql: 'EXISTS (SELECT 1 FROM routines WHERE id = ? AND deleted_at_ms IS NULL)', params: [routineId] }),
    routineAudit(db, at, { action: 'routine.run_now', routineId, slotKey: key }, routineId, {
      sql: 'EXISTS (SELECT 1 FROM routine_slots WHERE slot_key = ? AND claimed_at_ms = ? AND requested_by = ?)', params: [key, at.nowMs, at.actorId],
    }),
  ])
  const made = await db.prepare('SELECT * FROM routine_slots WHERE slot_key = ?').bind(key).first<SlotRow>()
  if (made) return { ok: made }
  const open = await db.prepare(
    "SELECT * FROM routine_slots WHERE routine_id = ? AND kind = 'manual' AND state IN ('claimed', 'started')",
  ).bind(routineId).first<SlotRow>()
  return open ? { conflict: open } : { refused: 'not_found' }
}

/**
 * A slot's result in plain words, for people who run a brand: its `result_text` (the agent's summary), else how it went.
 * Never a failure or refusal code (DESIGN.md, "Who it's for").
 */
export function resultWords(s: Pick<SlotRow, 'state' | 'result_text' | 'failure' | 'outcome' | 'reason'>): string {
  // A morning check's tail of normaliser counts (`(fixed: 2 cut)`) is for the eval runner, never for a person.
  if (s.result_text) return stripFixed(s.result_text)
  switch (s.state) {
    case 'claimed': case 'started': return "It's running"
    case 'ended':
      if (s.failure) return 'It stopped before it finished'
      return s.outcome === 'done' ? 'It finished' : 'It was stopped before it finished'
    case 'lost': return 'It stopped before it finished'
    case 'missed': return 'It missed its time'
    case 'skipped': return s.reason === 'disabled' ? 'It was off at its time' : s.reason === 'stage' ? 'It starts at a later stage' : 'It was skipped'
    case 'refused': return s.reason === 'paused' ? 'Your agent was paused' : s.reason === 'cap_reached' ? 'The spending cap was reached' : "It couldn't start"
  }
}

const STOPPED_ON_PURPOSE = new Set(['stopped', 'interrupted', 'cancelled'])

/** A slot's outcome in the panel's closed list (`RoutineRunOutcome`). */
export function runOutcome(s: Pick<SlotRow, 'state' | 'failure' | 'outcome' | 'reason'>): RoutineRunOutcome {
  switch (s.state) {
    case 'claimed': case 'started': return 'running'
    // A run someone stopped on purpose (stopped, interrupted or cancelled, with no failure) is neutral, not a warning.
    case 'ended': return s.failure !== null ? 'failed' : s.outcome === 'done' ? 'done' : STOPPED_ON_PURPOSE.has(s.outcome ?? '') ? 'skipped' : 'failed'
    case 'lost': return 'failed'
    case 'missed': case 'skipped': return 'skipped'
    case 'refused': return s.reason === 'paused' ? 'skipped' : 'failed'
  }
}

/** The fields of a slot route 68 reads. */
export type RunSlot = Pick<SlotRow, 'kind' | 'state' | 'reason' | 'due_at_ms' | 'started_at_ms' | 'run_id' | 'outcome' | 'failure' | 'result_text'>

/**
 * Route 68's read: a routine's own slots, newest first (`(local_date, claimed_at_ms)`, as 0200 orders them), at most
 * `limit`. Null when the routine isn't this brand's or is deleted (each brand has its own D1, so another brand's id names
 * nothing here).
 */
export async function routineRuns(db: D1Database, id: string, limit: number): Promise<RunSlot[] | null> {
  // One batch, so the routine and its slots are read at the same moment.
  const [routine, slots] = await db.batch<RunSlot | { ok: number }>([
    db.prepare('SELECT 1 AS ok FROM routines WHERE id = ? AND deleted_at_ms IS NULL').bind(id),
    db.prepare(
      `SELECT kind, state, reason, due_at_ms, started_at_ms, run_id, outcome, failure, result_text FROM routine_slots
        WHERE routine_id = ? ORDER BY local_date DESC, claimed_at_ms DESC, slot_key DESC LIMIT ?`,
    ).bind(id, limit),
  ])
  if (routine.results.length === 0) return null
  return slots.results as RunSlot[]
}

export interface ListedRoutine extends RoutineRow {
  /** The newest ended slot's fields (`last_slot_key`), when it's still there. */
  last_state: SlotRow['state'] | null
  last_ended_at_ms: number | null
  last_result_text: string | null
  last_failure: string | null
  last_outcome: string | null
  last_reason: string | null
}

/** Routines not deleted, newest first, `limit` a page after `after` (`created_at_ms`, `id`). */
export async function listRoutines(db: D1Database, after: { ms: number; id: string } | null, limit: number): Promise<ListedRoutine[]> {
  const page = after === null ? '' : 'AND (r.created_at_ms, r.id) < (?, ?)'
  const params = after === null ? [limit] : [after.ms, after.id, limit]
  return (await db.prepare(
    `SELECT r.*, s.state AS last_state, s.ended_at_ms AS last_ended_at_ms, s.result_text AS last_result_text,
        s.failure AS last_failure, s.outcome AS last_outcome, s.reason AS last_reason
      FROM routines r LEFT JOIN routine_slots s ON s.slot_key = r.last_slot_key
      WHERE r.deleted_at_ms IS NULL ${page} ORDER BY r.created_at_ms DESC, r.id DESC LIMIT ?`,
  ).bind(...params).all<ListedRoutine>()).results
}

/** Route 52's read: every routine, newest first; the deleted ones (for Undo) are the 50 deleted most recently. */
export async function allRoutines(db: D1Database): Promise<{ live: ListedRoutine[]; deleted: ListedRoutine[] }> {
  const select = `SELECT r.*, s.state AS last_state, s.ended_at_ms AS last_ended_at_ms, s.result_text AS last_result_text,
      s.failure AS last_failure, s.outcome AS last_outcome, s.reason AS last_reason
    FROM routines r LEFT JOIN routine_slots s ON s.slot_key = r.last_slot_key`
  const [live, deleted] = await db.batch<ListedRoutine>([
    db.prepare(`${select} WHERE r.deleted_at_ms IS NULL ORDER BY r.created_at_ms DESC, r.id DESC`),
    db.prepare(`${select} WHERE r.deleted_at_ms IS NOT NULL ORDER BY r.deleted_at_ms DESC, r.id DESC LIMIT 50`),
  ])
  return { live: live.results, deleted: deleted.results }
}

/** Whether a run or turn id is a routine run's: its slot names it and its chat is the routine principal's (route 33). */
export async function isRoutineRun(db: D1Database, id: string): Promise<boolean> {
  const hit = await db.prepare(
    `SELECT 1 AS ok FROM routine_slots s JOIN chats c ON c.id = s.chat_id
      WHERE c.owner_id = 'm_system' AND (s.run_id = ? OR s.turn_id = ?) LIMIT 1`,
  ).bind(id, id).first()
  return hit !== null
}

type LastFields = Pick<ListedRoutine, 'last_state' | 'last_ended_at_ms' | 'last_result_text' | 'last_failure' | 'last_outcome' | 'last_reason'>
const NO_LAST: LastFields = { last_state: null, last_ended_at_ms: null, last_result_text: null, last_failure: null, last_outcome: null, last_reason: null }

/** A routine's last ended slot's fields, read before a write so its answer carries `last` with no read after the commit. */
async function lastOf(db: D1Database, id: string): Promise<LastFields> {
  return (await db.prepare(
    `SELECT s.state AS last_state, s.ended_at_ms AS last_ended_at_ms, s.result_text AS last_result_text, s.failure AS last_failure,
        s.outcome AS last_outcome, s.reason AS last_reason
      FROM routines r JOIN routine_slots s ON s.slot_key = r.last_slot_key WHERE r.id = ?`,
  ).bind(id).first<LastFields>()) ?? NO_LAST
}

export type ListedOutcome = { ok: ListedRoutine } | { conflict: ListedRoutine } | { refused: 'not_found' | 'not_allowed' | 'stage' | 'routine_limit' }

/** A route write with its routine's `last` (switching, deleting or restoring never changes which slot ended last). */
async function withLast(db: D1Database, id: string, write: () => Promise<WriteOutcome>): Promise<ListedOutcome> {
  const last = await lastOf(db, id)
  const o = await write()
  if ('ok' in o) return { ok: { ...o.ok, ...last } }
  if ('conflict' in o) return { conflict: { ...o.conflict, ...last } }
  return o
}

/** The routines slot of the D1 stores (server/db/stores.ts): data in, data out, for routes 33, 52 to 56 and 68 and the signal. */
export function routineStore({ db }: { db: D1Database }) {
  return {
    signal: (nowMs: number) => routinesSignal(db, nowMs),
    list: () => allRoutines(db),
    /** The brand's zone (or why it can't be used), for the routines' `next`. */
    zone: async () => (await brandFacts(db)).tz,
    setEnabled: (id: string, on: boolean, ifRev: number, at: At) => withLast(db, id, async () => {
      const o = await updateRoutine(db, id, ifRev, { enabled: on }, at)
      if ('refused' in o && o.refused === 'system_instruction') throw new Error('setEnabled: refused an instruction it never sent')
      return o
    }),
    runNow: (id: string, clientKey: string, at: At) => runNow(db, id, clientKey, at),
    remove: (id: string, ifRev: number, at: At) => withLast(db, id, () => deleteRoutine(db, id, ifRev, at)),
    restore: (id: string, ifRev: number, at: At) => withLast(db, id, () => restoreRoutine(db, id, ifRev, at)),
    isRoutineRun: (id: string) => isRoutineRun(db, id),
    runs: (id: string, limit: number) => routineRuns(db, id, limit),
  }
}
export type RoutineStore = ReturnType<typeof routineStore>
