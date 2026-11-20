// The `pool-retry` due task (p3-design section 7). Owner: W2 (p3-w2.md). A stub from W1's first PR, so tasks/index.ts can list every P3 kind; the owner
// replaces the body. Idempotent by task id once built (p3-design section 6).
import type { TaskHandler } from '../brand-agent/scheduler.ts'
import { notBuilt } from '../brand-agent/tasks/not-built.ts'

export const poolRetry: TaskHandler = notBuilt
