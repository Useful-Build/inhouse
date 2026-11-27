// Settings > What the agent can do (Stage 1 M3-C, N26): its words and its Change window's checks. Ways it can fail:
//  1. the window's bounds drift from the server's, so it offers a value the server refuses (or refuses one it takes);
//  2. a value that doesn't apply to the operation (a daily count where no grant can cover it, a batch size where calls
//     never collect) shows or gets checked;
//  3. the window's "this ends every Always allow" note disagrees with the server's rule for raising `lowered_rev`;
//  4. the menu offers the page to a member (route 150 refuses them) or in the demo.
import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { BULK_THRESHOLD_MAX, LIMIT_MAX } from '../../../shared/contract/ceiling'
import type { CeilingRow, CeilingValues } from '../../../shared/contract/ceiling'
import { BATCH_ITEMS_MAX } from '../../../shared/contract/actions'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
const { CEILING_BOUNDS, approvalLine, changes, fieldsOf, limitLines, lowers, readValues } = await import('./ceiling-words')
const { menuFor } = await import('./menu')

const row = (o: Partial<CeilingRow> = {}): CeilingRow => ({
  operation: 'shopify.order.tag_add', title: 'Add tags to orders', description: 'Adds 1 to 5 tags to orders in the connected store.', tool: 'Shopify',
  measure: { kind: 'count', label: 'orders' }, applies: { perDay: true, batch: true }, guardrails: [], approverKind: 'person',
  suggested: { perDayMax: 200, unitsMax: 100 }, rev: 3, updatedAt: null, updatedBy: null,
  enabled: true, perDayMax: 200, unitsMax: 100, bulkThreshold: 5, batchMax: 500, ...o,
})

describe('bounds (failure 1)', () => {
  it("are the server's", () => {
    expect(CEILING_BOUNDS).toEqual({ limit: LIMIT_MAX, bulkThreshold: BULK_THRESHOLD_MAX, batch: BATCH_ITEMS_MAX })
  })
  it('a typed value is taken exactly when it is a whole number within its bound', () => {
    const r = row()
    fc.assert(fc.property(fc.constantFrom(...fieldsOf(r)), fc.oneof(fc.integer({ min: -5, max: LIMIT_MAX + 5 }), fc.constantFrom(0, 1, 5, 6, 500, 501)), (f, v) => {
      const got = readValues(r, true, { [f.key]: String(v) })
      expect('ok' in got).toBe(v >= 1 && v <= f.max)
      if ('ok' in got) expect(got.ok[f.key]).toBe(v)
    }))
    expect(readValues(r, true, { perDayMax: '1,200' })).toEqual({ ok: { enabled: true, perDayMax: 1200, unitsMax: 100, bulkThreshold: 5, batchMax: 500 } })
    for (const bad of ['', ' ', '1.5', '1e3', '-1', 'ten']) expect('error' in readValues(r, true, { unitsMax: bad }), bad).toBe(true)
    expect(readValues(r, true, { bulkThreshold: '6' })).toEqual({ error: 'Exact OK when more than this at once: enter a whole number from 1 to 5.' })
  })
})

describe('what applies (failure 2)', () => {
  it('a post shows no batch values; an exact-only operation no daily count', () => {
    const post = row({ applies: { perDay: true, batch: false }, measure: { kind: 'count', label: 'posts' }, unitsMax: 1 })
    expect(fieldsOf(post).map(f => f.key)).toEqual(['perDayMax', 'unitsMax'])
    expect(limitLines(post)).toEqual(['Up to 200 posts a day for each Always allow', 'Up to 1 post in one go'])
    const refund = row({ applies: { perDay: false, batch: false }, measure: { kind: 'money', currency: 'USD' }, guardrails: ['money', 'customer'], approverKind: 'admins', unitsMax: 50_000 })
    expect(fieldsOf(refund).map(f => f.key)).toEqual(['unitsMax'])
    expect(limitLines(refund)).toEqual(['Up to 50,000 minor units of USD in one go'])
    expect(approvalLine(refund)).toBe('An admin approves it exactly, every time, because it moves money and it reaches a customer.')
    // A value that doesn't apply is kept as the row holds it, whatever is typed.
    expect(readValues(post, true, { batchMax: '0' })).toEqual({ ok: { enabled: true, perDayMax: 200, unitsMax: 1, bulkThreshold: 5, batchMax: 500 } })
  })
  it('an operation that is off says only that', () => {
    expect(limitLines(row({ enabled: false }))).toEqual(["Off. Your Inhouse agent can't do this."])
    expect(limitLines(row())).toEqual(['Up to 200 orders a day for each Always allow', 'Up to 100 orders in one go', 'More than 5 at once needs an exact OK, and up to 500 in one batch'])
    expect(approvalLine(row())).toBe('The person who asked approves it first, or chooses Always allow.')
  })
})

describe('lowering (failure 3)', () => {
  const values = fc.record({
    enabled: fc.boolean(), perDayMax: fc.integer({ min: 1, max: 1000 }), unitsMax: fc.integer({ min: 1, max: 1000 }),
    bulkThreshold: fc.integer({ min: 1, max: 5 }), batchMax: fc.integer({ min: 1, max: 500 }),
  })
  // permissions/ceiling.ts `setCeilingStmt`: lowered_rev + (excluded.enabled < enabled OR excluded.per_day_max < ... )
  const serverLowers = (p: CeilingValues, n: CeilingValues) => Number(n.enabled) < Number(p.enabled) || n.perDayMax < p.perDayMax
    || n.unitsMax < p.unitsMax || n.bulkThreshold < p.bulkThreshold || n.batchMax < p.batchMax
  it("says so exactly when the server's rule raises lowered_rev; a change is any differing value", () => {
    fc.assert(fc.property(values, values, (p, n) => {
      expect(lowers(p, n)).toBe(serverLowers(p, n))
      expect(changes(p, n)).toBe(JSON.stringify(p) !== JSON.stringify(n))
      expect(lowers(p, p)).toBe(false)
    }))
  })
})

describe('the menu (failure 4)', () => {
  const ids = (product: boolean, inhouse = false, member = false) => menuFor({ connected: [], channels: [] }, product, inhouse, member).flatMap(s => s.pages).map(p => p.id)
  it('offers What the agent can do to admins and the Inhouse team in the product, never to a member or in the demo', () => {
    expect(ids(true)).toContain('team-ceiling')
    expect(ids(true, true)).toContain('team-ceiling')
    expect(ids(true, false, true)).not.toContain('team-ceiling')
    expect(ids(true, false, true)).toEqual(ids(true).filter(id => id !== 'team-ceiling'))
    expect(ids(false)).not.toContain('team-ceiling')
  })
})
