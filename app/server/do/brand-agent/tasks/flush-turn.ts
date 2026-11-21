// The `flush-turn:<turnId>` due task (p3-design 4.8): replays a final turn's fixed rows into D1 (the same ids and
// positions every time, `ON CONFLICT(id) DO NOTHING`; core.ts `AgentCore.flushTurn`) until the batch lands, with the
// scheduler's backoff (quarantined after its tries, like any task). Idempotent: a flushed turn is done.
import { backoffMs } from '../scheduler.ts'
import type { TaskHandler } from '../scheduler.ts'
import { FLUSH_TURN_PREFIX } from '../projection.ts'

export const flushTurn: TaskHandler = async (task, ctx) =>
  (await ctx.agent.flushTurn(task.id.slice(FLUSH_TURN_PREFIX.length)))
    ? { done: true }
    : { retryAtMs: ctx.nowMs + backoffMs(task.attempts), error: 'flush_failed' }
