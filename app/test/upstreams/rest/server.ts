// The REST fixture for Path C (Stage 1 M4-F, N50, N52): a small back-office API with no MCP address, on
// `rest.mcp-fixtures.example.com`. M4-P2's worked connector example calls it; detect calls its base address and finds
// no MCP answer (`not_mcp`). Bundled into the hub's TEST build only (through app/hub/testing/index.ts): relative
// imports and runtime globals, no npm package. Every value here is invented.
//
// - Auth: `Authorization: Bearer <REST_KEY>`. A test revokes the key (`revokeKey()`); every later request is 401, so
//   "a key the fixture revokes turns the tool to Needs a new key" can be shown (connect plan checklist 5).
// - `GET /api/v1/me` is the harmless authenticated request a connector's `check()` makes (N50).
// - Reads: `GET /api/v1/orders?query=`, `GET /api/v1/orders/:id`. Write: `POST /api/v1/orders/:id/notes`.
// - Every request is logged (method, path, query, whether a credential came, and a write's body), never the key.
// - A JSON-RPC POST to any address here gets 404 with a plain JSON error: no MCP answer.

import { HOSTS, json } from '../mcp/wire'

/** TEST-ONLY invented key. */
export const REST_KEY = 'test-only-rest-key-5c9d'
export const REST_HOST = HOSTS.rest
export const REST_BASE = `https://${REST_HOST}/api/v1`

export const ORDERS = [
  { id: 'o-1042', customer: 'ada@fixture.invalid', status: 'shipped', total: '38.00' },
  { id: 'o-1043', customer: 'ben@fixture.invalid', status: 'refunded', total: '24.00' },
  { id: 'o-1044', customer: 'cy@fixture.invalid', status: 'open', total: '112.50' },
] as const

export type RestLogEntry = { method: string; path: string; query: string; credential: boolean; body?: unknown; status: number }

export class FakeRestApi {
  readonly host = REST_HOST
  requests: RestLogEntry[] = []
  notes: { order: string; text: string }[] = []
  revoked = false

  reset(): void {
    this.requests = []
    this.notes = []
    this.revoked = false
  }

  revokeKey(): void {
    this.revoked = true
  }

  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const auth = req.headers.get('Authorization')
    const entry: RestLogEntry = { method: req.method, path: url.pathname, query: url.search, credential: auth !== null, status: 0 }
    this.requests.push(entry)
    const res = await this.#route(req, url, auth)
    entry.status = res.status
    return res
  }

  async #route(req: Request, url: URL, auth: string | null): Promise<Response> {
    const path = url.pathname.startsWith('/api/v1/') ? url.pathname.slice('/api/v1'.length) : null
    // An address with no route (the base address detect probes, say) is 404 before any auth: no MCP answer, no challenge.
    if (path === null || !/^\/(me|orders(\/[a-z0-9-]+(\/notes)?)?)$/.test(path)) return json({ message: 'Not Found' }, 404)
    if (auth !== `Bearer ${REST_KEY}` || this.revoked) return json({ message: 'Unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer realm="fixture-rest"' })
    if (req.method === 'GET' && path === '/me') return json({ account: 'fixture-backoffice', plan: 'test' })
    if (req.method === 'GET' && path === '/orders') {
      const q = (url.searchParams.get('query') ?? '').toLowerCase()
      return json({ orders: ORDERS.filter(o => o.id.includes(q) || o.customer.includes(q) || o.status.includes(q)) })
    }
    let m = /^\/orders\/([a-z0-9-]+)$/.exec(path)
    if (req.method === 'GET' && m) {
      const o = ORDERS.find(x => x.id === m![1])
      return o ? json(o) : json({ message: 'Not Found' }, 404)
    }
    m = /^\/orders\/([a-z0-9-]+)\/notes$/.exec(path)
    if (req.method === 'POST' && m) {
      if (!ORDERS.some(x => x.id === m![1])) return json({ message: 'Not Found' }, 404)
      const body = (await req.json().catch(() => null)) as { text?: unknown } | null
      if (typeof body?.text !== 'string' || body.text.length === 0) return json({ message: 'text is required' }, 422)
      this.requests[this.requests.length - 1]!.body = { text: body.text }
      this.notes.push({ order: m[1]!, text: body.text })
      return json({ order: m[1], noted: true }, 201)
    }
    return json({ message: 'Not Found' }, 404)
  }
}
