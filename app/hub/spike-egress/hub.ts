// M4-P0 spike (throwaway, never merged): a stand-in hub main module. It holds the keys, and gives a connector exactly
// one way out: a capability bound to one connection, generation, tool and mode, that attaches the key itself and
// reaches only the grant's hosts. Two forms of the same gate: an RpcTarget passed per call (as app/hub/codemode/ does)
// and a WorkerEntrypoint used as the Dynamic Worker's globalOutbound (Cloudflare's egress-control gateway pattern).
import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers'

export type Grant = { connectionId: string; generation: number; tool: string; mode: 'read' | 'write'; hosts: string[] }

// Stand-in for the hub's vault. Invented test-only values.
const KEYS: Record<string, string> = { 'conn-a': 'spike-key-a-7f3c', 'conn-b': 'spike-key-b-91d2' }

type Gated = { ok: true; req: Request } | { ok: false; refused: string }

function gate(grant: Grant, input: Request): Gated {
  const url = new URL(input.url)
  if (url.protocol !== 'https:') return { ok: false, refused: 'not_https' }
  if (!grant.hosts.includes(url.hostname)) return { ok: false, refused: `host_not_allowed:${url.hostname}` }
  const method = input.method.toUpperCase()
  if (grant.mode === 'read' && method !== 'GET' && method !== 'HEAD') return { ok: false, refused: `method_not_allowed:${method}` }
  const key = KEYS[grant.connectionId]
  if (!key) return { ok: false, refused: 'no_key' }
  const headers = new Headers(input.headers)
  for (const h of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(h)
  headers.set('Authorization', `Bearer ${key}`)
  return { ok: true, req: new Request(url, { method, headers, body: input.body, redirect: 'manual' }) }
}

/** Form A: the per-call capability. Private fields, one method; RPC exposes nothing else. */
export class Outbound extends RpcTarget {
  readonly #grant: Grant
  constructor(grant: Grant) {
    super()
    this.#grant = grant
  }
  async fetch(url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<{ status: number; body: string }> {
    const g = gate(this.#grant, new Request(url, { method: init?.method ?? 'GET', body: init?.body, headers: init?.headers }))
    if (!g.ok) return { status: 403, body: g.refused }
    const res = await fetch(g.req)
    return { status: res.status, body: await res.text() }
  }
}

/** Form B: the gateway, passed as the Dynamic Worker's globalOutbound with the grant as props (only the hub sets them). */
export class EgressGate extends WorkerEntrypoint<Record<string, never>, Grant> {
  async fetch(req: Request): Promise<Response> {
    const g = gate(this.ctx.props, req)
    if (!g.ok) return new Response(g.refused, { status: 403 })
    return fetch(g.req)
  }
}

export default {
  fetch(): Response {
    return new Response(null, { status: 404 })
  },
}
