// Stage 1 M1 (frozen by W0-A; M1-B builds it, N3): a job, a chat turn that hit a per-turn limit and carries on in more
// turns until it's done, out of budget, cancelled or at its 8-hour cap. Its events are in runs.ts (`job.*`).
import { z } from 'zod'
import { InstantSchema, MoneySchema } from './common.ts'
import { ChatIdSchema, TurnIdSchema } from './chat-ids.ts'

/** A job's id: `j_` + 128 random bits (its continuation keys are `job_<jobId>_<n>`). */
export const JobIdSchema = z.string().regex(/^j_[A-Za-z0-9_-]{22}$/)
export type JobId = z.infer<typeof JobIdSchema>

export const JobStateSchema = z.enum(['running', 'waiting', 'ended'])
export type JobState = z.infer<typeof JobStateSchema>

/** How a job ended (N3). `budget`: it reached its budget; `time`: its 8-hour cap; `taken_over`: a person wrote in the chat. */
export const JobOutcomeSchema = z.enum(['done', 'failed', 'budget', 'cancelled', 'time', 'stuck', 'taken_over'])
export type JobOutcome = z.infer<typeof JobOutcomeSchema>

/** The job's last progress line: a server label and how many helpers are running. */
export const JobProgressSchema = z.object({ label: z.string(), helpers: z.number().int().min(0) })
export type JobProgress = z.infer<typeof JobProgressSchema>

/** The stored job, so a reload shows it with no live turn. */
export const JobSchema = z.object({
  jobId: JobIdSchema,
  chatId: ChatIdSchema,
  rootTurnId: TurnIdSchema,
  state: JobStateSchema,
  /** Set once `ended`. */
  outcome: JobOutcomeSchema.nullable(),
  startedAt: InstantSchema,
  deadlineAt: InstantSchema,
  endedAt: InstantSchema.nullable(),
  progress: JobProgressSchema.nullable(),
  /** What the job spent, once ended. */
  cost: MoneySchema.nullable(),
})
export type Job = z.infer<typeof JobSchema>

/** `GET /api/chats/:id/job` (`job(chatId)`): the chat's latest job, or null. `POST /api/jobs/:id/cancel` answers the same. */
export const ChatJobSchema = z.object({ job: JobSchema.nullable() })
export type ChatJob = z.infer<typeof ChatJobSchema>
