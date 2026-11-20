// The `pool-retry` due task (p3-design section 7): expires turns queued 60 s and hands the queue's head back to W1
// while a slot is free; reschedules itself while the queue isn't empty. Idempotent by task id: a pass with nothing to
// do changes nothing.
import type { RunnerPoolPort } from '../brand-agent/ports.ts'
import type { TaskHandler } from '../brand-agent/scheduler.ts'
import type { RunnerPool } from './pool.ts'

export const poolRetry: TaskHandler = async (_task, ctx) => {
  // TEMPORARY until W1's port lists the pool's queue methods: the fake pool has no queue, and a task for it fails loud.
  const pool = ctx.ports.pool as RunnerPoolPort & Partial<Pick<RunnerPool, 'retryQueue'>>
  if (pool.retryQueue === undefined) throw new Error('pool-retry: the pool port has no placement queue')
  await pool.retryQueue()
  return { done: true }
}
