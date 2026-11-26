// Pause and the gate (N12). The pause flag lives in BrandAgent's SQLite; answers run in the Worker and write D1, which
// can't read the flag. So the gate row (`outbox_gate`) is the truth for D1, and one batch keeps it in step: `paused` and
// `do_gen` set to the object's state, `epoch` raised, and every `approved` row sent back to `waiting` with its use
// released and its line. It runs from the outbox's pause hook on every Pause and every Resume, and from the sweep
// whenever the gate and the object disagree. It's safe to repeat.
// Why that holds: an answer is refused while the gate is paused; a claim needs the row's `approved_epoch` to equal the
// gate's `epoch` (so no approval given before a Pause or a Resume is claimed after it) and the gate's `do_gen` to equal
// the dispatcher's own `pauseGen` (so if a hook failed or hasn't run yet, nothing is claimed until a sync succeeds, and
// that sync lapses every approved row). So resuming sends nothing, even when a hook fails.
import { SYSTEM_MEMBER_ID, writeStamp } from '../db/ids.ts'
import { all, first, runBatch, stmt } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'
import type { PauseHook } from '../do/brand-agent/ports.ts'
import { notifyAll } from './notify.ts'
import type { OutboxNotifier } from './notify.ts'
import { linesForStamped, UNRELEASED_USE } from './sql.ts'
import type { OutboxGateRow } from './types.ts'
import { LAPSE_TEXT } from './words.ts'

/** The object's pause state, as the claim compares it: the flag and its generation (BrandAgent's `flags` table). */
export interface PauseState { paused: boolean; pauseGen: number }

/**
 * Reads BrandAgent's own flags (core.ts `isPaused`, `pauseGen`): paused while `paused_at_ms` is set; `pause_gen` raised
 * by every pause and resume, 0 before the first. gate.test.ts checks this agrees with the engine's own reads.
 */
export function doPauseState(sql: SqlStorage): PauseState {
  const rows = sql.exec<{ key: string; value: number | string | null }>("SELECT key, value FROM flags WHERE key IN ('paused_at_ms', 'pause_gen')").toArray()
  const gen = rows.find(r => r.key === 'pause_gen')?.value
  return { paused: rows.some(r => r.key === 'paused_at_ms' && r.value !== null), pauseGen: typeof gen === 'number' ? gen : 0 }
}

export const readGate = async (db: D1Database): Promise<OutboxGateRow> => {
  const g = await first<OutboxGateRow>(db, stmt('SELECT * FROM outbox_gate WHERE id = 1'))
  if (!g) throw new Error('outbox: the gate row is missing')
  return g
}

/** Whether the gate and the object disagree (the sweep then syncs). */
export const outOfStep = (g: OutboxGateRow, s: PauseState): boolean => (g.paused === 1) !== s.paused || g.do_gen !== s.pauseGen

/** The sync's batch: lines first (they read the approved rows), then the uses, then the rows, then the gate. */
export function gateSyncStmts(s: PauseState, at: { nowMs: number; requestId: string }, stamp: string): Stmt[] {
  const who = { atMs: at.nowMs, actorId: SYSTEM_MEMBER_ID, requestId: at.requestId }
  return [
    stmt(
      `UPDATE outbox_actions SET stamp = ? WHERE state = 'approved'`,
      stamp,
    ),
    linesForStamped(
      'action.lapsed',
      `json_object('actionId', a.id, 'reason', 'paused', 'released', json(CASE WHEN ${UNRELEASED_USE} THEN 'true' ELSE 'false' END))`,
      [], who, stamp,
    ),
    stmt(
      `UPDATE permission_uses SET released_at_ms = ?, release_reason = 'lapsed'
       WHERE released_at_ms IS NULL AND id IN (SELECT id || '#' || rev FROM outbox_actions WHERE state = 'approved' AND stamp = ?)`,
      at.nowMs, stamp,
    ),
    stmt(
      `UPDATE outbox_actions SET state = 'waiting', rev = rev + 1, approved_by = NULL, approved_rev = NULL, approved_at_ms = NULL,
         approved_epoch = NULL, send_at_ms = NULL, grant_id = NULL, lapsed_reason = 'paused', updated_at_ms = ?
       WHERE state = 'approved' AND stamp = ?`,
      at.nowMs, stamp,
    ),
    stmt(
      'UPDATE outbox_gate SET paused = ?, do_gen = ?, epoch = epoch + 1, updated_at_ms = ? WHERE id = 1',
      s.paused ? 1 : 0, s.pauseGen, at.nowMs,
    ),
  ]
}

/** One sync, then a notice to each lapsed action's approver. Returns how many approvals lapsed. */
export async function syncGate(d: { db: D1Database; state: PauseState; nowMs: number; requestId: string; notify: OutboxNotifier }): Promise<number> {
  const stamp = writeStamp(d.requestId)
  await runBatch(d.db, gateSyncStmts(d.state, d, stamp))
  const lapsed = await all<{ id: string; rev: number; approver: string }>(d.db, stmt(
    "SELECT id, rev, approver FROM outbox_actions WHERE stamp = ? AND state = 'waiting' AND lapsed_reason = 'paused'", stamp,
  ))
  await notifyAll(d.notify, lapsed.map(r => ({ kind: 'approval_lapsed' as const, to: r.approver, actionId: r.id, key: `lapsed:${r.id}:${r.rev}`, body: LAPSE_TEXT.paused })))
  console.log({ event: 'outbox_gate_sync', paused: d.state.paused, pauseGen: d.state.pauseGen, lapsed: lapsed.length })
  return lapsed.length
}

/** The outbox's pause hook (compose.ts): the same sync on Pause and on Resume, from the object's state at that moment. */
export function outboxPauseHook(d: { db: D1Database; state: () => PauseState; notify: OutboxNotifier }): PauseHook {
  const run = async (atMs: number) => {
    await syncGate({ db: d.db, state: d.state(), nowMs: atMs, requestId: `outbox-gate-${crypto.randomUUID()}`, notify: d.notify })
  }
  return { onPause: e => run(e.atMs), onResume: e => run(e.atMs) }
}
