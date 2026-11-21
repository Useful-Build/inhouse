// One recorded upstream per case (the hub's test build registers `MORNING_CHECK_UPSTREAMS` in hub/testing/index.ts; the
// runner points the product Worker's SHOPIFY_SHOP at a case's host). Datasets are built when this module loads, so each
// start of the hub gives fresh ages: a run is minutes long, never hours. Imports no npm package (bundled into the hub).
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

/** The upstream with the case's fault: named operations (or every request) answer a fixed error; the rest go through. */
export function withFault(inner: Upstream, fault: FaultSpec): Upstream {
  return async req => {
    if (fault.ops === 'all') return new Response('unavailable', { status: 503 })
    if (new URL(req.url).pathname.endsWith('/graphql.json')) {
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

/** Every case's upstream by host, built now. */
export function morningCheckUpstreams(nowMs: number = Date.now()): Record<string, Upstream> {
  return Object.fromEntries(CASES.map(c => [hostOf(c.id), upstreamFor(c, nowMs)]))
}

export const MORNING_CHECK_UPSTREAMS: Record<string, Upstream> = morningCheckUpstreams()
