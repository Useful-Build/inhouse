import { afterEach, describe, expect, it, vi } from 'vitest'
import { runLive } from '../../../test/connectors/shopify/live-run'
import { CASES } from '../../../test/connectors/shopify/cases'
import { createShopifyUpstream, TEST_CLIENT_ID, TEST_CLIENT_SECRET } from '../../../test/upstreams/shopify/server'
import { handDataset } from './test-kit'

// Test 10 of the brief's section 9: the live script's canary. It runs against the recorded upstream, which issues
// `shpat_test_<n>` tokens, with console spies over the whole run: no token, secret, body or header is ever printed.

const ENV = { SHOPIFY_SHOP: 'example-fixture', SHOPIFY_CLIENT_ID: TEST_CLIENT_ID, SHOPIFY_CLIENT_SECRET: TEST_CLIENT_SECRET }

describe('the live script', () => {
  afterEach(() => vi.restoreAllMocks())

  it('prints case names and outcomes only, never a token, secret, body or header', async () => {
    const printed: string[] = []
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a.map(String).join(' ')))
    const { failures } = await runLive(ENV, { upstream: createShopifyUpstream(handDataset), committed: handDataset })
    const all = printed.join('\n')
    expect(all).toContain('grant: ok, scopes match')
    for (const c of CASES) expect(all).toContain(`case ${c.name}: `)
    for (const leak of ['shpat_test', TEST_CLIENT_SECRET, 'X-Shopify', 'Trail lantern', 'Igniter', 'gid://', 'HX-00', '{"']) expect(all).not.toContain(leak)
    // The hand dataset isn't the fixture: its facts fail, and say so by case name.
    expect(failures.some(f => f.startsWith('case stock of the oversold SKU: fact: '))).toBe(true)
  })

  it('every case passes its non-fact checks against the recorded upstream (bounds, fields, differential)', async () => {
    const { failures } = await runLive(ENV, { upstream: createShopifyUpstream(handDataset), committed: handDataset, cases: CASES.map(c => ({ name: c.name, tool: c.tool, input: c.input, pages: c.pages })), print: () => {} })
    expect(failures).toEqual([])
  })

  it.each(['SHOPIFY_SHOP', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'])('fails, never skips, without %s', async key => {
    await expect(runLive({ ...ENV, [key]: undefined }, { upstream: createShopifyUpstream(handDataset), committed: handDataset, print: () => {} })).rejects.toThrow(/must be set/)
  })

  it('a scope mismatch fails at the grant', async () => {
    const { failures } = await runLive(ENV, {
      upstream: createShopifyUpstream(handDataset, { scope: ['read_orders', 'read_products', 'read_inventory', 'read_customers', 'read_locations'] }),
      committed: handDataset,
      print: () => {},
    })
    expect(failures).toEqual(['grant: scope_mismatch'])
  })
})
