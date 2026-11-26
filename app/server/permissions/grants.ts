// Grants (N10): "Always allow", the person's list and remove, and the lapses written in the same batch as the change
// that causes them (a member removed or their role lowered, an account disconnected or reconnected), so nothing old
// comes back to life. Every write stamps the rows it changed (`stamp`) and its audit lines are inserted only where that
// stamp is, so a line is written exactly when its change applied. Lines hold ids, the operation, the scope key, counts
// and closed codes; never an argument.
import type { AuditArgs } from '../../shared/contract/audit.ts'
import { OPERATION_TITLE } from '../../shared/audit-text.ts'
import type { Permission } from '../../shared/contract/permissions.ts'
import type { MemberRole } from '../../shared/contract/members.ts'
import { auditInsert } from '../db/audit.ts'
import type { AuditHook } from '../db/audit.ts'
import { writeStamp } from '../db/ids.ts'
import type { At } from '../db/members.ts'
import { all, first, runBatch, stmt } from '../db/sql.ts'
import type { SqlValue, Stmt } from '../db/sql.ts'
import { memberHolder } from './decide.ts'
import type { RevokeReason } from './policy.ts'
import type { Resolved, WriteOperationKey } from './types.ts'

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
/** A permission's id: `pg_` + 128 random bits. */
export const newPermissionId = (): string => `pg_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`

/** A condition other statements in the batch left: SQL for `EXISTS (...)` and its parameters. */
export interface Exists { sql: string; params: readonly SqlValue[] }

const COLUMNS = 'INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id)'

/** One audit line, checked against the schema like every line (db/audit.ts), inserted only where `exists` holds. */
export function lineWhere(line: { atMs: number; actorId: string; args: AuditArgs; targetId: string; requestId: string }, exists: Exists): Stmt {
  const plain = auditInsert({ ...line, target: { kind: 'member', id: line.targetId } }, null)
  // `auditInsert` parsed the arguments; its values are the line's columns in order. The target kind is ours.
  const values = [...plain.params]
  values[3] = 'permission'
  return stmt(`${COLUMNS} SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${exists.sql})`, ...values, ...exists.params)
}

/** `permission_grants` as D1 returns it. */
export interface GrantRow {
  id: string
  holder: string
  holder_member: string | null
  account_id: string
  account_gen: number
  operation: WriteOperationKey
  scope_json: string
  scope_key: string
  per_day: number
  policy_rev: number
  granted_by: string
  granted_role: MemberRole
  ceiling_rev: number
  source_action: string | null
  granted_at_ms: number
  revoked_at_ms: number | null
  revoked_by: string | null
  revoke_reason: string | null
  rev: number
  stamp: string | null
}

// ---------- "Always allow" (the outbox composes it into the winning answer's batch, N11) ----------

export interface AlwaysAllowInput {
  /** The member who said "Always allow": their own grant (`member:<id>`). A brand grant has no route in M2 (D4). */
  holderMemberId: string
  grantedRole: MemberRole
  resolved: Pick<Resolved, 'accountId' | 'accountGen' | 'operation' | 'scope' | 'scopeKey' | 'policyRev'>
  perDay: number
  sourceAction: string
  /** The answer's own condition: only the winning answer may create a grant (its row stamped by this batch). */
  onlyIf: Exists
  at: At
}

/**
 * The grant's insert and its line. The insert takes the ceiling's current `lowered_rev` in the same statement, and adds
 * nothing while the operation is off, `onlyIf` fails, or a live grant already holds the key (`ON CONFLICT DO NOTHING`
 * on the live index). Read the live grant back with `liveGrant` after the batch.
 */
export function alwaysAllowStmts(input: AlwaysAllowInput): { id: string; stamp: string; stmts: Stmt[] } {
  const id = newPermissionId()
  const stamp = writeStamp(input.at.requestId)
  const r = input.resolved
  const holder = memberHolder(input.holderMemberId)
  return {
    id,
    stamp,
    stmts: [
      stmt(
        `INSERT INTO permission_grants (id, holder, holder_member, account_id, account_gen, operation, scope_json, scope_key, per_day,
           policy_rev, granted_by, granted_role, ceiling_rev, source_action, granted_at_ms, stamp)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, c.lowered_rev, ?, ?, ?
         FROM permission_ceiling c WHERE c.operation = ? AND c.enabled = 1 AND EXISTS (${input.onlyIf.sql})
         ON CONFLICT DO NOTHING`,
        id, holder, input.holderMemberId, r.accountId, r.accountGen, r.operation, JSON.stringify(r.scope), r.scopeKey, input.perDay,
        r.policyRev, input.at.actorId, input.grantedRole, input.sourceAction, input.at.nowMs, stamp, r.operation, ...input.onlyIf.params,
      ),
      lineWhere(
        {
          atMs: input.at.nowMs, actorId: input.at.actorId, targetId: id, requestId: input.at.requestId,
          args: { action: 'permission.granted', permissionId: id, operation: r.operation, accountId: r.accountId, scopeKey: r.scopeKey, holder: 'member', perDay: input.perDay, actionId: input.sourceAction },
        },
        { sql: 'SELECT 1 FROM permission_grants WHERE id = ? AND stamp = ?', params: [id, stamp] },
      ),
    ],
  }
}

/** The live grant for this holder, account, operation and scope, or null. */
export function liveGrant(db: D1Database, key: { holder: string; accountId: string; operation: WriteOperationKey; scopeKey: string }): Promise<GrantRow | null> {
  return first<GrantRow>(db, stmt(
    'SELECT * FROM permission_grants WHERE holder = ? AND account_id = ? AND operation = ? AND scope_key = ? AND revoked_at_ms IS NULL',
    key.holder, key.accountId, key.operation, key.scopeKey,
  ))
}

// ---------- lapses, written in the batch of the change that causes them ----------

/**
 * Revokes every live grant `where` names, stamped, and one `permission.revoked` line per grant this statement revoked.
 * The lines are built in SQL from the revoked rows (their id and operation, both ours), so a grant made between a read
 * and this batch is still revoked and still gets its line. `when` is the triggering change's own condition.
 */
function revokeWhere(where: string, params: readonly SqlValue[], reason: RevokeReason, at: At, when: Exists | null): Stmt[] {
  const stamp = writeStamp(at.requestId)
  const guard = when ? ` AND EXISTS (${when.sql})` : ''
  return [
    stmt(
      `UPDATE permission_grants SET revoked_at_ms = ?, revoked_by = ?, revoke_reason = ?, rev = rev + 1, stamp = ?
       WHERE revoked_at_ms IS NULL AND ${where}${guard}`,
      at.nowMs, at.actorId, reason, stamp, ...params, ...(when?.params ?? []),
    ),
    stmt(
      `${COLUMNS} SELECT ?, ?, 'permission.revoked', 'permission', id,
         json_object('permissionId', id, 'operation', operation, 'reason', ?), ?
       FROM permission_grants WHERE stamp = ? ORDER BY id`,
      at.nowMs, at.actorId, reason, at.requestId, stamp,
    ),
  ]
}

/** A member removed (`member_removed`) or their role lowered (`role_lowered`): their own grants end. */
export const revokeMemberGrantsStmts = (memberId: string, reason: 'member_removed' | 'role_lowered', at: At, when: Exists): Stmt[] =>
  revokeWhere('holder_member = ?', [memberId], reason, at, when)

/**
 * An account disconnected (every grant on it ends) or reconnected (`keepGen`: the grants on any other generation end).
 * N10: a disconnect or reconnect revokes grants on the old generation.
 */
export const revokeAccountGrantsStmts = (accountId: string, keepGen: number | null, at: At, when: Exists): Stmt[] =>
  keepGen === null
    ? revokeWhere('account_id = ?', [accountId], 'account_disconnected', at, when)
    : revokeWhere('account_id = ? AND account_gen <> ?', [accountId, keepGen], 'account_reconnected', at, when)

// ---------- the person's list and remove (routes in server/api/permissions.ts) ----------

/** Who reads or removes: a brand person. Admins see and remove any grant; a member only their own (N15). */
export interface Viewer { memberId: string; role: MemberRole }

type ListRow = GrantRow & { channel_name: string | null }

const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const TOOL: Readonly<Record<WriteOperationKey, string>> = { 'shopify.order.tag_add': 'Shopify', 'slack.channel.post': 'Slack' }

/** A grant as the list shows it: server words only (the operation's title, the tool, the scope in plain words). */
export function permissionOf(r: ListRow, viewer: Viewer): Permission {
  const scope = JSON.parse(r.scope_json) as Record<string, string>
  const tool = TOOL[r.operation]
  const where = r.operation === 'slack.channel.post' ? `#${r.channel_name ?? 'a channel no longer listed'}` : scope.shop ?? r.account_id
  return {
    id: r.id,
    rev: r.rev,
    holder: r.holder === 'brand' ? { kind: 'brand' } : { kind: 'member', memberId: r.holder_member as string },
    operation: r.operation,
    title: OPERATION_TITLE[r.operation],
    tool: { accountId: r.account_id, label: tool },
    scope: where,
    perDay: r.per_day,
    grantedBy: r.granted_by,
    grantedAt: instant(r.granted_at_ms),
    can: { remove: viewer.role === 'admin' || r.holder === memberHolder(viewer.memberId) },
  }
}

const LIST = `SELECT g.*, nc.name AS channel_name FROM permission_grants g
  LEFT JOIN notify_channels nc ON nc.channel_id = json_extract(g.scope_json, '$.channelId')
  WHERE g.revoked_at_ms IS NULL`

/** An active brand person of this role, as a statement condition (the actor checked inside the write). */
const ACTIVE_PERSON = "SELECT 1 FROM members WHERE id = ? AND kind = 'person' AND status = 'active' AND role = ?"

export type RemoveOutcome = { ok: Permission[] } | { conflict: Permission } | { refused: 'not_found' }

export function permissionStore({ db, hook = s => s }: { db: D1Database; hook?: AuditHook }) {
  const visible = async (viewer: Viewer): Promise<ListRow[]> => (viewer.role === 'admin'
    ? all<ListRow>(db, stmt(`${LIST} ORDER BY g.granted_at_ms DESC, g.id DESC`))
    : all<ListRow>(db, stmt(`${LIST} AND g.holder = ? ORDER BY g.granted_at_ms DESC, g.id DESC`, memberHolder(viewer.memberId))))

  return {
    /** This person's live grants; for an admin, every live grant of the brand. Newest first. */
    async list(viewer: Viewer): Promise<Permission[]> {
      return (await visible(viewer)).map(r => permissionOf(r, viewer))
    },

    /**
     * Removes a live grant at `ifRev`: its holder, or an active admin (checked in the statement, so a role lowered in
     * between refuses). One batch with its `permission.revoked` line. A grant the viewer may not see is `not_found`.
     */
    async remove(input: { id: string; ifRev: number }, viewer: Viewer, at: At): Promise<RemoveOutcome> {
      const stamp = writeStamp(at.requestId)
      // Only picks the line's operation (it never changes); every rule is in the update's own WHERE.
      const row = await first<GrantRow>(db, stmt('SELECT * FROM permission_grants WHERE id = ?', input.id))
      if (!row) return { refused: 'not_found' }
      const [change] = await runBatch(db, [
        stmt(
          `UPDATE permission_grants SET revoked_at_ms = ?, revoked_by = ?, revoke_reason = 'removed', rev = rev + 1, stamp = ?
           WHERE id = ? AND rev = ? AND revoked_at_ms IS NULL
             AND (holder = ? OR EXISTS (${ACTIVE_PERSON}))`,
          at.nowMs, at.actorId, stamp, input.id, input.ifRev, memberHolder(viewer.memberId), viewer.memberId, 'admin',
        ),
        hook(lineWhere(
          { atMs: at.nowMs, actorId: at.actorId, targetId: input.id, requestId: at.requestId, args: { action: 'permission.revoked', permissionId: input.id, operation: row.operation, reason: 'removed' } },
          { sql: 'SELECT 1 FROM permission_grants WHERE id = ? AND stamp = ?', params: [input.id, stamp] },
        )),
      ])
      if (change.meta.changes > 0) return { ok: await this.list(viewer) }
      const now = (await visible(viewer)).find(r => r.id === input.id)
      return now ? { conflict: permissionOf(now, viewer) } : { refused: 'not_found' }
    },
  }
}

export type PermissionStore = ReturnType<typeof permissionStore>
