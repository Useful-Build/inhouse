import { exports } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CallerScope, HubResult, ToolInfo } from '../../index/contract'
import { testUpstreams } from '../../testing/index'
import { createShopifyUpstream } from '../../../test/upstreams/shopify/server'
import { SHOPIFY_READ_SCOPES } from './documents'
import { call, fakeClient, handDataset } from './test-kit'

// The Shopify tools through the Worker's ReadGateway, under workerd, against the recorded upstream (CI only). Each test
// registers the upstream itself: H0's workerd tests set and delete the same host.

const HOST = 'example-fixture.myshopify.com'
const run: CallerScope = { kind: 'run', runId: 'run-1', principalId: 'principal-1', requestId: 'req-1' }
const NAMES = ['orders_search', 'order_get', 'refunds_search', 'returns_search', 'products_search', 'inventory_levels_get']
const INPUTS: [string, Record<string, unknown>][] = [
  ['orders_search', { financialStatus: 'paid', first: 20 }],
  ['order_get', { name: '#1006' }],
  ['refunds_search', { createdFrom: '2026-11-19T00:00:00Z', sku: 'HX-0062' }],
  ['returns_search', { sku: 'HX-0089' }],
  ['products_search', { stockBelow: 1 }],
  ['inventory_levels_get', { sku: 'HX-0038' }],
]

beforeEach(async () => {
  await reset()
  testUpstreams.set(HOST, createShopifyUpstream(handDataset))
})
afterEach(() => {
  testUpstreams.delete(HOST)
})

describe('the Shopify tools through ReadGateway', () => {
  it('listTools includes the six with their JSON schemas', async () => {
    // RPC result types intersect with Disposable, which defeats narrowing: cast to the contract type.
    const r = (await exports.ReadGateway.listTools(run)) as HubResult<ToolInfo[]>
    if (!r.ok) throw new Error(`listTools failed: ${r.error.code}`)
    const shopify = r.value.filter(t => NAMES.includes(t.name))
    expect(shopify.map(t => t.name).sort()).toEqual([...NAMES].sort())
    for (const t of shopify) {
      expect(t.connector).toBe('shopify')
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
    }
  })

  for (const [name, input] of INPUTS) {
    it(`callTool ${name} returns what the node-level call returns`, async () => {
      const expected = await call(name, input, fakeClient(handDataset))
      if (!expected.ok) throw new Error(`node-level ${name} failed: ${expected.error.code}`)
      expect(await exports.ReadGateway.callTool(run, name, input)).toEqual({ ok: true, value: { data: expected.value } })
    })
  }

  it('a write-scoped grant is scope_mismatch', async () => {
    testUpstreams.set(HOST, createShopifyUpstream(handDataset, { scope: [...SHOPIFY_READ_SCOPES, 'write_orders'] }))
    expect(await exports.ReadGateway.callTool(run, 'orders_search', {})).toMatchObject({ ok: false, error: { code: 'scope_mismatch' } })
  })

  it('another API version is upstream_version_mismatch', async () => {
    testUpstreams.set(HOST, createShopifyUpstream({ ...(structuredClone(handDataset) as object), apiVersion: '2026-07' }))
    expect(await exports.ReadGateway.callTool(run, 'orders_search', {})).toMatchObject({ ok: false, error: { code: 'upstream_version_mismatch' } })
  })

  it('throttled is rate_limited with retryAfterMs', async () => {
    testUpstreams.set(HOST, createShopifyUpstream(handDataset, { faults: ['throttled'] }))
    const r = (await exports.ReadGateway.callTool(run, 'orders_search', { first: 20 })) as HubResult<unknown>
    expect(r).toMatchObject({ ok: false, error: { code: 'rate_limited' } })
    if (!r.ok) expect(r.error.retryAfterMs).toBeGreaterThanOrEqual(1000)
  })

  it('bad input is invalid_args before any upstream call', async () => {
    expect(await exports.ReadGateway.callTool(run, 'inventory_levels_get', { sku: 'a', productId: 'b' })).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
  })
})
