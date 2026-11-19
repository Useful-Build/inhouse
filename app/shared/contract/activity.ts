// Activity's fixed lines and the audit log (changes to how the agent may work).
import { z } from 'zod'
import { StageSchema } from './common.ts'

export const AuditEntrySchema = z.object({ day: z.string(), who: z.string(), what: z.string(), detail: z.string(), at: z.string() })
export type AuditEntry = z.infer<typeof AuditEntrySchema>

export const ActivityLineSchema = z.object({
  /** Missing for lines that belong to today. */
  day: z.string().optional(),
  /** Shown ("6:00 AM"). Never sort on it: use `atMin`. */
  t: z.string(),
  /** The same time as minutes since midnight, for sorting inside a day. */
  atMin: z.number(),
  kind: z.enum(['read', 'change', 'needs', 'problem']),
  /** Shown only from this stage up. */
  minStage: StageSchema.optional(),
  text: z.string(),
  who: z.string(),
  why: z.string(),
  result: z.string(),
  by: z.string(),
  /** The run's recorded steps. Missing for a routine whose steps weren't recorded. */
  trace: z.string().optional(),
})
export type ActivityLine = z.infer<typeof ActivityLineSchema>
