// Support grants (p2-design.md section 9, BD7): the time-boxed access an Admin gives the Inhouse team. W2 owns this file in P2.
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { MemberIdSchema } from './members.ts'

/** How long a grant may run, in hours. */
export const GRANT_HOURS = [1, 4, 24, 72] as const
export const GrantHoursSchema = z.literal(GRANT_HOURS)
export type GrantHours = z.infer<typeof GrantHoursSchema>

export const GrantIdSchema = z.string().regex(/^g_[A-Za-z0-9_-]{1,64}$/)

/** `live`: not ended and not past `endsAt` when it was read. */
export const SupportGrantSchema = z.object({
  id: GrantIdSchema,
  createdBy: MemberIdSchema,
  createdAt: InstantSchema,
  endsAt: InstantSchema,
  endedAt: InstantSchema.nullable(),
  endedBy: MemberIdSchema.nullable(),
  rev: z.number().int().min(1),
  live: z.boolean(),
})
export type SupportGrant = z.infer<typeof SupportGrantSchema>
