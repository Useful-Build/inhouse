// The `grant-expiry` due task (p3-design 4.10). Owner: W1. A stub from W1's first PR, so tasks/index.ts can list every P3 kind; the owner
// replaces the body. Idempotent by task id once built (p3-design section 6).
import type { TaskHandler } from '../scheduler.ts'
import { notBuilt } from './not-built.ts'

export const grantExpiry: TaskHandler = notBuilt
