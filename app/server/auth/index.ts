// The API's sign-in and access parts (p2-design sections 1 to 3), as server/api.ts takes them (ApiParts): `authenticate`
// and `checkOrigin` (authenticate.ts), and `authorize`, which runs `checkAccess` (matrix.ts) on the route's row with the
// object the route names, then writes the `support.access` audit line an Inhouse read of brand data needs.
import type { AccessRow } from './matrix.ts'
import { checkAccess } from './matrix.ts'
import type { AccessObject, ForbiddenReason } from './matrix.ts'
import type { Principal } from './principal.ts'
import type { AuthStores } from './stores.ts'

export { authenticate, authenticateUpgrade, checkOrigin } from './authenticate.ts'
export type { AuthOutcome } from './authenticate.ts'
export type { Principal } from './principal.ts'
export type { AuthStores } from './stores.ts'

export type AccessRefusal = { code: 'forbidden'; reason?: ForbiddenReason } | { code: 'unavailable' }

/**
 * The object a row's rule needs, from the request: a `personal` route is always the caller's own (none takes a member
 * id), and an `adminWrite` route's object is its `:key` and the JSON body's `value` (an unreadable body: no value,
 * so refused).
 */
async function objectFor(row: AccessRow, principal: Principal, request: Request, params: Record<string, string>): Promise<AccessObject | undefined> {
  if (row.class === 'personal') return { ownerId: 'memberId' in principal ? principal.memberId : undefined }
  if (row.adminWrite && principal.kind === 'person' && principal.role === 'admin') {
    let value: unknown
    try {
      value = ((await request.clone().json()) as { value?: unknown } | null)?.value
    } catch {
      value = undefined
    }
    return { settingKey: params.key, value }
  }
  return undefined
}

/** Null when the handler may run; else the refusal. An Inhouse read of brand data is audited first (no line: 503). */
export async function authorize(row: AccessRow, principal: Principal, request: Request, params: Record<string, string>, stores: AuthStores, nowMs: number): Promise<AccessRefusal | null> {
  const decision = checkAccess(principal, row, nowMs, await objectFor(row, principal, request, params))
  if ('refused' in decision) return decision.reason ? { code: 'forbidden', reason: decision.reason } : { code: 'forbidden' }
  if (principal.kind === 'inhouse' && row.class === 'brand_data') {
    try {
      await stores.audit.supportAccess(principal, { method: row.method, route: row.pattern })
    } catch (err) {
      console.error({ event: 'support_access_unlogged', requestId: principal.requestId, error: err instanceof Error ? err.name : 'unknown' })
      return { code: 'unavailable' }
    }
  }
  return null
}

/**
 * Stand-in stores until W2's D1 data layer is wired (server/index.ts): every call throws, so every sign-in that needs
 * D1 answers 503 and nothing is let through. Only `monitor` (no member row) gets a principal.
 */
export const unwiredStores: AuthStores = {
  members: {
    resolvePerson: () => Promise.reject(new Error('stores not wired')),
    resolveInhouse: () => Promise.reject(new Error('stores not wired')),
    serviceMember: () => Promise.reject(new Error('stores not wired')),
    profile: () => Promise.reject(new Error('stores not wired')),
  },
  grants: { active: () => Promise.reject(new Error('stores not wired')) },
  audit: { supportAccess: () => Promise.reject(new Error('stores not wired')) },
}
