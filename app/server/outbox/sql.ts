// The outbox's SQL pieces (N11): ids, the stamp pattern, audit lines on `action` targets and the guarded use writes. A
// zero-row statement doesn't fail a D1 batch, so every later statement in a batch acts only where the winning
// statement left its stamp (the ledger's pattern, server/usage/ledger.ts).
import type { AuditArgs } from '../../shared/contract/audit.ts'
import type { LapseReasonSchema } from '../../shared/contract/audit.ts'
import type { z } from 'zod'
import { auditInsert } from '../db/audit.ts'
import { stmt } from '../db/sql.ts'
import type { SqlValue, Stmt } from '../db/sql.ts'
import type { Exists } from '../permissions/grants.ts'
import type { ReleaseReason } from '../permissions/policy.ts'
import { reserveUseSql } from '../permissions/uses.ts'
import type { UseReservation } from '../permissions/uses.ts'

export type { Exists }
export type LapseReason = z.infer<typeof LapseReasonSchema>

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
/** An action's id: `ac_` + 128 random bits (shared/contract/actions.ts `ActionIdSchema`). */
export const newActionId = (): string => `ac_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`

/** The states an action never leaves (a resolved `needs_check` is `sent` or `failed`). */
export const FINAL_STATES = ['sent', 'failed', 'undone', 'denied', 'withdrawn', 'expired'] as const

/** The row this batch stamped: the condition its later statements and lines hang on. */
export const stamped = (actionId: string, stamp: string): Exists => ({ sql: 'SELECT 1 FROM outbox_actions WHERE id = ? AND stamp = ?', params: [actionId, stamp] })

/** The gate is open: not paused and not held for a restore (N12). */
export const GATE_OPEN = 'SELECT 1 FROM outbox_gate WHERE id = 1 AND paused = 0 AND restore_hold = 0'

/** A use's key in `permission_uses` (0720_permissions.sql: `id = action_id || '#' || action_rev`). */
export const permissionUseKey = (actionId: string, rev: number): string => `${actionId}#${rev}`

const COLUMNS = 'INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id)'

/**
 * One audit line about an action, checked against the schema like every line (db/audit.ts), its target the action.
 * Inserted only where `exists` holds; `exists` null writes it unconditionally (a line nothing else in the batch decides).
 */
export function actionLine(line: { atMs: number; actorId: string; args: AuditArgs & { actionId: string }; requestId: string }, exists: Exists | null): Stmt {
  const plain = auditInsert({ atMs: line.atMs, actorId: line.actorId, args: line.args, target: null, requestId: line.requestId }, null)
  const values = [...plain.params]
  values[3] = 'action'
  values[4] = line.args.actionId
  if (exists === null) return stmt(`${COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?)`, ...values)
  return stmt(`${COLUMNS} SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${exists.sql})`, ...values, ...exists.params)
}

/** `released` as a JSON boolean, for a line built in SQL: whether this revision's use is unreleased now. */
export const UNRELEASED_USE = "EXISTS (SELECT 1 FROM permission_uses u WHERE u.id = a.id || '#' || a.rev AND u.released_at_ms IS NULL)"

/**
 * One line per action row a batch stamped, built in SQL from the rows (their id and attempt, both ours): for a write
 * that changes many rows at once (the pause sync, the sweep). `argsSql` is a `json_object(...)` over alias `a` with no
 * `action` key; `params` are its bound values.
 */
export function linesForStamped(action: AuditArgs['action'], argsSql: string, params: readonly SqlValue[], at: { atMs: number; actorId: string; requestId: string }, stamp: string): Stmt {
  return stmt(
    `${COLUMNS} SELECT ?, ?, ?, 'action', a.id, ${argsSql}, ? FROM outbox_actions a WHERE a.stamp = ? ORDER BY a.id`,
    at.atMs, at.actorId, action, ...params, at.requestId, stamp,
  )
}

/**
 * Reserves a use (permissions/uses.ts `reserveUseSql`), only where `onlyIf` also holds: a use is reserved only by the
 * answer or the request that won, so a losing batch can't take a unit (or collide with the winner's key). The guard is
 * one more condition on the same statement's WHERE.
 */
export function reserveUseWhere(r: UseReservation, onlyIf: Exists): Stmt {
  const base = reserveUseSql(r)
  // The reservation's last condition is its ceiling; anything else means its SQL changed shape, so fail loud.
  if (!/<= MIN\(g\.per_day, c\.per_day_max\)\s*$/.test(base.sql)) throw new Error('reserveUseWhere: reserveUseSql changed shape')
  return stmt(`${base.sql.trimEnd()} AND EXISTS (${onlyIf.sql})`, ...base.params, ...onlyIf.params)
}

/** Releases this revision's use once (a released use stays released), only where `onlyIf` holds. */
export function releaseUseWhere(r: { actionId: string; actionRev: number; reason: ReleaseReason; atMs: number }, onlyIf: Exists): Stmt {
  return stmt(
    `UPDATE permission_uses SET released_at_ms = ?, release_reason = ? WHERE id = ? AND released_at_ms IS NULL AND EXISTS (${onlyIf.sql})`,
    r.atMs, r.reason, permissionUseKey(r.actionId, r.actionRev), ...onlyIf.params,
  )
}

/** Whether this revision's use exists and is unreleased (a line's `released` decided in SQL, before the release). */
export const unreleasedUse = (actionId: string, rev: number): Exists =>
  ({ sql: 'SELECT 1 FROM permission_uses WHERE id = ? AND released_at_ms IS NULL', params: [permissionUseKey(actionId, rev)] })

/** `a AND b` as one condition. */
export const both = (a: Exists, b: Exists): Exists => ({ sql: `${a.sql} AND EXISTS (${b.sql})`, params: [...a.params, ...b.params] })
/** `a AND NOT b`. */
export const butNot = (a: Exists, b: Exists): Exists => ({ sql: `${a.sql} AND NOT EXISTS (${b.sql})`, params: [...a.params, ...b.params] })
