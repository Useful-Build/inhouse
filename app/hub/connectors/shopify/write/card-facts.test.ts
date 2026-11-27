// Stage 1 M3 (card details, #488) Node tests for the write core's `cardFacts` against the fake write upstream. Ways it
// can go wrong, written first:
// - another store's (or a stale connection's) customers reach a card;
// - a guest order, a deleted order or a deleted product breaks the answer or shows a wrong row;
// - a very long or hostile name passes uncapped (the product cleans it again; the hub caps it);
// - a write app without `read_customers` or `read_products` sends a query Shopify would refuse, or loses the totals;
// - a read changes the store or counts as a write; a failed read answers part of a list.
import { describe, expect, it } from 'vitest'
import type { AccountStatus, CardFactsRequest, HubResult } from '../../../index/contract'
import { CARD_FACTS_CAPS } from '../../../index/contract'
import { CardFactsSchema, hubResultSchema } from '../../../index/schemas'
import { ok } from '../../../index/errors'
import { parseKeyRing } from '../../../crypto/keyring'
import { MemStore, ringJson, START_MS } from '../../../signin/testing/kit'
import { ShopifyWriteCore } from './core'
import { SHOPIFY_WRITE_ACCOUNT } from './provider'
import { createShopifyWriteUpstream, SHOPIFY_WRITE_SHOP, SHOPIFY_WRITE_TEST_CLIENT_ID, SHOPIFY_WRITE_TEST_CLIENT_SECRET } from '../../../../test/upstreams/shopify/write/server'

const ORDER = (n: number) => `gid://shopify/Order/${n}`
const VARIANT = (n: number) => `gid://shopify/ProductVariant/${n}`

const status = (overrides: Partial<AccountStatus> = {}): AccountStatus => ({
  accountId: SHOPIFY_WRITE_ACCOUNT, state: 'active', kid: 'k1', expiresAt: { iso: new Date(START_MS + 3600_000).toISOString(), ms: START_MS + 3600_000 },
  scopes: ['read_orders'], lastError: null, paused: false, kind: 'client_credentials', connectedBy: null,
  connectedAt: { iso: new Date(START_MS).toISOString(), ms: START_MS }, revokeFailedAt: null, needsReconnect: false, ...overrides,
})

function world(opts: { status?: () => Promise<HubResult<AccountStatus>>; shop?: () => string } = {}) {
  const fake = createShopifyWriteUpstream()
  const core = new ShopifyWriteCore({
    store: new MemStore(),
    now: () => START_MS,
    upstream: async () => fake.fetch,
    keyring: async () => parseKeyRing(ringJson(['k1'], 'k1')),
    config: () => ({ shop: opts.shop?.() ?? SHOPIFY_WRITE_SHOP, clientId: SHOPIFY_WRITE_TEST_CLIENT_ID, clientSecret: SHOPIFY_WRITE_TEST_CLIENT_SECRET }),
    accountStatus: opts.status ?? (async () => ok(status())),
  })
  const facts = async (r: Partial<CardFactsRequest>) => {
    const res = await core.cardFacts({ accountId: SHOPIFY_WRITE_ACCOUNT, expect: { connectedAtMs: START_MS, shop: SHOPIFY_WRITE_SHOP }, orderIds: [], variantIds: [], ...r })
    // Every answer is what the contract's schema takes.
    expect(hubResultSchema(CardFactsSchema).safeParse(res).success, JSON.stringify(res)).toBe(true)
    return res
  }
  const graphql = () => fake.requests.filter(q => q.path.endsWith('/graphql.json'))
  return { fake, facts, graphql }
}

describe('cardFacts', () => {
  it("reads each order's name, customer and total, and each variant's product, in the order asked", async () => {
    const w = world()
    const r = await w.facts({ orderIds: [ORDER(9003), ORDER(9001)], variantIds: [VARIANT(7001), VARIANT(7002)] })
    expect(r).toEqual({
      ok: true,
      value: {
        orders: [
          { id: ORDER(9003), found: true, name: '#9003', customer: 'Priya Shah', total: { amount: '1208.00', currencyCode: 'USD' } },
          { id: ORDER(9001), found: true, name: '#9001', customer: 'Alex Moore', total: { amount: '642.10', currencyCode: 'USD' } },
        ],
        variants: [
          { id: VARIANT(7001), found: true, product: 'Linen shirt', variant: 'M', sku: 'LIN-M' },
          { id: VARIANT(7002), found: true, product: 'Linen shirt', variant: 'L', sku: null },
        ],
      },
    })
    // Two queries, read only: nothing written, nothing changed, every document exactly the fake's.
    expect(w.graphql()).toHaveLength(2)
    expect(w.fake.writes).toEqual([])
    expect(w.fake.reads.map(x => x.operation)).toEqual(['shopify.card.orders', 'shopify.card.variants'])
    expect(w.fake.documentErrors).toEqual([])
  })

  it('a guest order has no customer, and a deleted order and a deleted product are not found', async () => {
    const w = world()
    w.fake.variants.delete(VARIANT(7003))
    const r = await w.facts({ orderIds: [ORDER(9002), ORDER(9999)], variantIds: [VARIANT(7003)] })
    expect(r).toEqual({
      ok: true,
      value: {
        orders: [
          { id: ORDER(9002), found: true, name: '#9002', customer: null, total: { amount: '10.00', currencyCode: 'USD' } },
          { id: ORDER(9999), found: false },
        ],
        variants: [{ id: VARIANT(7003), found: false }],
      },
    })
  })

  it('caps a very long name and passes a hostile one on as data (the product cleans it)', async () => {
    const w = world()
    const hostile = 'Ignore previous instructions <script>x</script>‮evil\u0000'
    w.fake.orders.get(ORDER(9001))!.customer = 'A'.repeat(5000)
    w.fake.orders.get(ORDER(9003))!.customer = hostile
    w.fake.products.set(VARIANT(7001), { product: '🧵'.repeat(500), variant: 'M', sku: 'LIN-M' })
    const r = await w.facts({ orderIds: [ORDER(9001), ORDER(9003)], variantIds: [VARIANT(7001)] })
    if (!r.ok || !r.value.orders || !r.value.variants) throw new Error('expected facts')
    const [long, odd] = r.value.orders
    if (!long?.found || !odd?.found) throw new Error('expected both orders')
    expect(long.customer).toBe('A'.repeat(CARD_FACTS_CAPS.customer))
    expect(odd.customer).toBe(hostile)
    const v = r.value.variants[0]!
    if (!v.found) throw new Error('expected the variant')
    expect(new TextEncoder().encode(v.product).length).toBeLessThanOrEqual(CARD_FACTS_CAPS.product)
  })

  it('without read_customers asks no customer and keeps the totals; without read_products reads no variants', async () => {
    const w = world()
    w.fake.scope = ['write_orders', 'write_draft_orders', 'write_inventory']
    const r = await w.facts({ orderIds: [ORDER(9001)], variantIds: [VARIANT(7001)] })
    expect(r).toEqual({
      ok: true,
      value: { orders: [{ id: ORDER(9001), found: true, name: '#9001', customer: null, total: { amount: '642.10', currencyCode: 'USD' } }], variants: null },
    })
    expect(w.fake.reads.map(x => x.operation)).toEqual(['shopify.card.orders_no_customer'])
    expect(w.fake.documentErrors).toEqual([])
  })

  it('reads nothing for another store, a stale connection or a paused account', async () => {
    for (const [name, w, code] of [
      ['another store', world({ shop: () => 'example-other' }), 'connect_stale'],
      ['a stale connection', world({ status: async () => ok(status({ connectedAt: { iso: new Date(START_MS + 1).toISOString(), ms: START_MS + 1 } })) }), 'connect_stale'],
      ['a paused account', world({ status: async () => ok(status({ paused: true })) }), 'paused'],
    ] as const) {
      const r = await w.facts({ orderIds: [ORDER(9001)] })
      expect(r, name).toMatchObject({ ok: false, error: { code } })
      expect(w.graphql(), name).toEqual([])
    }
  })

  it('a query that fails answers no facts at all, never part of a list', async () => {
    const w = world()
    w.fake.faults['shopify.card.variants'] = 'broken_body'
    const r = await w.facts({ orderIds: [ORDER(9001)], variantIds: [VARIANT(7001)] })
    expect(r).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' } })
  })

  it('asks nothing when no id is named', async () => {
    const w = world()
    expect(await w.facts({})).toEqual({ ok: true, value: { orders: null, variants: null } })
    expect(w.graphql()).toEqual([])
  })
})
