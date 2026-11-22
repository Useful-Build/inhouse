// The `deferred-hook:<questionId>` due task (PR 6, P6 ask 4): P6's `onDeferred` for the question a checkpoint left the
// chat waiting on, retried with the default backoff until it answers ok, quarantined after 10 (core.ts `deferredHook`).
// Its payload is the `DeferredQuestion`, kept by route 51's revive, so a revived task runs the same call again.
import type { TaskHandler } from '../scheduler.ts'

export const deferredHook: TaskHandler = (task, ctx) => ctx.agent.deferredHook(task, ctx)
