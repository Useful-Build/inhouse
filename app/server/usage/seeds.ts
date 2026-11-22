// The usage tasks' seeds, for the BrandAgent's `ensureSeeds()` (p3-design 4.11, W1): the hourly sweep and today's audit
// copy. `ensure` only inserts a missing task, so calling this on every start never moves a due time.
import { auditCopyDueMs, auditCopyTaskId } from '../audit-copy.ts'
import type { Scheduler } from '../do/brand-agent/scheduler.ts'
import { SWEEP_EVERY_MS, SWEEP_TASK_ID } from './sweep.ts'

export function ensureUsageTasks(scheduler: Scheduler, nowMs: number): void {
  scheduler.ensure({ id: SWEEP_TASK_ID, kind: 'usage-sweep', dueAtMs: nowMs + SWEEP_EVERY_MS })
  const today = new Date(nowMs).toISOString().slice(0, 10)
  scheduler.ensure({ id: auditCopyTaskId(today), kind: 'audit-copy', dueAtMs: auditCopyDueMs(today) })
}
