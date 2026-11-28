// M4-F's lines in the test-fakes hook (../fakes.ts), through ConnectGateway.testFakes on workerd with the test config:
// `state` carries the fixtures' log, `set` revokes a fixture key, `reset` undoes both. Ways it can fail: the hook reads
// another fixtures instance than the seam serves; a revoke outlives `reset`; an unknown key name is applied.
import { exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CallerScope, ConnectGateway } from '../../index/contract'
import { modernRequest } from '../../../test/upstreams/mcp/modern'
import { REST_BASE, REST_KEY } from '../../../test/upstreams/rest/server'
import { testUpstreamFetch } from '../index'

const server: CallerScope = { kind: 'server', job: 'test-fakes', requestId: 'req-m4f' }
const gw = exports as unknown as { ConnectGateway: Required<ConnectGateway> }
const call = (op: unknown) => gw.ConnectGateway.testFakes(server, op)
const value = async <T = Record<string, unknown>>(op: unknown): Promise<T> => {
  const r = await call(op)
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value as T
}
const me = () => testUpstreamFetch(new Request(`${REST_BASE}/me`, { headers: { Authorization: `Bearer ${REST_KEY}` } }))

beforeEach(async () => {
  await value({ op: 'reset' })
})

describe('the fixtures in the test-fakes hook', () => {
  it("state holds the fixtures' request log for a request through the seam", async () => {
    expect((await testUpstreamFetch(modernRequest('https://modern.mcp-fixtures.example.com/open/mcp', 1, 'server/discover'))).status).toBe(200)
    const s = await value<{ fixtures: { log: { host: string; rpc?: string; credential: string }[] } }>({ op: 'state' })
    expect(s.fixtures.log).toEqual([expect.objectContaining({ host: 'modern.mcp-fixtures.example.com', rpc: 'server/discover', credential: 'none', status: 200 })])
  })

  it('set revokes a fixture key; reset restores it and clears the log', async () => {
    expect((await me()).status).toBe(200)
    await value({ op: 'set', fixtures: { revokeKey: 'rest' } })
    expect((await me()).status).toBe(401)
    await value({ op: 'reset' })
    expect((await value<{ fixtures: { log: unknown[] } }>({ op: 'state' })).fixtures.log).toEqual([])
    expect((await me()).status).toBe(200)
  })

  it('toolsVersion switches one connection by address; state lists it; reset switches it back (#624)', async () => {
    const list = async (url: string) => {
      const res = await testUpstreamFetch(modernRequest(url, 1, 'tools/list'))
      return ((await res.json()) as { result: { tools: { name: string; description: string }[] } }).result.tools
    }
    const url = 'https://modern.mcp-fixtures.example.com/changing/mcp?c=hook'
    const before = await list(url)
    await value({ op: 'set', fixtures: { toolsVersion: { address: url, version: 2 } } })
    expect((await value<{ fixtures: { switched: string[] } }>({ op: 'state' })).fixtures.switched).toEqual(['modern.mcp-fixtures.example.com/changing/mcp?c=hook'])
    expect(await list(url)).not.toEqual(before)
    // Control: the same endpoint under another connection is untouched.
    expect(await list('https://modern.mcp-fixtures.example.com/changing/mcp?c=other')).toEqual(before)
    await value({ op: 'reset' })
    expect(await list(url)).toEqual(before)
  })

  it('revokeLogins ends every fixture login; clockMs moves the fixtures clock; reset restores both', async () => {
    await value({ op: 'set', fixtures: { clockMs: 1_000 } })
    expect((await value<{ fixtures: { clockMs: number } }>({ op: 'state' })).fixtures.clockMs).toBe(1_000)
    await value({ op: 'set', fixtures: { revokeLogins: true } })
    await value({ op: 'reset' })
    expect((await value<{ fixtures: { clockMs: number } }>({ op: 'state' })).fixtures.clockMs).toBe(Date.UTC(2026, 10, 28, 9, 0, 0))
  })

  it('an unknown key name or field, or an address with no second state, is invalid_args, and nothing is applied', async () => {
    for (const bad of [
      { op: 'set', fixtures: { revokeKey: 'slack' } },
      { op: 'set', fixtures: { revokeAll: true } },
      { op: 'set', fixtures: { revokeKey: 'rest', toolsVersion: { address: 'https://modern.mcp-fixtures.example.com/open/mcp', version: 2 } } },
      { op: 'set', fixtures: { toolsVersion: { address: 'not a url', version: 2 } } },
      { op: 'set', fixtures: { toolsVersion: { address: 'https://modern.mcp-fixtures.example.com/changing/mcp', version: 3 } } },
    ]) {
      expect(await call(bad), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    }
    expect((await me()).status).toBe(200)
  })
})
