// The audit writer (p2-design section 8, decision Q3). Every change and its line go in one `DB.batch`; the line's insert
// is `INSERT ... SELECT ... WHERE EXISTS (the changed row, stamped by this write)`, so a change that matched no row (a
// stale ifRev, a refused guard) writes no line. Arguments are checked against `AuditArgsSchema` before anything runs:
// people by member id only, a setting's value only for an audit-safe key, else its length and an HMAC.
import { AuditArgsSchema } from '../../shared/contract/audit.ts'
import type { AuditArgs } from '../../shared/contract/audit.ts'
import { stmt } from './sql.ts'
import type { SqlValue, Stmt } from './sql.ts'

export type TargetKind = 'member' | 'setting' | 'grant' | 'memory'
  // P5 (p5-w1)
  | 'connector'
  // P5 (p5-w4)
  | 'channel'

export interface LineInput {
  atMs: number
  actorId: string
  args: AuditArgs
  target: { kind: TargetKind; id: string } | null
  requestId: string
}

/** The row the change touched, found by `where` (with `params`) and the write's `stamp` on its `req_id`. */
export interface Guard {
  table: 'members' | 'settings' | 'support_grants' | 'memories' | 'today_aside'
    // P5 (p5-w1)
    | 'connector_accounts'
    // P5 (p5-w4)
    | 'notify_channels'
  where: string
  params: readonly SqlValue[]
  stamp: string
}

/** Swaps an audit statement (tests only: an invalid one proves the change rolls back with it). */
export type AuditHook = (s: Stmt) => Stmt

const COLUMNS = 'INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id)'

/** The line's insert. Throws when the arguments break the schema (a name, an email, a value of a redacted key). */
export function auditInsert(line: LineInput, guard: Guard | null): Stmt {
  const { action, ...rest } = AuditArgsSchema.parse(line.args)
  const values: SqlValue[] = [line.atMs, line.actorId, action, line.target?.kind ?? null, line.target?.id ?? null, JSON.stringify(rest), line.requestId]
  if (!guard) return stmt(`${COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?)`, ...values)
  return stmt(
    `${COLUMNS} SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ${guard.table} WHERE ${guard.where} AND req_id = ?)`,
    ...values, ...guard.params, guard.stamp,
  )
}

/** `AUDIT_HASH_KEY` is unset: logged by name (api.ts logs `err.name`), so the 503's cause is plain in the logs. */
export class AuditKeyMissingError extends Error {
  constructor() {
    super('AUDIT_HASH_KEY is not set')
    this.name = 'AuditKeyMissingError'
  }
}

const keys = new Map<string, Promise<CryptoKey>>()

/**
 * A value the log may not hold: its length and the first 16 bytes of HMAC-SHA-256 under `AUDIT_HASH_KEY`, hex. The
 * same value always gives the same hash (so two lines can be compared), and the key never leaves the Worker.
 */
export async function redact(hashKey: string, value: string): Promise<{ len: number; hash: string }> {
  if (!hashKey) throw new AuditKeyMissingError()
  let key = keys.get(hashKey)
  if (!key) {
    key = crypto.subtle.importKey('raw', new TextEncoder().encode(hashKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    keys.set(hashKey, key)
  }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(value)))
  return { len: value.length, hash: [...mac.subarray(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('') }
}
