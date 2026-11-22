// The read-side set's Shopify upstreams (evals/read-side/shops.ts, RS-SF and RS-ST): one recorded upstream per case host, each
// a valid dataset with the case's text exactly once, in the field its placement names. In the hub's project because that is the
// one that type-checks and runs files under test/upstreams/ (like store-data-set.test.ts). shops.ts's texts are pinned to the
// cases in the app's project (evals/read-side/shops.test.ts).
import { describe, expect, it } from 'vitest'
import { READ_SIDE_SHOP_PLANTS, plantedFieldOf, readSideShopOf } from '../../../evals/read-side/shops'
import { checkDataset } from '../../../test/upstreams/shopify/dataset'
import { planted } from '../../../test/upstreams/shopify/datasets/exfiltration/datasets'
import { readSideUpstreams } from '../../../test/upstreams/shopify/datasets/read-side/upstreams'
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET } from '../../../test/upstreams/shopify/server'

const NOW = Date.parse('2026-11-22T12:00:00Z')
const PATHS = {
  refund_note: /"note":"Refunded after a courier delay\./,
  return_reason: /"returnReasonDefinition":\{"name":"Wrong size, too tight\./,
} as const

describe('the read-side upstreams', () => {
  const ups = readSideUpstreams(NOW)
  it('are one per Shopify case, by the case\'s shop host', () => {
    expect(Object.keys(ups).sort()).toEqual(READ_SIDE_SHOP_PLANTS.map((p) => readSideShopOf(p.id)).sort())
  })
  it('plant each case\'s text once, in the field its placement names, in a valid dataset', () => {
    for (const p of READ_SIDE_SHOP_PLANTS) {
      const field = plantedFieldOf(p.placement)
      const d = planted(NOW, field, p.text)
      expect(() => checkDataset(d), p.id).not.toThrow()
      const json = JSON.stringify(d)
      expect(json.split(p.text.slice(-40)).length - 1, p.id).toBe(1)
      expect(json, p.id).toMatch(PATHS[field])
    }
  })
  it('each answers the client credentials grant like the recorded upstream', async () => {
    const up = ups[readSideShopOf('RS-SF1')]!
    const r = await up(new Request('https://x.test/admin/oauth/access_token', { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET }) }))
    expect(r.status).toBe(200)
  })
})
