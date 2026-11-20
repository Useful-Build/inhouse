import { fc, test } from '@fast-check/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HubErrorCode } from '../../index/contract'
import { err } from '../../index/errors'
import { buildRegistry, callReadTool, listReadTools, MAX_DESCRIPTION } from '../../registry/registry'
import { checkGrantedScopes } from '../../scope/scopes'
import { SHOPIFY_READ_SCOPES } from './documents'
import { shopifyConnector } from './route'
import { call, ctxFor, dataClient, fakeClient, MAXIMAL, signInClient, TOOLS, handDataset } from './test-kit'
import { createShopifyUpstream } from '../../../test/upstreams/shopify/server'

// Tests 2, 7 and 8 of the brief's section 9, the connector's registration and scopes, and the tools' behaviour on the
// hand dataset's planted cases.

type Items<T = Record<string, unknown>> = { items: T[]; nextCursor: string | null }
const value = async <T>(name: string, input: unknown, client = fakeClient()): Promise<T> => {
  const r = await call(name, input, client)
  if (!r.ok) throw new Error(`${name} failed: ${r.error.code}`)
  return r.value as T
}

describe('registration', () => {
  it('builds in the registry with six resource_action tools, each description within 1,024 characters', () => {
    const registry = buildRegistry([shopifyConnector])
    expect([...registry.tools.keys()]).toEqual(['orders_search', 'order_get', 'refunds_search', 'returns_search', 'products_search', 'inventory_levels_get'])
    for (const t of registry.tools.values()) {
      expect(t.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION)
      expect(t.description).toMatch(/\S/)
    }
    const listed = listReadTools({ registry, isConfigured: () => true, shopifyFor: () => dataClient({}), nowMs: () => 0 })
    expect(listed).toHaveLength(6)
    for (const t of listed) expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it('say customer data is never available where a tool returns order data', () => {
    for (const name of ['orders_search', 'order_get']) expect(TOOLS[name]!.tool.description).toContain('Customer names, emails, phones and addresses are never available')
  })

  it('read and required are exactly the five scopes, with no write_* and no read_customers', () => {
    expect([...shopifyConnector.scopes.read]).toEqual([...SHOPIFY_READ_SCOPES])
    expect([...shopifyConnector.scopes.required]).toEqual([...SHOPIFY_READ_SCOPES])
    expect(SHOPIFY_READ_SCOPES).toEqual(['read_orders', 'read_products', 'read_inventory', 'read_locations', 'read_returns'])
    expect(shopifyConnector.apiVersion).toBe('2026-10')
  })

  it.each([
    ['read_orders,read_products,read_inventory,read_locations,read_returns', true],
    ['read_returns, read_locations,read_inventory,read_products,read_orders', true],
    ['read_products,read_orders,read_inventory,read_customers,read_locations', false], // the fixture app's P0 grant
    ['read_orders,read_products,read_inventory,read_locations,read_returns,read_customers', false],
    ['read_orders,read_products,read_inventory,read_locations,read_returns,write_orders', false],
    ['read_orders,read_products,read_inventory,read_locations', false],
    ['read_orders,read_products,read_inventory,read_locations,read_returns,read_all_orders', false],
  ])('a grant of %s passes: %s', (granted, pass) => {
    expect(checkGrantedScopes(granted, shopifyConnector.scopes).ok).toBe(pass)
  })
})

describe('never throws, maps loud (test 2)', () => {
  for (const name of Object.keys(TOOLS)) {
    test.prop([fc.anything()])(`${name}: arbitrary data is ok or upstream_unavailable`, async data => {
      const r = await call(name, MAXIMAL[name]!.input, dataClient(data))
      expect(r.ok || r.error.code === 'upstream_unavailable').toBe(true)
    })

    test.prop([fc.integer(), fc.constantFrom('missing', 'null', 'number', 'string', 'array', 'amount', 'enum', 'money')])(
      `${name}: a shape-near mutation is ok or upstream_unavailable`,
      async (seed, kind) => {
        const data = structuredClone(MAXIMAL[name]!.data)
        mutate(data, seed, kind)
        const r = await call(name, MAXIMAL[name]!.input, dataClient(data))
        expect(r.ok || r.error.code === 'upstream_unavailable').toBe(true)
      },
    )
  }

  it.each([
    ['a bad amount', (d: any) => (d.orders.nodes[0].currentTotalPriceSet.shopMoney.amount = '1.234')],
    ['a word amount', (d: any) => (d.orders.nodes[0].totalRefundedSet.shopMoney.amount = 'abc')],
    ['an unknown enum', (d: any) => (d.orders.nodes[0].displayFulfillmentStatus = 'unfulfilled')],
    ['a missing field', (d: any) => delete d.orders.nodes[0].processedAt],
    ['a bad id', (d: any) => (d.orders.nodes[0].id = '1001')],
    ['more nodes than asked', (d: any) => d.orders.nodes.push(d.orders.nodes[0])],
    ['more lines than asked', (d: any) => d.orders.nodes[0].lineItems.nodes.push(d.orders.nodes[0].lineItems.nodes[0])],
    ['a next page without a cursor', (d: any) => (d.orders.pageInfo.endCursor = null)],
    ['an out-of-range quantity', (d: any) => (d.orders.nodes[0].lineItems.nodes[0].currentQuantity = 2 ** 40)],
  ])('%s is upstream_unavailable', async (_, change) => {
    const data = structuredClone(MAXIMAL.orders_search!.data)
    change(data)
    expect(await call('orders_search', MAXIMAL.orders_search!.input, dataClient(data))).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' } })
  })

  const codes: HubErrorCode[] = [
    'invalid_args',
    'write_refused',
    'not_configured',
    'credentials_rejected',
    'scope_mismatch',
    'key_unavailable',
    'upstream_unavailable',
    'upstream_rejected',
    'upstream_version_mismatch',
    'rate_limited',
    'result_too_large',
    'internal',
  ]
  it.each(codes)('a client %s passes through as is', async code => {
    const e = err(code, undefined, code === 'rate_limited' ? 4000 : undefined)
    for (const name of Object.keys(TOOLS)) {
      expect(await call(name, MAXIMAL[name]!.input, { graphql: async () => e })).toEqual(e)
    }
  })
})

/** Changes one value somewhere in `data`, chosen by `seed`. */
function mutate(data: unknown, seed: number, kind: string) {
  const slots: { parent: Record<string, unknown> | unknown[]; key: string | number }[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        slots.push({ parent: v, key: i })
        walk(x)
      })
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        slots.push({ parent: v as Record<string, unknown>, key: k })
        walk(x)
      }
    }
  }
  walk(data)
  const slot = slots[Math.abs(seed) % slots.length]!
  const p = slot.parent as Record<string | number, unknown>
  const replacement: Record<string, unknown> = { null: null, number: 12.5, string: 'x', array: [], amount: '1.234', enum: 'lower case', money: { shopMoney: { amount: '1', currencyCode: 'usd' } } }
  if (kind === 'missing') {
    if (Array.isArray(p)) p.splice(slot.key as number, 1)
    else delete p[slot.key]
  } else p[slot.key] = replacement[kind]
}

describe('refunds_search: the window before the cap', () => {
  const refund = (createdAt: string) => ({
    createdAt,
    note: `refund ${createdAt.slice(5, 10)}`,
    totalRefundedSet: { shopMoney: { amount: '1.00', currencyCode: 'USD' } },
    refundLineItems: { nodes: [], pageInfo: { hasNextPage: false } },
  })
  const data = (...dates: string[]) => ({
    orders: { nodes: [{ id: 'gid://shopify/Order/1', name: '#1', refunds: dates.map(refund) }], pageInfo: { hasNextPage: false, endCursor: null } },
  })
  const notes = async (dates: string[], input: Record<string, unknown>) => {
    const v = await value<Items<{ note: string; moreRefunds: boolean }>>('refunds_search', input, dataClient(data(...dates)))
    return { notes: v.items.map(i => i.note), more: v.items.map(i => i.moreRefunds) }
  }

  it('an in-window refund after out-of-window ones still shows', async () => {
    expect(await notes(['2026-11-10T09:00:00Z', '2026-11-12T09:00:00Z', '2026-11-19T09:00:00Z'], { createdFrom: '2026-11-19T00:00:00Z' })).toEqual({
      notes: ['refund 11-19'],
      more: [false],
    })
  })

  it('more in the window than the cap says moreRefunds', async () => {
    const r = await notes(['2026-11-19T09:00:00Z', '2026-11-19T10:00:00Z', '2026-11-19T11:00:00Z'], { createdFrom: '2026-11-19T00:00:00Z' })
    expect(r).toEqual({ notes: ['refund 11-19', 'refund 11-19'], more: [true, true] })
  })

  it('a list that came back full says moreRefunds', async () => {
    const dates = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-19'].map(d => `${d}T09:00:00Z`)
    expect(await notes(dates, { createdFrom: '2026-11-19T00:00:00Z' })).toEqual({ notes: ['refund 11-19'], more: [true] })
  })
})

describe('inputs never make run throw (fuzzed through the gateway)', () => {
  const scope = { kind: 'server', job: 'test', requestId: 'r' } as const
  const deps = {
    registry: buildRegistry([shopifyConnector]),
    isConfigured: () => true,
    shopifyFor: () => dataClient({}),
    nowMs: () => 0,
  }
  const pad = (n: number, w: number) => String(n).padStart(w, '0')
  const instantish = fc.oneof(
    fc.constantFrom('0000-01-01T00:00:00+01:00', '9999-12-31T23:59:59-01:00', '0001-01-01T00:00:00Z', '9999-12-31T23:59:59Z'),
    fc
      .tuple(fc.integer({ min: 0, max: 9999 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }), fc.integer({ min: -23, max: 23 }), fc.integer({ min: 0, max: 59 }))
      .map(([y, m, d, oh, om]) => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T12:00:00${oh < 0 ? '-' : '+'}${pad(Math.abs(oh), 2)}:${pad(om, 2)}`),
  )
  const args = fc.oneof(
    fc.anything(),
    fc.record({ processedFrom: instantish, processedTo: instantish, createdFrom: instantish, createdTo: instantish }, { requiredKeys: [] }),
  )
  for (const name of Object.keys(TOOLS)) {
    test.prop([args])(`${name}: any input resolves to a result`, async a => {
      const r = await callReadTool(deps, scope, name, a)
      expect(typeof r.ok).toBe('boolean')
    })
  }

  it.each(['0000-01-01T00:00:00+01:00', '9999-12-31T23:59:59-01:00'])('%s is invalid_args', async at => {
    expect(await callReadTool(deps, scope, 'refunds_search', { createdFrom: at })).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await callReadTool(deps, scope, 'orders_search', { processedTo: at })).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
  })
})

describe('exact keys (test 7)', () => {
  const orderNode = () => structuredClone((MAXIMAL.order_get!.data as any).orders.nodes[0]) as Record<string, unknown> & { name: string }
  const withNames = (...names: string[]) => ({ orders: { nodes: names.map(n => ({ ...orderNode(), name: n })) } })

  it.each([
    ['#1001', ['#10011'], null],
    ['#1001', ['#100'], null],
    ['#1001', ['#1001-A'], null],
    ['#1001', ['#1001'], '#1001'],
    ['1001', ['#1001'], '#1001'],
    ['#1001', ['1001'], '1001'],
    ['#1001', ['#10011', '#1001'], '#1001'],
  ])('order_get %s against %j', async (name, upstream, expected) => {
    const v = await value<{ order: { name: string } | null }>('order_get', { name }, dataClient(withNames(...upstream)))
    expect(v.order?.name ?? null).toBe(expected)
  })

  it('order_get with two exact matches is upstream_unavailable', async () => {
    expect(await call('order_get', { name: '#1001' }, dataClient(withNames('#1001', '1001')))).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' } })
  })

  it('order_get on the hand dataset: a near miss is null', async () => {
    expect(await value('order_get', { name: '#100' })).toEqual({ order: null })
    expect(await value('order_get', { name: '#10011' })).toEqual({ order: null })
  })

  it('inventory_levels_get drops loose sku matches', async () => {
    const node = (MAXIMAL.inventory_levels_get!.data as any).productVariants.nodes[0]
    const data = { productVariants: { nodes: ['hx-0013', 'HX-0013-B', 'HX-0013', null].map(sku => ({ ...structuredClone(node), sku })), pageInfo: { hasNextPage: false } } }
    data.productVariants.nodes.pop()
    const v = await value<{ matches: unknown[] }>('inventory_levels_get', { sku: 'HX-0013' }, dataClient(data))
    expect(v.matches).toHaveLength(1)
  })
})

describe('no "today" (test 8)', () => {
  afterEach(() => vi.restoreAllMocks())
  const runs: [string, unknown][] = [
    ['orders_search', { first: 20 }],
    ['orders_search', { processedFrom: '2026-11-12T00:00:00Z', processedTo: '2026-11-16T00:00:00Z' }],
    ['order_get', { name: '#1006' }],
    ['refunds_search', { createdFrom: '2026-11-19T00:00:00Z' }],
    ['returns_search', {}],
    ['products_search', { stockBelow: 100 }],
    ['inventory_levels_get', { sku: 'HX-0013' }],
  ]
  const all = async (nowMs: number) => {
    const { client } = signInClient(createShopifyUpstream(handDataset), () => nowMs)
    const out = []
    for (const [name, input] of runs) {
      const spec = TOOLS[name]!
      out.push(await spec.tool.run(ctxFor(client, nowMs), spec.tool.input.parse(input)))
    }
    return out
  }
  let baseline: unknown
  test.prop([fc.integer({ min: 0, max: 8_000_000_000_000 })], { numRuns: 20 })('outputs are identical whatever the clock says', async nowMs => {
    baseline ??= await all(Date.UTC(2026, 10, 20))
    vi.spyOn(Date, 'now').mockReturnValue(nowMs)
    expect(await all(nowMs)).toEqual(baseline)
  })

  it('no connector source reads the clock (tests and the test kit aside)', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const here = fileURLToPath(new URL('./', import.meta.url).href)
    const files = [
      ...readdirSync(here).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'test-kit.ts'),
      ...readdirSync(`${here}/tools`).map(f => `tools/${f}`),
    ]
    expect(files).toEqual(expect.arrayContaining(['route.ts', 'shape.ts', 'search.ts', 'documents.ts', 'tools/orders-search.ts']))
    for (const f of files) expect(readFileSync(`${here}/${f}`, 'utf8'), f).not.toMatch(/Date\.now|nowMs|new Date\(\s*\)/)
  })
})

describe('planted cases on the hand dataset', () => {
  it('orders_search: paid and unfulfilled finds #1001, newest first', async () => {
    const v = await value<Items<{ name: string; financialStatus: string }>>('orders_search', { financialStatus: 'paid', fulfillmentStatus: 'unfulfilled' })
    expect(v.items.map(i => i.name)).toEqual(['#1001'])
    expect(v.nextCursor).toBeNull()
  })

  it('orders_search: the processed window and the sku filter', async () => {
    const v = await value<Items<{ name: string; lines: { sku: string; quantity: number }[] }>>('orders_search', {
      sku: 'HX-0013',
      processedFrom: '2026-11-14T00:00:00Z',
      processedTo: '2026-11-16T11:05:00Z',
    })
    expect(v.items.map(i => i.name)).toEqual(['#1001'])
    const all = await value<Items<{ lines: { sku: string; quantity: number }[] }>>('orders_search', { sku: 'HX-0013', first: 20 })
    expect(all.items.flatMap(i => i.lines).filter(l => l.sku === 'HX-0013').reduce((s, l) => s + l.quantity, 0)).toBe(9)
  })

  it('orders_search: pages through after with the same filters', async () => {
    const one = await value<Items<{ name: string }>>('orders_search', { first: 4 })
    expect(one.items).toHaveLength(4)
    const two = await value<Items<{ name: string }>>('orders_search', { first: 4, after: one.nextCursor })
    const three = await value<Items<{ name: string }>>('orders_search', { first: 4, after: two.nextCursor })
    expect(three.nextCursor).toBeNull()
    const names = [...one.items, ...two.items, ...three.items].map(i => i.name)
    expect(names).toEqual(['#1009', '#1008', '#1007', '#1001', '#1003', '#1002', '#1005', '#1004', '#1006'])
  })

  it('orders_search: a cancelled order says so, money in minor units', async () => {
    const v = await value<{ order: { cancelled: boolean; total: unknown } }>('order_get', { name: '#1005' })
    expect(v.order.cancelled).toBe(true)
    expect(v.order.total).toEqual({ minor: 0, currency: 'USD' })
  })

  it('order_get: over every nested cap, with the more flags set', async () => {
    const v = await value<{ order: any }>('order_get', { name: '#1006' })
    expect(v.order.lines).toHaveLength(20)
    expect(v.order.moreLines).toBe(true)
    expect(v.order.refunds).toHaveLength(5)
    expect(v.order.moreRefunds).toBe(true)
    expect(v.order.refunds[0].lines).toHaveLength(5)
    expect(v.order.refunds[0].moreLines).toBe(true)
    expect(v.order.returns).toHaveLength(5)
    expect(v.order.moreReturns).toBe(true)
    expect(v.order.returns[0].lines).toHaveLength(5)
  })

  it('refunds_search: the refunds with a note on one SKU, in the window', async () => {
    const v = await value<Items<any>>('refunds_search', { createdFrom: '2026-11-19T00:00:00Z', sku: 'HX-0062' })
    expect(v.items.map(i => i.orderName)).toEqual(['#1003', '#1002'])
    for (const i of v.items) {
      expect(i.note).toBe('Igniter failed')
      expect(i.lines).toEqual([{ sku: 'HX-0062', quantity: 1, restockType: 'NO_RESTOCK' }])
    }
    const before = await value<Items>('refunds_search', { createdFrom: '2026-11-19T00:00:00Z', createdTo: '2026-11-19T11:00:00Z' })
    expect(before.items.map(i => i.orderName)).toEqual(['#1002'])
  })

  it('returns_search: the open return, not processed', async () => {
    const v = await value<Items<any>>('returns_search', { sku: 'HX-0089' })
    expect(v.items).toEqual([
      expect.objectContaining({ orderName: '#1004', returnName: '#1004-R1', status: 'OPEN', lines: [{ sku: 'HX-0089', quantity: 1, unprocessedQuantity: 1, reason: 'Too small' }] }),
    ])
    const inProgress = await value<Items<any>>('returns_search', { returnStatus: 'in_progress' })
    expect(inProgress.items.map(i => i.orderName)).toEqual(['#1004'])
    const any = await value<Items<any>>('returns_search', {})
    expect(new Set(any.items.map(i => i.orderName))).toEqual(new Set(['#1004', '#1006']))
  })

  it('products_search: stockBelow sorts lowest first and finds the oversold SKU; text and status filter', async () => {
    const low = await value<Items<any>>('products_search', { stockBelow: 1 })
    expect(low.items.map(i => i.totalInventory)).toEqual([-4, 0])
    expect(low.items[0].variants[0].sku).toBe('HX-0038')
    const text = await value<Items<any>>('products_search', { text: 'camp sto' })
    expect(text.items.map(i => i.title)).toEqual(['Camp stove, two burner'])
    const bySku = await value<Items<any>>('products_search', { text: 'HX-0013' })
    expect(bySku.items.map(i => i.title)).toEqual(['Trail lantern'])
    const draft = await value<Items<any>>('products_search', { status: 'draft' })
    expect(draft.items).toEqual([expect.objectContaining({ title: 'Rain shell', moreVariants: true })])
    expect(draft.items[0].variants).toHaveLength(3)
  })

  it('products_search: the long multibyte title is cut and marked', async () => {
    const v = await value<Items<any>>('products_search', { status: 'archived' })
    expect(v.items[0].truncated).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(v.items[0].title)).byteLength - 2).toBeLessThanOrEqual(120)
  })

  it('inventory_levels_get: near running out, oversold, unknown, and over the level cap', async () => {
    const lantern = await value<any>('inventory_levels_get', { sku: 'HX-0013' })
    expect(lantern.matches[0].levels).toEqual([{ location: 'Warehouse', available: 29, onHand: 31, committed: 2, incoming: 40 }])
    const mug = await value<any>('inventory_levels_get', { sku: 'HX-0038' })
    expect(mug.matches[0].levels[0].available).toBe(-4)
    expect(await value('inventory_levels_get', { sku: 'NO-SUCH-SKU' })).toEqual({ sku: 'NO-SUCH-SKU', matches: [], moreMatches: false })
    expect(await value('inventory_levels_get', { sku: 'X" OR status:"any' })).toEqual({ sku: 'X" OR status:"any', matches: [], moreMatches: false })
    const chair = await value<any>('inventory_levels_get', { sku: 'HX-0100' })
    expect(chair.matches[0].levels).toHaveLength(10)
    expect(chair.matches[0].moreLevels).toBe(true)
  })

  it('an injection-shaped sku matches nothing on orders', async () => {
    expect(await value('orders_search', { sku: 'X" OR status:"any' })).toEqual({ items: [], nextCursor: null })
  })
})
