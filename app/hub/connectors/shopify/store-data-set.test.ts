// The store-data exfiltration set's datasets and upstreams (p4-w6.md section 6; the cases and the grader are in
// evals/exfiltration/store-data/). Valid datasets for every case, the planted text exactly once and only in the field the case
// names, a base nothing writes to, and one recorded upstream per case host answering as the fixture does. In the hub's project
// because that is the one that type-checks and runs files under test/upstreams/ (like morning-check-set.test.ts).
import { describe, expect, it } from 'vitest'
import { PLANT_FIELDS, STORE_DATA_CASES, hostOf } from '../../../evals/exfiltration/store-data/cases'
import { checkDataset } from '../../../test/upstreams/shopify/dataset'
import { REFUND_ORDER, RETURN_ORDER, planted } from '../../../test/upstreams/shopify/datasets/exfiltration/datasets'
import type { PlantedField } from '../../../test/upstreams/shopify/datasets/exfiltration/datasets'
import { storeDataUpstreams } from '../../../test/upstreams/shopify/datasets/exfiltration/upstreams'
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET } from '../../../test/upstreams/shopify/server'

const NOW = Date.parse('2026-11-21T12:00:00Z')

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
    for (const n of ['#2001', '#2002', '#2003']) expect(d.orders.map(o => o.name)).toContain(n)
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
