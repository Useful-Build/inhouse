// The product Worker (P2). Static assets are served before it runs, except /api/* (`assets.run_worker_first`), so
// every request here is an API call, or an asset request the Worker passes to the assets binding.
// An /api/* request goes: authenticate (401 before any route lookup, so an unknown path without a JWT is 401, not 404),
// the Origin check on non-GET, the route (unknown: 404), its matrix row (none: 500, never the handler), checkAccess,
// then the handler. Every API response goes through the security headers (server/http.ts). p2-design sections 3 and 4.
import { accessMatrix } from './access-matrix.ts'
import { authenticate, checkAccess, checkOrigin } from './auth/index.ts'
import { apiError } from './http.ts'
import { matchRoute, routes } from './routes.ts'

async function api(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
  const principal = await authenticate(request, env, requestId)
  if (!principal) return apiError('unauthorized')
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const reason = checkOrigin(request, env, principal)
    if (reason) return apiError('forbidden', { reason })
  }
  const { pathname } = new URL(request.url)
  const found = matchRoute(routes, request.method, pathname)
  if (!found) return apiError('not_found')
  const row = accessMatrix.find(r => r.method === found.route.method && r.pattern === found.route.pattern)
  if (!row) {
    console.error({ event: 'route_without_matrix_row', requestId, method: found.route.method, pattern: found.route.pattern })
    return apiError('unknown')
  }
  const denied = checkAccess(row, principal, request)
  if (denied) return apiError(denied.code, denied.reason ? { reason: denied.reason } : {})
  return found.route.handler({ request, env, ctx, principal, params: found.params, requestId })
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url)
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    const requestId = crypto.randomUUID()
    try {
      return await api(request, env, ctx, requestId)
    } catch (err) {
      // Logged with the request id; the answer carries no detail.
      console.error({ event: 'api_error', requestId, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
      return apiError('unknown')
    }
  },
} satisfies ExportedHandler<Env>
