// Spend against the monthly cap, by day and by person, job, model and tool.
import './jitless.ts'
import { z } from 'zod'
import { MoneySchema } from './common.ts'

export const UsageRowSchema = z.object({
  name: z.string(),
  /** What the row covers when the team can't reach the agent in a channel. */
  sub: z.string(),
  /** The same line once a channel is connected: `{channel}` stands for the channel's name. Missing: `sub` always. */
  subWithChannel: z.string().optional(),
  spent: MoneySchema,
  conversations: z.number(),
})
export type UsageRow = z.infer<typeof UsageRowSchema>

export const UsageDataSchema = z.object({
  month: z.string(),
  cap: MoneySchema,
  /** Percent of the cap. */
  alertAt: z.number(),
  total: MoneySchema,
  conversations: z.number(),
  questionsAsked: z.number(),
  jobsRun: z.number(),
  daily: z.array(MoneySchema),
  breakdown: z.record(z.enum(['person', 'job', 'model', 'tool']), z.array(UsageRowSchema)),
})
export type UsageData = z.infer<typeof UsageDataSchema>
