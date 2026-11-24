// The routes outside sign-in (P8a F2): server/index.ts asks here before api.ts. A POST to a `webhookRoutes` path is
// answered by its handler, which authenticates the request itself (Shopify's HMAC); anything else, any other method on
// the same path included, returns null and takes the signed-in path (401 without a JWT). A webhook route needs its
// `webhook` row in the access matrix, or it answers 500 and never runs, as api.ts does for a route without a row.
import type { AccessRow } from '../access-matrix.ts'
import { apiError } from '../http.ts'
import type { WebhookRoute } from '../routes.ts'
import { safeError } from '../safe-error.ts'
import type { WebhookContext } from './shopify-privacy/handler.ts'

export async function serveWebhook(
  table: readonly WebhookRoute[], rows: readonly AccessRow[], request: Request, env: WebhookContext['env'], requestId: string,
): Promise<Response | null> {
  if (request.method !== 'POST') return null
  const { pathname } = new URL(request.url)
  const route = table.find(r => r.pattern === pathname)
  if (!route) return null
  if (!rows.some(r => r.method === route.method && r.pattern === route.pattern && r.class === 'webhook')) {
    console.error({ event: 'route_without_matrix_row', requestId, method: route.method, pattern: route.pattern })
    return apiError('unknown')
  }
  try {
    return await route.handler({ request, env, requestId, nowMs: Date.now() })
  } catch (err) {
    console.error({ event: 'api_error', requestId, error: safeError(err) })
    return apiError('unknown')
  }
}
