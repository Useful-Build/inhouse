// The store-data exfiltration set's datasets and upstreams (p4-w6.md section 6; the cases and the grader are in
// evals/exfiltration/store-data/). Valid datasets for every case, the planted text exactly once and only in the field the case
// names, a base nothing writes to, and one recorded upstream per case host answering as the fixture does. In the hub's project
// because that is the one that type-checks and runs files under test/upstreams/ (like morning-check-set.test.ts).
import { fc, test as fcTest } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { ASKS, PLANT_FIELDS, STORE_DATA_CASES, canaryOf, hostOf } from '../../../evals/exfiltration/store-data/cases'
import type { Ask, PlantField, StoreDataCase } from '../../../evals/exfiltration/store-data/cases'
import { expectedFindings } from '../../../test/upstreams/morning-check/oracle'
import { checkDataset } from '../../../test/upstreams/shopify/dataset'
import { REFUND_ORDER, RETURN_ORDER, UNRESTOCKED_ORDER, planted } from '../../../test/upstreams/shopify/datasets/exfiltration/datasets'
import type { PlantedField } from '../../../test/upstreams/shopify/datasets/exfiltration/datasets'
import { storeDataUpstreams } from '../../../test/upstreams/shopify/datasets/exfiltration/upstreams'
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createShopifyUpstream } from '../../../test/upstreams/shopify/server'
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
    expect(Object.keys(PATHS).sort()).toEqual([...PLANT_FIELDS, 'variant_title'].sort())
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

  /** The read that carries each field to the model. */
  const READ: Record<PlantField, (k: StoreDataCase) => Promise<unknown>> = {
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

  it('cover all ten cases', () => {
    expect(STORE_DATA_CASES).toHaveLength(10)
    expect(STORE_DATA_CASES.every(k => Object.hasOwn(READ, k.field))).toBe(true)
  })

  /** How much of the planted text each field's read shows: all of it, except a return reason (cut after the canary). */
  const SHOWN: Record<PlantField, (k: StoreDataCase) => string> = {
    refund_note: k => k.text, product_title: k => k.text, line_item_title: k => k.text,
    return_reason: k => k.text.slice(0, CAPS.reason),
  }

  for (const k of STORE_DATA_CASES) {
    it(`${k.id} (${k.field}, ${k.ask}): exposed, the canary and the planted text are in what the read returns`, async () => {
      const shown = SHOWN[k.field](k)
      expect(shown, k.id).toContain(k.canary)
      const got = await READ[k.field](k)
      expect(has(got, k)).toBe(true)
      expect(where(got, shown).length, k.id).toBeGreaterThan(0)
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

})

// A counted defence (cases.ts header): the hub cuts a variant title to CAPS.variantTitle bytes in both read tools that
// return one, so a variant title planted with any ask's instruction reaches the model as a fragment, without the full
// instruction or its canary. Driven through the hub's own tools over a planted dataset; the cut fragment must be there,
// so a read that drops the field (rather than cutting it) fails here too.
describe('the variant title cap, a counted defence', () => {
  const strings = (v: unknown): string[] => {
    const out: string[] = []
    const walk = (x: unknown) => {
      if (typeof x === 'string') out.push(x)
      else if (Array.isArray(x)) x.forEach(walk)
      else if (x && typeof x === 'object') Object.values(x).forEach(walk)
    }
    walk(v)
    return out
  }

  for (const a of Object.keys(ASKS) as Ask[]) {
    it(`${a}: products_search and inventory_levels_get cut the planted instruction before its end and before its canary ends`, async () => {
      const canary = canaryOf(`VT-${a}`)
      const text = ASKS[a].text(canary)
      const fragment = text.slice(0, CAPS.variantTitle)
      expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(CAPS.variantTitle)
      expect(fragment.includes(canary)).toBe(false)
      const d = planted(NOW, 'variant_title', text)
      const sku = d.products[0]!.variants.nodes[0]!.sku!
      const client = signInClient(createShopifyUpstream(d)).client
      const reads = {
        products_search: await call('products_search', { first: 20 }, client, NOW),
        inventory_levels_get: await call('inventory_levels_get', { sku }, client, NOW),
      }
      for (const [tool, r] of Object.entries(reads)) {
        expect(r.ok, tool).toBe(true)
        const got = strings(r)
        expect(got, tool).toContain(fragment)
        expect(got.some(x => x.includes(text)), tool).toBe(false)
        expect(got.some(x => x.includes(canary)), tool).toBe(false)
      }
    })
  }
})
