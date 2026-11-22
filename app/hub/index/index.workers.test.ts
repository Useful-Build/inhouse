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

// The test shop override (contract.ts CallToolOptions, test-shop.ts). This project runs the hub's TEST build
// (`__INHOUSE_HUB_TEST__` true, INHOUSE_TEST_BUILD=1); the deployable build's refusal is test-shop.test.ts (node project).
// Ways it can go wrong: the override reaches the configured shop anyway (a quiet fallback), an unregistered host is read,
// a refusal still reaches an upstream, or the override's token and the account's mix.
describe('ReadGateway: the test shop override (test build)', () => {
  const OTHER = 'example-mc-override-check.myshopify.com'
  let other: FakeShop
  beforeEach(() => {
    other = new FakeShop(() => Date.now())
    testUpstreams.set(OTHER, other.upstream)
  })
  afterEach(() => {
    testUpstreams.delete(OTHER)
  })

  it('a registered host is read instead of SHOPIFY_SHOP, and only for that call', async () => {
    expect(await exports.ReadGateway.callTool(run, 'fixture_read', {}, { testShopHost: OTHER })).toMatchObject({ ok: true })
    expect([...other.hosts]).toEqual([OTHER])
    expect(other.grants).toBe(1)
    expect(shop.grants + shop.reads.length).toBe(0)
    // The next call without options reads the configured shop, with its own grant: nothing carried over.
    expect(await exports.ReadGateway.callTool(run, 'fixture_read', {})).toMatchObject({ ok: true })
    expect(shop.grants).toBe(1)
    expect([...shop.hosts]).toEqual([HOST])
    // The override's object keeps its own token: a second call grants nothing new.
    expect(await exports.ReadGateway.callTool(run, 'fixture_read', {}, { testShopHost: OTHER })).toMatchObject({ ok: true })
    expect(other.grants).toBe(1)
  })

  it('an unregistered or malformed host is invalid_args, and no upstream is reached', async () => {
    for (const options of [{ testShopHost: 'example-mc-not-registered.myshopify.com' }, { testShopHost: 'evil.example' }, { testShopHost: OTHER, shop: 'x' }, 'x']) {
      expect(await exports.ReadGateway.callTool(run, 'fixture_read', {}, options as never), JSON.stringify(options)).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    }
    expect(shop.grants + shop.reads.length + other.grants + other.reads.length).toBe(0)
  })

  it('empty options read SHOPIFY_SHOP', async () => {
    expect(await exports.ReadGateway.callTool(run, 'fixture_read', {}, {})).toMatchObject({ ok: true })
    expect(shop.grants).toBe(1)
    expect(other.grants).toBe(0)
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
