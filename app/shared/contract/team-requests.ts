// Routes 80 to 83 (P6a W3): requests to the Inhouse team. Strict, parsed at the boundary both ways. The audit lines never
// hold `text` or `subject` (shared/contract/audit.ts).
import { z } from 'zod'
import { TeamRequestIdSchema, TeamRequestKindSchema } from './audit.ts'
import { InstantSchema } from './common.ts'

export const TEAM_REQUEST_OPEN_MAX = 50
export const TEAM_REQUEST_LIST_MAX = 200
export { TEAM_REQUEST_TEXT_MAX } from './keys.ts'
import { TEAM_REQUEST_TEXT_MAX } from './keys.ts'
export const TEAM_REQUEST_SUBJECT_MAX = 64

export const TeamRequestStatusSchema = z.enum(['open', 'done', 'declined', 'withdrawn'])
export type TeamRequestStatus = z.infer<typeof TeamRequestStatusSchema>

/** A request as the client reads it. `mine`: the reader made it. `requestedBy`: the member id. */
export const TeamRequestRecordSchema = z.strictObject({
  id: TeamRequestIdSchema,
  kind: TeamRequestKindSchema,
  subject: z.string().nullable(),
  text: z.string(),
  /** Who asked: for members and Admins (names and `mine`). The Inhouse team gets no member ids. */
  requestedBy: z.string().optional(),
  mine: z.boolean(),
  status: TeamRequestStatusSchema,
  at: InstantSchema,
  updatedAt: InstantSchema,
  rev: z.number().int().min(1),
})
export type TeamRequestRecord = z.infer<typeof TeamRequestRecordSchema>

/** Route 80: newest first, at most 200. */
export const TeamRequestsListSchema = z.strictObject({ items: z.array(TeamRequestRecordSchema) })
export type TeamRequestsList = z.infer<typeof TeamRequestsListSchema>

const text = z.string().trim().min(1).max(TEAM_REQUEST_TEXT_MAX)
const subject = z.string().trim().min(1).max(TEAM_REQUEST_SUBJECT_MAX)
const rev = z.number().int().min(1).max(999_999_999)

/** Route 81, `POST /api/team-requests`. */
export const TeamRequestCreateInputSchema = z.strictObject({ kind: TeamRequestKindSchema, subject: subject.optional(), text })
/** Route 82, `PUT /api/team-requests/:id/status`: the Inhouse team's answer. */
export const TeamRequestStatusInputSchema = z.strictObject({ status: z.enum(['done', 'declined']), ifRev: rev })
/** Route 83, `PUT /api/team-requests/:id/withdrawn`: the requester takes it back. */
export const TeamRequestWithdrawInputSchema = z.strictObject({ ifRev: rev })
