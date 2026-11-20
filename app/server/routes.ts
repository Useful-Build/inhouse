// The route table (p2-design section 3). Orchestrator only: a worker's module exports its handlers and its PR body
// lists the routes; the orchestrator adds them here. Every route also has a row in access-matrix.ts.
import { accessMatrix, canRows } from './access-matrix.ts'
import type { AuthStores, Principal } from './auth/index.ts'
import type { RequireObject } from './auth/matrix.ts'
import { meHandler } from './auth/me-handler.ts'
import { changeMemberRole, inviteMember, listMembers, removeMember } from './api/members.ts'
import { getBrandSettings, getPersonalSettings, getTechnicalSettings, putBrandSetting, putPersonalSetting, putTechnicalSetting } from './api/settings.ts'
import { SECURITY_HEADERS, apiError } from './http.ts'
import { clientError } from '../worker/client-error.ts'

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

/** Every route whose handler hasn't landed yet: 503 `unavailable`. W2 and W3 replace them one by one. */
const notYet: Handler = async () => apiError('unavailable')

/**
 * Hardening's reporter (worker/client-error.ts, shared with the demo Worker and left as is) with section 4's error
 * bodies: its bare 400, 403, 413 and 429 become `invalid`, `forbidden`, `invalid` with reason `too_large` and
 * `rate_limited` (keeping `Retry-After`); any other status passes through.
 */
export async function reportClientError(request: Request): Promise<Response> {
  const res = await clientError(request, SECURITY_HEADERS)
  switch (res.status) {
    case 400: return apiError('invalid')
    case 403: return apiError('forbidden')
    case 413: return apiError('invalid', { reason: 'too_large' })
    case 429: {
      const retry = res.headers.get('Retry-After')
      return apiError('rate_limited', retry === null ? {} : { headers: { 'Retry-After': retry } })
    }
    default: return res
  }
}

/** One route per access-matrix row, in the table's order (the row numbers of p2-design section 3). */
export const routes: readonly Route[] = [
  /* 1 */ { method: 'GET', pattern: '/api/health', handler: notYet },
  /* 2 */ { method: 'GET', pattern: '/api/me', handler: meHandler({ rows: accessMatrix, canRows }) },
  /* 3 */ { method: 'GET', pattern: '/api/members', handler: listMembers },
  /* 4 */ { method: 'POST', pattern: '/api/members/invites', handler: inviteMember },
  /* 5 */ { method: 'PUT', pattern: '/api/members/:id/role', handler: changeMemberRole },
  /* 6 */ { method: 'DELETE', pattern: '/api/members/:id', handler: removeMember },
  /* 7 */ { method: 'GET', pattern: '/api/settings/personal', handler: getPersonalSettings },
  /* 8 */ { method: 'PUT', pattern: '/api/settings/personal/:key', handler: putPersonalSetting },
  /* 9 */ { method: 'GET', pattern: '/api/settings/brand', handler: getBrandSettings },
  /* 10 */ { method: 'PUT', pattern: '/api/settings/brand/:key', handler: putBrandSetting },
  /* 11 */ { method: 'GET', pattern: '/api/settings/technical', handler: getTechnicalSettings },
  /* 12 */ { method: 'PUT', pattern: '/api/settings/technical/:key', handler: putTechnicalSetting },
  /* 13 */ { method: 'PUT', pattern: '/api/photo', handler: notYet },
  /* 14 */ { method: 'DELETE', pattern: '/api/photo', handler: notYet },
  /* 15 */ { method: 'GET', pattern: '/api/members/:id/photo', handler: notYet },
  /* 16 */ { method: 'GET', pattern: '/api/grants', handler: notYet },
  /* 17 */ { method: 'POST', pattern: '/api/grants', handler: notYet },
  /* 18 */ { method: 'POST', pattern: '/api/grants/:id/end', handler: notYet },
  /* 19 */ { method: 'GET', pattern: '/api/audit', handler: notYet },
  /* 20 */ { method: 'GET', pattern: '/api/audit/export.csv', handler: notYet },
  // A report row, so no stores.
  /* 21 */ { method: 'POST', pattern: '/api/client-error', handler: async ({ request }) => reportClientError(request) },
]

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
