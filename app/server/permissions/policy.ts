// The permission rules' fixed numbers (N9, N10, decision D3). `POLICY_REV` is raised whenever the rules or an operation
// entry change shape: every grant and every action carries the revision it was made under, and one made under another
// revision covers nothing.
// Stage 1 M3-L: revision 2 (N23's limits; `shopify.order.tag_add` takes a list of orders, M3-S1). No grant lives outside
// tests (N2), so nothing real lapses with it.

import { RevokeReasonSchema } from '../../shared/contract/audit.ts'
import { BULK_THRESHOLD_MAX } from '../../shared/contract/ceiling.ts'
import type { RevokeReason } from '../../shared/contract/audit.ts'

export const POLICY_REV = 2

/**
 * More records than this is always an exact approval (D3), never covered by "Always allow": the most the ceiling's
 * `bulk_threshold` may be (0760's CHECK). Stage 1 M3-L: the rules read the row's own `bulk_threshold`, 1 to this.
 */
export const BULK_RECORDS = BULK_THRESHOLD_MAX

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

/** Stage 1 M3 (N22, N23): why one batch item's units were given back (`permission_item_releases.reason`). */
export const ITEM_RELEASE_REASONS = ['failed', 'moved', 'withdrawn'] as const
export type ItemReleaseReason = (typeof ITEM_RELEASE_REASONS)[number]
