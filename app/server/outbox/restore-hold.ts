// The restore hold (M2-R, N12): step 4 of a restore's reconcile (ops/backup/reconcile/index.ts), run on the restored
// database, after the audit re-append and before the deletion-log replay. A restored database is the backup's, so its
// outbox may name actions the live brand went on to send, and grants the live brand went on to revoke. One batch, safe
// to repeat:
//  1. the gate: `restore_hold = 1` (no answer and no claim while it's set), `epoch + 1`, and `do_gen = -1`. The gate's
//     sync only moves forward (gate.ts), so a gate restored ahead of the object (the backup's `do_gen` above a fresh or
//     recovered BrandAgent's `pause_gen`) would never move again and nothing would ever be claimed; at -1 the next sync
//     re-seats it from below, whatever the object's generation.
//  2. a `waiting` row the live brand closed after the backup (an `action.answered` deny, an `action.withdrawn` or an
//     `action.lapsed` expiry line above the backup's audit id) closed again the same way, as step 3b re-applies member
//     removals: the re-appended line is its record, so no new line. Those exits only leave `waiting` and are final, so
//     such a row was never sent, whatever it went through before;
//  3. every `approved` and `sending` row to `needs_check` (a send may have happened after the backup), with an
//     `action.needs_check` line (`why: 'restore'`). So is a `waiting` row the live brand approved after the backup (an
//     `action.answered` line above the backup's audit id, re-appended in step 3), and, when the audit lines came from the
//     daily copy with a gap, every `waiting` row: the lines that would say were lost. A row held this way is never sent
//     by the system; a person checks the tool and resolves it.
//  4. every live grant revoked with reason `restore` (a restored grant can predate its revoke), with its
//     `permission.revoked` line.
// Uses stay as they are: a held row keeps its reservation until a person resolves it ("it didn't go out" releases it).
// No notice is sent: the restored database isn't live until the switch, after the confirm.
// Only the admin's audited restore confirm (`releaseHoldStmts`, ops/backup/reconcile/confirm.ts) clears the hold. A
// normal Resume never does: the sync sets `paused` and `do_gen`, never `restore_hold`. Every statement acts only while
// this restore has no `restore.confirmed` line, so a reconcile that read the record before a concurrent confirm can't
// hold the outbox again after the release (its record write then refuses `record_changed`).
import { first, runBatch, stmt } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'
import { writeStamp } from '../db/ids.ts'
import { linesForStamped } from './sql.ts'

export interface HoldAt { nowMs: number; actorId: string; /** This restore's own request id: its lines carry it, so a re-run finds them. */ requestId: string }

export interface HoldInput {
  restoreId: string
  /** The backup's largest audit id: an `action.answered` line above it was written after the backup. */
  afterId: number
  /** The audit lines came from the daily copy and lines after it were lost: every waiting row is held. */
  gap: boolean
  at: HoldAt
}

/**
 * What the hold has done, every run so far included: the rows it held and the grants it revoked (by their lines under
 * this restore's request id), and the waiting rows it closed again (`closed`: a final state the re-appended lines name).
 */
export interface HoldResult { held: string[]; revoked: string[]; closed: string[] }

/**
 * The hold's own audit lines, as a condition on `audit_log` whose one parameter is the restore's request id: the
 * reconcile's audit re-append (step 3) leaves exactly these out on a re-run, and nothing else under that id.
 */
export const HOLD_LINES = `req_id = ? AND ((action = 'action.needs_check' AND json_extract(args_json, '$.why') = 'restore')
  OR (action = 'permission.revoked' AND json_extract(args_json, '$.reason') = 'restore'))`

const COLUMNS = 'INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id)'

/** A waiting row the live brand approved after the backup (or any waiting row, when lines were lost). */
const APPROVED_SINCE = `(? = 1 OR EXISTS (SELECT 1 FROM audit_log l WHERE l.id > ? AND l.action = 'action.answered'
  AND l.target_kind = 'action' AND l.target_id = outbox_actions.id AND json_extract(l.args_json, '$.choice') <> 'deny'))`

/** The live brand's final exits from `waiting`, as audit lines, and the state each leaves. */
const CLOSES = [
  { state: 'denied', line: "l.action = 'action.answered' AND json_extract(l.args_json, '$.choice') = 'deny'", lapsed: null },
  { state: 'withdrawn', line: "l.action = 'action.withdrawn'", lapsed: null },
  { state: 'expired', line: "l.action = 'action.lapsed' AND json_extract(l.args_json, '$.reason') = 'expired'", lapsed: 'expired' },
] as const
const closeLine = (line: string) =>
  `FROM audit_log l WHERE l.id > ? AND l.target_kind = 'action' AND l.target_id = outbox_actions.id AND ${line}`

/** This restore not yet confirmed: every statement's guard. */
const UNCONFIRMED = "NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'restore.confirmed' AND json_extract(args_json, '$.restoreId') = ?)"

export function restoreHoldStmts(input: HoldInput, stamp: string): Stmt[] {
  const { at, restoreId } = input
  const who = { atMs: at.nowMs, actorId: at.actorId, requestId: at.requestId }
  return [
    stmt(`UPDATE outbox_gate SET restore_hold = 1, do_gen = -1, epoch = epoch + 1, updated_at_ms = ? WHERE id = 1 AND ${UNCONFIRMED}`, at.nowMs, restoreId),
    // Closed live after the backup: first, so a row that was approved, lapsed back and then closed isn't held.
    ...CLOSES.map(c => stmt(
      `UPDATE outbox_actions SET state = ?, rev = rev + 1, lapsed_reason = COALESCE(?, lapsed_reason),
         final_at_ms = (SELECT MIN(l.at_ms) ${closeLine(c.line)}), updated_at_ms = ?
       WHERE state = 'waiting' AND EXISTS (SELECT 1 ${closeLine(c.line)}) AND ${UNCONFIRMED}`,
      c.state, c.lapsed, input.afterId, at.nowMs, input.afterId, restoreId,
    )),
    stmt(
      `UPDATE outbox_actions SET stamp = ? WHERE (state IN ('approved', 'sending') OR (state = 'waiting' AND ${APPROVED_SINCE})) AND ${UNCONFIRMED}`,
      stamp, input.gap ? 1 : 0, input.afterId, restoreId,
    ),
    // A row never claimed has no attempt to name.
    linesForStamped(
      'action.needs_check',
      `CASE WHEN a.attempt > 0 THEN json_object('actionId', a.id, 'attempt', a.attempt, 'why', 'restore')
        ELSE json_object('actionId', a.id, 'why', 'restore') END`,
      [], who, stamp,
    ),
    stmt("UPDATE outbox_actions SET state = 'needs_check', rev = rev + 1, updated_at_ms = ? WHERE stamp = ?", at.nowMs, stamp),
    stmt(
      `UPDATE permission_grants SET revoked_at_ms = ?, revoked_by = ?, revoke_reason = 'restore', rev = rev + 1, stamp = ?
       WHERE revoked_at_ms IS NULL AND ${UNCONFIRMED}`,
      at.nowMs, at.actorId, stamp, restoreId,
    ),
    stmt(
      `${COLUMNS} SELECT ?, ?, 'permission.revoked', 'permission', id,
         json_object('permissionId', id, 'operation', operation, 'reason', 'restore'), ?
       FROM permission_grants WHERE stamp = ? ORDER BY id`,
      at.nowMs, at.actorId, at.requestId, stamp,
    ),
  ]
}

/**
 * Runs the hold, then reads back what it has done (this run and every earlier one). After this restore's confirm it
 * changes nothing and returns what it had done.
 */
export async function holdOutbox(db: D1Database, input: HoldInput): Promise<HoldResult> {
  await runBatch(db, restoreHoldStmts(input, writeStamp(input.at.requestId)))
  const confirmed = await first<{ one: number }>(db, stmt(`SELECT 1 AS one WHERE NOT (${UNCONFIRMED})`, input.restoreId))
  const gate = await first<{ restore_hold: number }>(db, stmt('SELECT restore_hold FROM outbox_gate WHERE id = 1'))
  if (!confirmed && gate?.restore_hold !== 1) throw new Error('restore hold: the gate is not held')
  const ids = async (sql: string, ...params: (string | number)[]) => (await db.prepare(sql).bind(...params).all<{ id: string }>()).results.map(r => r.id)
  return {
    held: await ids("SELECT DISTINCT target_id AS id FROM audit_log WHERE action = 'action.needs_check' AND req_id = ? AND json_extract(args_json, '$.why') = 'restore' ORDER BY id", input.at.requestId),
    revoked: await ids(`SELECT DISTINCT target_id AS id FROM audit_log WHERE action = 'permission.revoked' AND req_id = ? AND json_extract(args_json, '$.reason') = 'restore' ORDER BY id`, input.at.requestId),
    closed: await ids(
      `SELECT id FROM outbox_actions WHERE ${CLOSES.map(c => `(state = '${c.state}' AND EXISTS (SELECT 1 ${closeLine(c.line)}))`).join(' OR ')} ORDER BY id`,
      ...CLOSES.map(() => input.afterId),
    ),
  }
}

/**
 * The confirm's release, in the confirm's own batch: the hold cleared, the epoch raised and `do_gen` set to -1 again,
 * only where this restore's `restore.confirmed` line is (written earlier in the same batch, or by an earlier confirm).
 * Any sync made before the confirm counts for nothing: the first sync after the switch seats the gate at the live
 * object's generation, and until it does no claim wins.
 */
export function releaseHoldStmts(p: { restoreId: string; nowMs: number }): Stmt[] {
  return [
    stmt(
      `UPDATE outbox_gate SET restore_hold = 0, do_gen = -1, epoch = epoch + 1, updated_at_ms = ?
       WHERE id = 1 AND restore_hold = 1
         AND EXISTS (SELECT 1 FROM audit_log WHERE action = 'restore.confirmed' AND json_extract(args_json, '$.restoreId') = ?)`,
      p.nowMs, p.restoreId,
    ),
  ]
}
