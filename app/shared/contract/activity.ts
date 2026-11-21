// Activity's fixed lines and the audit log (changes to how the agent may work).
import { z } from 'zod'
import { InstantSchema, ProseSchema, StageSchema } from './common.ts'

export const AuditEntrySchema = z.object({ at: InstantSchema, who: z.string(), what: z.string(), detail: z.string() })
export type AuditEntry = z.infer<typeof AuditEntrySchema>

export const ActivityLineSchema = z.object({
  at: InstantSchema,
  kind: z.enum(['read', 'change', 'needs', 'problem']),
  /** Shown only from this stage up. */
  minStage: StageSchema.optional(),
  text: z.string(),
  who: z.string(),
  why: z.string(),
  result: z.string(),
  /** Who did it, and when where it says ("approved by Dana Kim at {at:time}"). */
  by: ProseSchema,
  /** The run's recorded steps. Missing for a routine whose steps weren't recorded. */
  trace: z.string().optional(),
})
export type ActivityLine = z.infer<typeof ActivityLineSchema>
