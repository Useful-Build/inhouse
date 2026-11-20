// A member of the team. W2 owns this file in P2.
import { z } from 'zod'

export const MemberSchema = z.object({ id: z.string(), name: z.string(), photo: z.string().optional(), email: z.string(), title: z.string(), role: z.string() })
export type Member = z.infer<typeof MemberSchema>

// ---------- P2: the member record the product serves (p2-design.md sections 1 and 7). `MemberSchema` stays until W3 moves off it. ----------

/**
 * A member id: 'm_' and a random or fixed suffix. No spaces or '@', so it can't carry an email or a name as typed, but
 * the pattern alone can't stop one spelled into the suffix (`m_Dana_Kim`): the server mints ids from random bytes and
 * checks an id it is given names a known member before it writes.
 */
export const MemberIdSchema = z.string().regex(/^m_[A-Za-z0-9_-]{1,64}$/)
export type MemberId = z.infer<typeof MemberIdSchema>

/** A person's role. Approving is a job per rule, not a role; the Inhouse team is its own principal, never a member role. */
export const MemberRoleSchema = z.enum(['member', 'admin'])
export type MemberRole = z.infer<typeof MemberRoleSchema>

export const MemberStatusSchema = z.enum(['invited', 'active', 'removed'])
export type MemberStatus = z.infer<typeof MemberStatusSchema>

/** A display name: 1 to 80 characters after trimming. */
export const MemberNameSchema = z.string().trim().min(1).max(80)
/** A job title: 1 to 80 characters after trimming. One form for "no title": null (or left out of an invite), never ''. */
export const MemberTitleSchema = z.string().trim().min(1).max(80)

/**
 * A person on the team as the API serves them. `email` and `title` are null once the member is pseudonymised (the name
 * is then "Former member"); `photo` is the Worker's photo URL, or null.
 */
export const MemberRecordSchema = z.object({
  id: MemberIdSchema,
  name: MemberNameSchema,
  email: z.email().nullable(),
  title: MemberTitleSchema.nullable(),
  role: MemberRoleSchema,
  status: MemberStatusSchema,
  photo: z.string().nullable(),
  rev: z.number().int().min(1),
})
export type MemberRecord = z.infer<typeof MemberRecordSchema>

/** `POST /api/members/invites`. */
export const InviteInputSchema = z.object({
  name: MemberNameSchema,
  email: z.email().max(254),
  title: MemberTitleSchema.optional(),
  role: MemberRoleSchema,
}).strict()
export type InviteInput = z.infer<typeof InviteInputSchema>

/** A record's revision as a write sends it back (p2-design section 5): the `rev` it last read. */
export const IfRevSchema = z.number().int().min(0)

/** `PUT /api/members/:id/role`. */
export const RoleChangeInputSchema = z.object({ role: MemberRoleSchema, ifRev: IfRevSchema }).strict()
export type RoleChangeInput = z.infer<typeof RoleChangeInputSchema>

/** `DELETE /api/members/:id?ifRev=`: the query, as text. */
export const MemberRemoveQuerySchema = z.object({ ifRev: z.string().regex(/^(0|[1-9]\d{0,8})$/).transform(Number) }).strict()
