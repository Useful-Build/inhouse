// Helpers for the permission tests (server/permissions/*.test.ts, in the Workers runtime). Never imported by the Worker.
// They write rows directly: no route writes the ceiling in M2 (N2), and the grant writer is the outbox's (M2-B).
import type { MemberRole } from '../../shared/contract/members.ts'
import { CEILING_LIMIT_DEFAULTS } from './ceiling.ts'
import type { CeilingFacts, GrantFacts, WriteOperationKey } from './types.ts'

/** Empties the permission tables and the stores the claim reads. Member rows stay (the audit log names them). */
export async function resetPermissions(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM permission_item_releases'),
    db.prepare('DELETE FROM permission_uses'),
    db.prepare('DELETE FROM permission_grants'),
    db.prepare('DELETE FROM permission_ceiling'),
    db.prepare('DELETE FROM notify_channels'),
    db.prepare('DELETE FROM connector_accounts'),
  ])
}

/** An active person with this id and role (created, or set back to active with this role). */
export async function person(db: D1Database, id: string, role: MemberRole, status: 'active' | 'removed' = 'active'): Promise<void> {
  await db.prepare(
    `INSERT INTO members (id, kind, role, status, created_at_ms) VALUES (?, 'person', ?, ?, 1)
     ON CONFLICT (id) DO UPDATE SET role = excluded.role, status = excluded.status, removed_at_ms = NULL, rev = rev + 1`,
  ).bind(id, role, status).run()
}

/** A ceiling row as given; limits left out are 0760's defaults (M2's rules). */
export async function ceiling(
  db: D1Database, operation: WriteOperationKey,
  row: { enabled: boolean; perDayMax: number; loweredRev: number } & Partial<Pick<CeilingFacts, 'unitsMax' | 'bulkThreshold' | 'batchMax' | 'rev'>>,
): Promise<void> {
  const d = CEILING_LIMIT_DEFAULTS
  await db.prepare(
    `INSERT INTO permission_ceiling (operation, enabled, per_day_max, lowered_rev, units_max, bulk_threshold, batch_max, rev, updated_at_ms, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'm_system')
     ON CONFLICT (operation) DO UPDATE SET enabled = excluded.enabled, per_day_max = excluded.per_day_max, lowered_rev = excluded.lowered_rev,
       units_max = excluded.units_max, bulk_threshold = excluded.bulk_threshold, batch_max = excluded.batch_max, rev = excluded.rev`,
  ).bind(operation, row.enabled ? 1 : 0, row.perDayMax, row.loweredRev, row.unitsMax ?? d.unitsMax, row.bulkThreshold ?? d.bulkThreshold, row.batchMax ?? d.batchMax, row.rev ?? 1).run()
}

/**
 * A connected account at generation `gen` (its `connected_at_ms`). A Shopify account carries its write store's handle
 * (`shop`, M2-D: the hub's word copied in), `store-a` unless given.
 */
export async function account(db: D1Database, accountId: string, gen: number, shop: string | null = accountId.startsWith('shopify:') ? 'store-a' : null): Promise<void> {
  await db.prepare(
    `INSERT INTO connector_accounts (account_id, connector, last_state, last_state_at_ms, connected_at_ms, shop) VALUES (?, ?, 'connected', ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET connected_at_ms = excluded.connected_at_ms, disconnected_at_ms = NULL, shop = excluded.shop`,
  ).bind(accountId, accountId.split(':')[0], gen, gen, shop).run()
}

export async function channel(db: D1Database, id: string, name: string, addedBy: string): Promise<void> {
  await db.prepare('INSERT INTO notify_channels (channel_id, name, added_by, added_at_ms) VALUES (?, ?, ?, 1)').bind(id, name, addedBy).run()
}

/**
 * A grant row as the facts say (scope JSON from the key's one `name=value`). `unitsMax` may be left out: the row then
 * takes 0760's default of 1, M2's one unit per call.
 */
export type GrantRowInput = Omit<GrantFacts, 'unitsMax'> & { unitsMax?: number }

export async function insertGrant(db: D1Database, g: GrantRowInput, at = 1): Promise<void> {
  const [k, v] = g.scopeKey.split('=')
  await db.prepare(
    `INSERT INTO permission_grants (id, holder, holder_member, account_id, account_gen, operation, scope_json, scope_key, per_day,
       units_max, policy_rev, granted_by, granted_role, ceiling_rev, granted_at_ms, revoked_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    g.id, g.holder, g.holder.startsWith('member:') ? g.holder.slice('member:'.length) : null, g.accountId, g.accountGen, g.operation,
    JSON.stringify({ [decodeURIComponent(k)]: decodeURIComponent(v) }), g.scopeKey, g.perDay, g.unitsMax ?? 1, g.policyRev,
    g.holder.startsWith('member:') ? g.holder.slice('member:'.length) : 'm_system', g.grantedRole, g.ceilingRev, at, g.revokedAtMs,
  ).run()
}

/** The live-grant index's key: two live grants with the same key can't both exist. */
export const liveKey = (g: GrantFacts) => `${g.holder}|${g.accountId}|${g.operation}|${g.scopeKey}`

/** The grants the database can hold at once: the first live grant per live key, and every revoked one. */
export function storable(grants: readonly GrantFacts[]): GrantFacts[] {
  const seen = new Set<string>()
  return grants.filter(g => {
    if (g.revokedAtMs !== null) return true
    if (seen.has(liveKey(g))) return false
    seen.add(liveKey(g))
    return true
  })
}
