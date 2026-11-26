// The sweep (N11): the task `outbox-sweep`, seeded, every 60 s. One pass:
//  1. repairs the gate when it and the object disagree (gate.ts: the sync that lapses every approved row);
//  2. schedules the send of an approved row still unclaimed 30 s past its hold (its task was lost); the send task claims
//     it with the same conditional update as always;
//  3. moves a row `sending` for more than 60 s to `needs_check` (compare on its attempt), never back to `approved`;
//  4. expires a waiting card past its 7 days.
import { SYSTEM_MEMBER_ID, writeStamp } from '../db/ids.ts'
import { all, runBatch, stmt } from '../db/sql.ts'
import type { DueTask, Scheduler, TaskContext, TaskHandler, TaskResult } from '../do/brand-agent/scheduler.ts'
import { withSeed } from '../do/brand-agent/scheduler.ts'
import { SEND_KIND, sendTaskId } from './send-task.ts'
import { outOfStep, readGate, syncGate } from './gate.ts'
import type { PauseState } from './gate.ts'
import { notifyAll, outboxNotifier } from './notify.ts'
import type { OutboxNotifier } from './notify.ts'
import { linesForStamped } from './sql.ts'
import { timing } from './timing.ts'
import { LAPSE_TEXT, NEEDS_CHECK_TEXT } from './words.ts'

export const SWEEP_ID = 'outbox-sweep'

export interface SweepDeps {
  db: D1Database
  nowMs: number
  state: PauseState
  scheduler: Pick<Scheduler, 'ensure'>
  notify: OutboxNotifier
  requestId: string
}

export interface SweepResult { synced: boolean; rescheduled: number; stale: number; expired: number }

export async function sweepOutbox(d: SweepDeps): Promise<SweepResult> {
  const t = timing()
  const who = { atMs: d.nowMs, actorId: SYSTEM_MEMBER_ID, requestId: d.requestId }
  const synced = outOfStep(await readGate(d.db), d.state)
  if (synced) await syncGate({ db: d.db, state: d.state, nowMs: d.nowMs, requestId: d.requestId, notify: d.notify })

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
    ...stale.map(r => ({ kind: 'needs_check' as const, to: r.approver, actionId: r.id, key: `needs_check:${r.id}:${r.attempt}`, body: NEEDS_CHECK_TEXT })),
    ...expired.map(r => ({ kind: 'approval_expired' as const, to: r.approver, actionId: r.id, key: `expired:${r.id}`, body: LAPSE_TEXT.expired })),
  ])
  const result = { synced, rescheduled: lost.length, stale: stale.length, expired: expired.length }
  if (synced || lost.length > 0 || stale.length > 0 || expired.length > 0) console.log({ event: 'outbox_sweep', ...result })
  return result
}

const run: TaskHandler = async (_task: DueTask, ctx: TaskContext): Promise<TaskResult> => {
  await sweepOutbox({
    db: ctx.env.DB, nowMs: ctx.nowMs, state: { paused: ctx.paused, pauseGen: ctx.pauseGen }, scheduler: ctx.scheduler,
    notify: outboxNotifier(ctx.env), requestId: `outbox-sweep-${crypto.randomUUID()}`,
  })
  ctx.scheduler.schedule({ id: SWEEP_ID, kind: SWEEP_ID, dueAtMs: ctx.nowMs + timing().sweepEveryMs })
  return { done: true }
}

/** The registered handler (tasks/index.ts): seeded due now on every start, then every 60 s. */
export const outboxSweep: TaskHandler = withSeed(run, { id: SWEEP_ID })
