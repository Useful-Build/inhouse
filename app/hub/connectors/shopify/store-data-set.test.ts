// The store-data exfiltration set's datasets and upstreams (p4-w6.md section 6; the cases and the grader are in
// evals/exfiltration/store-data/). Valid datasets for every case, the planted text exactly once and only in the field the case
// names, a base nothing writes to, and one recorded upstream per case host answering as the fixture does. In the hub's project
// because that is the one that type-checks and runs files under test/upstreams/ (like morning-check-set.test.ts).
import { fc, test as fcTest } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { ASKS, PLANT_FIELDS, STORE_DATA_CASES, hostOf } from '../../../evals/exfiltration/store-data/cases'
import type { Ask, PlantField, StoreDataCase } from '../../../evals/exfiltration/store-data/cases'
import { expectedFindings } from '../../../test/upstreams/morning-check/oracle'
import { checkDataset } from '../../../test/upstreams/shopify/dataset'
import { REFUND_ORDER, RETURN_ORDER, UNRESTOCKED_ORDER, planted } from '../../../test/upstreams/shopify/datasets/exfiltration/datasets'
import type { PlantedField } from '../../../test/upstreams/shopify/datasets/exfiltration/datasets'
import { storeDataUpstreams } from '../../../test/upstreams/shopify/datasets/exfiltration/upstreams'
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET } from '../../../test/upstreams/shopify/server'
import { CAPS } from './documents'
import { call, signInClient } from './test-kit'

const NOW = Date.parse('2026-11-21T12:00:00Z')
const DAY_MS = 86_400_000

const where = (d: unknown, text: string): string[] => {
  const hits: string[] = []
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      if (v.includes(text)) hits.push(path)
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
  }
  walk(d, '$')
  return hits
}

describe('the store-data datasets', () => {
  it('are valid datasets for every case', () => {
    for (const k of STORE_DATA_CASES) expect(() => checkDataset(planted(NOW, k.field, k.text)), k.id).not.toThrow()
  })

  it('hold the text exactly once, in the field the case names (an oracle by path)', () => {
    const PATHS: Record<PlantedField, RegExp> = {
      refund_note: /^\$\.orders\[\d+\]\.refunds\[0\]\.note$/,
      line_item_title: /^\$\.orders\[\d+\]\.lineItems\.nodes\[0\]\.title$/,
      return_reason: /^\$\.orders\[\d+\]\.returns\.nodes\[0\]\.returnLineItems\.nodes\[0\]\.returnReasonDefinition\.name$/,
      product_title: /^\$\.products\[0\]\.title$/,
      variant_title: /^\$\.products\[0\]\.variants\.nodes\[0\]\.title$/,
    }
    expect([...PLANT_FIELDS].sort()).toEqual(Object.keys(PATHS).sort())
    for (const k of STORE_DATA_CASES) {
      const hits = where(planted(NOW, k.field, k.text), k.canary)
      expect(hits, k.id).toHaveLength(1)
      expect(hits[0], k.id).toMatch(PATHS[k.field])
    }
  })

  it('sit in the orders the base builds, and keep the three late orders the morning check still has to report', () => {
    const d = planted(NOW, 'refund_note', 'X')
    expect(d.orders.find(o => o.name === REFUND_ORDER)!.refunds).toHaveLength(1)
    expect(d.orders.find(o => o.name === RETURN_ORDER)!.returns.nodes).toHaveLength(1)
    expect(d.orders.find(o => o.name === UNRESTOCKED_ORDER)!.returns.nodes).toHaveLength(1)
    for (const n of ['#2001', '#2002', '#2003']) expect(d.orders.map(o => o.name)).toContain(n)
  })

  it('give the morning check two problems to report on every case, the planted orders\' among them (the eight rules, in plain code)', () => {
    for (const k of STORE_DATA_CASES) {
      expect(expectedFindings(planted(NOW, k.field, k.text), NOW), k.id).toEqual([
        { key: 'late-orders', sev: 'amber', sources: ['#2001', '#2002', '#2003'] },
        { key: 'returns-not-restocked', sev: 'amber', sources: [UNRESTOCKED_ORDER] },
      ])
    }
  })

  it('never change the base: two plantings are independent and carry only their own text', () => {
    const a = planted(NOW, 'product_title', 'AAA')
    const b = planted(NOW, 'product_title', 'BBB')
    expect(where(a, 'BBB')).toEqual([])
    expect(where(b, 'AAA')).toEqual([])
    expect(where(planted(NOW, 'refund_note', 'CCC'), 'AAA')).toEqual([])
  })

  it('plant nothing in the fields the read tools leave out (the order note and the buyer\'s return notes)', () => {
    const json = JSON.stringify(planted(NOW, 'refund_note', 'ZZZ'))
    expect(json).not.toMatch(/"(?:note|customerNote|returnNote)":"(?!ZZZ)[^"]/)
  })
})

describe('the store-data upstreams', () => {
  const ups = storeDataUpstreams(NOW)
  it('are one per case, by the case\'s shop host', () => {
    expect(Object.keys(ups).sort()).toEqual(STORE_DATA_CASES.map(k => hostOf(k.id)).sort())
  })
  it('each answers the client credentials grant like the recorded upstream (a token), and refuses a wrong secret', async () => {
    const up = ups[hostOf(STORE_DATA_CASES[0]!.id)]!
    const grant = (secret: string) => up(new Request('https://x.test/admin/oauth/access_token', { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: TEST_CLIENT_ID, client_secret: secret }) }))
    const ok = await grant(TEST_CLIENT_SECRET)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { access_token: string }).access_token).toMatch(/^shpat_test_\d+$/)
    expect((await grant('wrong')).status).toBe(401)
  })
})

// What the morning check reads (server/prompt/routines/morning-check.ts): the four searches it makes on every run (orders,
// refunds, returns, products; every case of the graded set's run on 2026-11-22 called each), paged to the end, plus one
// order_get per order a problem it reports names, to fill the item. Driven through the hub's own tools over each case's
// recorded upstream, so a field the tools leave out, cap or filter away fails here rather than in a paid run.
describe('what the morning check reads', () => {
  const ups = storeDataUpstreams(NOW)
  const client = (k: StoreDataCase) => signInClient(ups[hostOf(k.id)]!).client
  const iso = (ms: number) => new Date(ms).toISOString()

  async function paged(k: StoreDataCase, tool: string, input: Record<string, unknown>): Promise<unknown[]> {
    const c = client(k)
    const pages: unknown[] = []
    let after: string | null = null
    do {
      const r = await call(tool, after === null ? input : { ...input, after }, c, NOW)
      if (!r.ok) throw new Error(`${k.id} ${tool}: ${r.error.code}`)
      pages.push(r.value)
      after = (r.value as { nextCursor?: string | null }).nextCursor ?? null
    } while (after !== null)
    return pages
  }
  const has = (v: unknown, k: StoreDataCase) => JSON.stringify(v).includes(k.canary)

  /** The read that carries each field to the model. Variant titles are left out: see the blocked test below. */
  const READ: Record<Exclude<PlantField, 'variant_title'>, (k: StoreDataCase) => Promise<unknown>> = {
    // The refund-spike rule needs at least the last 24 h; the agent picks the window, so the property below tries them.
    refund_note: k => paged(k, 'refunds_search', { createdFrom: iso(NOW - 15 * DAY_MS) }),
    product_title: k => paged(k, 'products_search', { first: 20 }),
    return_reason: k => paged(k, 'returns_search', {}),
    // The returns-not-restocked item: its source's order, opened for its lines and unit price (only order_get has them).
    line_item_title: async k => {
      const returns = (await paged(k, 'returns_search', {})) as { items: { orderName: string; status: string; lines: { unprocessedQuantity: number }[] }[] }[]
      const sources = returns.flatMap(p => p.items).filter(r => r.status === 'CLOSED' && r.lines.some(l => l.unprocessedQuantity > 0)).map(r => r.orderName)
      expect(sources, k.id).toEqual([UNRESTOCKED_ORDER])
      return Promise.all(sources.map(name => call('order_get', { name }, client(k), NOW)))
    },
  }

  for (const k of STORE_DATA_CASES.filter(x => x.field !== 'variant_title')) {
    it(`${k.id} (${k.field}): the canary is in what the read returns`, async () => {
      expect(has(await READ[k.field as keyof typeof READ](k), k)).toBe(true)
    })
  }

  for (const k of STORE_DATA_CASES.filter(x => x.field === 'refund_note')) {
    fcTest.prop([fc.integer({ min: 24 * 3600, max: 30 * 24 * 3600 })], { numRuns: 25 })(
      `${k.id}: refunds_search returns the note for any window that covers the last 24 h`,
      async back => {
        expect(has(await paged(k, 'refunds_search', { createdFrom: iso(NOW - back * 1000) }), k)).toBe(true)
      },
    )
  }

  it('the line item title is on the returned line, and the refund on the refund-spike rule\'s last 24 h', () => {
    const k = STORE_DATA_CASES.find(x => x.field === 'line_item_title')!
    const o = planted(NOW, k.field, k.text).orders.find(x => x.name === UNRESTOCKED_ORDER)!
    expect(o.lineItems.nodes[0]!.title).toBe(k.text)
    expect(o.returns.nodes[0]!.returnLineItems.nodes[0]!.fulfillmentLineItem.lineItem.sku).toBe(o.lineItems.nodes[0]!.sku)
    const refund = planted(NOW, 'refund_note', 'X').orders.find(x => x.name === REFUND_ORDER)!.refunds[0]!
    expect(NOW - Date.parse(refund.createdAt!)).toBeLessThan(24 * 3600_000)
  })

  // Blocked, not fixed here: the hub caps a variant title at CAPS.variantTitle bytes (products_search and
  // inventory_levels_get alike), and every ask puts the canary past that, so the canary of a variant_title case never
  // reaches a tool result, whatever the morning check reads. This pins the facts, so a change to the cap or the asks
  // shows up here.
  it('variant_title (XS05, XS06) is blocked: the variant title cap cuts every ask\'s canary', async () => {
    for (const a of Object.keys(ASKS) as Ask[]) {
      const text = ASKS[a].text('kestrel-xs00-r0-00000000')
      expect(text.indexOf('kestrel-') + 'kestrel-xs00-r0-00000000'.length, a).toBeGreaterThan(CAPS.variantTitle)
    }
    for (const k of STORE_DATA_CASES.filter(x => x.field === 'variant_title')) {
      const pages = await paged(k, 'products_search', { first: 20 })
      expect(JSON.stringify(pages), k.id).toContain(k.text.slice(0, CAPS.variantTitle))
      expect(has(pages, k), k.id).toBe(false)
    }
  })
})
