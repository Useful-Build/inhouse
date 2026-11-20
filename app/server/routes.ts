// The route table (p2-design section 3). Orchestrator only: a worker's module exports its handlers and its PR body
// lists the routes; the orchestrator adds them here. Every route also has a row in access-matrix.ts.
import type { Principal } from './auth/index.ts'

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface HandlerContext {
  request: Request
  env: Env
  ctx: ExecutionContext
  principal: Principal
  /** The `:name` segments of the route's pattern. */
  params: Record<string, string>
  requestId: string
}

export type Handler = (c: HandlerContext) => Promise<Response>

/** `pattern` is a path such as `/api/members/:id/role`; a `:name` segment matches one non-empty path segment. */
export interface Route { readonly method: Method; readonly pattern: string; readonly handler: Handler }

export const routes: readonly Route[] = []

/** The route for this method and path, with its params, or null (404 `not_found`). */
export function matchRoute(table: readonly Route[], method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split('/')
  for (const route of table) {
    if (route.method !== method) continue
    const want = route.pattern.split('/')
    if (want.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < want.length && ok; i++) {
      if (want[i].startsWith(':')) {
        if (parts[i] === '') ok = false
        else {
          try { params[want[i].slice(1)] = decodeURIComponent(parts[i]) } catch { ok = false }
        }
      } else if (want[i] !== parts[i]) ok = false
    }
    if (ok) return { route, params }
  }
  return null
}
