// A grant's uses (N10). Reserving a use is one statement: a `permission_uses` row is inserted only while the grant is
// live, the operation enabled, the grant made under the current ceiling and policy and on the account's current
// generation (defence in depth: the claim checks them too), and the day's unreleased units for the grant
// plus these units stay within `MIN(grant.per_day, ceiling.per_day_max)`. A revoked grant or a disabled operation
// leaves the minimum NULL, so nothing is inserted. A zero-row insert doesn't fail a D1 batch, so the outbox composes
// its batch on the ledger's stamp pattern: its later statements act only where this row exists (N11). The caller mints
// the action id first; `decide` returns no statements.
// Released on Undo, on any lapse, and on a definite failure; kept on `sent`, and on `needs_check` until a person says
// it didn't go out. `day` is the brand's day in its time zone, fixed at the reservation.
import { stmt } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'
import { intlZone } from '../routines/slots.ts'
import { POLICY_REV } from './policy.ts'
import type { ReleaseReason } from './policy.ts'

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

/** The one statement that reserves a use, or inserts nothing (the grant's day is spent, revoked or out of ceiling). */
export function reserveUseSql(r: UseReservation): Stmt {
  if (!Number.isSafeInteger(r.units) || r.units < 1) throw new Error('reserveUseSql: units must be a whole number, at least 1')
  return stmt(
    `INSERT INTO permission_uses (id, action_id, action_rev, grant_id, day, units, at_ms)
     SELECT ?, ?, ?, g.id, ?, ?, ?
     FROM permission_grants g
     JOIN permission_ceiling c ON c.operation = g.operation AND c.enabled = 1
     WHERE g.id = ? AND g.revoked_at_ms IS NULL AND g.ceiling_rev = c.lowered_rev AND g.policy_rev = ?
       AND EXISTS (SELECT 1 FROM connector_accounts ca WHERE ca.account_id = g.account_id AND ca.connected_at_ms = g.account_gen)
       AND (SELECT COALESCE(SUM(u.units), 0) FROM permission_uses u
            WHERE u.grant_id = g.id AND u.day = ? AND u.released_at_ms IS NULL) + ? <= MIN(g.per_day, c.per_day_max)`,
    `${r.actionId}#${r.actionRev}`, r.actionId, r.actionRev, r.day, r.units, r.atMs, r.grantId, POLICY_REV, r.day, r.units,
  )
}

/** Releases this action revision's use, once (a released use stays released). */
export function releaseUseSql(r: { actionId: string; actionRev: number; reason: ReleaseReason; atMs: number }): Stmt {
  return stmt(
    'UPDATE permission_uses SET released_at_ms = ?, release_reason = ? WHERE action_id = ? AND action_rev = ? AND released_at_ms IS NULL',
    r.atMs, r.reason, r.actionId, r.actionRev,
  )
}
