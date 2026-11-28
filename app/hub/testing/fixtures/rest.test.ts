// Path C's REST fixture (app/test/upstreams/rest/server.ts; N50, connect plan checklist 5): a key that works until the
// fixture revokes it, a harmless check request, reads and a write, and a log that never holds the key.
import { beforeEach, describe, expect, it } from 'vitest'
import type { McpFixtures } from '../../../test/upstreams/mcp/index'
import { REST_BASE, REST_KEY } from '../../../test/upstreams/rest/server'
import { fixtures } from './kit'

let fx: McpFixtures
beforeEach(() => {
  fx = fixtures()
})

const get = (path: string, key: string | null = REST_KEY) => fx.fetch(new Request(`${REST_BASE}${path}`, { headers: key === null ? {} : { Authorization: `Bearer ${key}` } }))

describe('the REST fixture', () => {
  it('the check request works with the key, is refused without it or with another, and after a revoke', async () => {
    expect(await (await get('/me')).json()).toEqual({ account: 'fixture-backoffice', plan: 'test' })
    expect((await get('/me', null)).status).toBe(401)
    expect((await get('/me', 'not-the-key')).status).toBe(401)
    fx.revokeKey('rest')
    expect((await get('/me')).status).toBe(401)
    expect((await get('/orders')).status).toBe(401)
  })

  it('reads orders, writes a note (logged with its body), and the log never holds the key', async () => {
    expect(((await (await get('/orders?query=refunded')).json()) as { orders: unknown[] }).orders).toHaveLength(1)
    expect((await get('/orders/o-1042')).status).toBe(200)
    const w = await fx.fetch(new Request(`${REST_BASE}/orders/o-1042/notes`, { method: 'POST', headers: { Authorization: `Bearer ${REST_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Called the customer' }) }))
    expect(w.status).toBe(201)
    expect(fx.rest.notes).toEqual([{ order: 'o-1042', text: 'Called the customer' }])
    expect(fx.rest.requests.at(-1)).toMatchObject({ method: 'POST', path: '/api/v1/orders/o-1042/notes', credential: true, body: { text: 'Called the customer' }, status: 201 })
    expect(JSON.stringify([fx.rest.requests, fx.log.entries])).not.toContain(REST_KEY)
  })

  it("a write's body lands on its own log entry even when another request is logged while the body is read", async () => {
    let send!: (text: string) => void
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        send = text => {
          c.enqueue(new TextEncoder().encode(text))
          c.close()
        }
      },
    })
    const init = { method: 'POST', headers: { Authorization: `Bearer ${REST_KEY}`, 'Content-Type': 'application/json' }, body, duplex: 'half' } as RequestInit
    // Straight to the REST fake (the router reads a JSON body before routing, so the race only exists here).
    const write = fx.rest.fetch(new Request(`${REST_BASE}/orders/o-1043/notes`, init))
    expect((await fx.rest.fetch(new Request(`${REST_BASE}/me`, { headers: { Authorization: `Bearer ${REST_KEY}` } }))).status).toBe(200)
    send(JSON.stringify({ text: 'late body' }))
    expect((await write).status).toBe(201)
    expect(fx.rest.requests.map(r => [r.path, r.body ?? null])).toEqual([['/api/v1/orders/o-1043/notes', { text: 'late body' }], ['/api/v1/me', null]])
  })

  it('a JSON-RPC POST anywhere gets 404 with no challenge: no MCP answer', async () => {
    const res = await fx.fetch(new Request(REST_BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }) }))
    expect(res.status).toBe(404)
    expect(res.headers.get('WWW-Authenticate')).toBeNull()
  })
})
