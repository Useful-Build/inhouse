// A.5 at the Node level: each reference script, run as a plain async function over ScriptApi against the recorded
// fixture upstream (token and all), equals its oracle, stays under the S4 bound and passes the level 1 allowlist on
// every call. The workers project runs the same scripts in a real Dynamic Worker (measure.workers.test.ts).
import { describe, expect, it } from 'vitest'
import { checkShopifyFields } from '../../scope/fields'
import { ScriptApi } from '../api'
import { MAX_CALLS } from '../caps'
import { SHOPIFY_API_VERSION } from '../../connectors/shopify/documents'
import { createShopifyUpstream, TEST_CLIENT_ID, TEST_CLIENT_SECRET } from '../../../test/upstreams/shopify/server'
import { dataset } from '../../../test/upstreams/shopify/recordings/fixture/dataset'
import type { Dataset } from '../../../test/upstreams/shopify/dataset'
import { ASKED_AT, MAX_ANSWER_BYTES, MEASURE_CASES } from './scripts'
import { lowestStock, openReturnsNotRestocked, refundsByProductAndReason, unfulfilledOverThreeDays } from './oracle'

const d = dataset as Dataset
export const EXPECTED: Record<string, unknown> = {
  'lowest-stock': lowestStock(d),
  'unfulfilled-3-days': unfulfilledOverThreeDays(d, ASKED_AT),
  'refunds-by-product-reason': refundsByProductAndReason(d),
  'open-returns-not-restocked': openReturnsNotRestocked(d),
}

const BASE = 'https://example-fixture.myshopify.com'
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (arg: string, body: string) => (shop: unknown) => Promise<unknown>

async function client() {
  const upstream = createShopifyUpstream(dataset)
  const t = await upstream(
    new Request(`${BASE}/admin/oauth/access_token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET }),
    }),
  )
  const token = ((await t.json()) as { access_token: string }).access_token
  return {
    graphql: async (document: string, variables?: Record<string, unknown>, apiVersion?: string) => {
      if (!checkShopifyFields(document, variables).ok) throw new Error('field not allowed')
      const res = await upstream(
        new Request(`${BASE}/admin/api/${apiVersion}/graphql.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': token },
          body: JSON.stringify({ query: document, variables }),
        }),
      )
      const body = (await res.json()) as { data?: unknown; errors?: unknown }
      if (body.errors) throw new Error(`upstream errors: ${JSON.stringify(body.errors)}`)
      return { ok: true as const, value: { data: body.data } }
    },
  }
}

describe('the S4 measurement (Node level)', () => {
  for (const c of MEASURE_CASES) {
    it(`${c.id}: equals its oracle, within ${MAX_ANSWER_BYTES} bytes and ${MAX_CALLS} calls`, async () => {
      const api = new ScriptApi(await client(), SHOPIFY_API_VERSION)
      const result = await new AsyncFunction('shop', c.code)(api)
      const json = JSON.stringify(result)
      expect(JSON.parse(json)).toEqual(EXPECTED[c.id])
      expect(new TextEncoder().encode(json).byteLength).toBeLessThanOrEqual(MAX_ANSWER_BYTES)
      expect(api.calls).toBeLessThanOrEqual(MAX_CALLS)
    })
  }

  it('the oracles found something to find (the cases can fail)', () => {
    expect((EXPECTED['unfulfilled-3-days'] as { count: number }).count).toBeGreaterThan(0)
    expect((EXPECTED['refunds-by-product-reason'] as { groups: number }).groups).toBeGreaterThan(0)
    expect((EXPECTED['open-returns-not-restocked'] as { returns: number }).returns).toBeGreaterThan(0)
    expect((EXPECTED['lowest-stock'] as { lowest: unknown[] }).lowest).toHaveLength(5)
  })
})
