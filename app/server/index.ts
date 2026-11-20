// The product Worker (P2). Static assets are served before it runs, except /api/* (`assets.run_worker_first`), so
// every request here is an API call, or an asset request the Worker passes to the assets binding. The API's request
// path, and its rules, are server/api.ts. p2-design sections 2 to 4.
import { accessMatrix } from './access-matrix.ts'
import { api } from './api.ts'
import type { ApiParts } from './api.ts'
import { authenticate, checkAccess, checkOrigin } from './auth/index.ts'
import { openStores } from './db/stores.ts'
import { apiError } from './http.ts'
import { routes } from './routes.ts'

// `stores`: W2's D1 data layer (server/db/). A handler reaches D1 and R2 only through them (routes.ts, STORE_BINDINGS).
const parts: ApiParts = { authenticate, checkOrigin, checkAccess, stores: env => openStores(env), routes, accessMatrix }

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url)
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    const requestId = crypto.randomUUID()
    try {
      return await api(parts, request, env, ctx, requestId)
    } catch (err) {
      // Logged with the request id; the answer carries no detail.
      console.error({ event: 'api_error', requestId, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
      return apiError('unknown')
    }
  },
} satisfies ExportedHandler<Env>
