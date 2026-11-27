// Stage 1 M3-S1 (N21, N22) Node tests for the Shopify write set, part 1, through `runWriteAction` and the shared write
// core against the fake write upstream. Ways it can go wrong, written first:
// - an argument outside the strict shape reaches Shopify (a sixth order, a duplicate, a customer on a draft);
// - an operation's fault maps to the wrong answer: a refusal that says `unknown`, an unclear one that says `no`, a
//   throttle that isn't `rate_limited` with `sent: 'no'` or names no wait;
// - a multi-order call that went out in part says `ok` or `sent: 'no'`, or doesn't name which orders went out;
// - one hub call makes more than one upstream write request (or a retry);
// - a stale account generation, another store or a missing scope still sends;
// - a draft sends a field Shopify's input would act on beyond lines, note and tags.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountStatus, HubResult, WriteOperationKey, WriteRequest } from '../index/contract'
import { WriteResultSchema } from '../index/schemas'
import { ok } from '../index/errors'
import { parseKeyRing } from '../crypto/keyring'
import { MemStore, ringJson, START_MS } from '../signin/testing/kit'
import { ShopifyWriteCore } from '../connectors/shopify/write/core'
import { SHOPIFY_WRITE_ACCOUNT, throttleWaitMs } from '../connectors/shopify/write/provider'
import { SHOPIFY_WRITE_OPS } from '../connectors/shopify/write/ops/index'
import { ORDERS_PER_CALL_MAX } from '../connectors/shopify/write/ops/tags'
import {
  createShopifyWriteUpstream,
  FAKE_THROTTLE,
  SHOPIFY_WRITE_SHOP,
  SHOPIFY_WRITE_TEST_CLIENT_ID,
  SHOPIFY_WRITE_TEST_CLIENT_SECRET
} from '../../test/upstreams/shopify/write/server'
import { runWriteAction, type WriteGatewayDeps } from './gateway'

const CONNECTED_AT_MS = START_MS
const ORDER = (n: number) => `gid://shopify/Order/${n}`
const VARIANT = (n: number) => `gid://shopify/ProductVariant/${n}`

const status = (overrides: Partial<AccountStatus> = {}): AccountStatus => ({
  accountId: SHOPIFY_WRITE_ACCOUNT,
  state: 'active',
  kid: 'k1',
  expiresAt: { iso: new Date(START_MS + 3600_000).toISOString(), ms: START_MS + 3600_000 },
  scopes: ['read_orders'],
  lastError: null,
  paused: false,
  kind: 'client_credentials',
  connectedBy: null,
  connectedAt: { iso: new Date(CONNECTED_AT_MS).toISOString(), ms: CONNECTED_AT_MS },
  revokeFailedAt: null,
  needsReconnect: false,
  ...overrides,
})

type ShopifyKey = Extract<WriteOperationKey, `shopify.${string}`>

/** A valid call of each operation, on orders and variants the fake knows. */
const ARGS: Record<ShopifyKey, unknown> = {
  'shopify.order.tag_add': { orderIds: [ORDER(9001)], tags: ['priority'] },
  'shopify.order.tag_remove': { orderIds: [ORDER(9003)], tags: ['vip'] },
  'shopify.draft_order.create': { lines: [{ variantId: VARIANT(7001), quantity: 2 }] },
}
const KEYS = Object.keys(ARGS) as ShopifyKey[]

const req = (operation: ShopifyKey, args: unknown = ARGS[operation], overrides: Partial<WriteRequest> = {}): WriteRequest => ({
  actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA',
  attempt: 1,
  requestId: 'req-write-1',
  accountId: SHOPIFY_WRITE_ACCOUNT,
  expect: { connectedAtMs: CONNECTED_AT_MS, shop: SHOPIFY_WRITE_SHOP },
  operation,
  args,
  ...overrides,
})

let logs: string[] = []
beforeEach(() => {
  logs = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)))
})
afterEach(() => vi.restoreAllMocks())

function world(opts: { status?: () => Promise<HubResult<AccountStatus>>; shop?: () => string; writeTimeoutMs?: number } = {}) {
  const fake = createShopifyWriteUpstream()
  const core = new ShopifyWriteCore({
    store: new MemStore(),
    now: () => START_MS,
    upstream: async () => fake.fetch,
    keyring: async () => parseKeyRing(ringJson(['k1'], 'k1')),
    config: () => ({ shop: opts.shop?.() ?? SHOPIFY_WRITE_SHOP, clientId: SHOPIFY_WRITE_TEST_CLIENT_ID, clientSecret: SHOPIFY_WRITE_TEST_CLIENT_SECRET }),
    accountStatus: opts.status ?? (async () => ok(status())),
    writeTimeoutMs: opts.writeTimeoutMs,
  })
  const deps: WriteGatewayDeps = {
    shopifyWrite: input => core.run(input),
    slackChannelPost: async () => { throw new Error('no Slack here') },
    now: () => START_MS,
  }
  const run = async (r: WriteRequest) => {
    const res = await runWriteAction(deps, r)
    expect(WriteResultSchema.safeParse(res).success, JSON.stringify(res)).toBe(true)
    return res
  }
  /** Write requests that reached the GraphQL endpoint (the token grant isn't one). */
  const graphql = () => fake.requests.filter(q => q.path.endsWith('/graphql.json'))
  return { fake, run, graphql }
}

describe('the table', () => {
  it('has one hub entry per Shopify operation the contract names, and a call takes at most the bulk threshold', () => {
    expect(Object.keys(SHOPIFY_WRITE_OPS).sort()).toEqual([...KEYS].sort())
    // shared/contract/ceiling.ts BULK_THRESHOLD_MAX (the hub's typecheck can't reach that file's .ts imports).
    expect(ORDERS_PER_CALL_MAX).toBe(5)
  })
})

describe.each(KEYS)('%s', key => {
  it('succeeds once: one upstream request, a safe ref, no argument or token in the logs', async () => {
    const w = world()
    const r = await w.run(req(key))
    expect(r.ok).toBe(true)
    expect(w.fake.writes).toHaveLength(1)
    expect(w.fake.writes[0]!.operation).toBe(key)
    expect(w.graphql()).toHaveLength(1)
    expect(logs.join('\n')).not.toMatch(/shpat_|priority|ProductVariant|9001|9003/)
  })

  it.each([
    ['refuse', 'upstream_rejected', 'no'],
    ['broken_body', 'upstream_unavailable', 'unknown'],
  ] as const)('the %s fault answers %s, sent: %s, and changes nothing', async (fault, code, sent) => {
    const w = world()
    w.fake.faults[key] = fault
    const before = JSON.stringify({ orders: [...w.fake.orders.values()], drafts: w.fake.drafts })
    expect(await w.run(req(key))).toMatchObject({ ok: false, error: { code }, sent })
    expect(JSON.stringify({ orders: [...w.fake.orders.values()], drafts: w.fake.drafts })).toBe(before)
    expect(w.fake.writes).toHaveLength(1)
  })

  it('the timeout fault answers upstream_unavailable, sent: unknown, at the deadline, with no retry', async () => {
    const w = world({ writeTimeoutMs: 30 })
    w.fake.faults[key] = 'timeout'
    expect(await w.run(req(key))).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' }, sent: 'unknown' })
    expect(w.fake.writes).toHaveLength(1)
  })

  it('the throttle fault answers rate_limited, sent: no, with the wait the cost extension names; nothing ran', async () => {
    const w = world()
    w.fake.faults[key] = 'throttle'
    const r = await w.run(req(key))
    expect(r).toMatchObject({ ok: false, error: { code: 'rate_limited', retryAfterMs: 100 }, sent: 'no' })
    expect(w.fake.drafts).toEqual([])
    expect(w.fake.orders.get(ORDER(9001))!.tags).toEqual(['existing'])
    expect(w.fake.orders.get(ORDER(9003))!.tags).toEqual(['vip'])
  })

  it('refuses a stale account generation, another store, a paused account and no expected store, before any request', async () => {
    const stale = world({ status: async () => ok(status({ connectedAt: { iso: '', ms: CONNECTED_AT_MS + 1 } })) })
    expect(await stale.run(req(key))).toMatchObject({ ok: false, error: { code: 'connect_stale' }, sent: 'no' })
    const other = world({ shop: () => 'other-store' })
    expect(await other.run(req(key))).toMatchObject({ ok: false, error: { code: 'connect_stale' }, sent: 'no' })
    const paused = world({ status: async () => ok(status({ paused: true })) })
    expect(await paused.run(req(key))).toMatchObject({ ok: false, error: { code: 'paused' }, sent: 'no' })
    const unnamed = world()
    expect(await unnamed.run(req(key, ARGS[key], { expect: { connectedAtMs: CONNECTED_AT_MS } }))).toMatchObject({ ok: false, error: { code: 'invalid_args' }, sent: 'no' })
    for (const w of [stale, other, paused, unnamed]) expect(w.fake.requests).toEqual([])
  })

  it("refuses when the write app's grant lacks a write scope (sent: no, no write)", async () => {
    const w = world()
    w.fake.scope = ['write_orders']
    expect(await w.run(req(key))).toMatchObject({ ok: false, error: { code: 'scope_mismatch' }, sent: 'no' })
    expect(w.fake.writes).toEqual([])
  })

  it('refuses an unknown key, a missing field and another operation\'s arguments before any request', async () => {
    const w = world()
    const others = KEYS.filter(k => k !== key && JSON.stringify(Object.keys(ARGS[k] as object)) !== JSON.stringify(Object.keys(ARGS[key] as object)))
    for (const args of [{ ...(ARGS[key] as object), extra: 1 }, {}, null, ...others.map(k => ARGS[k])]) {
      expect(await w.run(req(key, args)), JSON.stringify(args)).toMatchObject({ ok: false, error: { code: 'invalid_args' }, sent: 'no' })
    }
    expect(w.fake.requests).toEqual([])
  })
})

describe('tags on several orders (one hub call, one document)', () => {
  it('adds to up to 5 orders in one upstream request, with each order a variable, never in the query text', async () => {
    const w = world()
    w.fake.orders.set(ORDER(9004), { id: ORDER(9004), name: '#9004', tags: [] })
    w.fake.orders.set(ORDER(9005), { id: ORDER(9005), name: '#9005', tags: [] })
    const ids = [9001, 9002, 9003, 9004, 9005].map(ORDER)
    const r = await w.run(req('shopify.order.tag_add', { orderIds: ids, tags: ['rush'] }))
    expect(r).toEqual({ ok: true, value: { ref: 'orders 9001, 9002, 9003, 9004, 9005: rush' } })
    expect(w.graphql()).toHaveLength(1)
    expect(w.fake.writes[0]!.variables).toEqual({ tags: ['rush'], id0: ids[0], id1: ids[1], id2: ids[2], id3: ids[3], id4: ids[4] })
    for (const id of ids) expect(w.fake.orders.get(id)!.tags).toContain('rush')
  })

  it('removes from several orders; a tag an order lacks is no error', async () => {
    const w = world()
    const r = await w.run(req('shopify.order.tag_remove', { orderIds: [ORDER(9001), ORDER(9003)], tags: ['vip', 'existing'] }))
    expect(r).toEqual({ ok: true, value: { ref: 'orders 9001, 9003: removed vip, existing' } })
    expect(w.fake.orders.get(ORDER(9001))!.tags).toEqual([])
    expect(w.fake.orders.get(ORDER(9003))!.tags).toEqual([])
  })

  it('a partial outcome is sent: unknown and names which orders went out and which were refused', async () => {
    const w = world()
    const r = await w.run(req('shopify.order.tag_add', { orderIds: [ORDER(9001), ORDER(424242), ORDER(9002)], tags: ['rush'] }))
    expect(r).toEqual({ ok: false, error: { code: 'upstream_rejected', message: 'upstream rejected the request: sent 9001,9002; refused 424242' }, sent: 'unknown' })
    expect(w.fake.orders.get(ORDER(9001))!.tags).toEqual(['existing', 'rush'])
    expect(w.fake.orders.get(ORDER(9002))!.tags).toEqual(['rush'])
    expect(w.graphql()).toHaveLength(1)
  })

  it('every order refused is sent: no and names them', async () => {
    const w = world()
    const r = await w.run(req('shopify.order.tag_remove', { orderIds: [ORDER(424242), ORDER(434343)], tags: ['vip'] }))
    expect(r).toEqual({ ok: false, error: { code: 'upstream_rejected', message: 'upstream rejected the request: refused 424242,434343' }, sent: 'no' })
  })

  it('an order whose answer is missing or odd is unclear: never ok and never sent: no', async () => {
    const args = { orderIds: [ORDER(9001), ORDER(9002)], tags: ['rush'] }
    const done = { node: { id: ORDER(9001) }, userErrors: [] }
    for (const [data, message] of [
      [{ o0: done }, 'sent 9001; unclear 9002'],
      [{ o0: done, o1: { node: { id: ORDER(9001) }, userErrors: [] } }, 'sent 9001; unclear 9002'],
      [{ o0: done, o1: { node: { id: ORDER(9002) }, userErrors: [{ message: 'x' }] } }, 'sent 9001; unclear 9002'],
      [{ o0: null, o1: { node: null, userErrors: [{ message: 'x' }] } }, 'refused 9002; unclear 9001'],
    ] as const) {
      const w = world()
      const inner = w.fake.fetch
      // The core reads the fake's `fetch` on every call: this answer replaces the fake's own after it ran.
      w.fake.fetch = async (q: Request) => new URL(q.url).pathname.endsWith('/graphql.json')
        ? (await inner(q), new Response(JSON.stringify({ data }), { status: 200, headers: { 'X-Shopify-API-Version': '2026-10' } }))
        : inner(q)
      expect(await w.run(req('shopify.order.tag_add', args)), JSON.stringify(data))
        .toEqual({ ok: false, error: { code: 'upstream_unavailable', message: `upstream unavailable: ${message}` }, sent: 'unknown' })
    }
  })

  it('a throttled multi-order call waits for the whole document\'s cost; nothing ran', async () => {
    const w = world()
    w.fake.faults['shopify.order.tag_add'] = 'throttle'
    const r = await w.run(req('shopify.order.tag_add', { orderIds: [ORDER(9001), ORDER(9002), ORDER(9003)], tags: ['rush'] }))
    expect(r).toEqual({ ok: false, error: { code: 'rate_limited', message: 'rate limited by the upstream', retryAfterMs: 300 }, sent: 'no' })
    expect([...w.fake.orders.values()].every(o => !o.tags.includes('rush'))).toBe(true)
  })
})

describe('shopify.draft_order.create', () => {
  it('sends exactly lines, note and tags, and nothing else', async () => {
    const w = world()
    const args = { lines: [{ variantId: VARIANT(7001), quantity: 2 }, { variantId: VARIANT(7003), quantity: 1 }], note: 'For the\nshowroom', tags: ['sample'] }
    const r = await w.run(req('shopify.draft_order.create', args))
    expect(r).toEqual({ ok: true, value: { ref: 'draft order 1001: 3 items' } })
    expect(w.fake.writes[0]!.variables).toEqual({ input: { lineItems: args.lines, note: 'For the\nshowroom', tags: ['sample'] } })
    expect(w.fake.drafts).toEqual([{ id: 'gid://shopify/DraftOrder/1001', ...args }])
  })

  it('an unknown variant is refused by Shopify: sent: no, no draft', async () => {
    const w = world()
    expect(await w.run(req('shopify.draft_order.create', { lines: [{ variantId: VARIANT(8888), quantity: 1 }] }))).toMatchObject({ ok: false, error: { code: 'upstream_rejected' }, sent: 'no' })
    expect(w.fake.drafts).toEqual([])
  })

  it('refuses anything past lines, note and tags, and every bound, before any request', async () => {
    const w = world()
    const line = { variantId: VARIANT(7001), quantity: 1 }
    for (const args of [
      { lines: [] },
      { lines: Array.from({ length: 21 }, (_, i) => ({ variantId: VARIANT(i + 1), quantity: 1 })) },
      { lines: [line, line] },
      { lines: [{ ...line, quantity: 0 }] },
      { lines: [{ ...line, quantity: 101 }] },
      { lines: [{ ...line, quantity: 1.5 }] },
      { lines: [{ ...line, price: '0.00' }] },
      { lines: [{ variantId: 'gid://shopify/Product/7001', quantity: 1 }] },
      { lines: [line], note: '' },
      { lines: [line], note: 'x'.repeat(501) },
      { lines: [line], note: 'bidi ‮ note' },
      { lines: [line], note: 'tab\there' },
      { lines: [line], tags: [] },
      { lines: [line], tags: ['a,b'] },
      { lines: [line], customerId: 'gid://shopify/Customer/1' },
      { lines: [line], email: 'someone@example.com' },
      { lines: [line], reserveInventoryUntil: '2030-01-01T00:00:00Z' },
      { lines: [line], appliedDiscount: { value: 100 } },
    ]) {
      expect(await w.run(req('shopify.draft_order.create', args)), JSON.stringify(args)).toMatchObject({ ok: false, error: { code: 'invalid_args' }, sent: 'no' })
    }
    expect(w.fake.requests).toEqual([])
  })
})

describe('throttleWaitMs', () => {
  it('reads the bucket shortfall at the restore rate, bounded to a day; anything odd names no wait', () => {
    const ext = (requestedQueryCost: unknown, currentlyAvailable: unknown, restoreRate: unknown) => ({ cost: { requestedQueryCost, throttleStatus: { currentlyAvailable, restoreRate, maximumAvailable: 2000 } } })
    expect(throttleWaitMs(ext(50, FAKE_THROTTLE.currentlyAvailable, FAKE_THROTTLE.restoreRate))).toBe(500)
    expect(throttleWaitMs(ext(10, 50, 100))).toBe(0)
    expect(throttleWaitMs(ext(1e12, 0, 0.001))).toBe(86_400_000)
    for (const bad of [undefined, null, {}, { cost: null }, ext('10', 0, 100), ext(10, 0, 0), ext(10, 0, -1), ext(Number.NaN, 0, 100), ext(-1, 0, 100)]) {
      expect(throttleWaitMs(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})
