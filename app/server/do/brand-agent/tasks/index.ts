// The due-task handler registry (p3-design section 6): every P3 kind (twelve) and its owner's handler, each in the
// owner's own file. This file is orchestrator-only: a new kind is a line here plus its handler.
import type { TaskHandler } from '../scheduler.ts'
import { withSeed } from '../scheduler.ts'
import { authoritySweep } from './authority-sweep.ts'
import { callLease } from './call-lease.ts'
import { flushTurn } from './flush-turn.ts'
import { grantExpiry } from './grant-expiry.ts'
import { runAdvance } from './run-advance.ts'
import { turnWatch } from './turn-watch.ts'
import { deferredHook } from './deferred-hook.ts'
import { deferredResume } from './deferred-resume.ts'
import { auditCopy } from '../../../audit-copy.ts'
import { createUsageSweep } from '../../../usage/sweep.ts'
import { turnCalls } from '../turn-calls.ts'
import { poolRetry } from '../../runner/pool-retry.ts'
import { chatFileSweep } from '../../../files-io/orphan-sweep.ts'
import { routineTick } from '../../../routines/tick.ts'
import { routineEnd } from '../../../routines/end.ts'

export const taskHandlers: Readonly<Record<string, TaskHandler>> = {
  // W1
  'grant-expiry': grantExpiry,
  'authority-sweep': authoritySweep,
  'turn-watch': turnWatch,
  'run-advance': runAdvance,
  'call-lease': callLease,
  'flush-turn': flushTurn,
  // W1 PR 6 (the P6 seams, A2's brief): P6's `onDeferred` and a resume waiting out a pause.
  'deferred-hook': deferredHook,
  'deferred-resume': deferredResume,
  // W4
  'audit-copy': auditCopy,
  // W1 PR 2b gives the sweep the BrandAgent's reader over `model_calls` (A4-approved line).
  'usage-sweep': createUsageSweep(turnCalls),
  // W2
  'pool-retry': poolRetry,
  // W3 follow-up: the chat file orphan sweep (a seed: ensured due now on every start).
  'chat-file-sweep': chatFileSweep,
  // P4 W2
  'routine-tick': withSeed(routineTick, { id: 'routine-tick' }),
  'routine-end': routineEnd,
}
