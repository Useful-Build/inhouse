import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { checkDataset } from '../../../test/upstreams/shopify/dataset'
import { createShopifyUpstream, SHOPIFY_UPSTREAM_CANARY, TEST_CLIENT_ID, TEST_CLIENT_SECRET, type Fault } from '../../../test/upstreams/shopify/server'
import { currentDocumentHashes, ORDERS_SEARCH, PRODUCTS_SEARCH, SHOPIFY_READ_SCOPES } from './documents'
import { call, fakeClient, handDataset } from './test-kit'
import { FINANCIAL_STATUSES, FULFILLMENT_STATUSES, RETURN_STATUSES, variablesFor as ordersVariables } from './tools/orders-search'
import { variablesFor as productsVariables } from './tools/products-search'

// Test 6 of the brief's section 9: the recorded upstream's semantics, refusals, grant and faults.

const HOST = 'https://example-fixture.myshopify.com'
type Upstream = ReturnType<typeof createShopifyUpstream>

async function grant(up: Upstream, secret = TEST_CLIENT_SECRET): Promise<Response> {
  return up(
    new Request(`${HOST}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: TEST_CLIENT_ID, client_secret: secret }).toString(),
    }),
  )
}
async function token(up: Upstream): Promise<string> {
  return ((await (await grant(up)).json()) as { access_token: string }).access_token
}
async function post(up: Upstream, tok: string, query: string, variables: Record<string, unknown> = {}, version = '2026-10') {
  const res = await up(
    new Request(`${HOST}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': tok },
      body: JSON.stringify({ query, variables }),
    }),
  )
  return { res, body: res.status === 200 ? ((await res.json()) as any) : null }
}

describe('paging (a property)', () => {
  const skus = ['HX-0013', 'HX-0062', 'HX-0038', 'HX-1001', 'NONE']
  test.prop([
    fc.record(
      {
        financialStatus: fc.constantFrom(...FINANCIAL_STATUSES),
        fulfillmentStatus: fc.constantFrom(...FULFILLMENT_STATUSES),
        returnStatus: fc.constantFrom(...RETURN_STATUSES),
        sku: fc.constantFrom(...skus),
        processedFrom: fc.constantFrom('2026-11-09T00:00:00Z', '2026-11-12T10:30:00Z', '2026-11-15T00:00:00Z'),
        processedTo: fc.constantFrom('2026-11-13T00:00:00Z', '2026-11-16T11:05:00Z', '2026-12-01T00:00:00Z'),
      },
      { requiredKeys: [] },
    ),
    fc.integer({ min: 1, max: 20 }),
  ])('orders: every matching node exactly once, for any filters and page size', async (filters, first) => {
    const up = createShopifyUpstream(handDataset)
    const tok = await token(up)
    const all = await post(up, tok, ORDERS_SEARCH, { ...ordersVariables(filters), first: 250 })
    const expected = (all.body.data.orders.nodes as { id: string }[]).map(n => n.id)
    const seen: string[] = []
    let after: string | null = null
    for (let i = 0; i < 20; i++) {
      const r = await call('orders_search', { ...filters, first, ...(after ? { after } : {}) }, fakeClient())
      if (!r.ok) throw new Error(r.error.code)
      const v = r.value as { items: { id: string }[]; nextCursor: string | null }
      // A fresh client per page: cursors are a function of the data and query, not of the session.
      seen.push(...v.items.map(x => x.id))
      after = v.nextCursor
      if (!after) break
    }
    expect(after).toBeNull()
    expect(seen).toEqual(expected)
    expect(new Set(seen).size).toBe(seen.length)
  })

  test.prop([
    fc.record({ status: fc.constantFrom('active', 'draft', 'archived' as const), stockBelow: fc.integer({ min: -5, max: 100 }), text: fc.constantFrom('camp', 'HX-0089', 'tr') }, { requiredKeys: [] }),
    fc.integer({ min: 1, max: 20 }),
  ])('products: every matching node exactly once', async (filters, first) => {
    const up = createShopifyUpstream(handDataset)
    const tok = await token(up)
    const all = await post(up, tok, PRODUCTS_SEARCH, { ...productsVariables(filters as never), first: 250 })
    const expected = (all.body.data.products.nodes as { id: string }[]).map(n => n.id)
    const seen: string[] = []
    let after: string | null = null
    for (let i = 0; i < 10; i++) {
      const r = await call('products_search', { ...filters, first, ...(after ? { after } : {}) }, fakeClient())
      if (!r.ok) throw new Error(r.error.code)
      const v = r.value as { items: { id: string }[]; nextCursor: string | null }
      seen.push(...v.items.map(x => x.id))
      after = v.nextCursor
      if (!after) break
    }
    expect(seen).toEqual(expected)
  })

  it('a cursor from another query fails', async () => {
    const one = await call('orders_search', { first: 2 }, fakeClient())
    if (!one.ok) throw new Error(one.error.code)
    const after = (one.value as { nextCursor: string }).nextCursor
    expect(await call('orders_search', { first: 2, after, sku: 'HX-0013' }, fakeClient())).toMatchObject({ ok: false, error: { code: 'upstream_rejected' } })
    expect(await call('products_search', { first: 2, after }, fakeClient())).toMatchObject({ ok: false, error: { code: 'upstream_rejected' } })
    expect(await call('orders_search', { first: 2, after: 'bm90LWEtY3Vyc29y' }, fakeClient())).toMatchObject({ ok: false, error: { code: 'upstream_rejected' } })
  })

  it('is deterministic', async () => {
    const a = createShopifyUpstream(handDataset)
    const b = createShopifyUpstream(handDataset)
    const x = await post(a, await token(a), ORDERS_SEARCH, { first: 3 })
    const y = await post(b, await token(b), ORDERS_SEARCH, { first: 3 })
    expect(x.body).toEqual(y.body)
  })
})

describe('refusals', () => {
  it('a mutation, an anonymous query and an unknown operation answer ACCESS_DENIED, with the canary', async () => {
    const up = createShopifyUpstream(handDataset)
    const tok = await token(up)
    for (const q of ['mutation M { orderCancel(orderId: "1") { job { id } } }', '{ shop { name } }', 'query Other { shop { name } }', 'subscription S { x }']) {
      const { body } = await post(up, tok, q)
      expect(body.errors[0].extensions.code).toBe('ACCESS_DENIED')
      expect(body.errors[0].message).toContain(SHOPIFY_UPSTREAM_CANARY)
      expect(body.data).toBeUndefined()
    }
  })

  it('a changed document answers RE_RECORD_NEEDED, and so does a dataset recorded with another document', async () => {
    const up = createShopifyUpstream(handDataset)
    const tok = await token(up)
    const changed = ORDERS_SEARCH.replace('cancelledAt', 'cancelledAt note')
    expect((await post(up, tok, changed, { first: 1 })).body.errors[0].extensions.code).toBe('RE_RECORD_NEEDED')
    const stale = structuredClone(handDataset) as any
    stale.documentHashes.OrdersSearch = '00000000'
    const up2 = createShopifyUpstream(stale)
    expect((await post(up2, await token(up2), ORDERS_SEARCH, { first: 1 })).body.errors[0].extensions.code).toBe('RE_RECORD_NEEDED')
  })

  it('a query outside the recorded grammar is a GraphQL error', async () => {
    const up = createShopifyUpstream(handDataset)
    const { body } = await post(up, await token(up), ORDERS_SEARCH, { first: 1, query: 'sku:HX-0013' })
    expect(body.errors[0].extensions.code).toBe('INVALID_SEARCH')
  })

  it('first above 250 is refused', async () => {
    const up = createShopifyUpstream(handDataset)
    const { body } = await post(up, await token(up), ORDERS_SEARCH, { first: 251 })
    expect(body.errors[0].extensions.code).toBe('BAD_REQUEST')
  })

  it('reports a cost and a bucket', async () => {
    const up = createShopifyUpstream(handDataset)
    const { body } = await post(up, await token(up), ORDERS_SEARCH, { first: 20 })
    expect(body.extensions.cost.requestedQueryCost).toBeGreaterThan(0)
    expect(body.extensions.cost.throttleStatus).toMatchObject({ maximumAvailable: 2000, restoreRate: 100 })
  })
})

describe('grant, token and version', () => {
  it('grants the five scopes for the test credentials, counting tokens per instance', async () => {
    const up = createShopifyUpstream(handDataset)
    const one = (await (await grant(up)).json()) as Record<string, unknown>
    expect(one).toEqual({ access_token: 'shpat_test_1', scope: SHOPIFY_READ_SCOPES.join(','), expires_in: 86399 })
    expect(((await (await grant(up)).json()) as { access_token: string }).access_token).toBe('shpat_test_2')
  })

  it('refuses a wrong secret and an unknown token with 401', async () => {
    const up = createShopifyUpstream(handDataset)
    expect((await grant(up, 'wrong')).status).toBe(401)
    expect((await post(up, 'shpat_test_1', ORDERS_SEARCH, { first: 1 })).res.status).toBe(401)
  })

  it('a token from another instance is unknown here', async () => {
    const a = createShopifyUpstream(handDataset)
    const b = createShopifyUpstream(handDataset)
    await token(a)
    await token(a)
    expect((await post(b, 'shpat_test_2', ORDERS_SEARCH, { first: 1 })).res.status).toBe(401)
  })

  it('another API version answers with the dataset version header (upstream_version_mismatch at the hub)', async () => {
    const up = createShopifyUpstream(handDataset)
    const { res } = await post(up, await token(up), ORDERS_SEARCH, { first: 1 }, '2026-07')
    expect(res.headers.get('X-Shopify-API-Version')).toBe('2026-10')
    const old = { ...(structuredClone(handDataset) as object), apiVersion: '2026-07' }
    expect(await call('orders_search', {}, fakeClient(old))).toMatchObject({ ok: false, error: { code: 'upstream_version_mismatch' } })
  })

  it('the scope option grants another list (scope_mismatch end to end)', async () => {
    expect(await call('orders_search', {}, fakeClient(handDataset, { scope: [...SHOPIFY_READ_SCOPES, 'write_orders'] }))).toMatchObject({ ok: false, error: { code: 'scope_mismatch' } })
    expect(await call('orders_search', {}, fakeClient(handDataset, { scope: ['read_orders', 'read_products', 'read_inventory', 'read_customers', 'read_locations'] }))).toMatchObject({
      ok: false,
      error: { code: 'scope_mismatch' },
    })
  })
})

describe('faults', () => {
  it.each<[Fault, Record<string, unknown>]>([
    ['throttled', { ok: false, error: { code: 'rate_limited' } }],
    ['server-error', { ok: false, error: { code: 'upstream_unavailable' } }],
    ['oversize-body', { ok: false, error: { code: 'result_too_large' } }],
    ['unauthorized-once', { ok: true }],
  ])('%s', async (fault, expected) => {
    const r = await call('orders_search', { first: 20 }, fakeClient(handDataset, { faults: [fault] }))
    expect(r).toMatchObject(expected)
    if (fault === 'throttled' && !r.ok) expect(r.error.retryAfterMs).toBeGreaterThanOrEqual(1000)
  })
})

describe('the dataset checker', () => {
  it('accepts the hand dataset', () => {
    expect(() => checkDataset(handDataset)).not.toThrow()
    expect((handDataset as { documentHashes: unknown }).documentHashes).toEqual(currentDocumentHashes())
  })

  it.each<[string, (d: any) => void]>([
    ['a missing field', d => delete d.orders[0].processedAt],
    ['an unknown field', d => (d.orders[0].email = 'x@example.com')],
    ['a bad gid', d => (d.products[0].id = '7')],
    ['a duplicate id', d => (d.orders[1].id = d.orders[0].id)],
    ['a local instant', d => (d.orders[0].processedAt = '2026-11-14T09:00:00')],
    ['a bad version', d => (d.apiVersion = '2026-11')],
    ['a float quantity', d => (d.orders[0].lineItems.nodes[0].currentQuantity = 1.5)],
  ])('throws on %s', (_, change) => {
    const d = structuredClone(handDataset)
    change(d)
    expect(() => checkDataset(d)).toThrow(/shopify dataset/)
    expect(() => createShopifyUpstream(d)).toThrow(/shopify dataset/)
  })
})
