// The R2 lifecycle proposal (P8 C1, for the orchestrator; Wasim's P8 approval packet flags the deviation): one decision
// per registered prefix. Lifecycle rules are a bucket setting, not Worker config: the release workflow or the runbook
// applies `lifecycleConfig()` per brand bucket with `wrangler r2 bucket lifecycle set <bucket> --file <file>` (the body
// of the put lifecycle configuration API; it replaces every rule). Expiry acts on each object by its own age, and
// "objects will typically be removed from a bucket within 24 hours" of it, so "kept 30 days" means 30 to 31 days, and a
// backup's manifest (written last) can outlive its first parts by minutes: `listBackups` may list a backup whose parts
// are gone for that window, and G1's restore refuses it by name (`part_missing`).
// https://developers.cloudflare.com/r2/buckets/object-lifecycles/ and
// https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/
// (both read 2026-11-22). This module touches no bucket.
import { R2_PREFIXES } from '../../../server/db/r2-keys.ts'

export type LifecycleDecision =
  | { prefix: string; expireDays: number; why: string }
  | { prefix: string; expireDays: null; why: string }

/**
 * No lifecycle backstop on `files/`, `sessions/` or `library/` (B9): an age rule can't tell a live chat's files from a
 * dead one's, nor honour "Until deleted"; retention's jobs remove them with their rows. This departs from the plan's
 * "lifecycle rules as the retention backstop".
 */
export const R2_LIFECYCLE_PROPOSAL: readonly LifecycleDecision[] = [
  { prefix: 'photos/', expireDays: null, why: 'a member photo lives while its member row points at it; replaced and deleted objects go with the photo route and person deletion' },
  { prefix: 'sessions/', expireDays: null, why: 'a transcript goes with its chat (retention and person deletion); a chat\'s age isn\'t its objects\' age' },
  { prefix: 'files/', expireDays: null, why: 'a chat file goes with its chat or its trashed row, and the orphan sweep removes leftovers; never by object age' },
  { prefix: 'audit-copy/', expireDays: null, why: 'the audit log\'s copy is never shortened (decision Q3)' },
  { prefix: 'library/', expireDays: null, why: 'a Library file goes with its library_uploads row ("Until deleted"); never by object age' },
  { prefix: 'backups/', expireDays: 30, why: 'backups are kept 30 days (decision Q3): a deleted person leaves them within that window' },
  { prefix: 'restore/', expireDays: 30, why: 'a restore\'s snapshot and records are kept 30 days, like the backups they came from' },
  { prefix: 'deletion-log/', expireDays: null, why: 'the deletion log is never shortened (F1\'s replay after a restore reads it)' },
]

/** Incomplete multipart uploads anywhere in the bucket are aborted after a day (no job uploads in parts). */
export const ABORT_MULTIPART_DAYS = 1
const DAY_S = 86_400

/** The JSON body for `wrangler r2 bucket lifecycle set <bucket> --file <file>`. */
export function lifecycleConfig(decisions: readonly LifecycleDecision[] = R2_LIFECYCLE_PROPOSAL) {
  return {
    rules: [
      ...decisions.filter((d): d is Extract<LifecycleDecision, { expireDays: number }> => d.expireDays !== null).map(d => ({
        id: `expire-${d.prefix.replace(/\/$/, '')}-${d.expireDays}d`,
        enabled: true,
        conditions: { prefix: d.prefix },
        deleteObjectsTransition: { condition: { type: 'Age' as const, maxAge: d.expireDays * DAY_S } },
      })),
      {
        id: `abort-multipart-${ABORT_MULTIPART_DAYS}d`,
        enabled: true,
        conditions: { prefix: '' },
        abortMultipartUploadsTransition: { condition: { type: 'Age' as const, maxAge: ABORT_MULTIPART_DAYS * DAY_S } },
      },
    ],
  }
}

/** The prefixes the proposal must decide: every one the product writes. */
export const registeredPrefixes = (): readonly string[] => R2_PREFIXES
