// The `hub` route through the egress's dispatch (`handleEgress`), on W1's fake BrandAgentRpc and real run tokens. Needs
// the orchestrator's dispatch lines in index.ts and deps.ts (H1's PR body). Ways it can fail, written down first:
//  1. a refused token (each TokenRefusal) reaches the hub, or is answered with anything but 401;
//  2. the token is checked against any route but `mcp`, so `/hub/` stays open after `mcp` closes (or the reverse);
//  3. the token header reaches the hub route's handler or the hub.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { CallerScope, HubResult, ToolInfo } from '../../hub/index/contract.ts'
import { createRunTokens, type TokenRefusal } from '../do/brand-agent/tokens.ts'
import type { EgressDeps } from './deps.ts'
import type { HubRouteDeps, ReadGatewayLike } from './hub.ts'
import { handleEgress } from './index.ts'
import { egressRequest, FakeEgressRpc, GRANT, harness, TOKEN } from './testing/harness.ts'

const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

function fakeHub() {
  const scopes: CallerScope[] = []
  const hub: ReadGatewayLike = {
    listTools: async scope => {
      scopes.push(scope)
      return { ok: true, value: [] } satisfies HubResult<ToolInfo[]>
    },
    callTool: async scope => {
      scopes.push(scope)
      return { ok: true, value: { data: null } }
    },
  }
  return { hub, scopes }
}

async function setup(rpc?: FakeEgressRpc) {
  const h = await harness(rpc ? { rpc } : {})
  const f = fakeHub()
  const hubDeps: HubRouteDeps = { hub: f.hub, now: () => 0, requestId: () => 'req-1', log: e => void h.logs.push(e as unknown as Record<string, unknown>) }
  // The orchestrator's line adds `hub` to EgressDeps; a variable (not a literal) keeps this typechecking before it lands.
  const deps: EgressDeps & { hub: HubRouteDeps } = Object.assign({}, h.deps, { hub: hubDeps })
  return { h, f, deps }
}

describe('/hub/ through the egress', () => {
  it('a live mcp grant reaches the hub as the grant run, without the token header', async () => {
    const { h, f, deps } = await setup()
    const res = await handleEgress(egressRequest('/hub/', { body: list, headers: { 'content-type': 'application/json' } }), deps)
    expect(res.status).toBe(200)
    expect(f.scopes).toEqual([{ kind: 'run', runId: GRANT.runId, principalId: GRANT.memberId, requestId: 'req-1' }])
    expect(h.rpc.callsOf('checkRunToken').map(c => c.args[1])).toEqual(['mcp'])
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN)
  })

  it.each<TokenRefusal | 'missing'>(['unknown', 'revoked', 'expired', 'closed', 'missing'])('a %s token is 401 before any hub call', async why => {
    const rpc = new FakeEgressRpc()
    rpc.checkRunToken = async (hash, route) => {
      rpc.calls.push({ method: 'checkRunToken', args: [hash, route] })
      return { refused: why === 'missing' ? 'unknown' : why }
    }
    const { h, f, deps } = await setup(rpc)
    const res = await handleEgress(egressRequest('/hub/', { body: list, headers: { 'content-type': 'application/json' }, token: why === 'missing' ? null : TOKEN }), deps)
    expect(res.status).toBe(401)
    expect(f.scopes).toEqual([])
    expect(h.logs.filter(l => l.event === 'egress_refused')).toHaveLength(1)
  })

  it('on real run tokens: closing the mcp route closes /hub/ too; closing another route does not', async () => {
    const stub = env.BRAND_AGENT.getByName(`hub-egress-${crypto.randomUUID()}`)
    await runInDurableObject(stub, async (_obj, state) => {
      const tokens = createRunTokens(state.storage.sql, () => 1_800_000_000_000)
      const { expiresAtMs: _, ...grant } = GRANT
      const token = await tokens.mint(grant, 1_800_000_000_000)
      const { f, deps } = await setup(new FakeEgressRpc(tokens, () => 1_800_000_000_000))
      const ask = () => handleEgress(egressRequest('/hub/', { body: list, headers: { 'content-type': 'application/json' }, token }), deps)
      tokens.closeRoutes(GRANT.turnId, ['files', 'events'], 'test')
      expect((await ask()).status).toBe(200)
      tokens.closeRoutes(GRANT.turnId, ['mcp'], 'test')
      expect((await ask()).status).toBe(401)
      expect(f.scopes).toHaveLength(1)
    })
  })

  it("W3's server scope is a ReadGateway caller too (the same HUB binding)", async () => {
    const f = fakeHub()
    const scope: CallerScope = { kind: 'server', job: 'morning-check', requestId: 'req-9' }
    expect(await f.hub.listTools(scope)).toEqual({ ok: true, value: [] })
  })
})
