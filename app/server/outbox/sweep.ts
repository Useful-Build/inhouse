// The sweep (N11): the task `outbox-sweep`, seeded, every 60 s. One pass:
//  1. repairs the gate when it and the object disagree (gate.ts: the sync that lapses every approved row);
//  2. schedules the send of an approved row still unclaimed 30 s past its hold (its task was lost); the send task claims
//     it with the same conditional update as always;
//  3. moves a row `sending` for more than 60 s to `needs_check` (compare on its attempt), never back to `approved`;
//  4. expires a waiting card past its 7 days;
//  5. lapses an approval not claimed within 10 minutes of being given (the approval age cap; the claim checks it too).
import { SYSTEM_MEMBER_ID, writeStamp } from '../db/ids.ts'
import { all, runBatch, stmt } from '../db/sql.ts'
import type { DueTask, Scheduler, TaskContext, TaskHandler, TaskResult } from '../do/brand-agent/scheduler.ts'
import { withSeed } from '../do/brand-agent/scheduler.ts'
import { SEND_KIND, sendTaskId } from './send-task.ts'
import { clearLag, noteLag, outOfStep, readGate, syncGate } from './gate.ts'
import type { PauseState } from './gate.ts'
import { notifyAll, outboxNotifier } from './notify.ts'
import type { OutboxNotifier } from './notify.ts'
import { linesForStamped, UNRELEASED_USE } from './sql.ts'
import { timing } from './timing.ts'
import { LAPSE_TEXT, NEEDS_CHECK_TEXT } from './words.ts'

export const SWEEP_ID = 'outbox-sweep'

export interface SweepDeps {
  db: D1Database
  nowMs: number
  /** The object's pause state, read when the sweep compares and syncs (never a value from before an await). */
  state: () => PauseState
  /** BrandAgent's record of a gate left behind (the health signal): noted when found behind, cleared once synced. */
  lag?: { note(gen: number, nowMs: number): void; clear(): void }
  scheduler: Pick<Scheduler, 'ensure'>
  notify: OutboxNotifier
  requestId: string
}

export interface SweepResult { synced: boolean; rescheduled: number; stale: number; expired: number; tooOld: number }

export async function sweepOutbox(d: SweepDeps): Promise<SweepResult> {
  const t = timing()
  const who = { atMs: d.nowMs, actorId: SYSTEM_MEMBER_ID, requestId: d.requestId }
  const gate = await readGate(d.db)
  const synced = outOfStep(gate, d.state())
  if (synced) {
    d.lag?.note(d.state().pauseGen, d.nowMs)
    await syncGate({ db: d.db, state: d.state, nowMs: d.nowMs, requestId: d.requestId, notify: d.notify })
    if (!outOfStep(await readGate(d.db), d.state())) d.lag?.clear()
  } else {
    d.lag?.clear()
  }

  // The approval age cap: an approval not claimed within `approvalMaxAgeMs` lapses back to waiting, its use released.
  const oldStamp = writeStamp(d.requestId)
  await runBatch(d.db, [
    stmt("UPDATE outbox_actions SET stamp = ? WHERE state = 'approved' AND approved_at_ms <= ?", oldStamp, d.nowMs - t.approvalMaxAgeMs),
    linesForStamped(
      'action.lapsed',
      `json_object('actionId', a.id, 'reason', 'stale_approval', 'released', json(CASE WHEN ${UNRELEASED_USE} THEN 'true' ELSE 'false' END))`,
      [], who, oldStamp,
    ),
    stmt(
      `UPDATE permission_uses SET released_at_ms = ?, release_reason = 'lapsed'
       WHERE released_at_ms IS NULL AND id IN (SELECT id || '#' || rev FROM outbox_actions WHERE state = 'approved' AND stamp = ?)`,
      d.nowMs, oldStamp,
    ),
    stmt(
      `UPDATE outbox_actions SET state = 'waiting', rev = rev + 1, approved_by = NULL, approved_rev = NULL, approved_at_ms = NULL,
         approved_epoch = NULL, send_at_ms = NULL, grant_id = NULL, lapsed_reason = 'stale_approval', updated_at_ms = ?
       WHERE state = 'approved' AND stamp = ?`,
      d.nowMs, oldStamp,
    ),
  ])
  const tooOld = await all<{ id: string; rev: number; approver: string }>(d.db, stmt("SELECT id, rev, approver FROM outbox_actions WHERE stamp = ? AND state = 'waiting'", oldStamp))

  const lost = await all<{ id: string }>(d.db, stmt(
    "SELECT id FROM outbox_actions WHERE state = 'approved' AND send_at_ms <= ? ORDER BY send_at_ms LIMIT 100", d.nowMs - t.lostTaskMs,
  ))
  for (const r of lost) d.scheduler.ensure({ id: sendTaskId(r.id), kind: SEND_KIND, dueAtMs: d.nowMs })

  const staleStamp = writeStamp(d.requestId)
  await runBatch(d.db, [
    stmt(
      `UPDATE outbox_actions SET state = 'needs_check', rev = rev + 1, updated_at_ms = ?, stamp = ?
       WHERE state = 'sending' AND claimed_at_ms <= ?`,
      d.nowMs, staleStamp, d.nowMs - t.staleSendingMs,
    ),
    linesForStamped('action.needs_check', "json_object('actionId', a.id, 'attempt', a.attempt, 'why', 'stale')", [], who, staleStamp),
  ])
  const stale = await all<{ id: string; attempt: number; approver: string }>(d.db, stmt('SELECT id, attempt, approver FROM outbox_actions WHERE stamp = ?', staleStamp))

  const expiredStamp = writeStamp(d.requestId)
  await runBatch(d.db, [
    stmt(
      `UPDATE outbox_actions SET state = 'expired', rev = rev + 1, lapsed_reason = 'expired', final_at_ms = ?, updated_at_ms = ?, stamp = ?
       WHERE state = 'waiting' AND expires_at_ms <= ?`,
      d.nowMs, d.nowMs, expiredStamp, d.nowMs,
    ),
    linesForStamped('action.lapsed', "json_object('actionId', a.id, 'reason', 'expired', 'released', json('false'))", [], who, expiredStamp),
  ])
  const expired = await all<{ id: string; approver: string }>(d.db, stmt('SELECT id, approver FROM outbox_actions WHERE stamp = ?', expiredStamp))

  await notifyAll(d.notify, [
    ...tooOld.map(r => ({ kind: 'approval_lapsed' as const, to: r.approver, actionId: r.id, key: `lapsed:${r.id}:${r.rev}`, body: LAPSE_TEXT.stale_approval })),
    ...stale.map(r => ({ kind: 'needs_check' as const, to: r.approver, actionId: r.id, key: `needs_check:${r.id}:${r.attempt}`, body: NEEDS_CHECK_TEXT })),
    ...expired.map(r => ({ kind: 'approval_expired' as const, to: r.approver, actionId: r.id, key: `expired:${r.id}`, body: LAPSE_TEXT.expired })),
  ])
  const result = { synced, rescheduled: lost.length, stale: stale.length, expired: expired.length, tooOld: tooOld.length }
  if (synced || lost.length > 0 || stale.length > 0 || expired.length > 0 || tooOld.length > 0) console.log({ event: 'outbox_sweep', ...result })
  return result
}

const run: TaskHandler = async (_task: DueTask, ctx: TaskContext): Promise<TaskResult> => {
  await sweepOutbox({
    db: ctx.env.DB, nowMs: ctx.nowMs, state: () => ({ paused: ctx.paused, pauseGen: ctx.pauseGen }), scheduler: ctx.scheduler,
    lag: { note: (gen, atMs) => noteLag(ctx.sql, gen, atMs), clear: () => clearLag(ctx.sql) },
    notify: outboxNotifier(ctx.env), requestId: `outbox-sweep-${crypto.randomUUID()}`,
  })
  ctx.scheduler.schedule({ id: SWEEP_ID, kind: SWEEP_ID, dueAtMs: ctx.nowMs + timing().sweepEveryMs })
  return { done: true }
}

/** The registered handler (tasks/index.ts): seeded due now on every start, then every 60 s. */
export const outboxSweep: TaskHandler = withSeed(run, { id: SWEEP_ID })
