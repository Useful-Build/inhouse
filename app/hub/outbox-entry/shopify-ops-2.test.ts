// Stage 1 M3-S2 (N21) Node tests for the Shopify write set, part 2 (restock, reduce, refund), the write core's scope-aware
// token reuse (#490), the fake upstream's strict document check (#489) and the store's currency. The operations' shared
// cases (faults, stale accounts, scopes, strict arguments) run over every operation in shopify-ops.test.ts. Ways it can go
// wrong, written first:
// - the same idempotency key twice changes stock or refunds twice; a call with no key reaches Shopify;
// - a refund goes out when Shopify's suggested amount isn't the approved amount, in another currency, or for an order
//   placed in another presentment currency; its transactions don't carry the amount; a line is restocked the wrong way;
// - a refund lookup that failed says `sent: 'unknown'` (a query changes nothing) or is followed by the mutation;
// - a refund that came back with another amount says `ok`;
// - a token granted before `write_inventory` existed refuses a stock change until it expires (#490);
// - the fake answers a malformed document, another mutation under a known name, or one with odd variables (#489);
// - the currency is read on every account list, kept for another store, or taken from an odd answer.
import { fc, test } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountStatus, HubResult, WriteRequest } from '../index/contract'
import { WriteResultSchema } from '../index/schemas'
import { ok } from '../index/errors'
import { parseKeyRing } from '../crypto/keyring'
import { MemStore, ringJson, START_MS } from '../signin/testing/kit'
import { CURRENCY_MAX_AGE_MS, ShopifyWriteCore, type WriteTokenRecord } from '../connectors/shopify/write/core'
import { SHOPIFY_WRITE_ACCOUNT } from '../connectors/shopify/write/provider'
import { SHOPIFY_WRITE_OPS, type ShopifyWriteKey } from '../connectors/shopify/write/ops/index'
import { fromMinor, minorDigits, toMinor } from '../connectors/shopify/write/ops/money'
import { REFUND_CREATE_MUTATION } from '../connectors/shopify/write/ops/refund-create'
import {
  createShopifyWriteUpstream,
  SHOPIFY_WRITE_SHOP,
  SHOPIFY_WRITE_TEST_CLIENT_ID,
  SHOPIFY_WRITE_TEST_CLIENT_SECRET,
} from '../../test/upstreams/shopify/write/server'
import { runWriteAction, type WriteGatewayDeps } from './gateway'

const CONNECTED_AT_MS = START_MS
const ORDER = (n: number) => `gid://shopify/Order/${n}`
const LINE = (n: number) => `gid://shopify/LineItem/${n}`
const ITEM = (n: number) => `gid://shopify/InventoryItem/${n}`
const LOCATION = (n: number) => `gid://shopify/Location/${n}`
const KEY = 'ac_AAAAAAAAAAAAAAAAAAAAAA:1'

const status = (): AccountStatus => ({
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
})

const restock = (o: Record<string, unknown> = {}) => ({ inventoryItemId: ITEM(8001), locationId: LOCATION(601), quantity: 20, reason: 'restock', ...o })
const reduce = (o: Record<string, unknown> = {}) => ({ inventoryItemId: ITEM(8001), locationId: LOCATION(601), quantity: 3, reason: 'damaged', ...o })
const refund = (o: Record<string, unknown> = {}) => ({
  orderId: ORDER(9001), lines: [{ lineItemId: LINE(90011), quantity: 2 }], amount: { minor: 2490, currency: 'USD' }, restock: false, notifyCustomer: false, ...o,
})

const req = (operation: ShopifyWriteKey, args: unknown, overrides: Partial<WriteRequest> = {}): WriteRequest => ({
  actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA',
  attempt: 1,
  requestId: 'req-write-1',
  accountId: SHOPIFY_WRITE_ACCOUNT,
  expect: { connectedAtMs: CONNECTED_AT_MS, shop: SHOPIFY_WRITE_SHOP },
  operation,
  args,
  idempotencyKey: KEY,
  ...overrides,
})

let logs: string[] = []
beforeEach(() => {
  logs = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)))
})
afterEach(() => vi.restoreAllMocks())

function world(opts: { status?: () => Promise<HubResult<AccountStatus>>; shop?: () => string | null; writeTimeoutMs?: number } = {}) {
  const fake = createShopifyWriteUpstream()
  const store = new MemStore()
  let now = START_MS
  // One key ring for the world's life, so a stored token opens on the next call (as the DO's keys do).
  const ring = parseKeyRing(ringJson(['k1'], 'k1'))
  const core = new ShopifyWriteCore({
    store,
    now: () => now,
    upstream: async () => fake.fetch,
    keyring: async () => ring,
    config: () => {
      const shop = opts.shop ? opts.shop() : SHOPIFY_WRITE_SHOP
      return shop === null ? null : { shop, clientId: SHOPIFY_WRITE_TEST_CLIENT_ID, clientSecret: SHOPIFY_WRITE_TEST_CLIENT_SECRET }
    },
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
  const graphql = () => fake.requests.filter(q => q.path.endsWith('/graphql.json'))
  const level = (item: number, location: number) => fake.stock.get(`${ITEM(item)}|${LOCATION(location)}`)
  /** Replaces the fake's answer to the mutation (after the fake ran it) with `data`. */
  const answerMutationWith = (data: unknown) => {
    const inner = fake.fetch
    fake.fetch = async (q: Request) => {
      const body = q.clone()
      const res = await inner(q)
      if (!new URL(q.url).pathname.endsWith('/graphql.json')) return res
      const text = String(((await body.json()) as { query?: unknown }).query)
      return text.trimStart().startsWith('mutation')
        ? new Response(JSON.stringify({ data }), { status: 200, headers: { 'X-Shopify-API-Version': '2026-10' } })
        : res
    }
  }
  return { fake, store, core, run, graphql, level, answerMutationWith, tick: (ms: number) => void (now += ms) }
}

describe('shopify.inventory.restock and .reduce', () => {
  it('a restock raises available stock by its quantity, with the key, the reason and changeFromQuantity: null', async () => {
    const w = world()
    expect(await w.run(req('shopify.inventory.restock', restock()))).toEqual({ ok: true, value: { ref: 'stock +20 at location 601 (item 8001)' } })
    expect(w.level(8001, 601)).toBe(30)
    expect(w.fake.writes[0]!.variables).toEqual({
      input: { name: 'available', reason: 'restock', changes: [{ inventoryItemId: ITEM(8001), locationId: LOCATION(601), delta: 20, changeFromQuantity: null }] },
      idempotencyKey: KEY,
    })
  })

  it('a reduce lowers it with a negative delta and its reason', async () => {
    const w = world()
    expect(await w.run(req('shopify.inventory.reduce', reduce({ locationId: LOCATION(602), quantity: 5, reason: 'shrinkage' }))))
      .toEqual({ ok: true, value: { ref: 'stock -5 at location 602 (item 8001)' } })
    expect(w.level(8001, 602)).toBe(0)
    expect(w.fake.writes[0]!.variables).toMatchObject({ input: { reason: 'shrinkage', changes: [{ delta: -5 }] } })
  })

  it.each(['shopify.inventory.restock', 'shopify.inventory.reduce'] as const)('%s: the same idempotency key twice changes stock once', async key => {
    const w = world()
    const args = key === 'shopify.inventory.restock' ? restock() : reduce()
    const first = await w.run(req(key, args))
    const again = await w.run(req(key, args, { attempt: 2 }))
    expect(first.ok && again).toEqual(first)
    expect(w.level(8001, 601)).toBe(key === 'shopify.inventory.restock' ? 30 : 7)
    expect(w.fake.writes.map(x => x.replayed ?? false)).toEqual([false, true])
    // Another change under the same key is never applied: an unclear answer, nothing changed.
    const other = await w.run(req(key, { ...args, quantity: 1 }, { attempt: 3 }))
    expect(other).toMatchObject({ ok: false, sent: 'unknown' })
    expect(w.level(8001, 601)).toBe(key === 'shopify.inventory.restock' ? 30 : 7)
  })

  it('a call with no idempotency key is refused before any request', async () => {
    const w = world()
    for (const [key, args] of [['shopify.inventory.restock', restock()], ['shopify.inventory.reduce', reduce()], ['shopify.refund.create', refund()]] as const) {
      expect(await w.run(req(key, args, { idempotencyKey: undefined }))).toEqual({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: idempotencyKey' }, sent: 'no' })
    }
    expect(w.fake.requests).toEqual([])
  })

  it('an item not stocked at the location is refused by Shopify: sent: no, nothing changed', async () => {
    const w = world()
    expect(await w.run(req('shopify.inventory.restock', restock({ locationId: LOCATION(699) })))).toMatchObject({ ok: false, error: { code: 'upstream_rejected' }, sent: 'no' })
    expect([...w.fake.stock.values()]).toEqual([10, 0, 5])
  })

  it('an answer that names another change is unclear, never ok', async () => {
    const w = world()
    w.answerMutationWith({ inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: 'gid://shopify/InventoryAdjustmentGroup/1', changes: [{ name: 'available', delta: 2 }] }, userErrors: [] } })
    expect(await w.run(req('shopify.inventory.restock', restock()))).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' }, sent: 'unknown' })
  })

  it('refuses every argument outside the shape before any request', async () => {
    const w = world()
    for (const [key, args] of [
      ['shopify.inventory.restock', restock({ quantity: 0 })],
      ['shopify.inventory.restock', restock({ quantity: -3 })],
      ['shopify.inventory.restock', restock({ quantity: 2.5 })],
      ['shopify.inventory.restock', restock({ quantity: 1_000_001 })],
      ['shopify.inventory.restock', restock({ reason: 'damaged' })],
      ['shopify.inventory.restock', restock({ reason: 'movement_created' })],
      ['shopify.inventory.restock', restock({ reason: undefined })],
      ['shopify.inventory.restock', restock({ inventoryItemId: 'gid://shopify/ProductVariant/8001' })],
      ['shopify.inventory.restock', restock({ locationId: '601' })],
      ['shopify.inventory.restock', restock({ changeFromQuantity: 10 })],
      ['shopify.inventory.restock', restock({ delta: 20 })],
      ['shopify.inventory.reduce', reduce({ reason: 'restock' })],
      ['shopify.inventory.reduce', reduce({ reason: undefined })],
      ['shopify.inventory.reduce', reduce({ quantity: -3 })],
    ] as const) {
      expect(await w.run(req(key, args)), JSON.stringify(args)).toMatchObject({ ok: false, error: { code: 'invalid_args' }, sent: 'no' })
    }
    expect(w.fake.requests).toEqual([])
  })
})

describe('shopify.refund.create', () => {
  it('refunds exactly the approved amount: the suggestion first, then the amount explicitly in the transaction, with the key', async () => {
    const w = world()
    expect(await w.run(req('shopify.refund.create', refund()))).toEqual({ ok: true, value: { ref: 'refund 5001 on order 9001: 24.90 USD' } })
    expect(w.fake.reads.map(r => r.operation)).toEqual(['shopify.refund.suggestion'])
    expect(w.fake.writes).toHaveLength(1)
    expect(w.fake.writes[0]!.variables).toEqual({
      input: {
        orderId: ORDER(9001),
        currency: 'USD',
        notify: false,
        refundLineItems: [{ lineItemId: LINE(90011), quantity: 2, restockType: 'NO_RESTOCK' }],
        transactions: [{ orderId: ORDER(9001), parentId: 'gid://shopify/OrderTransaction/70001', gateway: 'bogus', kind: 'REFUND', amount: '24.90' }],
      },
      idempotencyKey: KEY,
    })
    expect(w.fake.refunds).toEqual([{ id: 'gid://shopify/Refund/5001', orderId: ORDER(9001), amountMinor: 2490, notify: false }])
  })

  it('with shipping, the customer\'s email and a restock: a fulfilled line returns, an unfulfilled one cancels', async () => {
    const w = world()
    const args = refund({
      lines: [{ lineItemId: LINE(90011), quantity: 1 }, { lineItemId: LINE(90012), quantity: 2 }], shippingMinor: 500,
      amount: { minor: 1245 + 1000 + 500, currency: 'USD' }, restock: true, notifyCustomer: true,
    })
    expect(await w.run(req('shopify.refund.create', args))).toEqual({ ok: true, value: { ref: 'refund 5001 on order 9001: 27.45 USD' } })
    expect(w.fake.writes[0]!.variables).toMatchObject({
      input: {
        notify: true,
        refundLineItems: [{ lineItemId: LINE(90011), quantity: 1, restockType: 'RETURN' }, { lineItemId: LINE(90012), quantity: 2, restockType: 'CANCEL' }],
        shipping: { amount: '5.00' },
        transactions: [{ amount: '27.45' }],
      },
    })
    expect(w.fake.refundOrders.get(ORDER(9001))!.lines[1]!.unfulfilled).toBe(1)
  })

  it('the same call twice refunds once: the second lookup sees the lines refunded, and the mutation, if sent, replays', async () => {
    const w = world()
    const first = await w.run(req('shopify.refund.create', refund()))
    expect(first.ok).toBe(true)
    // The outbox never resends an unclear call; a second attempt only follows a throttle, which ran nothing. Even so, a
    // second call can't refund again: Shopify's suggestion for those lines is now nothing.
    expect(await w.run(req('shopify.refund.create', refund(), { attempt: 2 }))).toMatchObject({ ok: false, error: { message: 'upstream rejected the request: amount_changed' }, sent: 'no' })
    expect(w.fake.refunds).toHaveLength(1)
    expect(w.fake.writes).toHaveLength(1)
    // The mutation itself under the same key: Shopify answers the first refund again and refunds nothing.
    const sent = w.fake.writes[0]!.variables
    const again = await w.fake.fetch(new Request(`https://${SHOPIFY_WRITE_SHOP}.myshopify.com/admin/api/2026-10/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': w.fake.issuedTokens[0]! },
      body: JSON.stringify({ query: REFUND_CREATE_MUTATION, variables: sent }),
    }))
    expect(await again.json()).toMatchObject({ data: { refundCreate: { refund: { id: 'gid://shopify/Refund/5001' } } } })
    expect(w.fake.refunds).toHaveLength(1)
    expect(w.fake.writes.map(x => x.replayed ?? false)).toEqual([false, true])
  })

  it('a changed amount is sent: no, "the refund amount changed", and nothing is written', async () => {
    const w = world()
    w.fake.refundOrders.get(ORDER(9001))!.lines[0]!.priceMinor = 1300
    expect(await w.run(req('shopify.refund.create', refund()))).toEqual({ ok: false, error: { code: 'upstream_rejected', message: 'upstream rejected the request: amount_changed' }, sent: 'no' })
    expect(w.fake.writes).toEqual([])
    expect(w.fake.refunds).toEqual([])
  })

  it('refuses another currency than the order\'s, and an order placed in another presentment currency, before any write', async () => {
    const w = world()
    expect(await w.run(req('shopify.refund.create', refund({ amount: { minor: 2490, currency: 'EUR' } })))).toMatchObject({ ok: false, error: { message: 'upstream rejected the request: currency' }, sent: 'no' })
    const cad = { orderId: ORDER(9003), lines: [{ lineItemId: LINE(90031), quantity: 1 }] }
    for (const currency of ['USD', 'CAD']) {
      expect(await w.run(req('shopify.refund.create', refund({ ...cad, amount: { minor: 1000, currency } })))).toMatchObject({ ok: false, error: { message: 'upstream rejected the request: currency' }, sent: 'no' })
    }
    expect(w.fake.writes).toEqual([])
  })

  it('an order Shopify doesn\'t know, lines past what\'s left and a part-fulfilled restock are refused before any write', async () => {
    const w = world()
    expect(await w.run(req('shopify.refund.create', refund({ orderId: ORDER(4242) })))).toMatchObject({ ok: false, error: { message: 'upstream rejected the request: order' }, sent: 'no' })
    expect(await w.run(req('shopify.refund.create', refund({ lines: [{ lineItemId: LINE(90011), quantity: 3 }], amount: { minor: 3735, currency: 'USD' } }))))
      .toMatchObject({ ok: false, error: { message: 'upstream rejected the request: amount_changed' }, sent: 'no' })
    // Line 90012 has 3 unfulfilled units; 1 fulfilled then makes a 3-unit refund part fulfilled, part not.
    w.fake.refundOrders.get(ORDER(9001))!.lines[1]!.unfulfilled = 2
    expect(await w.run(req('shopify.refund.create', refund({ lines: [{ lineItemId: LINE(90012), quantity: 3 }], amount: { minor: 1500, currency: 'USD' }, restock: true }))))
      .toMatchObject({ ok: false, error: { message: 'upstream rejected the request: restock_part_fulfilled' }, sent: 'no' })
    expect(w.fake.writes).toEqual([])
  })

  // #512 review H1: a line of 5, 2 shipped and 3 not (order 9004). The customer sends back the 2 shipped and an admin
  // approves "2 × line, restock: yes". A cancel there would cancel 2 unshipped units nobody approved; a return could be
  // the wrong 2 as well. The arguments can't say which units, so a restock on such a line is refused, sent: no.
  it('a restock on a line with both shipped and unshipped units left is refused, and no unshipped unit is cancelled', async () => {
    const w = world()
    const line = () => w.fake.refundOrders.get(ORDER(9004))!.lines[0]!
    for (const quantity of [1, 2, 3, 5]) {
      const r = await w.run(req('shopify.refund.create', refund({ orderId: ORDER(9004), lines: [{ lineItemId: LINE(90041), quantity }], amount: { minor: 1000 * quantity, currency: 'USD' }, restock: true })))
      expect(r, String(quantity)).toEqual({ ok: false, error: { code: 'upstream_rejected', message: 'upstream rejected the request: restock_part_fulfilled' }, sent: 'no' })
    }
    expect(w.fake.writes).toEqual([])
    expect(line()).toMatchObject({ refunded: 0, unfulfilled: 3 })
    // Without a restock the refund goes out (no unit is cancelled or returned to stock).
    const plain = await w.run(req('shopify.refund.create', refund({ orderId: ORDER(9004), lines: [{ lineItemId: LINE(90041), quantity: 2 }], amount: { minor: 2000, currency: 'USD' } })))
    expect(plain.ok, JSON.stringify(plain)).toBe(true)
    expect(w.fake.writes[0]!.variables).toMatchObject({ input: { refundLineItems: [{ lineItemId: LINE(90041), quantity: 2, restockType: 'NO_RESTOCK' }] } })
    expect(line()).toMatchObject({ refunded: 2, unfulfilled: 3 })
  })

  it('a restock goes out as a cancel once every unit left on the line is unshipped, and as a return once every one is shipped', async () => {
    const w = world()
    const line = () => w.fake.refundOrders.get(ORDER(9004))!.lines[0]!
    // The 2 shipped units refunded first (no restock): the 3 left are all unshipped.
    expect((await w.run(req('shopify.refund.create', refund({ orderId: ORDER(9004), lines: [{ lineItemId: LINE(90041), quantity: 2 }], amount: { minor: 2000, currency: 'USD' } })))).ok).toBe(true)
    const cancel = await w.run(req('shopify.refund.create', refund({ orderId: ORDER(9004), lines: [{ lineItemId: LINE(90041), quantity: 1 }], amount: { minor: 1000, currency: 'USD' }, restock: true }), { idempotencyKey: 'ac_CCCCCCCCCCCCCCCCCCCCCC:1' }))
    expect(cancel.ok, JSON.stringify(cancel)).toBe(true)
    expect(w.fake.writes[1]!.variables).toMatchObject({ input: { refundLineItems: [{ restockType: 'CANCEL' }] } })
    expect(line()).toMatchObject({ refunded: 3, unfulfilled: 2 })
    // Line 90011 of order 9001 is all shipped: a return.
    expect((await w.run(req('shopify.refund.create', refund({ restock: true }), { idempotencyKey: 'ac_DDDDDDDDDDDDDDDDDDDDDD:1' }))).ok).toBe(true)
    expect(w.fake.writes[2]!.variables).toMatchObject({ input: { refundLineItems: [{ restockType: 'RETURN' }] } })
  })

  it.each([
    ['throttle', 'rate_limited'],
    ['refuse', null],
    ['broken_body', 'upstream_unavailable'],
    ['timeout', 'upstream_unavailable'],
  ] as const)('a lookup that fails (%s) is sent: no, and the mutation never goes', async (fault, code) => {
    const w = world({ writeTimeoutMs: 30 })
    w.fake.faults['shopify.refund.suggestion'] = fault
    const r = await w.run(req('shopify.refund.create', refund()))
    if (code === null) expect(r.ok).toBe(true) // A query has no user error to refuse with: the fake's `refuse` changes nothing.
    else {
      expect(r).toMatchObject({ ok: false, error: { code }, sent: 'no' })
      expect(w.fake.writes).toEqual([])
    }
  })

  it('a refund that came back with another amount is unclear, never ok and never sent: no', async () => {
    const w = world()
    w.answerMutationWith({ refundCreate: { refund: { id: 'gid://shopify/Refund/5001', totalRefundedSet: { shopMoney: { amount: '20.00', currencyCode: 'USD' } } }, userErrors: [] } })
    expect(await w.run(req('shopify.refund.create', refund()))).toEqual({ ok: false, error: { code: 'upstream_unavailable', message: 'upstream unavailable: refund amount differs' }, sent: 'unknown' })
  })

  it('refuses every argument outside the shape before any request', async () => {
    const w = world()
    for (const args of [
      refund({ amount: { minor: 2490, currency: 'usd' } }),
      refund({ amount: { minor: 0, currency: 'USD' } }),
      refund({ amount: { minor: 24.9, currency: 'USD' } }),
      refund({ amount: { minor: 2490 } }),
      refund({ amount: 2490 }),
      refund({ lines: [] }),
      refund({ lines: [], shippingMinor: 0 }),
      refund({ lines: [], shippingMinor: 500, restock: true, amount: { minor: 500, currency: 'USD' } }),
      refund({ lines: [{ lineItemId: LINE(90011), quantity: 1 }, { lineItemId: LINE(90011), quantity: 1 }] }),
      refund({ lines: [{ lineItemId: LINE(90011), quantity: 0 }] }),
      refund({ lines: [{ lineItemId: 'gid://shopify/Order/90011', quantity: 1 }] }),
      refund({ shippingMinor: -1 }),
      refund({ restock: 'yes' }),
      refund({ notifyCustomer: undefined }),
      refund({ transactions: [] }),
      refund({ note: 'promised' }),
      refund({ orderId: 'gid://shopify/Order/0' }),
    ]) {
      expect(await w.run(req('shopify.refund.create', args)), JSON.stringify(args)).toMatchObject({ ok: false, error: { code: 'invalid_args' }, sent: 'no' })
    }
    expect(w.fake.requests).toEqual([])
  })
})

describe('#490: a cached write token is reused only when its grant covers the operation\'s scope', () => {
  it('a token granted before write_inventory existed is replaced for a stock change, then reused for everything', async () => {
    const w = world()
    expect((await w.run(req('shopify.order.tag_add', { orderIds: [ORDER(9002)], tags: ['a'] }))).ok).toBe(true)
    expect(w.fake.issuedTokens).toHaveLength(1)
    // The stored grant as an older build kept it: no write_inventory.
    const rec = w.store.get<WriteTokenRecord>('write_record')!
    w.store.put('write_record', { ...rec, scopes: ['write_orders', 'write_draft_orders'] })
    expect((await w.run(req('shopify.order.tag_add', { orderIds: [ORDER(9002)], tags: ['b'] }))).ok).toBe(true)
    expect(w.fake.issuedTokens).toHaveLength(1) // write_orders is covered: the old token is reused
    expect(await w.run(req('shopify.inventory.restock', restock()))).toMatchObject({ ok: true })
    expect(w.fake.issuedTokens).toHaveLength(2)
    expect(w.store.get<WriteTokenRecord>('write_record')!.scopes.sort()).toEqual(['read_customers', 'read_products', 'write_draft_orders', 'write_inventory', 'write_orders'])
    expect(await w.run(req('shopify.inventory.reduce', reduce(), { idempotencyKey: 'ac_BBBBBBBBBBBBBBBBBBBBBB:1' }))).toMatchObject({ ok: true })
    expect(w.fake.issuedTokens).toHaveLength(2)
  })

  it('a new grant that still lacks the scope is refused scope_mismatch, sent: no, with no write', async () => {
    const w = world()
    w.fake.scope = ['write_orders', 'write_draft_orders']
    expect(await w.run(req('shopify.inventory.restock', restock()))).toMatchObject({ ok: false, error: { code: 'scope_mismatch' }, sent: 'no' })
    expect(w.fake.writes).toEqual([])
  })
})

describe('#489: the fake answers only the exact document of an operation it knows', () => {
  async function post(w: ReturnType<typeof world>, query: string, variables: Record<string, unknown>) {
    const tokenRes = await w.fake.fetch(new Request(`https://${SHOPIFY_WRITE_SHOP}.myshopify.com/admin/oauth/access_token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: SHOPIFY_WRITE_TEST_CLIENT_ID, client_secret: SHOPIFY_WRITE_TEST_CLIENT_SECRET }),
    }))
    const token = ((await tokenRes.json()) as { access_token: string }).access_token
    const res = await w.fake.fetch(new Request(`https://${SHOPIFY_WRITE_SHOP}.myshopify.com/admin/api/2026-10/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }),
    }))
    return (await res.json()) as { data?: unknown; errors?: { extensions: { code: string } }[] }
  }
  const TAGS = 'mutation OrderTagsAdd($tags: [String!]!, $id0: ID!) { o0: tagsAdd(id: $id0, tags: $tags) { node { id } userErrors { field message } } }'
  const vars = { tags: ['x'], id0: ORDER(9001) }

  it('takes the document however it is spaced, and runs it', async () => {
    const w = world()
    const r = await post(w, `# a comment\n${TAGS.replaceAll(' ', '\n  ').replace('$tags:', '$tags :')}`, vars)
    expect(r.errors).toBeUndefined()
    expect(w.fake.orders.get(ORDER(9001))!.tags).toContain('x')
  })

  it.each([
    ['a malformed document', TAGS.slice(0, -2), vars, 'GRAPHQL_PARSE_FAILED'],
    ['a literal value in place of a variable', TAGS.replace('id: $id0', 'id: "gid://shopify/Order/9001"'), { tags: ['x'] }, 'GRAPHQL_PARSE_FAILED'],
    ['two operations', `${TAGS} ${TAGS}`, vars, 'GRAPHQL_PARSE_FAILED'],
    ['another mutation under a known name', TAGS.replace('tagsAdd', 'tagsRemove'), vars, 'GRAPHQL_VALIDATION_FAILED'],
    ['a misspelt selection', TAGS.replace('userErrors', 'userErros'), vars, 'GRAPHQL_VALIDATION_FAILED'],
    ['a field the operation doesn\'t ask', TAGS.replace('node { id }', 'node { id note }'), vars, 'GRAPHQL_VALIDATION_FAILED'],
    ['another variable type', TAGS.replace('$id0: ID!', '$id0: String!'), vars, 'GRAPHQL_VALIDATION_FAILED'],
    ['a variable declared and not given', TAGS, { tags: ['x'] }, 'GRAPHQL_VALIDATION_FAILED'],
    ['a variable given and not declared', TAGS, { ...vars, id1: ORDER(9002) }, 'GRAPHQL_VALIDATION_FAILED'],
    ['a stock change with no idempotency directive', 'mutation InventoryRestock($input: InventoryAdjustQuantitiesInput!) { inventoryAdjustQuantities(input: $input) { inventoryAdjustmentGroup { id changes { name delta } } userErrors { field message } } }', { input: {} }, 'GRAPHQL_VALIDATION_FAILED'],
    ['a query under a mutation\'s name', TAGS.replace('mutation', 'query'), vars, 'ACCESS_DENIED'],
  ])('refuses %s and changes nothing', async (_, query, variables, code) => {
    const w = world()
    const r = await post(w, query, variables)
    expect(r.errors?.[0]?.extensions.code).toBe(code)
    expect(w.fake.orders.get(ORDER(9001))!.tags).toEqual(['existing'])
    expect(w.fake.writes).toEqual([])
    if (code !== 'ACCESS_DENIED') expect(w.fake.documentErrors).toHaveLength(1)
  })

  const tagArgs = fc.record({
    orderIds: fc.uniqueArray(fc.constantFrom(9001, 9002, 9003).map(ORDER), { minLength: 1, maxLength: 3 }),
    tags: fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 5 }),
  })
  const stockArgs = fc.record({ inventoryItemId: fc.constant(ITEM(8001)), locationId: fc.constant(LOCATION(601)), quantity: fc.integer({ min: 1, max: 5 }), reason: fc.constantFrom('restock', 'received', 'correction') })
  const draftArgs = fc.record({
    lines: fc.uniqueArray(fc.constantFrom(7001, 7002, 7003), { minLength: 1, maxLength: 3 }).map(ns => ns.map(n => ({ variantId: `gid://shopify/ProductVariant/${n}`, quantity: 1 }))),
    note: fc.option(fc.stringMatching(/^[a-z ]{1,20}$/), { nil: undefined }),
  }).map(a => (a.note === undefined ? { lines: a.lines } : a))
  const refundArgs = fc.record({ q: fc.integer({ min: 1, max: 2 }), restock: fc.boolean(), notifyCustomer: fc.boolean(), shipping: fc.boolean() })
    .map(r => refund({ lines: [{ lineItemId: LINE(90011), quantity: r.q }], restock: r.restock, notifyCustomer: r.notifyCustomer, ...(r.shipping ? { shippingMinor: 500 } : {}), amount: { minor: 1245 * r.q + (r.shipping ? 500 : 0), currency: 'USD' } }))

  test.prop([fc.oneof(
    tagArgs.map(a => ['shopify.order.tag_add', a] as const),
    tagArgs.map(a => ['shopify.order.tag_remove', a] as const),
    draftArgs.map(a => ['shopify.draft_order.create', a] as const),
    stockArgs.map(a => ['shopify.inventory.restock', a] as const),
    stockArgs.map(a => ['shopify.inventory.reduce', { ...a, reason: 'damaged' }] as const),
    refundArgs.map(a => ['shopify.refund.create', a] as const),
  )], { numRuns: 120 })('every document the hub builds, for any valid call, is one the fake takes and answers', async ([key, args]) => {
    const w = world()
    const r = await w.run(req(key, args))
    expect(w.fake.documentErrors).toEqual([])
    expect(r.ok, JSON.stringify(r)).toBe(true)
  })

  it('the hub table and the fake name the same operations', async () => {
    const { FAKE_WRITE_OPS } = await import('../../test/upstreams/shopify/write/ops/index')
    const mutations = FAKE_WRITE_OPS.filter(o => o.kind === 'mutation').map(o => o.key).sort()
    expect(mutations).toEqual(Object.keys(SHOPIFY_WRITE_OPS).sort())
  })
})

describe('the store\'s currency', () => {
  it('is read once with the write token and kept a day for that store', async () => {
    const w = world()
    expect(await w.core.currency()).toBe('USD')
    expect(w.fake.reads.map(r => r.operation)).toEqual(['shopify.shop.currency'])
    w.fake.currency = 'EUR'
    w.tick(CURRENCY_MAX_AGE_MS - 1)
    expect(await w.core.currency()).toBe('USD')
    expect(w.fake.reads).toHaveLength(1)
    w.tick(1)
    expect(await w.core.currency()).toBe('EUR')
    expect(w.fake.reads).toHaveLength(2)
  })

  it('is read again for another store, and none without config or with an odd answer', async () => {
    let shop: string | null = SHOPIFY_WRITE_SHOP
    const w = world({ shop: () => shop })
    expect(await w.core.currency()).toBe('USD')
    shop = 'other-store'
    w.fake.currency = 'usd'
    expect(await w.core.currency()).toBeNull()
    shop = null
    expect(await w.core.currency()).toBeNull()
    expect(w.fake.reads).toHaveLength(2)
  })

  it('a throttled or broken read is none, and nothing is kept', async () => {
    const w = world()
    w.fake.faults['shopify.shop.currency'] = 'throttle'
    expect(await w.core.currency()).toBeNull()
    w.fake.faults['shopify.shop.currency'] = 'succeed'
    expect(await w.core.currency()).toBe('USD')
  })
})

describe('money', () => {
  it('converts exactly between decimal strings and minor units, per currency', () => {
    expect(minorDigits('USD')).toBe(2)
    expect(minorDigits('JPY')).toBe(0)
    expect(minorDigits('KWD')).toBe(3)
    expect(toMinor('24.90', 'USD')).toBe(2490)
    expect(toMinor('24.9', 'USD')).toBe(2490)
    expect(toMinor('24.900', 'USD')).toBe(2490)
    expect(toMinor('24', 'USD')).toBe(2400)
    expect(toMinor('2490', 'JPY')).toBe(2490)
    expect(toMinor('2490.00', 'JPY')).toBe(2490)
    expect(toMinor('1.234', 'KWD')).toBe(1234)
    for (const bad of ['24.901', '-1.00', '1e3', ' 1.00', '01.00', '1.', '.5', '', 24.9, null, '2490.5']) {
      expect(toMinor(bad, bad === '2490.5' ? 'JPY' : 'USD'), String(bad)).toBeNull()
    }
    expect(fromMinor(2490, 'USD')).toBe('24.90')
    expect(fromMinor(5, 'USD')).toBe('0.05')
    expect(fromMinor(0, 'USD')).toBe('0.00')
    expect(fromMinor(2490, 'JPY')).toBe('2490')
    expect(fromMinor(1234, 'KWD')).toBe('1.234')
  })

  test.prop([fc.integer({ min: 0, max: 1_000_000_000 }), fc.constantFrom('USD', 'JPY', 'KWD', 'EUR', 'CAD')])('round-trips every whole amount', (minor, currency) => {
    expect(toMinor(fromMinor(minor, currency), currency)).toBe(minor)
  })
})
