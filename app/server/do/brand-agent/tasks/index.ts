// The due-task handler registry (p3-design section 6): every P3 kind and its owner's handler. W1's first PR lists all
// nine against stubs in the owners' files; from then on this file is orchestrator-only (an owner fills its own file).
import type { TaskHandler } from '../scheduler.ts'
import { authoritySweep } from './authority-sweep.ts'
import { callLease } from './call-lease.ts'
import { flushTurn } from './flush-turn.ts'
import { grantExpiry } from './grant-expiry.ts'
import { runAdvance } from './run-advance.ts'
import { turnWatch } from './turn-watch.ts'
import { auditCopy } from '../../../audit-copy.ts'
import { createUsageSweep } from '../../../usage/sweep.ts'
import { turnCalls } from '../turn-calls.ts'
import { poolRetry } from '../../runner/pool-retry.ts'

export const taskHandlers: Readonly<Record<string, TaskHandler>> = {
  // W1
  'grant-expiry': grantExpiry,
  'authority-sweep': authoritySweep,
  'turn-watch': turnWatch,
  'run-advance': runAdvance,
  'call-lease': callLease,
  'flush-turn': flushTurn,
  // W4
  'audit-copy': auditCopy,
  // W1 PR 2b gives the sweep the BrandAgent's reader over `model_calls` (A4-approved line).
  'usage-sweep': createUsageSweep(turnCalls),
  // W2
  'pool-retry': poolRetry,
}
