// The access matrix's types (p2-design section 3). The rows live in server/access-matrix.ts (orchestrator only), one
// per route in server/routes.ts, beside the `CanRows` map; `checkAccess` reads a route's row and `canFor` reads the
// same rows for `me().can`, so the UI's `can` never disagrees with the server.
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
 * - `report`: POST only, per `allow` (Inhouse included, no grant: the error reporter posts from both hosts); never a
 *   service token. Its handler gets no stores (api.ts), so it can only log. No `CanKey` points at one.
 */
export type RouteClass = 'brand_data' | 'baseline' | 'technical' | 'personal' | 'open' | 'report'

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
  /**
   * A `technical` row an Admin may write, but only through the object rule (`tm:<id>:on` set to `'off'`). Such a row
   * lists `admin` in `allow` too (row 12: `allow: ['inhouse', 'admin'], adminWrite: true`); `allow` alone never lets
   * an Admin write it.
   */
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

/**
 * - `audit: 'support.access'`: set by `checkAccess` exactly for Inhouse on `brand_data`; api.ts writes that line from
 *   the decision before the handler runs (never re-derives it).
 * - `objectCheck: 'required'`: the row's rule needs the object (a `personal` row, an Admin on an `adminWrite` row) and
 *   none was given; api.ts hands the handler `requireObject` and records each call's outcome: any refusal answers 403
 *   whatever the handler returned, and a 2xx needs at least one passing call (none: 500 and one log line). The 403
 *   only fixes the answer: it can't undo a write the handler committed after swallowing a refusal, so a handler must
 *   never catch `AccessRefused`.
 */
export type AccessDecision =
  | { ok: true; audit?: 'support.access'; objectCheck?: 'required' }
  | { refused: 'forbidden'; reason?: ForbiddenReason }

/**
 * Whether `principal` may use `row` at `nowMs` (a grant ending exactly at `nowMs` isn't live). Pure. api.ts calls it
 * with `object` undefined before the handler; `requireObject` calls it again with the object.
 */
export type CheckAccess = (principal: Principal, row: AccessRow, object: AccessObject | undefined, nowMs: number) => AccessDecision

/**
 * What a handler on an `objectCheck: 'required'` row must call once it knows the object: runs `checkAccess` with it
 * and throws an `AccessRefused` (api.ts answers 403 `forbidden` with its reason) when refused.
 */
export type RequireObject = (object: AccessObject) => void

/** What `RequireObject` throws. */
export interface AccessRefused extends Error {
  readonly code: 'forbidden'
  readonly reason?: ForbiddenReason
}

/**
 * Each `CanKey`'s row (the values live beside the rows in server/access-matrix.ts). `as: 'adminWrite'` evaluates the
 * row with the object an Admin's allowed write has (`{ settingKey: 'tm:<id>:on', value: 'off' }`).
 */
export type CanRows = Record<CanKey, { readonly method: Method; readonly pattern: string; readonly as?: 'adminWrite' }>

/**
 * `me().can`: each `CanKey` evaluated through `checkAccess` on its row. A decision still marked
 * `objectCheck: 'required'` counts as **false**: only `as: 'adminWrite'` supplies an object, so an Admin gets
 * `editTechnical` false and `switchModelOff` true on row 12, as the server answers.
 */
export type CanFor = (principal: Principal, rows: readonly AccessRow[], canRows: CanRows, nowMs: number) => Record<CanKey, boolean>

/**
 * What's wrong with a `CanRows` map against the rows: each `CanKey` must map to exactly one row. Empty when sound.
 * The matrix-invariant tests run it on the committed rows.
 */
export function canRowsProblems(rows: readonly AccessRow[], canRows: CanRows): string[] {
  const problems: string[] = []
  for (const [key, want] of Object.entries(canRows)) {
    const n = rows.filter(r => r.method === want.method && r.pattern === want.pattern).length
    if (n !== 1) problems.push(`${key} → ${want.method} ${want.pattern} matches ${n} rows`)
  }
  return problems
}

const OK: AccessDecision = { ok: true }
const NO: AccessDecision = { refused: 'forbidden' }
const OBJECT_REQUIRED: AccessDecision = { ok: true, objectCheck: 'required' }

/** The only technical write an Admin may make (decision log: admins may switch a model off). Call 4 may add `'on'`. */
const ADMIN_WRITE_KEY = /^tm:[^:]+:on$/

/** The object an Admin's allowed `adminWrite` write has, for `canFor` (`as: 'adminWrite'`). */
export const ADMIN_WRITE_OBJECT: AccessObject = { settingKey: 'tm:any:on', value: 'off' }

const owner = (object: AccessObject | undefined, memberId: string): AccessDecision =>
  object === undefined ? OBJECT_REQUIRED : object.ownerId === memberId ? OK : { refused: 'forbidden', reason: 'not_owner' }

export const checkAccess: CheckAccess = (principal, row, object, nowMs) => {
  const read = row.method === 'GET'
  if (principal.kind === 'service') {
    if (!row.services?.includes(principal.name)) return NO
    if (principal.name === 'monitor') return row.class === 'open' && read ? OK : NO
    if (!read || row.class === 'open' || row.class === 'report') return NO
    return row.class === 'personal' ? owner(object, principal.memberId) : OK
  }
  if (row.class === 'open') return NO
  if (row.class === 'report') {
    const who = principal.kind === 'inhouse' ? 'inhouse' : principal.role
    return row.method === 'POST' && row.allow.includes(who) ? OK : NO
  }

  if (principal.kind === 'inhouse') {
    if (!row.allow.includes('inhouse')) return NO
    switch (row.class) {
      case 'brand_data': {
        if (!read) return NO
        const g = principal.grant
        return g && g.endsAtMs > nowMs ? { ok: true, audit: 'support.access' } : { refused: 'forbidden', reason: 'grant_required' }
      }
      case 'baseline': return read ? OK : NO
      case 'technical': return OK
      case 'personal': return NO
    }
  }

  const role = principal.role
  if (!row.allow.includes(role)) return row.class === 'technical' && !read && role === 'admin' ? { refused: 'forbidden', reason: 'admin_read_only' } : NO
  if (row.class === 'technical' && !read) {
    // A Member never writes technical; an Admin only on an `adminWrite` row, and only through the object rule.
    if (role !== 'admin') return NO
    if (!row.adminWrite) return { refused: 'forbidden', reason: 'admin_read_only' }
    if (object === undefined) return OBJECT_REQUIRED
    return typeof object.settingKey === 'string' && ADMIN_WRITE_KEY.test(object.settingKey) && object.value === 'off'
      ? OK
      : { refused: 'forbidden', reason: 'admin_read_only' }
  }
  return row.class === 'personal' ? owner(object, principal.memberId) : OK
}

/** What `requireObject` throws: api.ts answers 403 `forbidden` with its reason. */
export class AccessRefusedError extends Error implements AccessRefused {
  readonly code = 'forbidden' as const
  readonly reason?: ForbiddenReason
  constructor(reason?: ForbiddenReason) {
    super('forbidden')
    this.name = 'AccessRefused'
    this.reason = reason
  }
}

/**
 * `requireObject` for one request on one row, with every call's outcome recorded: `refusal` is the first refusal
 * (api.ts answers 403 with it whatever the handler returned), `passed` whether at least one call passed. The 403 only
 * fixes the answer: it can't undo a write committed before the handler returned, so api.ts also hands the handler its
 * stores through `closedAfterRefusal`, and a handler that swallows `AccessRefused` can't write through them after it.
 */
export function objectGate(principal: Principal, row: AccessRow, nowMs: number): { requireObject: RequireObject; readonly passed: boolean; readonly refusal: AccessRefusedError | null } {
  let passed = false
  let refusal: AccessRefusedError | null = null
  return {
    requireObject(object) {
      const d = checkAccess(principal, row, object, nowMs)
      const refused = 'refused' in d ? new AccessRefusedError(d.reason) : d.objectCheck ? new AccessRefusedError() : null
      if (refused) {
        refusal ??= refused
        throw refused
      }
      passed = true
    },
    get passed() { return passed },
    get refusal() { return refusal },
  }
}

/** The row for a method and pattern, or undefined. */
export const rowFor = (rows: readonly AccessRow[], method: string, pattern: string) =>
  rows.find(r => r.method === method && r.pattern === pattern)

export const canFor: CanFor = (principal, rows, canRows, nowMs) => {
  const out = {} as Record<CanKey, boolean>
  for (const key of Object.keys(canRows) as CanKey[]) {
    const want = canRows[key]
    const row = rowFor(rows, want.method, want.pattern)
    const d = row && checkAccess(principal, row, want.as === 'adminWrite' ? ADMIN_WRITE_OBJECT : undefined, nowMs)
    out[key] = !!d && 'ok' in d && !d.objectCheck
  }
  return out
}

/** What a store call throws once the request's object check has refused. */
export class StoresClosedError extends Error {
  constructor() {
    super('stores closed: this request was refused')
    this.name = 'StoresClosed'
  }
}

/**
 * `stores` as the handler gets them: every method, at any depth, throws `StoresClosedError` once `refused()` is true
 * (reads too: the answer is 403 anyway). A call made before the refusal runs as usual; what it returns isn't wrapped.
 */
export function closedAfterRefusal<T extends object>(stores: T, refused: () => boolean): T {
  // A blank target, so a frozen store or a class instance (private fields, prototype methods) wraps as well: each
  // method still runs with the real object as `this`.
  const target = stores
  return new Proxy(Object.create(null) as T, {
    get(_, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          if (refused()) throw new StoresClosedError()
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return value !== null && typeof value === 'object' ? closedAfterRefusal(value, refused) : value
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  })
}
