import { exports } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CallerScope, HubResult, ToolInfo } from './contract'
import { testUpstreams } from '../testing/index'
import { FakeShop } from '../signin/testing/kit'
import { FIXTURE_ACCOUNT } from '../registry/testing/fixture-connector'

// The hub has no HTTP surface: the default export answers 404 for every method and path.
describe('the default export', () => {
  const paths = ['/', '/mcp', `/${crypto.randomUUID()}`]
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    for (const path of paths) {
      it(`${method} ${path} is 404`, async () => {
        const res = await exports.default.fetch(new Request(`https://hub.example${path}`, { method }))
        expect(res.status).toBe(404)
        expect(res.headers.get('Cache-Control')).toBe('no-store')
        expect(await res.json()).toEqual({ error: 'not_found' })
      })
    }
  }
})

const HOST = 'example-fixture.myshopify.com'
const run: CallerScope = { kind: 'run', runId: 'run-1', principalId: 'principal-1', requestId: 'req-1' }
const server: CallerScope = { kind: 'server', job: 'test', requestId: 'req-2' }
let shop: FakeShop

beforeEach(async () => {
  await reset()
  shop = new FakeShop(() => Date.now())
  testUpstreams.set(HOST, shop.upstream)
})
afterEach(() => {
  testUpstreams.delete(HOST)
})

describe('ReadGateway through the Worker exports', () => {
  it('lists the registered read tools: the fixture connector and Shopify (with code mode, P5 W2)', async () => {
    // RPC result types intersect with Disposable, which defeats narrowing: cast to the contract type.
    const r = (await exports.ReadGateway.listTools(run)) as HubResult<ToolInfo[]>
    if (!r.ok) throw new Error(`listTools failed: ${r.error.code}`)
    expect(r.value.map(t => t.name).sort()).toEqual(
      ['fixture_query', 'fixture_read', 'inventory_levels_get', 'order_get', 'orders_search', 'products_search', 'refunds_search', 'returns_search', 'shopify_script_run'],
    )
  })

  it('runs a read tool through SignIn', async () => {
    expect(await exports.ReadGateway.callTool(run, 'fixture_read', {})).toEqual({
      ok: true,
      value: { data: { data: { shop: { name: 'Example Fixture' } } } },
    })
    expect(shop.grants).toBe(1)
  })

  // A registered write-mode tool can't exist here (buildRegistry refuses it at startup); the gateway's own mode check is
  // registry.test.ts property 9.
  it('an unregistered write name is unknown_tool and a mutation document is write_refused, before any upstream call', async () => {
    expect(await exports.ReadGateway.callTool(run, 'orders_update', {})).toMatchObject({ ok: false, error: { code: 'unknown_tool' } })
    expect(await exports.ReadGateway.callTool(run, 'fixture_query', { document: 'mutation { orderCancel(orderId: "1") { job { id } } }' })).toMatchObject({
      ok: false,
      error: { code: 'write_refused' },
    })
    expect(shop.grants + shop.reads.length).toBe(0)
  })

  it('bad input is invalid_args, never a throw', async () => {
    expect(await exports.ReadGateway.callTool({ kind: 'nobody' } as never, 'fixture_read', {})).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await exports.ReadGateway.callTool(run, 'fixture_read', { extra: 1 })).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
  })
})

describe('ServerGateway', () => {
  it('reports status and re-encrypts', async () => {
    expect(await exports.ServerGateway.status(server, FIXTURE_ACCOUNT)).toMatchObject({ ok: true, value: { state: 'empty', kid: null } })
    await exports.ReadGateway.callTool(run, 'fixture_read', {})
    expect(await exports.ServerGateway.status(server, FIXTURE_ACCOUNT)).toMatchObject({ ok: true, value: { state: 'active', kid: 'ktest-2' } })
    expect(await exports.ServerGateway.reencrypt(server, FIXTURE_ACCOUNT)).toEqual({ ok: true, value: { kid: 'ktest-2', changed: false } })
    expect(await exports.ServerGateway.status(server, 'Bad Id')).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
  })
})
