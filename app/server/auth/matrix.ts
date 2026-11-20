// The access matrix's types (p2-design section 3). The rows live in server/access-matrix.ts (orchestrator only), one
// per route in server/routes.ts; `checkAccess` reads a route's row and `canFor` reads the same rows for `me().can`, so
// the UI's `can` never disagrees with the server.
import type { CanKey } from '../../shared/contract/me.ts'
import type { Principal } from './principal.ts'
import type { Method } from '../routes.ts'

/**
 * - `brand_data`: persons per `allow`; Inhouse only on GET with a live grant, after a `support.access` audit line.
 * - `baseline`: Inhouse may GET without a grant; writes per `allow`, never Inhouse.
 * - `technical`: Inhouse reads and writes; Member and Admin GET only; an Admin write only on an `adminWrite` row whose
 *   object check passes.
 * - `personal`: only the owner (`object.ownerId === principal.memberId`), never Inhouse.
 * - `open`: the closed list (today only `GET /api/health`, for `monitor`).
 */
export type RouteClass = 'brand_data' | 'baseline' | 'technical' | 'personal' | 'open'

/** One row per route. `method` and `pattern` match the route's own (server/routes.ts) exactly. */
export interface AccessRow {
  readonly method: Method
  /** The route's pattern, `:name` segments included (`/api/members/:id/role`). */
  readonly pattern: string
  readonly class: RouteClass
  /** Which roles the row lets through, before the class rules narrow it. */
  readonly allow: readonly ('member' | 'admin' | 'inhouse')[]
  /** Service tokens the row lets through: `monitor` only on `open` rows, `smoke` only on GET rows. */
  readonly services?: readonly ('monitor' | 'smoke')[]
  /** A `technical` row an Admin may write, but only where the object check passes (`tm:<id>:on` set to `'off'`). */
  readonly adminWrite?: true
}

/** What the handler is about to touch, for the rows whose rule depends on it. */
export interface AccessObject {
  /** `personal`: the member id that owns the record. */
  ownerId?: string
  /** `adminWrite`: the setting key being written. */
  settingKey?: string
  /** `adminWrite`: the value being written. */
  value?: unknown
}

/** The `forbidden` reasons p2-design section 4 lets the body name; any other refusal is a bare `forbidden`. */
export type ForbiddenReason = 'grant_required' | 'admin_read_only' | 'not_owner'

export type AccessDecision = { ok: true } | { refused: 'forbidden'; reason?: ForbiddenReason }

/**
 * Whether `principal` may use `row` at `nowMs` (a grant ending exactly at `nowMs` isn't live). Pure: the
 * `support.access` audit line an Inhouse read of brand data needs is written by the caller after `{ ok: true }`.
 */
export type CheckAccess = (principal: Principal, row: AccessRow, nowMs: number, object?: AccessObject) => AccessDecision

/** `me().can`: each `CanKey` evaluated through `checkAccess` on its row. */
export type CanFor = (principal: Principal, rows: readonly AccessRow[], nowMs: number) => Record<CanKey, boolean>

const OK: AccessDecision = { ok: true }
const NO: AccessDecision = { refused: 'forbidden' }

/** The only technical write an Admin may make (decision log: admins may switch a model off). Call 4 may add `'on'`. */
const ADMIN_WRITE_KEY = /^tm:[^:]+:on$/
const adminWriteAllowed = (o: AccessObject | undefined) =>
  !!o && typeof o.settingKey === 'string' && ADMIN_WRITE_KEY.test(o.settingKey) && o.value === 'off'

export const checkAccess: CheckAccess = (principal, row, nowMs, object) => {
  const read = row.method === 'GET'
  if (principal.kind === 'service') {
    if (!row.services?.includes(principal.name)) return NO
    if (principal.name === 'monitor') return row.class === 'open' && read ? OK : NO
    if (!read || row.class === 'open') return NO
    if (row.class === 'personal' && object?.ownerId !== principal.memberId) return { refused: 'forbidden', reason: 'not_owner' }
    return OK
  }
  if (row.class === 'open') return NO

  if (principal.kind === 'inhouse') {
    if (!row.allow.includes('inhouse')) return NO
    switch (row.class) {
      case 'brand_data': {
        if (!read) return NO
        const g = principal.grant
        return g && g.endsAtMs > nowMs ? OK : { refused: 'forbidden', reason: 'grant_required' }
      }
      case 'baseline': return read ? OK : NO
      case 'technical': return OK
      case 'personal': return NO
    }
  }

  const role = principal.role
  if (row.class === 'technical') {
    if (read) return row.allow.includes(role) ? OK : NO
    if (role === 'admin' && row.adminWrite) return adminWriteAllowed(object) ? OK : { refused: 'forbidden', reason: 'admin_read_only' }
    return role === 'admin' ? { refused: 'forbidden', reason: 'admin_read_only' } : NO
  }
  if (!row.allow.includes(role)) return NO
  if (row.class === 'personal' && object?.ownerId !== principal.memberId) return { refused: 'forbidden', reason: 'not_owner' }
  return OK
}

/** Which row (and object) each `CanKey` asks about (p2-design section 3). */
export const CAN_ROWS: Record<CanKey, { method: Method; pattern: string; object?: AccessObject }> = {
  invite: { method: 'POST', pattern: '/api/members/invites' },
  changeRole: { method: 'PUT', pattern: '/api/members/:id/role' },
  remove: { method: 'DELETE', pattern: '/api/members/:id' },
  editBrandSettings: { method: 'PUT', pattern: '/api/settings/brand/:key' },
  editTechnical: { method: 'PUT', pattern: '/api/settings/technical/:key' },
  switchModelOff: { method: 'PUT', pattern: '/api/settings/technical/:key', object: { settingKey: 'tm:any:on', value: 'off' } },
  grantSupport: { method: 'POST', pattern: '/api/grants' },
  viewMembers: { method: 'GET', pattern: '/api/members' },
  viewAudit: { method: 'GET', pattern: '/api/audit' },
  exportAudit: { method: 'GET', pattern: '/api/audit/export.csv' },
}

/** The row for a method and pattern, or undefined. */
export const rowFor = (rows: readonly AccessRow[], method: string, pattern: string) =>
  rows.find(r => r.method === method && r.pattern === pattern)

export const canFor: CanFor = (principal, rows, nowMs) => {
  const out = {} as Record<CanKey, boolean>
  for (const [key, want] of Object.entries(CAN_ROWS) as [CanKey, (typeof CAN_ROWS)[CanKey]][]) {
    const row = rowFor(rows, want.method, want.pattern)
    out[key] = !!row && 'ok' in checkAccess(principal, row, nowMs, want.object)
  }
  return out
}
