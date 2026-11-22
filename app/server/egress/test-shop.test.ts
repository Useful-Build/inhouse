// The test shop override, product side (test-shop.ts, and its off stand-in). Ways it can go wrong, written first:
//  1. a build that isn't switched on (INHOUSE_TEST_BUILD unset or not "1") reads the row or sends the option;
//  2. a set override doesn't reach the hub, or reaches it on a call after it was cleared (it must be read per call);
//  3. a row that isn't a shop host is sent anyway, or quietly dropped (the call then reads SHOPIFY_SHOP): it must throw;
//  4. the off module (every build but test and eval) sends an option or reads anything;
//  5. a person's or the brand's setting with the same key is taken for the override.
// The deployable Worker not carrying the module, the canary or the option's name is check-product-build.mjs part 7.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CallToolOptions, CallerScope, HubResult } from '../../hub/index/contract.ts'
import { reset } from '../db/test-support.ts'
import type { ReadGatewayLike } from './hub.ts'
import { TEST_SHOP_KEY, TEST_SHOP_OWNER, SHOP_HOST, readTestShop, withTestShop } from './test-shop.ts'
import * as real from './test-shop.ts'
import * as off from './test-shop-off.ts'
import { SHOP_HOST as HUB_SHOP_HOST } from '../../hub/index/schemas.ts'
import { handleHub, hubRouteDeps } from './hub.ts'
import { GRANT } from './testing/harness.ts'

const HOST = 'example-mc-late-orders.myshopify.com'
const scope: CallerScope = { kind: 'run', runId: 'r', principalId: 'p', requestId: 'q' }

function recordingHub() {
  const calls: { name: string; options: CallToolOptions | undefined; arity: number }[] = []
  const hub: ReadGatewayLike = {
    listTools: async () => ({ ok: true, value: [] }),
    callTool: async (...a: [CallerScope, string, unknown, CallToolOptions?]) => {
      calls.push({ name: a[1], options: a[3], arity: a.length })
      return { ok: true, value: { data: null } } satisfies HubResult<{ data: unknown }>
    },
  }
  return { hub, calls }
}

const setRow = (owner: string, valueJson: string) =>
  env.DB.prepare('INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES (?, ?, ?, 1, 0, ?, ?)')
    .bind(owner, TEST_SHOP_KEY, valueJson, 'eval', 'eval').run()
const clearRow = () => env.DB.prepare('DELETE FROM settings WHERE owner = ? AND key = ?').bind(TEST_SHOP_OWNER, TEST_SHOP_KEY).run()

beforeEach(async () => {
  await reset(env.DB)
})

describe('withTestShop (test and eval builds)', () => {
  it('switched on, a set override rides on each call, read fresh per call (failure 2)', async () => {
    const { hub, calls } = recordingHub()
    const wrapped = withTestShop(hub, env.DB, { INHOUSE_TEST_BUILD: '1' })
    await wrapped.callTool(scope, 'orders_search', {})
    await setRow(TEST_SHOP_OWNER, JSON.stringify(HOST))
    await wrapped.callTool(scope, 'orders_search', {})
    await clearRow()
    await wrapped.callTool(scope, 'orders_search', {})
    expect(calls.map(c => c.options)).toEqual([undefined, { testShopHost: HOST }, undefined])
    // No options argument at all when none is set: the hub sees exactly the old three-argument call.
    expect(calls.map(c => c.arity)).toEqual([3, 4, 3])
  })

  it.each([[undefined], ['0'], ['true'], ['']])('INHOUSE_TEST_BUILD=%s: the hub as it is, nothing read (failure 1)', async flag => {
    const { hub } = recordingHub()
    expect(withTestShop(hub, env.DB, { INHOUSE_TEST_BUILD: flag })).toBe(hub)
  })

  it.each([['"evil.example"'], ['"example-mc-late-orders"'], ['42'], ['not json'], [JSON.stringify(`${HOST}/x`)]])('a row of %s throws and reaches no hub (failure 3)', async valueJson => {
    const { hub, calls } = recordingHub()
    await setRow(TEST_SHOP_OWNER, valueJson)
    await expect(withTestShop(hub, env.DB, { INHOUSE_TEST_BUILD: '1' }).callTool(scope, 'orders_search', {})).rejects.toThrow(/test shop/)
    expect(calls).toEqual([])
  })

  it('the brand\'s or a person\'s setting under the same key is not the override (failure 5)', async () => {
    await setRow('brand', JSON.stringify(HOST))
    await setRow('mbr_someone', JSON.stringify(HOST))
    expect(await readTestShop(env.DB)).toBeNull()
  })

  it('listTools never carries it', async () => {
    const { hub, calls } = recordingHub()
    await setRow(TEST_SHOP_OWNER, JSON.stringify(HOST))
    await withTestShop(hub, env.DB, { INHOUSE_TEST_BUILD: '1' }).listTools(scope)
    expect(calls).toEqual([])
  })
})

describe('the off stand-in (every other build)', () => {
  it('has every export of the real module, and its shop host pattern matches nothing', () => {
    expect(Object.keys(off).sort()).toEqual(Object.keys(real).sort())
    expect(off.SHOP_HOST.test('example-mc-late-orders.myshopify.com')).toBe(false)
  })

  it('returns the hub as it is, names nothing and reads nothing (failure 4)', async () => {
    const { hub } = recordingHub()
    await setRow(TEST_SHOP_OWNER, JSON.stringify(HOST))
    expect(off.withTestShop(hub, env.DB, { INHOUSE_TEST_BUILD: '1' })).toBe(hub)
    expect([off.TEST_SHOP_CANARY, off.TEST_SHOP_OWNER, off.TEST_SHOP_KEY]).toEqual(['', '', ''])
    expect(() => off.readTestShop(env.DB)).toThrow(/not in this build/)
  })
})

// A9: the runner's own route to the hub (H1's `/hub/`, hub.ts) also reaches ReadGateway.callTool. Ways it could leak the
// option: a caller-supplied `options`, `testShopHost` or `_meta` in the JSON-RPC params forwarded as the fourth argument;
// a row set but the caller's host sent instead. Only test-shop.ts may set it, and only from the row.
describe('the runner\'s egress route never forwards a caller\'s override', () => {
  const tamper = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orders_search', arguments: {}, options: { testShopHost: 'evil-store.myshopify.com' }, testShopHost: 'evil-store.myshopify.com', _meta: { testShopHost: 'evil-store.myshopify.com' } } }
  const post = (hub: ReadGatewayLike) =>
    handleHub(new Request('http://egress.internal/hub/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tamper) }), GRANT, hubRouteDeps(hub, () => {}))

  it.each([['the off stand-in', false], ['test-shop.ts with no row', true]])('%s: the hub gets three arguments, no options', async (_label, real) => {
    const { hub, calls } = recordingHub()
    const wrapped = real ? withTestShop(hub, env.DB, { INHOUSE_TEST_BUILD: '1' }) : off.withTestShop(hub, env.DB, { INHOUSE_TEST_BUILD: '1' })
    expect((await post(wrapped)).status).toBe(200)
    expect(calls).toEqual([{ name: 'orders_search', options: undefined, arity: 3 }])
  })

  it('with a row set, the option is the row\'s host, never the caller\'s', async () => {
    const { hub, calls } = recordingHub()
    await setRow(TEST_SHOP_OWNER, JSON.stringify(HOST))
    await post(withTestShop(hub, env.DB, { INHOUSE_TEST_BUILD: '1' }))
    expect(calls).toEqual([{ name: 'orders_search', options: { testShopHost: HOST }, arity: 4 }])
  })
})

describe('the shop host pattern', () => {
  it('is the hub schema\'s (hub/index/schemas.ts SHOP_HOST), so the product never sends a host the hub refuses as malformed', () => {
    expect(SHOP_HOST.source).toBe(HUB_SHOP_HOST.source)
    expect(SHOP_HOST.flags).toBe(HUB_SHOP_HOST.flags)
  })
})
