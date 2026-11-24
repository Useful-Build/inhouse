// The search-query grammar at the hub (P5 W2, A.3a), differential against the recorded upstream's parser
// (app/test/upstreams/shopify/query.ts), which reads exactly what H0's builder emits. Failure modes:
// - a builder output the tools send is refused (would break a tool);
// - a string the hub accepts means something else to the reference parser (the two grammars drift);
// - a key outside the root's list, an unquoted value, a wildcard outside quotes or a bare phrase on orders passes.
import fc from 'fast-check'
import { test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { parseSearchQuery, type SearchRoot } from './search-query'
import { buildQuery } from '../connectors/shopify/search'
import type { Clause, EqClause, EqField } from '../connectors/shopify/documents'
import { parseQuery } from '../../test/upstreams/shopify/query'

const KEYS: Record<SearchRoot, EqField[]> = {
  orders: ['financial_status', 'fulfillment_status', 'return_status', 'sku', 'name'],
  products: ['status', 'sku'],
  productVariants: ['sku'],
}
const value = fc.string({ maxLength: 16 })
const instant = fc.integer({ min: 0, max: 253402300799000 }).map(ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'))

const eqFor = (root: SearchRoot, negate: boolean) =>
  fc.record({ field: fc.constantFrom(...KEYS[root]), value, neg: negate ? fc.boolean() : fc.constant(false) }).map(
    ({ field, value, neg }): EqClause => (neg ? { kind: 'eq', field, value, negate: true } : { kind: 'eq', field, value }),
  )

function clauseFor(root: SearchRoot): fc.Arbitrary<Clause> {
  const all: fc.Arbitrary<Clause>[] = [eqFor(root, true), fc.array(eqFor(root, false), { minLength: 2, maxLength: 4 }).map((of): Clause => ({ kind: 'any', of }))]
  if (root === 'orders') {
    all.push(fc.record({ field: fc.constantFrom('processed_at' as const, 'updated_at' as const), op: fc.constantFrom('>=' as const, '<' as const), at: instant }).map((r): Clause => ({ kind: 'range', ...r })))
  }
  if (root === 'products') {
    all.push(value.map((v): Clause => ({ kind: 'phrase', value: v })))
    all.push(fc.integer({ min: -1e15 + 1, max: 1e15 - 1 }).map((n): Clause => ({ kind: 'below', field: 'inventory_total', value: n })))
  }
  return fc.oneof(...all)
}

const rooted = fc.constantFrom<SearchRoot>('orders', 'products', 'productVariants').chain(root => fc.tuple(fc.constant(root), fc.array(clauseFor(root), { minLength: 1, maxLength: 5 })))

describe('parseSearchQuery (differential)', () => {
  test.prop([rooted], { numRuns: 500 })('every builder output parses back to its clauses, under both parsers', ([root, clauses]) => {
    const q = buildQuery(clauses)!
    expect(parseSearchQuery(root, q)).toEqual(clauses)
    expect(parseQuery(q)).toEqual({ ok: true, clauses })
  })

  const noise = fc.stringMatching(/^[-a-z_:"'()<>=*@.0-9 ORT\\]{1,40}$/)
  test.prop([fc.constantFrom<SearchRoot>('orders', 'products', 'productVariants'), noise], { numRuns: 2000 })(
    'whatever the hub accepts, the reference parser reads the same way',
    (root, q) => {
      const ours = parseSearchQuery(root, q)
      if (ours === null) return
      expect(parseQuery(q)).toEqual({ ok: true, clauses: ours })
    },
  )
})

describe('parseSearchQuery: refusals', () => {
  it('refuses keys outside the root, unquoted values, wildcards outside quotes and bare text on orders', () => {
    const refused: [SearchRoot, string][] = [
      ['orders', 'email:"a@b.test"'],
      ['orders', 'email:a*'],
      ['orders', 'phone:"+15550100"'],
      ['orders', 'note:"x"'],
      ['orders', 'customer_id:"1"'],
      ['orders', 'tag:"vip"'],
      ['orders', 'address1:"x"'],
      ['orders', '"jane"'],
      ['orders', 'sku:abc'],
      ['orders', 'sku:"a"*'],
      ['orders', 'sku:"a" OR email:"b"'],
      ['orders', 'status:"active"'],
      ['orders', 'inventory_total:<5'],
      ['orders', "processed_at:>'2026-11-01'"],
      ['orders', 'sku:"a"  sku:"b"'],
      ['products', 'title:"tent"'],
      ['products', "updated_at:>='2026-11-01T00:00:00Z'"],
      ['productVariants', '"tent"'],
      ['productVariants', 'status:"active"'],
      ['orders', ''],
    ]
    for (const [root, q] of refused) expect(parseSearchQuery(root, q), `${root} ${q}`).toBeNull()
  })

  it('accepts the shapes the tools send', () => {
    expect(parseSearchQuery('orders', 'name:"#1001"')).not.toBeNull()
    expect(parseSearchQuery('orders', '-return_status:"no_return" sku:"HX-0089"')).not.toBeNull()
    expect(parseSearchQuery('products', '"tent" status:"active" inventory_total:<1')).not.toBeNull()
    expect(parseSearchQuery('productVariants', 'sku:"a*"')).not.toBeNull()
  })
})
