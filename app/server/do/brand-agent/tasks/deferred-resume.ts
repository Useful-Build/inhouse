// The `deferred-resume:<questionId>` due task (PR 6, A8): a resume refused for a wait (paused, draining, a full queue),
// tried again every minute. Each wait reschedules it with attempts 0 (core.ts `resumeDeferred`), so a long pause never
// quarantines it and the parked end task can't strand.
import type { TaskHandler } from '../scheduler.ts'

export const deferredResume: TaskHandler = (task, ctx) => ctx.agent.deferredResume(task)
