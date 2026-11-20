// The route table (p2-design section 3). Orchestrator only: a worker's module exports its handlers and its PR body
// lists the routes; the orchestrator adds them here. Every route also has a row in access-matrix.ts.
import type { AuthStores, Principal } from './auth/index.ts'
import type { RequireObject } from './auth/matrix.ts'

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** The Worker env's D1 and R2 bindings, whatever they're named. */
type StorageBinding = { [K in keyof Env]: Env[K] extends D1Database | R2Bucket ? K : never }[keyof Env]

/**
 * The bindings a store wraps, kept out of every handler's `env` (api.ts drops them at runtime too): `DB` (D1, every
 * store) and `FILES` (R2, W2's photo and file stores). A handler reaches D1 and R2 only through its stores. A new D1
 * or R2 binding fails the type check below until it's listed here.
 */
export const STORE_BINDINGS = ['DB', 'FILES'] as const satisfies readonly StorageBinding[]
type Unlisted = Exclude<StorageBinding, (typeof STORE_BINDINGS)[number]>
const everyStorageBindingListed: [Unlisted] extends [never] ? true : Unlisted = true
void everyStorageBindingListed

/** The env a handler gets: the Worker env without the store bindings. */
export type HandlerEnv = Omit<Env, (typeof STORE_BINDINGS)[number]>

export interface HandlerContext {
  request: Request
  /** The Worker env without `DB` and `FILES` (`STORE_BINDINGS`): D1 and R2 only through `stores`. */
  env: HandlerEnv
  ctx: ExecutionContext
  principal: Principal
  /** The `:name` segments of the route's pattern. */
  params: Record<string, string>
  requestId: string
  /** The request's one clock (api.ts reads it once): a handler never calls `Date.now()`. */
  nowMs: number
  /**
   * The request's stores. Every call throws once an object check has refused (a swallowed `AccessRefused` can't
   * write). Absent on a `report` row: its handler can only log.
   *
   * The store contract (W2): a store method takes data and returns data. No method hands out a writer: no transaction
   * or batch callback, no statement or batch builder, no sub-store or handle returned from a call. The closing is
   * checked only when a method is called, so a writer handed out before a refusal would still write after it.
   */
  stores?: AuthStores
  /**
   * On a row whose rule needs the object (`personal`, an Admin on an `adminWrite` row): call `requireObject` with it
   * before acting. It throws on refusal (403); a 2xx without a passing call becomes 500.
   */
  access: { requireObject: RequireObject }
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
