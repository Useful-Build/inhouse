import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkDataset } from '../../../test/upstreams/shopify/dataset'
import { createShopifyUpstream, TEST_CLIENT_ID, TEST_CLIENT_SECRET, type ShopifyUpstreamOptions } from '../../../test/upstreams/shopify/server'
import { buildDataset, parseCurlOutput, runStep, StepError } from '../../../test/upstreams/shopify/step'
import { CASES, type LiveCase } from '../../../test/connectors/shopify/cases'
import { handDataset } from './test-kit'

// Test 9 of the brief's section 9: the step engine proven offline, with the recorded upstream as the "store" and its
// answers written as `curl -i` text with harness noise around them.

const SHOP = 'example-fixture'
type Store = ReturnType<typeof createShopifyUpstream>

/** The hand dataset cut to what the recorder's limits can hold (no order or product over a recorder limit). */
function recordable(): any {
  const d = structuredClone(handDataset) as any
  d.orders = d.orders.filter((o: any) => o.name !== '#1006')
  d.products = d.products.filter((p: any) => p.variants.nodes.length <= 3 && p.variants.nodes.every((v: any) => v.inventoryItem.inventoryLevels.nodes.length <= 2))
  return d
}

/** Cases that exercise every tool on the hand dataset (the real list names the fixture's SKUs). */
const HAND_CASES: LiveCase[] = [
  { name: 'orders two pages', tool: 'orders_search', input: { first: 3 }, pages: 2 },
  { name: 'orders paid unfulfilled', tool: 'orders_search', input: { financialStatus: 'paid', fulfillmentStatus: 'unfulfilled', first: 20 } },
  { name: 'order 1001', tool: 'order_get', input: { name: '#1001' } },
  { name: 'refunds', tool: 'refunds_search', input: { createdFrom: '2026-11-19T00:00:00Z', sku: 'HX-0062' } },
  { name: 'returns', tool: 'returns_search', input: { first: 1 }, pages: 3 },
  { name: 'products low', tool: 'products_search', input: { stockBelow: 1 } },
  { name: 'stock', tool: 'inventory_levels_get', input: { sku: 'HX-0013' } },
]

async function curlText(store: Store, token: string, requestFile: string, noise = true): Promise<string> {
  const res = await store(
    new Request(`https://${SHOP}.myshopify.com/admin/api/2026-10/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: readFileSync(requestFile, 'utf8'),
    }),
  )
  const head = [`HTTP/2 ${res.status}`, ...[...res.headers].map(([k, v]) => `${k}: ${v}`)].join('\r\n')
  const text = `${head}\r\n\r\n${await res.text()}`
  return noise ? `Command running in background\n${text}\n\n[exit code 0]\n` : text
}

async function grantToken(store: Store): Promise<string> {
  const res = await store(
    new Request(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET }).toString(),
    }),
  )
  return ((await res.json()) as { access_token: string }).access_token
}

/** Drives start and ingest to done against `storeData`, as the orchestrator would with curl. Returns the step dir. */
async function drive(storeData: unknown, mode: 'record' | 'check', cases: readonly LiveCase[], options: ShopifyUpstreamOptions = {}, committed?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'shopify-step-'))
  const store = createShopifyUpstream(storeData, options)
  const token = await grantToken(store)
  let message = await runStep({ SHOPIFY_STEP: 'start', SHOPIFY_STEP_MODE: mode, SHOPIFY_STEP_DIR: dir }, { cases, committed })
  const commands: string[] = []
  for (let i = 0; i < 200 && message.startsWith('next:'); i++) {
    commands.push(message)
    const file = /--data-binary @(\S+)$/.exec(message)![1]!
    const response = join(dir, `response-${i}.txt`)
    writeFileSync(response, await curlText(store, token, file))
    message = await runStep({ SHOPIFY_STEP: 'ingest', SHOPIFY_STEP_DIR: dir, SHOPIFY_STEP_RESPONSE: response }, { cases })
  }
  return { dir, message, commands }
}

describe('the step engine, offline', () => {
  it('records a store, scrubs it, and the differential against the new recording is all equal', async () => {
    const store = recordable()
    const { dir, message, commands } = await drive(store, 'record', HAND_CASES)
    expect(message).toMatch(/^done: /)
    // The printed command keeps placeholders: no shop, no token, no card path.
    expect(commands[0]).toContain('curl -q -sSi -X POST "https://<shop>.myshopify.com/admin/api/2026-10/graphql.json" -H "X-Shopify-Access-Token: $(cat <TOKEN_CARD>)"')
    for (const f of readdirSync(dir).filter(f => f.startsWith('request-'))) {
      const body = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { query: string }
      expect(body.query.trimStart().startsWith('query ')).toBe(true)
    }
    const out = mkdtempSync(join(tmpdir(), 'shopify-out-'))
    const done = await runStep({ SHOPIFY_STEP: 'finish', SHOPIFY_STEP_DIR: dir, SHOPIFY_STEP_OUT: out, SHOPIFY_SHOP: SHOP }, { cases: HAND_CASES, today: '2026-11-20' })
    expect(done).toMatch(/differential all equal/)
    const diff = readFileSync(join(dir, 'differential.txt'), 'utf8')
    // The fixed cases, then the window cases cut from the recorded dates.
    expect(diff.trim().split('\n')).toEqual([...HAND_CASES.map(c => c.name), 'orders in a processed window', 'refunds in a closed window'].map(n => `${n}: equal`))

    const written = readFileSync(join(out, 'dataset.ts'), 'utf8')
    expect(written).toMatch(/^\/\/ Recorded from the read fixture store/)
    const recorded = checkDataset(JSON.parse(written.slice(written.indexOf('{'), written.lastIndexOf('}') + 1)))
    expect(recorded.orders.map(o => o.id)).toEqual(store.orders.map((_: unknown, i: number) => `gid://shopify/Order/${i + 1}`))
    expect(written).not.toMatch(/5550000|7770000|8880000|Warehouse|cursor/i)
    expect(recorded.products[0]!.variants.nodes[0]!.inventoryItem.inventoryLevels.nodes[0]!.location.name).toBe('Location 1')
    expect(recorded.orders.find(o => o.name === '#1002')!.refunds[0]!.note).toBe('Igniter failed')
    expect(recorded.orders.find(o => o.name === '#1004')!.returns.nodes).toHaveLength(1)

    // Check mode on the committed recording: the same cases, the same differential.
    const check = await drive(store, 'check', HAND_CASES, {}, recorded)
    expect(check.message).toMatch(/^done: /)
    expect(await runStep({ SHOPIFY_STEP: 'finish', SHOPIFY_STEP_DIR: check.dir }, { cases: HAND_CASES, committed: recorded })).toMatch(/all equal/)
  })

  it('the differential names the first difference when the recording disagrees', async () => {
    const store = recordable()
    const committed = structuredClone(store)
    committed.orders.find((o: any) => o.name === '#1001').displayFulfillmentStatus = 'FULFILLED'
    const check = await drive(store, 'check', HAND_CASES, {}, committed)
    expect(await runStep({ SHOPIFY_STEP: 'finish', SHOPIFY_STEP_DIR: check.dir }, { cases: HAND_CASES, committed })).toMatch(/has differences/)
    const lines = readFileSync(join(check.dir, 'differential.txt'), 'utf8')
    expect(lines).toMatch(/order 1001: \$\[0\]\.order\.fulfillmentStatus: values differ/)
    expect(lines).toMatch(/orders paid unfulfilled: \$\[0\]\.items: length 1 vs 0/)
  })

  it('fails when an order with refunds or returns escaped the refunds or returns pass', async () => {
    for (const plant of [
      // Refunded, but its financial status keeps it out of the refunds pass's search.
      (d: any) => (d.orders.find((o: any) => o.name === '#1003').displayFinancialStatus = 'PAID'),
    ]) {
      const store = recordable()
      plant(store)
      const { dir } = await drive(store, 'record', HAND_CASES.slice(0, 1))
      const out = mkdtempSync(join(tmpdir(), 'shopify-out-'))
      await expect(runStep({ SHOPIFY_STEP: 'finish', SHOPIFY_STEP_DIR: dir, SHOPIFY_STEP_OUT: out, SHOPIFY_SHOP: SHOP }, { cases: HAND_CASES.slice(0, 1) })).rejects.toThrow(
        /missing from the (refunds|returns) pass/,
      )
      expect(readdirSync(out)).toEqual([])
    }
    // The fake's searches agree with its own fields, so a returns-pass miss is built directly: the orders pass shows a
    // return status, the returns pass came back without that order.
    const order = (checkDataset(recordable()).orders.find(o => o.name === '#1004')!) as Record<string, unknown>
    const state = { nodes: { orders: [order], refunds: [], returns: [], products: [] }, currency: 'USD' }
    expect(() => buildDataset(state as never, '2026-11-20')).toThrow(/missing from the returns pass/)
  })

  it('window cases: one boundary inside the recorded dates, so the upper bound excludes something', async () => {
    const { windowOf, windowCases, windowSource } = await import('../../../test/connectors/shopify/cases')
    expect(windowOf(['2026-11-10T08:00:00Z', '2026-11-19T10:00:00.500Z', '2026-11-12T10:30:00Z'])).toEqual({ from: '2026-11-10T08:00:00Z', to: '2026-11-12T10:30:00Z' })
    expect(windowOf(['2026-11-10T08:00:00Z', '2026-11-10T08:00:00Z'])).toBeNull()
    const src = windowSource(checkDataset(handDataset))
    const cases = windowCases(src)
    expect(cases.map(c => c.name)).toEqual(['orders in a processed window', 'refunds in a closed window'])
    for (const c of cases) {
      const r = await (await import('../../../test/connectors/shopify/run')).runCase({ ...c, pages: 10 }, (await import('./test-kit')).fakeClient())
      if (!r.ok) throw new Error(r.error.code)
      const got = r.value.flatMap(p => (p as { items: unknown[] }).items).length
      const all = c.tool === 'orders_search' ? src.processedAt.length : src.refundCreatedAt.length
      expect(got).toBeGreaterThan(0)
      expect(got).toBeLessThan(all)
    }
  })

  it('stops with "raise the recorder limit" when a nested list may be incomplete', async () => {
    await expect(drive(handDataset, 'record', HAND_CASES)).rejects.toThrow(/raise the recorder limit/)
  })

  it('stops at the first step when the app scopes do not match', async () => {
    const fixtureGrant = ['read_products', 'read_orders', 'read_inventory', 'read_customers', 'read_locations']
    await expect(drive(recordable(), 'record', HAND_CASES, { scope: fixtureGrant })).rejects.toThrow(
      "the app's scopes don't match the connector: extra read_customers; missing read_returns",
    )
  })

  for (const [what, plant, pattern] of [
    ['the shop handle', (d: any) => (d.orders[0].lineItems.nodes[0].title = `Made for ${SHOP}`), /shop handle/],
    ['a myshopify host', (d: any) => (d.orders[0].lineItems.nodes[0].title = 'see x.myshopify.com'), /myshopify/],
    ['an email', (d: any) => (d.orders[1].refunds[0].note = 'asked by buyer@example.com'), /email/],
    ['a phone number', (d: any) => (d.orders[1].refunds[0].note = 'call +1 415 555 0123'), /phone/],
    ['an original gid number', (d: any) => (d.products[0].title = 'Stove 5550000001001'), /original gid/],
    ['an unformatted phone number', (d: any) => (d.orders[0].lineItems.nodes[0].title = 'ring 4155550123'), /phone/],
    ['a UK phone number', (d: any) => (d.orders[1].refunds[0].note = 'buyer on +44 20 7946 0958'), /phone/],
    ['a dotted phone number', (d: any) => (d.products[0].variants.nodes[0].title = '(020) 7946.0958 x1'), /phone/],
  ] as const) {
    it(`the scrub scan fails on ${what}`, async () => {
      const store = recordable()
      plant(store)
      const { dir, message } = await drive(store, 'record', HAND_CASES.slice(0, 1))
      expect(message).toMatch(/^done/)
      const out = mkdtempSync(join(tmpdir(), 'shopify-out-'))
      const finish = runStep({ SHOPIFY_STEP: 'finish', SHOPIFY_STEP_DIR: dir, SHOPIFY_STEP_OUT: out, SHOPIFY_SHOP: SHOP }, { cases: HAND_CASES.slice(0, 1) })
      await expect(finish).rejects.toThrow(pattern)
      await expect(finish).rejects.toBeInstanceOf(StepError)
      expect(readdirSync(out)).toEqual([])
    })
  }

  it('ingest refuses a bad status, another version, errors, a cost over 900 and a run that is not done', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shopify-step-'))
    await runStep({ SHOPIFY_STEP: 'start', SHOPIFY_STEP_MODE: 'check', SHOPIFY_STEP_DIR: dir }, { cases: HAND_CASES, committed: handDataset })
    const ingest = (text: string) => {
      const f = join(dir, 'r.txt')
      writeFileSync(f, text)
      return runStep({ SHOPIFY_STEP: 'ingest', SHOPIFY_STEP_DIR: dir, SHOPIFY_STEP_RESPONSE: f }, { cases: HAND_CASES })
    }
    const ok = '{"data":{"currentAppInstallation":{"accessScopes":[]},"shop":{"currencyCode":"USD"}},"extensions":{"cost":{"requestedQueryCost":2}}}'
    await expect(ingest(`HTTP/2 500\r\nx-shopify-api-version: 2026-10\r\n\r\n{}`)).rejects.toThrow(/status 500/)
    await expect(ingest(`HTTP/2 200\r\nx-shopify-api-version: 2027-01\r\n\r\n${ok}`)).rejects.toThrow(/2027-01, expected 2026-10/)
    await expect(ingest(`HTTP/2 200\r\nx-shopify-api-version: 2026-10\r\n\r\n{"errors":[{"message":"x"}]}`)).rejects.toThrow(/errors/)
    await expect(ingest(`HTTP/2 200\r\nx-shopify-api-version: 2026-10\r\n\r\n${ok.replace('"requestedQueryCost":2', '"requestedQueryCost":901')}`)).rejects.toThrow(/over 900/)
    await expect(runStep({ SHOPIFY_STEP: 'finish', SHOPIFY_STEP_DIR: dir }, { cases: HAND_CASES, committed: handDataset })).rejects.toThrow(/not done/)
  })

  it('reads curl -i output with a 100 Continue block and harness text', () => {
    const r = parseCurlOutput('noise\nHTTP/1.1 100 Continue\r\n\r\nHTTP/2 200\r\nX-Shopify-API-Version: 2026-10\r\n\r\n{"data":{}}\ntrailing text')
    expect(r.status).toBe(200)
    expect(r.headers.get('x-shopify-api-version')).toBe('2026-10')
    expect(r.body).toEqual({ data: {} })
  })

  it('the real case list builds a read request for every case', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shopify-step-'))
    // Start writes the first request; every case request is captured from the tool itself, so a bad case input fails here.
    await runStep({ SHOPIFY_STEP: 'start', SHOPIFY_STEP_MODE: 'check', SHOPIFY_STEP_DIR: dir }, { committed: handDataset })
    expect(new Set(CASES.map(c => c.name)).size).toBe(CASES.length)
    const { captureRequest, toolFor } = await import('../../../test/connectors/shopify/run')
    for (const c of CASES) {
      const r = await captureRequest(toolFor(c), c.input)
      expect(r.query.trimStart().startsWith('query ')).toBe(true)
    }
  })
})
