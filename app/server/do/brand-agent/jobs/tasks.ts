// The job engine's due tasks (Stage 1 M1-B, N3), registered in tasks/index.ts: each runs on the BrandAgent's engine.
import type { TaskHandler } from '../scheduler.ts'

/** `job-step:<jobId>:<n>`: judge the last turn's end, then the next continuation. */
export const jobStep: TaskHandler = (task, ctx) => ctx.agent.jobStep(task)
/** `job-deadline:<jobId>`: the job's 8-hour cap. */
export const jobDeadline: TaskHandler = (task, ctx) => ctx.agent.jobDeadline(task)
/** `job-end:<jobId>`: `closeJob` on the ledger and the one bell notice. */
export const jobEnd: TaskHandler = (task, ctx) => ctx.agent.jobEnd(task)
