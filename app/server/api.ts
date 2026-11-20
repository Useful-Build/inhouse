// The /api/* request path (p2-design sections 2 to 4): authenticate (401 before any route lookup, so an unknown path
// without a JWT is 401, not 404), the Origin check on non-GET and on a WebSocket upgrade, the route (unknown: 404), its
// matrix row (none: 500, never the handler), checkAccess, then the handler. Every answer carries the security headers
// and no-store: the errors through server/http.ts, and a handler's own Response is wrapped here, so no handler can opt
// out. Its parts come in as `ApiParts` (server/index.ts passes the real ones), so tests can drive the path itself.
import type { AccessRow } from './access-matrix.ts'
import { AccessRefusedError, objectGate } from './auth/index.ts'
import type { AuthStores, authenticate, checkAccess, checkOrigin } from './auth/index.ts'
import { SECURITY_HEADERS, apiError } from './http.ts'
import { respond, withSecurityHeaders } from '../shared/security-headers.ts'
import { matchRoute } from './routes.ts'
import type { Route } from './routes.ts'

export interface ApiParts {
  authenticate: typeof authenticate
  checkOrigin: typeof checkOrigin
  checkAccess: typeof checkAccess
  /** The D1-backed stores sign-in and access read (W2's data layer). */
  stores: (env: Env) => AuthStores
  routes: readonly Route[]
  accessMatrix: readonly AccessRow[]
}

export async function api(parts: ApiParts, request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
  const nowMs = Date.now()
  const stores = parts.stores(env)
  const auth = await parts.authenticate(request, env, stores, nowMs, requestId)
  if ('refused' in auth) return apiError(auth.refused, 'reason' in auth ? { reason: auth.reason } : {})
  const { principal } = auth
  // The API serves no CORS: a preflight gets 405, never a route.
  if (request.method === 'OPTIONS') return respond(SECURITY_HEADERS, 405, { headers: { Allow: 'GET, HEAD, POST, PUT, DELETE' } })
  const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
  if (upgrade || (request.method !== 'GET' && request.method !== 'HEAD')) {
    const reason = parts.checkOrigin(request, env)
    if (reason) return apiError('forbidden', { reason })
  }
  const { pathname } = new URL(request.url)
  const found = matchRoute(parts.routes, request.method, pathname)
  if (!found) return apiError('not_found')
  const row = parts.accessMatrix.find(r => r.method === found.route.method && r.pattern === found.route.pattern)
  if (!row) {
    console.error({ event: 'route_without_matrix_row', requestId, method: found.route.method, pattern: found.route.pattern })
    return apiError('unknown')
  }
  const decision = parts.checkAccess(principal, row, undefined, nowMs)
  if ('refused' in decision) return apiError('forbidden', decision.reason ? { reason: decision.reason } : {})
  // The audit duty comes from the decision (Inhouse reading brand data): no line, no data.
  if (decision.audit === 'support.access') {
    if (principal.kind !== 'inhouse') throw new Error('support.access decided for a principal that is not Inhouse')
    try {
      await stores.audit.supportAccess(principal, { method: row.method, route: row.pattern, nowMs })
    } catch (err) {
      console.error({ event: 'support_access_unlogged', requestId, error: err instanceof Error ? err.name : 'unknown' })
      return apiError('unavailable')
    }
  }
  const gate = objectGate(principal, row, nowMs)
  let response: Response
  try {
    response = await found.route.handler({ request, env, ctx, principal, params: found.params, requestId, access: { requireObject: gate.requireObject } })
  } catch (err) {
    if (err instanceof AccessRefusedError) return apiError('forbidden', err.reason ? { reason: err.reason } : {})
    throw err
  }
  // Fails closed on the outcome, not the call: any refusal is 403 whatever the handler answered (it may have caught it),
  // and a row whose rule needs the object never answers 2xx without a passing check.
  if (gate.refusal) return apiError('forbidden', gate.refusal.reason ? { reason: gate.refusal.reason } : {})
  if (decision.objectCheck === 'required' && response.status >= 200 && response.status < 300 && !gate.passed) {
    console.error({ event: 'object_check_skipped', requestId, method: row.method, pattern: row.pattern })
    return apiError('unknown')
  }
  return withSecurityHeaders(SECURITY_HEADERS, response)
}
