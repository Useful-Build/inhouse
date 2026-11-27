// One recorded upstream per case (the hub's test build registers `MORNING_CHECK_UPSTREAMS` in hub/testing/index.ts; the
// runner points the product Worker's SHOPIFY_SHOP at a case's host). A dataset is built on its case's first request, so each
// start of the hub gives fresh ages (a run is minutes long, never hours). Imports no npm package (bundled into the hub).
import { createShopifyUpstream } from '../shopify/server'
import { CASES } from './cases'
import type { MorningCase } from './cases'
import { hostOf } from '../../../evals/morning-check/expected'
import type { FaultSpec } from '../../../evals/morning-check/expected'

export type Upstream = (req: Request) => Promise<Response>

export { hostOf }

const MAX_BODY_BYTES = 4 * 1024 * 1024

/** The GraphQL operation name of a request body, or null. */
const operationOf = (body: string): string | null => {
  try {
    const q = (JSON.parse(body) as { query?: unknown }).query
    return typeof q === 'string' ? (/^\s*query\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(q)?.[1] ?? null) : null
  } catch {
    return null
  }
}

/**
 * The upstream with the case's fault: named operations (or every read) answer a fixed error; the rest go through. `ops: 'all'`
 * fails every GraphQL read but never the token endpoint: a connected store that's down. The hub's grant still works, so the
 * brand's Tools page (route 70) lists Shopify connected and the turn's prompt names it, as for a real outage of a store
 * that was connected before; failing the token endpoint too would read as no store connected, and the graded run's store
 * check would stop before the case (evals/shopify-served.ts).
 */
export function withFault(inner: Upstream, fault: FaultSpec): Upstream {
  return async req => {
    if (new URL(req.url).pathname.endsWith('/graphql.json')) {
      if (fault.ops === 'all') return new Response('unavailable', { status: 503 })
      const body = await req.text()
      const op = operationOf(body)
      if (op !== null && fault.ops.includes(op)) {
        if (fault.kind === 'credentials_rejected') return new Response(JSON.stringify({ errors: '[API] Invalid API key or access token' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
        return new Response(`{"data":"${'x'.repeat(MAX_BODY_BYTES)}"}`, { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return inner(new Request(req.url, { method: req.method, headers: req.headers, body }))
    }
    return inner(req)
  }
}

export function upstreamFor(c: MorningCase, nowMs: number): Upstream {
  const plain = createShopifyUpstream(c.build(nowMs))
  return c.fault ? withFault(plain, c.fault) : plain
}

/**
 * The case's upstream, built on its first request with the clock's time, then kept: a dataset's ages are relative to the
 * moment it is built, and a module is evaluated before the hub has a real clock (workerd's `Date.now()` is 0 until a request
 * is being handled), so building at load would give every order an age of decades.
 */
export function lazyUpstream(c: MorningCase, clock: () => number): Upstream {
  let built: Upstream | undefined
  return req => (built ??= upstreamFor(c, clock()))(req)
}

/** Every case's upstream by host; each builds its dataset on its first request. */
export const morningCheckUpstreams = (clock: () => number = Date.now): Record<string, Upstream> =>
  Object.fromEntries(CASES.map(c => [hostOf(c.id), lazyUpstream(c, clock)]))

export const MORNING_CHECK_UPSTREAMS: Record<string, Upstream> = morningCheckUpstreams()
