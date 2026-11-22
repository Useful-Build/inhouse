import { describe, expect, it } from 'vitest'
import { CASES } from '../../../test/connectors/shopify/cases'
import { runCase } from '../../../test/connectors/shopify/run'
import { dataset as fixture } from '../../../test/upstreams/shopify/recordings/fixture/dataset'
import { checkDataset } from '../../../test/upstreams/shopify/dataset'
import { testUpstreamFetch } from '../../testing/index'
import { call, fakeClient, signInClient } from './test-kit'

// The fixture facts (brief section 7, "after the recording"): what the P0 seeding record (S4, 2026-11-19) says the read
// fixture store holds, checked through the tools against the recorded fixture. The expected values are literals from
// that record, an oracle independent of the recording: none is read back from the dataset.

type Item = Record<string, any>

/** Every page of a list tool, following nextCursor (bounded, so a cursor bug can't loop). */
async function allItems(name: string, input: Record<string, unknown>): Promise<Item[]> {
  const client = fakeClient(fixture)
  const items: Item[] = []
  let after: string | null = null
  for (let page = 0; page < 50; page++) {
    const r = await call(name, after ? { ...input, after } : input, client)
    if (!r.ok) throw new Error(`${name} failed: ${r.error.code}`)
    const v = r.value as { items: Item[]; nextCursor: string | null }
    items.push(...v.items)
    after = v.nextCursor
    if (!after) return items
  }
  throw new Error(`${name}: more than 50 pages`)
}

async function one(name: string, input: Record<string, unknown>): Promise<Item> {
  const r = await call(name, input, fakeClient(fixture))
  if (!r.ok) throw new Error(`${name} failed: ${r.error.code}`)
  return r.value as Item
}

describe('the test build defaults to the recorded fixture', () => {
  it('the registered upstream for example-fixture.myshopify.com answers from the fixture, not the hand dataset', async () => {
    const r = await call('inventory_levels_get', { sku: 'P4-0038' }, signInClient(testUpstreamFetch).client)
    if (!r.ok) throw new Error(r.error.code)
    expect((r.value as Item).matches[0].levels[0].available).toBe(-4)
  })
})

describe('the recorded fixture holds the seeded store', () => {
  it('300 orders and 150 products in USD, a well-formed dataset', async () => {
    const d = checkDataset(fixture)
    expect(d.apiVersion).toBe('2026-10')
    expect(d.currency).toBe('USD')
    expect((await allItems('orders_search', { first: 20 })).length).toBe(300)
    expect((await allItems('products_search', { first: 20 })).length).toBe(150)
  })

  it('order #1001 is paid and unfulfilled', async () => {
    const { order } = await one('order_get', { name: '#1001' })
    expect(order).toMatchObject({ name: '#1001', financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', cancelled: false })
  })

  it('21 refunds on the stove SKU P4-0062 since 2026-11-19, each "Igniter failed" and not restocked', async () => {
    const refunds = (await allItems('refunds_search', { createdFrom: '2026-11-19T00:00:00Z', sku: 'P4-0062', first: 10 })).filter(i =>
      (i.lines as Item[]).some(l => l.sku === 'P4-0062'),
    )
    expect(refunds).toHaveLength(21)
    for (const r of refunds) {
      expect(r.note).toBe('Igniter failed')
      for (const l of (r.lines as Item[]).filter(l => l.sku === 'P4-0062')) expect(l.restockType).toBe('NO_RESTOCK')
    }
  })

  it('11 open returns on the shell SKU P4-0089, none processed or restocked', async () => {
    const returns = (await allItems('returns_search', { sku: 'P4-0089', first: 5 })).filter(i =>
      (i.lines as Item[]).some(l => l.sku === 'P4-0089' && l.unprocessedQuantity > 0),
    )
    expect(returns).toHaveLength(11)
  })

  it('the run-out SKU P4-0013: 97 units ordered, 29 available', async () => {
    const lines = (await allItems('orders_search', { sku: 'P4-0013', first: 20 })).flatMap(o => o.lines as Item[]).filter(l => l.sku === 'P4-0013')
    expect(lines.reduce((s, l) => s + l.quantity, 0)).toBe(97)
    const stock = await one('inventory_levels_get', { sku: 'P4-0013' })
    expect(stock.matches).toHaveLength(1)
    // One location in the store.
    expect(stock.matches[0].levels).toHaveLength(1)
    expect(stock.matches[0].levels[0].available).toBe(29)
  })

  it('the oversold SKU P4-0038: -4 available, and below 1 in the catalogue', async () => {
    const stock = await one('inventory_levels_get', { sku: 'P4-0038' })
    expect(stock.matches[0].levels[0].available).toBe(-4)
    const low = await allItems('products_search', { stockBelow: 1, first: 20 })
    expect(low.some(p => (p.variants as Item[]).some(v => v.sku === 'P4-0038'))).toBe(true)
  })

  it('every fact in the live case list holds on the recording', async () => {
    const client = fakeClient(fixture)
    for (const c of CASES.filter(c => c.fact)) {
      const r = await runCase(c, client)
      if (!r.ok) throw new Error(`${c.name}: ${r.error.code}`)
      expect(c.fact!(r.value), c.name).toBeNull()
    }
  })
})
