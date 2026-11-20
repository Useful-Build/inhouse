// The `usage-sweep` due task (p3-design section 9). Owner: W4 (p3-w4.md). A stub from W1's first PR, so tasks/index.ts can list every P3 kind; the owner
// replaces the body. Idempotent by task id once built (p3-design section 6).
import type { TaskHandler } from '../do/brand-agent/scheduler.ts'
import { notBuilt } from '../do/brand-agent/tasks/not-built.ts'

export const usageSweep: TaskHandler = notBuilt
