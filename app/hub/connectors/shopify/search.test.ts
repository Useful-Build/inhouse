import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { parseQuery } from '../../../test/upstreams/shopify/query'
import type { CallerScope } from '../../index/contract'
import { buildRegistry, callReadTool, type GatewayDeps } from '../../registry/registry'
import type { Clause, EqClause, EqField } from './documents'
import { shopifyConnector } from './route'
import { buildQuery, queryInstant, quoteValue } from './search'
import { dataClient } from './test-kit'

// Test 4 of the brief's section 9: builder and parser agree; hostile values never add a clause; inputs outside the
// regexes are invalid_args at the gateway's parse.

const FIELDS: EqField[] = ['financial_status', 'fulfillment_status', 'return_status', 'sku', 'name', 'status']
const value = fc.string({ unit: 'binary', maxLength: 40 })
const hostile = fc.constantFrom('X" OR status:"any', '\\', '\\"', '" OR "', '(a OR b)', 'a:b', ') OR (', "'", '"', '-x', 'a b')
const eqClause: fc.Arbitrary<EqClause> = fc
  .record({ field: fc.constantFrom(...FIELDS), value: fc.oneof(value, hostile), negate: fc.boolean() })
  .map(({ field, value, negate }) => (negate ? { kind: 'eq', field, value, negate: true } : { kind: 'eq', field, value }))
const instantArb = fc
  .date({ min: new Date('1970-01-01T00:00:00Z'), max: new Date('9999-12-31T23:59:59Z'), noInvalidDate: true })
  .map(d => queryInstant(d.toISOString()))
const clauseArb: fc.Arbitrary<Clause> = fc.oneof(
  eqClause,
  fc.record({
    kind: fc.constant('range' as const),
    field: fc.constantFrom('processed_at' as const, 'updated_at' as const),
    op: fc.constantFrom('>=' as const, '<' as const),
    at: instantArb,
  }),
  fc.record({ kind: fc.constant('below' as const), field: fc.constant('inventory_total' as const), value: fc.integer({ min: -100_000, max: 100_000 }) }),
  fc.record({ kind: fc.constant('phrase' as const), value: fc.oneof(value, hostile) }),
  fc
    .array(
      fc.record({ field: fc.constantFrom(...FIELDS), value: fc.oneof(value, hostile) }).map(({ field, value }): EqClause => ({ kind: 'eq', field, value })),
      { minLength: 2, maxLength: 3 },
    )
    .map(of => ({ kind: 'any' as const, of })),
)

describe('search builder and parser', () => {
  test.prop([fc.array(clauseArb, { minLength: 1, maxLength: 6 })])('the parser reads back exactly the clauses built', clauses => {
    const q = buildQuery(clauses)!
    const parsed = parseQuery(q)
    expect(parsed).toEqual({ ok: true, clauses: clauses.map(c => (c.kind === 'below' ? { ...c, value: c.value === 0 ? 0 : c.value } : c)) })
  })

  test.prop([fc.oneof(value, hostile)])('a hostile value is one quoted clause, never more', v => {
    for (const field of FIELDS) {
      const parsed = parseQuery(buildQuery([{ kind: 'eq', field, value: v }]))
      expect(parsed).toEqual({ ok: true, clauses: [{ kind: 'eq', field, value: v }] })
    }
    expect(parseQuery(quoteValue(v))).toEqual({ ok: true, clauses: [{ kind: 'phrase', value: v }] })
  })

  it('emits the documented shapes', () => {
    expect(
      buildQuery([
        { kind: 'range', field: 'processed_at', op: '>=', at: queryInstant('2026-11-19T12:00:00.500+02:00') },
        { kind: 'eq', field: 'sku', value: 'X" OR status:"any' },
        { kind: 'eq', field: 'return_status', value: 'no_return', negate: true },
        {
          kind: 'any',
          of: [
            { kind: 'eq', field: 'financial_status', value: 'refunded' },
            { kind: 'eq', field: 'financial_status', value: 'partially_refunded' },
          ],
        },
        { kind: 'below', field: 'inventory_total', value: 1 },
        { kind: 'phrase', value: 'camp stove' },
      ]),
    ).toBe(
      `processed_at:>='2026-11-19T10:00:00Z' sku:"X\\" OR status:\\"any" -return_status:"no_return" ` +
        `(financial_status:"refunded" OR financial_status:"partially_refunded") inventory_total:<1 "camp stove"`,
    )
    expect(buildQuery([])).toBeUndefined()
  })

  it.each([
    'sku:P4-0013',
    'status:"active" OR status:"draft"',
    'unknown:"x"',
    "processed_at:>2026-11-19T00:00:00Z",
    "processed_at:>='2026-11-19'",
    'sku:"a\\x"',
    'sku:"a"  sku:"b"',
    'sku:"unterminated',
    '(sku:"a")',
    'inventory_total:<01',
    '',
  ])('the parser refuses %j', q => {
    expect(parseQuery(q).ok).toBe(false)
  })
})

describe('inputs outside the regexes are invalid_args at the gateway', () => {
  const scope: CallerScope = { kind: 'server', job: 'test', requestId: 'req-1' }
  let sent = 0
  const deps: GatewayDeps = {
    registry: buildRegistry([shopifyConnector]),
    isConfigured: () => true,
    shopifyFor: () => {
      const c = dataClient({})
      return { graphql: (...a) => (sent++, c.graphql(...a)) }
    },
    nowMs: () => 0,
  }
  it.each([
    ['orders_search', { sku: 'P4-0013\n' }],
    ['orders_search', { sku: ' leading-space' }],
    ['orders_search', { sku: 'S'.repeat(65) }],
    ['orders_search', { sku: 'ünïcode' }],
    ['orders_search', { first: 21 }],
    ['orders_search', { first: 0 }],
    ['orders_search', { processedFrom: '2026-11-19T00:00:00' }],
    ['orders_search', { processedFrom: 'yesterday' }],
    ['orders_search', { financialStatus: 'any' }],
    ['orders_search', { after: 'a b' }],
    ['orders_search', { days: 7 }],
    ['order_get', { name: '#1001 OR name:#1002' }],
    ['order_get', { name: '#1001"' }],
    ['order_get', {}],
    ['refunds_search', {}],
    ['refunds_search', { createdFrom: '2026-11-19T00:00:00Z', first: 11 }],
    ['returns_search', { returnStatus: 'no_return' }],
    ['returns_search', { first: 6 }],
    ['products_search', { text: 'stove" OR status:"draft' }],
    ['products_search', { text: '-stove' }],
    ['products_search', { stockBelow: 1.5 }],
    ['products_search', { status: 'unlisted' }],
    ['inventory_levels_get', { sku: 'a', productId: 'x' }],
    ['inventory_levels_get', {}],
  ])('%s %j', async (name, args) => {
    const before = sent
    expect(await callReadTool(deps, scope, name, args)).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(sent).toBe(before)
  })
})
