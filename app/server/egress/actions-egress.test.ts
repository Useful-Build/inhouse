// The `actions` route through the egress's dispatch (`handleEgress`, Stage 1 M2-D), on W1's fake BrandAgentRpc. Ways it
// can fail, written down first:
//  1. `/actions/` is reachable when the egress has no actions deps, or with a refused token (each refusal answered 401
//     and logged as the `actions` path, before any BrandAgent call or D1 read);
//  2. the token is checked against any route but `mcp`, so `/actions/` stays open after `mcp` closes;
//  3. the answer skips the leak check's capture (it runs on every `/hub/`, `/mcp/` and `/actions/` answer);
//  4. the egress's sources name the hub's connect or delivery binding (the P5 boundary; the accounts come from BrandAgent).
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { TokenRefusal } from '../do/brand-agent/tokens.ts'
import type { ActionsRouteDeps } from './actions.ts'
import type { EgressDeps } from './deps.ts'
import { handleEgress } from './index.ts'
import { egressRequest, FakeEgressRpc, harness, NO_CAPTURE, TOKEN } from './testing/harness.ts'

const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
const json = { 'content-type': 'application/json' }

async function setup(rpc?: FakeEgressRpc) {
  const h = await harness(rpc ? { rpc } : {})
  const actions: ActionsRouteDeps = { db: env.DB, rpc: h.rpc, now: () => 0, sleep: async () => {}, requestId: () => 'req-1', log: e => void h.logs.push(e) }
  const deps: EgressDeps = { ...h.deps, actions }
  return { h, deps }
}

describe('/actions/ through the egress', () => {
  it('a live mcp grant reaches the route; the token is checked against `mcp`; the answer is captured', async () => {
    const { h, deps } = await setup()
    const captured: unknown[] = []
    const res = await handleEgress(egressRequest('/actions/', { body: list, headers: json }), deps, { captureTaint: async (_b, source) => { captured.push(source) } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { tools: expect.any(Array) } })
    expect(h.rpc.callsOf('checkRunToken').map(c => c.args[1])).toEqual(['mcp'])
    expect(captured).toEqual([{ route: 'mcp' }])
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN)
  })

  it.each<TokenRefusal>(['unknown', 'revoked', 'expired', 'closed'])('a %s token is 401 before anything else, logged as the actions path', async why => {
    const rpc = new FakeEgressRpc()
    rpc.checkRunToken = async (hash, route) => {
      rpc.calls.push({ method: 'checkRunToken', args: [hash, route] })
      return { refused: why }
    }
    const { h, deps } = await setup(rpc)
    const res = await handleEgress(egressRequest('/actions/', { body: list, headers: json }), deps, NO_CAPTURE)
    expect(res.status).toBe(401)
    expect(rpc.calls.map(c => c.method)).toEqual(['checkRunToken'])
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'egress_refused', route: 'mcp', path: 'actions', why }))
  })

  it('no actions deps: 404, nothing checked', async () => {
    const h = await harness()
    const res = await handleEgress(egressRequest('/actions/', { body: list, headers: json }), h.deps, NO_CAPTURE)
    expect(res.status).toBe(404)
    expect(h.rpc.calls).toEqual([])
  })

  it('the egress\'s sources never name the connect or delivery binding (P5): the accounts come from BrandAgent', async () => {
    const sources = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const names = Object.keys(sources).filter(f => !f.endsWith('.test.ts'))
    expect(names).toContain('./actions.ts')
    for (const f of names) expect(sources[f], f).not.toMatch(/HUB_DELIVERY|HUB_CONNECT|DeliveryGateway|ConnectGateway/)
  })
})
