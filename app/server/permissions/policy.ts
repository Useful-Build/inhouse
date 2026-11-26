// The permission rules' fixed numbers (N9, N10, decision D3). `POLICY_REV` is raised whenever the rules or an operation
// entry change shape: every grant and every action carries the revision it was made under, and one made under another
// revision covers nothing.

import { RevokeReasonSchema } from '../../shared/contract/audit.ts'
import type { RevokeReason } from '../../shared/contract/audit.ts'

export const POLICY_REV = 1

/** More records than this is always an exact approval (D3), never covered by "Always allow". */
export const BULK_RECORDS = 5

/** "Always allow" is offered first after this many "Allow once" answers for the same operation and scope... */
export const NUDGE_AFTER = 3
/** ...within this window. */
export const NUDGE_WINDOW_MS = 30 * 86_400_000

/** Why a live grant was revoked (`permission_grants.revoke_reason`, the `permission.revoked` line): the audit contract's list. */
export const REVOKE_REASONS = RevokeReasonSchema.options
export type { RevokeReason }

/** Why a reserved use was released (`permission_uses.release_reason`). */
export const RELEASE_REASONS = ['undone', 'lapsed', 'failed', 'not_sent'] as const
export type ReleaseReason = (typeof RELEASE_REASONS)[number]
