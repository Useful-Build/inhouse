// The handler every P3 task kind has until its owner builds it: it retries with the scheduler's backoff, so a task
// scheduled before its handler exists ends quarantined (and the runs signal red) rather than silently done.
import { backoffMs } from '../scheduler.ts'
import type { DueTask, TaskResult } from '../scheduler.ts'

export const notBuilt = async (task: DueTask, ctx: { nowMs: number }): Promise<TaskResult> =>
  ({ retryAtMs: ctx.nowMs + backoffMs(task.attempts), error: `not_built: ${task.kind}` })
