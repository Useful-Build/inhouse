// The `pool-retry` due task (p3-design section 7): expires turns queued 60 s and hands queued turns back to W1 while a
// slot is free; reschedules itself while the queue isn't empty. Idempotent by task id: a pass with nothing to do
// changes nothing.
import type { TaskHandler } from '../brand-agent/scheduler.ts'

export const poolRetry: TaskHandler = async (_task, ctx) => {
  await ctx.ports.pool.retryQueue()
  return { done: true }
}
