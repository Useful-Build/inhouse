// The hub's read-side shops must plant exactly what each Shopify case says it plants: a drift would leave a case reading a store
// without its instruction (never exposed) or with another case's canary. The upstreams themselves are checked in the hub's
// project (hub/connectors/shopify/read-side-set.test.ts), the one that type-checks files under test/upstreams/.
import { describe, expect, it } from 'vitest'
import { READ_SIDE_CASES } from './cases.ts'
import { READ_SIDE_SHOPS } from './product/setup.ts'
import { READ_SIDE_SHOP_PLANTS, plantedFieldOf, readSideShopOf } from './shops.ts'

describe('the read-side shops', () => {
  it('hold every Shopify case\'s placement and planted text, and nothing else', () => {
    expect(READ_SIDE_SHOP_PLANTS).toEqual(READ_SIDE_CASES.filter((c) => c.source === 'shopify').map((c) => ({ id: c.id, placement: c.placement, text: c.text })))
    for (const p of READ_SIDE_SHOP_PLANTS) expect(() => plantedFieldOf(p.placement)).not.toThrow()
  })
  it('are the only hosts the runner\'s shop door may write', () => {
    expect([...READ_SIDE_SHOPS].sort()).toEqual(READ_SIDE_SHOP_PLANTS.map((p) => readSideShopOf(p.id)).sort())
    expect([...READ_SIDE_SHOPS].every((h) => /^example-rs-rs-[a-z]{2}[0-9]\.myshopify\.com$/.test(h))).toBe(true)
  })
})
