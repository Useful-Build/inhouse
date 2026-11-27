// The alerts channel's brand grant (Stage 1 M2-N; Wasim, Q3 = A: "an admin marking a channel for alerts is the brand's
// grant for that channel"). When a brand admin moves the alerts mark onto a channel, the same batch that saves the list
// creates a grant held by the brand (`holder = 'brand'`, granted as `admin`) to post there as `slack.channel.post`, with
// the operation's default daily limit, so the agent's posts to that channel (notification_send, or the write tool) go
// after the hold without a card. When the mark moves off the channel, the same batch revokes it (`removed`: the admin
// took it back); taking the channel off the list revokes it as `channel_unlisted` (channels.ts, M2-A).
//
// Fail closed, all of it inside the statements (N10): the grant is made only where the operation is enabled in the
// ceiling (N2: never in a deployable build, so there the mark makes no grant), the Slack account is connected (the
// grant takes its generation), the actor is an active brand admin (the Inhouse team may save the list, decision 19, but
// only an admin grants for the brand, D4), and this very write marked the channel (its row carries this write's stamp).
// It takes the ceiling's `lowered_rev`, the current policy and the account's generation, so a later change to any of
// them makes it cover nothing, like every grant. A re-save that doesn't move the mark never makes one: a grant an admin
// removed in Permissions stays removed until the channel is marked again.
import { auditInsert } from '../db/audit.ts'
import { writeStamp } from '../db/ids.ts'
import type { At } from '../db/members.ts'
import { first, stmt } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'
import { ACCOUNT_IDS } from '../outbox/facts.ts'
import { grantDefaults } from '../outbox/operations/index.ts'
import { liveGrant, newPermissionId } from '../permissions/grants.ts'
import type { Exists } from '../permissions/grants.ts'
import { POLICY_REV } from '../permissions/policy.ts'
import { scopeKeyOf } from '../permissions/resolve.ts'

const OPERATION = 'slack.channel.post' as const
const SLACK = ACCOUNT_IDS.slack
const COLUMNS = 'INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id)'

/** The scope a channel's grant holds, and its key (the same `scopeKeyOf` the outbox's `resolve` uses). */
export const channelScope = (channelId: string) => {
  const scope = { channelId }
  return { scope, scopeKey: scopeKeyOf(scope) }
}

/** A brand grant's `per_day`: the operation's default (the ceiling's daily maximum caps it at each use, N10). */
export const ALERTS_PER_DAY = grantDefaults(OPERATION).perDay
/** Stage 1 M3-L (N24): its largest single call, the operation's default (one post). */
const ALERTS_UNITS_MAX = grantDefaults(OPERATION).unitsMax

/** The Slack account connected now (no disconnect after the connect), as SQL on `connector_accounts` aliased `ca`. */
const CONNECTED = 'ca.account_id = ? AND ca.connected_at_ms IS NOT NULL AND (ca.disconnected_at_ms IS NULL OR ca.disconnected_at_ms < ca.connected_at_ms)'

/**
 * Revokes every unrevoked brand grant to post to `channelId` that `extraWhere` narrows, stamped, with one
 * `permission.revoked` line per grant this statement revoked (built in SQL from the revoked rows, as grants.ts does).
 */
function revokeBrand(channelId: string, extraWhere: string, extraParams: readonly (string | number)[], reason: 'removed' | 'superseded', at: At, when: Exists): Stmt[] {
  const stamp = writeStamp(at.requestId)
  return [
    stmt(
      `UPDATE permission_grants SET revoked_at_ms = ?, revoked_by = ?, revoke_reason = ?, rev = rev + 1, stamp = ?
       WHERE revoked_at_ms IS NULL AND holder = 'brand' AND operation = ? AND account_id = ? AND json_extract(scope_json, '$.channelId') = ?
         ${extraWhere} AND EXISTS (${when.sql})`,
      at.nowMs, at.actorId, reason, stamp, OPERATION, SLACK, channelId, ...extraParams, ...when.params,
    ),
    stmt(
      `${COLUMNS} SELECT ?, ?, 'permission.revoked', 'permission', id,
         json_object('permissionId', id, 'operation', operation, 'reason', ?), ?
       FROM permission_grants WHERE stamp = ? ORDER BY id`,
      at.nowMs, at.actorId, reason, at.requestId, stamp,
    ),
  ]
}

/**
 * The mark moved onto `channelId`: its brand grant, only where `marked` holds (this write's stamp on the channel's
 * marked row) and the rules above do. A dead brand grant on the same key (another ceiling revision, policy or account
 * generation) is first revoked as `superseded` under the same conditions, so it doesn't hold the live index's slot.
 */
export function alertsGrantStmts(channelId: string, marked: Exists, at: At): Stmt[] {
  const id = newPermissionId()
  const stamp = writeStamp(at.requestId)
  const { scope, scopeKey } = channelScope(channelId)
  const eligible: Exists = {
    sql: `SELECT 1 FROM permission_ceiling c, connector_accounts ca WHERE c.operation = ? AND c.enabled = 1 AND ${CONNECTED}
      AND EXISTS (SELECT 1 FROM members m WHERE m.id = ? AND m.kind = 'person' AND m.status = 'active' AND m.role = 'admin')
      AND EXISTS (${marked.sql})`,
    params: [OPERATION, SLACK, at.actorId, ...marked.params],
  }
  return [
    ...revokeBrand(channelId, `AND (policy_rev <> ?
        OR ceiling_rev IS NOT (SELECT lowered_rev FROM permission_ceiling WHERE operation = permission_grants.operation)
        OR account_gen IS NOT (SELECT connected_at_ms FROM connector_accounts WHERE account_id = permission_grants.account_id))`,
    [POLICY_REV], 'superseded', at, eligible),
    stmt(
      `INSERT INTO permission_grants (id, holder, holder_member, account_id, account_gen, operation, scope_json, scope_key, per_day,
         units_max, policy_rev, granted_by, granted_role, ceiling_rev, source_action, granted_at_ms, stamp)
       SELECT ?, 'brand', NULL, ca.account_id, ca.connected_at_ms, ?, ?, ?, ?, ?, ?, ?, 'admin', c.lowered_rev, NULL, ?, ?
       FROM permission_ceiling c, connector_accounts ca
       WHERE c.operation = ? AND c.enabled = 1 AND ${CONNECTED}
         AND EXISTS (SELECT 1 FROM members m WHERE m.id = ? AND m.kind = 'person' AND m.status = 'active' AND m.role = 'admin')
         AND EXISTS (${marked.sql})
       ON CONFLICT DO NOTHING`,
      id, OPERATION, JSON.stringify(scope), scopeKey, ALERTS_PER_DAY, ALERTS_UNITS_MAX, POLICY_REV, at.actorId, at.nowMs, stamp,
      OPERATION, SLACK, at.actorId, ...marked.params,
    ),
    lineWhereStamped(id, stamp, at, {
      action: 'permission.granted', permissionId: id, operation: OPERATION, accountId: SLACK, scopeKey, holder: 'brand', perDay: ALERTS_PER_DAY,
    }),
  ]
}

/** The grant's `permission.granted` line, inserted only where the grant row carries this write's stamp. */
function lineWhereStamped(id: string, stamp: string, at: At, args: Extract<Parameters<typeof auditInsert>[0]['args'], { action: 'permission.granted' }>): Stmt {
  // `auditInsert` checks the line against the audit schema (db/audit.ts); its values are the line's columns in order.
  const plain = auditInsert({ atMs: at.nowMs, actorId: at.actorId, args, target: { kind: 'member', id }, requestId: at.requestId }, null)
  const values = [...plain.params]
  values[3] = 'permission'
  return stmt(`${COLUMNS} SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM permission_grants WHERE id = ? AND stamp = ?)`, ...values, id, stamp)
}

/** The mark moved off `channelId`: its brand grant ends (`removed`), only where `when` holds (this write changed that row). */
export const unmarkGrantStmts = (channelId: string, at: At, when: Exists): Stmt[] => revokeBrand(channelId, '', [], 'removed', at, when)

/** The alerts channel's live brand grant as the channel list shows it: its id, its scope in plain words and its daily limit. */
export interface AlertsGrantView { id: string; scope: string; perDay: number }

/**
 * The live, current brand grant to post to this channel (grants.ts `liveGrant`: unrevoked, current policy, ceiling and
 * account generation), with the daily limit a post meets now: the smaller of the grant's and the ceiling's (N10).
 */
export async function alertsGrantOf(db: D1Database, channel: { channelId: string; name: string }): Promise<AlertsGrantView | null> {
  const g = await liveGrant(db, { holder: 'brand', accountId: SLACK, operation: OPERATION, scopeKey: channelScope(channel.channelId).scopeKey })
  if (!g) return null
  const c = await first<{ per_day_max: number }>(db, stmt('SELECT per_day_max FROM permission_ceiling WHERE operation = ? AND enabled = 1', OPERATION))
  if (!c) return null
  return { id: g.id, scope: `#${channel.name}`, perDay: Math.min(g.per_day, c.per_day_max) }
}
