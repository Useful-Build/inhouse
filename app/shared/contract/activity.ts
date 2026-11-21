// Activity's fixed lines. The audit log is in ./audit.ts.
import { z } from 'zod'
import { InstantSchema, ProseSchema, StageSchema } from './common.ts'
import { MemberIdSchema } from './members.ts'
import { pageOf } from './paging.ts'

export const ActivityLineSchema = z.object({
  at: InstantSchema,
  kind: z.enum(['read', 'change', 'needs', 'problem']),
  /** Shown only from this stage up. */
  minStage: StageSchema.optional(),
  text: z.string(),
  who: z.string(),
  /** The member who did it, when a person did. Names shown come from the members list. */
  actorId: MemberIdSchema.optional(),
  why: z.string(),
  result: z.string(),
  /** Who did it, and when where it says ("approved by Dana Kim at {at:time}"). */
  by: ProseSchema,
  /** The run's recorded steps. Missing for a routine whose steps weren't recorded. */
  trace: z.string().optional(),
})
export type ActivityLine = z.infer<typeof ActivityLineSchema>

/** Route 59: a page of lines, newest first. */
export const ActivityPageSchema = pageOf(ActivityLineSchema)
export type ActivityPage = z.infer<typeof ActivityPageSchema>
