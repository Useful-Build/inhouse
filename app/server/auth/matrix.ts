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

export type AccessDecision = { ok: true } | { refused: 'forbidden'; reason: string }

/**
 * Whether `principal` may use `row` at `nowMs` (a grant ending exactly at `nowMs` isn't live). Pure: the
 * `support.access` audit line an Inhouse read of brand data needs is written by the caller after `{ ok: true }`.
 */
export type CheckAccess = (principal: Principal, row: AccessRow, nowMs: number, object?: AccessObject) => AccessDecision

/** `me().can`: each `CanKey` evaluated through `checkAccess` on its row. */
export type CanFor = (principal: Principal, rows: readonly AccessRow[], nowMs: number) => Record<CanKey, boolean>
