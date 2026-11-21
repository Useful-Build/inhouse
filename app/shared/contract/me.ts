// Who is signed in, and what they may do (p2-design sections 3 and 11). W1 owns this file in P2. The server builds it
// in `GET /api/me` (server/auth/me-handler.ts) from the verified principal; `can` comes from the same access-matrix rows
// that `checkAccess` reads, so the UI never offers an action the server refuses.
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { CAN_KEYS } from './keys.ts'

/** The three roles (decision log, "Roles"). Approver is not a role: approving is a job per rule, by member id. */
export const RoleSchema = z.enum(['member', 'admin', 'inhouse'])
export type Role = z.infer<typeof RoleSchema>

/**
 * The closed list of actions the UI asks about, each tied to one access-matrix row (p2-design section 3):
 * `invite` (row 4), `changeRole` (5), `remove` (6), `editBrandSettings` (10), `editTechnical` (12, for Inhouse),
 * `switchModel` (12 via its `adminWrite` flag: an Admin turns a model off or back on), `grantSupport` (17), `viewMembers` (3), `viewAudit` (19),
 * `exportAudit` (20).
 */
export const CanKeySchema = z.enum(CAN_KEYS)
export type CanKey = z.infer<typeof CanKeySchema>

/** Every `CanKey`, each exactly once: a missing or unknown key fails the parse. */
export const CanSchema = z.strictObject(
  Object.fromEntries(CanKeySchema.options.map(k => [k, z.boolean()])) as Record<CanKey, z.ZodBoolean>,
)
export type Can = z.infer<typeof CanSchema>

/** A live support grant (BD7), shown to the Inhouse team only. */
export const MeGrantSchema = z.strictObject({ id: z.string().min(1), endsAt: InstantSchema })
export type MeGrant = z.infer<typeof MeGrantSchema>

/** Strict: an unknown key fails. `grant` is null unless `role` is `inhouse`. */
export const MeSchema = z.strictObject({
  memberId: z.string().min(1),
  name: z.string(),
  /** Null for a service member (`smoke`), which has no email. */
  email: z.string().nullable(),
  role: RoleSchema,
  can: CanSchema,
  /** `/api/members/<id>/photo` when the member has a photo, else null. */
  photoUrl: z.string().nullable(),
  /**
   * Only on the eval deployment (p3-eval-observability rev 2, "The eval-brand marker"): the eval build compiled in AND
   * `INHOUSE_EVAL_BRAND === '1'`, a deploy-time fact, never data. The eval harness refuses a brand without it.
   */
  evalBrand: z.literal(true).optional(),
  /** The live support grant for an Inhouse principal; always null for anyone else. */
  grant: MeGrantSchema.nullable(),
}).refine(m => m.grant === null || m.role === 'inhouse', { path: ['grant'], message: 'only the Inhouse team sees a grant' })
export type Me = z.infer<typeof MeSchema>
