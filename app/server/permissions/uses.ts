// A grant's uses (N10; Stage 1 M3-L, N23). Reserving a use is one statement: a `permission_uses` row is inserted only
// while the grant is live, the operation enabled, the grant made under the current ceiling and policy and on the
// account's current generation (defence in depth: the claim checks them too), the call's units within both the grant's
// and the ceiling's `units_max` (the largest single call), and the day's unreleased units for the grant, less the batch
// items released from them, plus these units stay within `MIN(grant.per_day, ceiling.per_day_max)`. A revoked grant or a disabled operation
// leaves the minimum NULL, so nothing is inserted. A zero-row insert doesn't fail a D1 batch, so the outbox composes
// its batch on the ledger's stamp pattern: its later statements act only where this row exists (N11). The caller mints
// the action id first; `decide` returns no statements.
// Released on Undo, on any lapse, and on a definite failure; kept on `sent`, and on `needs_check` until a person says
// it didn't go out. `day` is the brand's day in its time zone, fixed at the reservation.
// A batch under a grant (M3-B) holds one use for its total; an item that fails definitely, moves to a new card or is
// withdrawn gives its units back once (`releaseItemSql`, `permission_item_releases`). Item releases count only while
// their use is unreleased: once the whole use is released they're inside it, so no unit is given back twice.
import { stmt } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'
import { intlZone } from '../routines/slots.ts'
import { POLICY_REV } from './policy.ts'
import type { ItemReleaseReason, ReleaseReason } from './policy.ts'
import type { Exists } from './grants.ts'

/** The brand's calendar day (`YYYY-MM-DD`) at `nowMs` in time zone `tz` (an IANA name; an unknown one throws). */
export function useDay(nowMs: number, tz: string): string {
  return intlZone(tz)(nowMs).date
}

export interface UseReservation {
  actionId: string
  actionRev: number
  grantId: string
  /** `useDay(nowMs, brand time zone)`. */
  day: string
  units: number
  atMs: number
}

/** The day's units a grant has in use: its unreleased uses, less the batch items released from them. SQL over `g`. */
const DAY_IN_USE = `(SELECT COALESCE(SUM(u.units), 0) FROM permission_uses u
            WHERE u.grant_id = g.id AND u.day = ? AND u.released_at_ms IS NULL)
       - (SELECT COALESCE(SUM(ir.units), 0) FROM permission_uses u
            JOIN permission_item_releases ir ON ir.action_id = u.action_id AND ir.action_rev = u.action_rev
            WHERE u.grant_id = g.id AND u.day = ? AND u.released_at_ms IS NULL)`

const isCount = (n: number) => Number.isSafeInteger(n) && n >= 1

/**
 * The one statement that reserves a use, or inserts nothing (the grant's day is spent, the call is past a `units_max`,
 * the grant revoked or out of ceiling).
 */
export function reserveUseSql(r: UseReservation): Stmt {
  if (!isCount(r.units)) throw new Error('reserveUseSql: units must be a whole number, at least 1')
  return stmt(
    `INSERT INTO permission_uses (id, action_id, action_rev, grant_id, day, units, at_ms)
     SELECT ?, ?, ?, g.id, ?, ?, ?
     FROM permission_grants g
     JOIN permission_ceiling c ON c.operation = g.operation AND c.enabled = 1
     WHERE g.id = ? AND g.revoked_at_ms IS NULL AND g.ceiling_rev = c.lowered_rev AND g.policy_rev = ?
       AND EXISTS (SELECT 1 FROM connector_accounts ca WHERE ca.account_id = g.account_id AND ca.connected_at_ms = g.account_gen
         AND (ca.disconnected_at_ms IS NULL OR ca.disconnected_at_ms < ca.connected_at_ms))
       AND ? <= g.units_max AND ? <= c.units_max
       AND ${DAY_IN_USE} + ? <= MIN(g.per_day, c.per_day_max)`,
    `${r.actionId}#${r.actionRev}`, r.actionId, r.actionRev, r.day, r.units, r.atMs, r.grantId, POLICY_REV, r.units, r.units, r.day, r.day, r.units,
  )
}

/** Releases this action revision's use, once (a released use stays released). */
export function releaseUseSql(r: { actionId: string; actionRev: number; reason: ReleaseReason; atMs: number }): Stmt {
  return stmt(
    'UPDATE permission_uses SET released_at_ms = ?, release_reason = ? WHERE action_id = ? AND action_rev = ? AND released_at_ms IS NULL',
    r.atMs, r.reason, r.actionId, r.actionRev,
  )
}

/** A batch item's units given back from its batch's one use (N22, N23). */
export interface ItemRelease {
  actionId: string
  /** The revision the batch's use was reserved at (its approved revision). */
  actionRev: number
  /** The item's position in the batch, 1-based. */
  n: number
  units: number
  reason: ItemReleaseReason
  atMs: number
}

/**
 * Gives one batch item's units back from its batch's use, at most once per item and revision (`ON CONFLICT DO
 * NOTHING` on the key), and only while the use is unreleased and its items' releases stay within its units. Inserts
 * nothing otherwise, and where `onlyIf` (the caller's winning change) doesn't hold.
 */
export function releaseItemSql(r: ItemRelease, onlyIf: Exists | null = null): Stmt {
  if (!isCount(r.units)) throw new Error('releaseItemSql: units must be a whole number, at least 1')
  if (!isCount(r.n)) throw new Error('releaseItemSql: n must be a whole number, at least 1')
  return stmt(
    `INSERT INTO permission_item_releases (id, action_id, action_rev, n, units, reason, at_ms)
     SELECT ?, ?, ?, ?, ?, ?, ?
     FROM permission_uses u
     WHERE u.id = ? AND u.released_at_ms IS NULL
       AND (SELECT COALESCE(SUM(ir.units), 0) FROM permission_item_releases ir
            WHERE ir.action_id = u.action_id AND ir.action_rev = u.action_rev) + ? <= u.units${onlyIf ? `
       AND EXISTS (${onlyIf.sql})` : ''}
     ON CONFLICT DO NOTHING`,
    `${r.actionId}#${r.actionRev}#${r.n}`, r.actionId, r.actionRev, r.n, r.units, r.reason, r.atMs, `${r.actionId}#${r.actionRev}`, r.units,
    ...(onlyIf?.params ?? []),
  )
}
