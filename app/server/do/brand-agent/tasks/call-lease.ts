// The `call-lease:<turnId>` due task (p3-design 8.2 and 9). This PR's part: an ended turn's start hold goes back to the
// ledger (`release`, retried until answered), once. The model calls' leases and the per-turn ledger queue join it with
// the spend gate (PR 2b). Idempotent: a turn whose hold went back (`turns.settled`) is done.
import type { TaskHandler } from '../scheduler.ts'

export const CALL_LEASE_PREFIX = 'call-lease:'

export const callLease: TaskHandler = (task, ctx) => ctx.agent.leaseTask(task.id.slice(CALL_LEASE_PREFIX.length))
