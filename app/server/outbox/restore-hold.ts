// The restore hold (M2-R, N12): step 4 of a restore's reconcile (ops/backup/reconcile/index.ts), run on the restored
// database, after the audit re-append and before the deletion-log replay. A restored database is the backup's, so its
// outbox may name actions the live brand went on to send, and grants the live brand went on to revoke. One batch, safe
// to repeat:
//  1. the gate: `restore_hold = 1` (no answer and no claim while it's set), `epoch + 1`, and `do_gen = -1`. The gate's
//     sync only moves forward (gate.ts), so a gate restored ahead of the object (the backup's `do_gen` above a fresh or
//     recovered BrandAgent's `pause_gen`) would never move again and nothing would ever be claimed; at -1 the next sync
//     re-seats it from below, whatever the object's generation.
//  2. every `approved` and `sending` row to `needs_check` (a send may have happened after the backup), with an
//     `action.needs_check` line (`why: 'restore'`). So is a `waiting` row the live brand approved after the backup (an
//     `action.answered` line above the backup's audit id, re-appended in step 3), and, when the audit lines came from the
//     daily copy with a gap, every `waiting` row: the lines that would say were lost. A row held this way is never sent
//     by the system; a person checks the tool and resolves it.
//  3. every live grant revoked with reason `restore` (a restored grant can predate its revoke), with its
//     `permission.revoked` line.
// Uses stay as they are: a held row keeps its reservation until a person resolves it ("it didn't go out" releases it).
// No notice is sent: the restored database isn't live until the switch, after the confirm.
// Only the admin's audited restore confirm (`releaseHoldStmts`, ops/backup/reconcile/confirm.ts) clears the hold. A
// normal Resume never does: the sync sets `paused` and `do_gen`, never `restore_hold`.
import { first, runBatch, stmt } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'
import { writeStamp } from '../db/ids.ts'
import { linesForStamped } from './sql.ts'

export interface HoldAt { nowMs: number; actorId: string; /** This restore's own request id: its lines carry it, so a re-run finds them. */ requestId: string }

export interface HoldInput {
  /** The backup's largest audit id: an `action.answered` line above it was written after the backup. */
  afterId: number
  /** The audit lines came from the daily copy and lines after it were lost: every waiting row is held. */
  gap: boolean
  at: HoldAt
}

/** What the hold has held and revoked under this restore's request id, every run so far included. */
export interface HoldResult { held: string[]; revoked: string[] }

const COLUMNS = 'INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id)'

/** A waiting row the live brand approved after the backup (or any waiting row, when lines were lost). */
const APPROVED_SINCE = `(? = 1 OR EXISTS (SELECT 1 FROM audit_log l WHERE l.id > ? AND l.action = 'action.answered'
  AND l.target_kind = 'action' AND l.target_id = outbox_actions.id AND json_extract(l.args_json, '$.choice') <> 'deny'))`

export function restoreHoldStmts(input: HoldInput, stamp: string): Stmt[] {
  const { at } = input
  const who = { atMs: at.nowMs, actorId: at.actorId, requestId: at.requestId }
  return [
    stmt('UPDATE outbox_gate SET restore_hold = 1, do_gen = -1, epoch = epoch + 1, updated_at_ms = ? WHERE id = 1', at.nowMs),
    stmt(
      `UPDATE outbox_actions SET stamp = ? WHERE state IN ('approved', 'sending') OR (state = 'waiting' AND ${APPROVED_SINCE})`,
      stamp, input.gap ? 1 : 0, input.afterId,
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
       WHERE revoked_at_ms IS NULL`,
      at.nowMs, at.actorId, stamp,
    ),
    stmt(
      `${COLUMNS} SELECT ?, ?, 'permission.revoked', 'permission', id,
         json_object('permissionId', id, 'operation', operation, 'reason', 'restore'), ?
       FROM permission_grants WHERE stamp = ? ORDER BY id`,
      at.nowMs, at.actorId, at.requestId, stamp,
    ),
  ]
}

/** Runs the hold, then reads back what it has done under `at.requestId` (this run and every earlier one). */
export async function holdOutbox(db: D1Database, input: HoldInput): Promise<HoldResult> {
  await runBatch(db, restoreHoldStmts(input, writeStamp(input.at.requestId)))
  const gate = await first<{ restore_hold: number }>(db, stmt('SELECT restore_hold FROM outbox_gate WHERE id = 1'))
  if (gate?.restore_hold !== 1) throw new Error('restore hold: the gate is not held')
  const ids = async (sql: string) => (await db.prepare(sql).bind(input.at.requestId).all<{ id: string }>()).results.map(r => r.id)
  return {
    held: await ids("SELECT DISTINCT target_id AS id FROM audit_log WHERE action = 'action.needs_check' AND req_id = ? AND json_extract(args_json, '$.why') = 'restore' ORDER BY id"),
    revoked: await ids("SELECT DISTINCT target_id AS id FROM audit_log WHERE action = 'permission.revoked' AND req_id = ? AND json_extract(args_json, '$.reason') = 'restore' ORDER BY id"),
  }
}

/**
 * The confirm's release, in the confirm's own batch: the hold cleared and the epoch raised, only where this restore's
 * `restore.confirmed` line is (written earlier in the same batch, or by an earlier confirm). `do_gen` is left as the
 * hold set it, so the first sync after the switch seats it at the object's generation before anything is claimed.
 */
export function releaseHoldStmts(p: { restoreId: string; nowMs: number }): Stmt[] {
  return [
    stmt(
      `UPDATE outbox_gate SET restore_hold = 0, epoch = epoch + 1, updated_at_ms = ?
       WHERE id = 1 AND restore_hold = 1
         AND EXISTS (SELECT 1 FROM audit_log WHERE action = 'restore.confirmed' AND json_extract(args_json, '$.restoreId') = ?)`,
      p.nowMs, p.restoreId,
    ),
  ]
}
