// Spend against the monthly cap, by day and by person, job, model and tool.
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
  // P3 (p3-design section 9, route 42): optional, so the demo's data (mock.ts) keeps parsing without them.
  /** The month as `YYYY-MM` in the brand's time zone. */
  monthKey: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  /** Spend is at or past the cap (or no cap is set), from the cap and spend as they are now: a raised cap clears it. */
  capReached: z.boolean().optional(),
  /** Spend is at or past the alert level of the cap, computed the same way. */
  alertCrossed: z.boolean().optional(),
  /** The months with usage, as `YYYY-MM`, newest first, this month always first: what the month picker offers. */
  months: z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)).optional(),
})
export type UsageData = z.infer<typeof UsageDataSchema>
