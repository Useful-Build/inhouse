// The level 1 field and argument check (P5 W2, A.7.1 and A.7.2). Failure modes first:
// - a non-allowed field reaches Shopify (directly, aliased, through a named or inline fragment, nested);
// - `edges`/`node` or introspection gets through;
// - a filter or sort becomes an oracle (`email:a*`, CUSTOMER_NAME, a bare phrase on orders), literal or by variable;
// - an unknown argument, or more than 3 root fields;
// - the six tools' own documents or the recorder's are refused (the check would break the tools).
// The property's oracle is the generator's own record of what it placed, never fields.ts.
import fc from 'fast-check'
import { test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { checkShopifyFields } from './fields'
import { DOCUMENT_FIELDS } from '../connectors/shopify/fields'
import { OPERATIONS, RECORDER, type Clause, type EqField } from '../connectors/shopify/documents'
import { buildQuery } from '../connectors/shopify/search'
import { variablesFor as inventoryVariables } from '../connectors/shopify/tools/inventory-levels-get'
import { variablesFor as orderGetVariables } from '../connectors/shopify/tools/order-get'

const passes = (doc: string, variables?: Record<string, unknown>) => checkShopifyFields(doc, variables).ok

// ---------- the generator's world: literal lists, written here ----------

const LEAVES = [...new Set(Object.values(DOCUMENT_FIELDS).flat())]
const ROOTS = [...new Set(LEAVES.map(p => p.split('.')[0]!))]
const CONNECTION_ROOTS = ['orders', 'products', 'productVariants'] as const
type Root = (typeof CONNECTION_ROOTS)[number]
const BAD_ROOTS = ['node', 'nodes', 'customers', '__schema', '__type']
const BAD_NAMES = ['email', 'phone', 'note', 'customAttributes', 'clientIp', 'customer', 'shippingAddress', 'billingAddress', 'firstName', 'displayName', 'zzInvented', 'secretField']
/** Object prefixes per root: where a non-allowed leaf can be placed. */
const PREFIXES_BY_ROOT = new Map<string, string[]>(
  ROOTS.map(r => [
    r,
    [...new Set(LEAVES.filter(p => p.startsWith(`${r}.`)).flatMap(p => p.split('.').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('.'))))],
  ]),
)
const SORTS: Record<Root, { good: string[]; bad: string[] }> = {
  orders: { good: ['PROCESSED_AT', 'UPDATED_AT', 'ID'], bad: ['CUSTOMER_NAME', 'TOTAL_PRICE', 'RELEVANCE'] },
  products: { good: ['TITLE', 'INVENTORY_TOTAL', 'ID'], bad: ['VENDOR', 'RELEVANCE'] },
  productVariants: { good: [], bad: ['SKU', 'ID'] },
}
const EQ_KEYS: Record<Root, EqField[]> = {
  orders: ['financial_status', 'fulfillment_status', 'return_status', 'sku', 'name'],
  products: ['status', 'sku'],
  productVariants: ['sku'],
}
const DENIED_QUERIES = ['email:"a@b.test"', 'phone:"+15550100"', 'note:"x"', 'customer_id:"1"', 'tag:"vip"', 'address1:"x"', 'sku:abc', 'sku:"a" email:a*']

type Placed = { doc: string; variables: Record<string, unknown>; bad: string[] }

const valueText = fc.stringMatching(/^[A-Za-z0-9 #*_"\\-]{0,12}$/)

function goodClause(root: Root): fc.Arbitrary<Clause> {
  const eq = fc.record({ field: fc.constantFrom(...EQ_KEYS[root]), value: valueText }).map(({ field, value }) => ({ kind: 'eq', field, value }) as Clause)
  const options: fc.Arbitrary<Clause>[] = [eq]
  if (root === 'orders') {
    options.push(
      fc.record({ field: fc.constantFrom('processed_at', 'updated_at'), op: fc.constantFrom('>=', '<'), ms: fc.integer({ min: 0, max: 4e12 }) }).map(
        ({ field, op, ms }) => ({ kind: 'range', field, op, at: new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') }) as Clause,
      ),
      fc
        .array(fc.record({ field: fc.constantFrom(...EQ_KEYS.orders), value: valueText }), { minLength: 2, maxLength: 3 })
        .map(of => ({ kind: 'any', of: of.map(o => ({ kind: 'eq', ...o })) }) as Clause),
    )
  }
  if (root === 'products') {
    options.push(
      valueText.map(value => ({ kind: 'phrase', value }) as Clause),
      fc.integer({ min: -50, max: 500 }).map(value => ({ kind: 'below', field: 'inventory_total', value }) as Clause),
    )
  }
  return fc.oneof(...options)
}

type Arg = { name: string; value: unknown; literal: string; bad: string | null }

function rootArgs(root: string): fc.Arbitrary<Arg[]> {
  if (!(CONNECTION_ROOTS as readonly string[]).includes(root)) {
    return fc.oneof(fc.constant([] as Arg[]), fc.constant<Arg[]>([{ name: 'first', value: 1, literal: '1', bad: 'arg on a non-connection root' }]))
  }
  const r = root as Root
  const first = fc.integer({ min: 1, max: 250 }).map((n): Arg => ({ name: 'first', value: n, literal: String(n), bad: null }))
  const query = fc.oneof(
    fc.array(goodClause(r), { minLength: 1, maxLength: 3 }).map((cs): Arg => {
      const q = buildQuery(cs)!
      return { name: 'query', value: q, literal: JSON.stringify(q), bad: null }
    }),
    fc.constantFrom(...DENIED_QUERIES).map((q): Arg => ({ name: 'query', value: q, literal: JSON.stringify(q), bad: `query ${q}` })),
    valueText.map((v): Arg => {
      const q = `"${v.replace(/[\\"]/g, c => `\\${c}`)}"`
      return { name: 'query', value: q, literal: JSON.stringify(q), bad: r === 'products' ? null : 'bare phrase' }
    }),
  )
  const sorts = [...SORTS[r].good.map(k => ({ k, bad: null as string | null })), ...SORTS[r].bad.map(k => ({ k, bad: `sortKey ${k}` }))]
  const sortKey = fc.constantFrom(...sorts).map(({ k, bad }): Arg => ({ name: 'sortKey', value: k, literal: k, bad }))
  const unknown = fc.constantFrom('savedSearchId', 'before', 'last').map((n): Arg => ({ name: n, value: 1, literal: '1', bad: `arg ${n}` }))
  const reverse = fc.boolean().map((b): Arg => ({ name: 'reverse', value: b, literal: String(b), bad: null }))
  return fc
    .tuple(first, fc.option(query), fc.option(sortKey), fc.option(reverse), fc.oneof({ arbitrary: fc.constant(null), weight: 8 }, { arbitrary: unknown, weight: 1 }))
    .map(([f, q, s, rv, u]) => [f, q, s, rv, u].filter((a): a is Arg => a !== null))
}

type Item = { path: string; bad: string | null }

function rootItems(root: string): fc.Arbitrary<Item[]> {
  if (BAD_ROOTS.includes(root)) {
    return fc.constant([{ path: root === '__schema' ? '__schema.types.name' : `${root}.id`, bad: `root ${root}` }])
  }
  const leaves = LEAVES.filter(p => p.startsWith(`${root}.`))
  const prefixes = PREFIXES_BY_ROOT.get(root) ?? [root]
  const good = fc.constantFrom(...leaves).map((path): Item => ({ path, bad: null }))
  // A name that is allowed at that spot (the merchant's refund `note`) isn't a violation: skip it.
  const badLeaf = fc.tuple(fc.constantFrom(...prefixes), fc.constantFrom(...BAD_NAMES)).filter(([p, n]) => !LEAVES.includes(`${p}.${n}`)).map(([p, n]): Item => ({ path: `${p}.${n}`, bad: `field ${n}` }))
  const withNodes = leaves.filter(p => p.split('.').includes('nodes'))
  const edges = withNodes.length
    ? fc.constantFrom(...withNodes).map((p): Item => ({ path: p.replace('.nodes.', '.edges.node.').replace(/^(\w+)\.nodes\./, '$1.edges.node.'), bad: 'edges' }))
    : good
  const typename = fc.constantFrom(...prefixes).map((p): Item => ({ path: `${p}.__typename`, bad: null }))
  const introspect = fc.constantFrom(...prefixes).map((p): Item => ({ path: `${p}.__type`, bad: 'introspection' }))
  return fc.tuple(
    fc.array(good, { minLength: 1, maxLength: 4 }),
    fc.array(fc.oneof({ arbitrary: badLeaf, weight: 3 }, { arbitrary: edges, weight: 1 }, { arbitrary: typename, weight: 4 }, { arbitrary: introspect, weight: 1 }), { maxLength: 1 }),
  ).map(([g, b]) => [...g, ...b])
}

type Trie = Map<string, Trie>

function trieOf(paths: string[]): Trie {
  const t: Trie = new Map()
  for (const p of paths) {
    let at = t
    for (const seg of p.split('.')) {
      if (!at.has(seg)) at.set(seg, new Map())
      at = at.get(seg)!
    }
  }
  return t
}

/** Renders a trie with random aliases, inline fragments and named fragments (drawn from `rand`). */
function render(t: Trie, rand: () => number, frags: string[]): string {
  const parts: string[] = []
  for (const [name, kids] of t) {
    const alias = rand() < 0.3 ? `${['total', 'email', 'x', 'name'][Math.floor(rand() * 4)]}${Math.floor(rand() * 100)}: ` : ''
    const body = kids.size ? ` { ${render(kids, rand, frags)} }` : ''
    let text = `${alias}${name}${body}`
    const wrap = rand()
    if (wrap < 0.15) text = `... on Thing { ${text} }`
    else if (wrap < 0.3) {
      const id = `F${frags.length}`
      frags.push(`fragment ${id} on Thing { ${text} }`)
      text = `...${id}`
    }
    parts.push(text)
  }
  return parts.join(' ')
}

const placed: fc.Arbitrary<Placed> = fc
  .tuple(
    fc.oneof({ arbitrary: fc.array(fc.constantFrom(...ROOTS), { minLength: 1, maxLength: 3 }), weight: 4 }, { arbitrary: fc.array(fc.constantFrom(...ROOTS, ...BAD_ROOTS), { minLength: 1, maxLength: 5 }), weight: 2 }).chain(roots =>
      fc.tuple(...roots.map(r => fc.tuple(fc.constant(r), rootItems(r), rootArgs(r), fc.boolean()))),
    ),
    fc.infiniteStream(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true })),
  )
  .map(([roots, stream]) => {
    const it = stream[Symbol.iterator]()
    const rand = () => it.next().value as number
    const frags: string[] = []
    const vars: string[] = []
    const variables: Record<string, unknown> = {}
    const bad: string[] = []
    if (roots.length > 3) bad.push('more than 3 roots')
    const fields = roots.map(([root, items, args, byVariable], i) => {
      for (const item of items) if (item.bad) bad.push(item.bad)
      for (const a of args) if (a.bad) bad.push(a.bad)
      const argText = args
        .map(a => {
          if (!byVariable || a.name === 'first') return `${a.name}: ${a.literal}`
          const v = `v${i}_${a.name}`
          vars.push(`$${v}: ${a.name === 'sortKey' ? 'OrderSortKeys' : a.name === 'reverse' ? 'Boolean' : 'String'}`)
          variables[v] = a.value
          return `${a.name}: $${v}`
        })
        .join(', ')
      const rootTrie = trieOf(items.map(x => x.path)).get(root)!
      const alias = roots.length > 1 ? `r${i}: ` : ''
      return `${alias}${root}${argText ? `(${argText})` : ''} { ${render(rootTrie, rand, frags)} }`
    })
    const head = vars.length ? `query Q(${vars.join(', ')})` : 'query Q'
    return { doc: `${head} { ${fields.join(' ')} }\n${frags.join('\n')}`, variables, bad }
  })

describe('checkShopifyFields: the generator places each violation and knows it (property)', () => {
  test.prop([placed], { numRuns: 600 })('the verdict equals the generator record', p => {
    const verdict = checkShopifyFields(p.doc, p.variables).ok
    if (verdict !== (p.bad.length === 0)) {
      throw new Error(`expected ${p.bad.length === 0 ? 'pass' : `refuse (${p.bad.join('; ')})`}, got ${verdict ? 'pass' : 'refuse'}\n${p.doc}\n${JSON.stringify(p.variables)}`)
    }
  })

  it('the generator reaches every kind of case (it can fail)', () => {
    const kinds = new Set<string>()
    let passed = 0
    fc.assert(
      fc.property(placed, p => {
        if (p.bad.length === 0) passed++
        for (const b of p.bad) kinds.add(b.split(' ')[0]!)
      }),
      { numRuns: 600, seed: 7 },
    )
    expect(passed).toBeGreaterThan(20)
    for (const k of ['field', 'root', 'edges', 'introspection', 'query', 'sortKey', 'arg', 'bare', 'more']) expect(kinds, k).toContain(k)
  })
})

describe('checkShopifyFields: literal cases', () => {
  it('every document in documents.ts passes with no variables', () => {
    for (const [name, doc] of Object.entries(OPERATIONS)) expect(passes(doc), name).toBe(true)
  })

  it('the tools pass with the variables their builders send', () => {
    expect(passes(OPERATIONS.InventoryLevelsGet!, inventoryVariables({ sku: 'HX-0038' } as never))).toBe(true)
    expect(passes(OPERATIONS.OrderGet!, orderGetVariables({ name: '#1006' } as never))).toBe(true)
    const q = buildQuery([
      { kind: 'range', field: 'processed_at', op: '>=', at: '2026-11-01T00:00:00Z' },
      { kind: 'range', field: 'processed_at', op: '<', at: '2026-11-20T00:00:00Z' },
      { kind: 'eq', field: 'financial_status', value: 'paid' },
      { kind: 'eq', field: 'fulfillment_status', value: 'unfulfilled' },
      { kind: 'eq', field: 'sku', value: 'HX-0062' },
    ])
    expect(passes(OPERATIONS.OrdersSearch!, { first: 20, query: q, after: 'abc' })).toBe(true)
    const refunds = buildQuery([
      { kind: 'any', of: [{ kind: 'eq', field: 'financial_status', value: 'refunded' }, { kind: 'eq', field: 'financial_status', value: 'partially_refunded' }] },
      { kind: 'range', field: 'updated_at', op: '>=', at: '2026-11-19T00:00:00Z' },
    ])
    expect(passes(OPERATIONS.RefundsSearch!, { first: 10, query: refunds })).toBe(true)
    expect(passes(OPERATIONS.RecordRefunds!, { first: RECORDER.pages.refunds, query: refunds })).toBe(true)
    expect(passes(OPERATIONS.ReturnsSearch!, { first: 5, query: buildQuery([{ kind: 'eq', field: 'return_status', value: 'no_return', negate: true }]) })).toBe(true)
    expect(passes(OPERATIONS.ProductsSearch!, { first: 20, sortKey: 'INVENTORY_TOTAL', query: buildQuery([{ kind: 'phrase', value: 'tent' }, { kind: 'eq', field: 'status', value: 'active' }, { kind: 'below', field: 'inventory_total', value: 1 }]) })).toBe(true)
    expect(passes('{ products(first: 5, query: "\\"tent\\"") { nodes { id } } }')).toBe(true)
  })

  it('refuses S4 review failure document and protected fields, aliased or through fragments', () => {
    expect(passes('{ orders(first: 5) { nodes { note customAttributes { key value } clientIp customer { id } } } }')).toBe(false)
    expect(passes('{ orders(first: 5) { nodes { total: email } } }')).toBe(false)
    expect(passes('{ orders(first: 5) { nodes { email: name } } }')).toBe(true)
    expect(passes('{ orders(first: 5) { nodes { ...F } } } fragment F on Order { id customer { id } }')).toBe(false)
    expect(passes('{ orders(first: 5) { nodes { ... on Order { note } } } }')).toBe(false)
    expect(passes('{ orders(first: 5) { edges { node { id } } } }')).toBe(false)
    expect(passes('{ __schema { types { name } } }')).toBe(false)
    expect(passes('{ orders(first: 5) { nodes { id __typename } __typename } }')).toBe(true)
    expect(passes('{ orders(first: 5) { nodes { id @include(if: true) } } }')).toBe(true)
    expect(passes('{ orders(first: 5) { nodes { id @deprecated } } }')).toBe(false)
    expect(passes('{ orders(first: 5) { nodes { lineItems } } }')).toBe(false)
  })

  it('refuses a fragment cycle and 21 nested spreads; 20 pass', () => {
    expect(passes('{ orders(first: 1) { nodes { ...A } } } fragment A on Order { id ...B } fragment B on Order { name ...A }')).toBe(false)
    const chain = (n: number) => {
      const defs = Array.from({ length: n }, (_, i) => `fragment F${i} on Order { ${i + 1 < n ? `...F${i + 1}` : 'id'} }`)
      return `{ orders(first: 1) { nodes { ...F0 } } } ${defs.join(' ')}`
    }
    expect(passes(chain(20))).toBe(true)
    expect(passes(chain(21))).toBe(false)
  })

  it('refuses an exponential fragment fan-out', () => {
    const defs = Array.from({ length: 18 }, (_, i) => `fragment F${i} on Order { ${i < 17 ? `...F${i + 1} ...F${i + 1}` : 'id'} }`)
    expect(passes(`{ orders(first: 1) { nodes { ...F0 } } } ${defs.join(' ')}`)).toBe(false)
  })

  it('refuses each filter and sort oracle, literal or by variable', () => {
    for (const doc of [
      '{ orders(first: 5, query: "email:a@b.test") { nodes { id } } }',
      '{ orders(query: "phone:+15550100") { nodes { id } } }',
      '{ orders(query: "note:\\"x\\"") { nodes { id } } }',
      '{ orders(query: "customer_id:\\"1\\"") { nodes { id } } }',
      '{ orders(query: "\\"jane\\"") { nodes { id } } }',
      '{ orders(sortKey: CUSTOMER_NAME) { nodes { id } } }',
      '{ orders(savedSearchId: 1) { nodes { id } } }',
      '{ o: customers(first: 1) { nodes { id } } }',
      '{ a: orders(first: 1) { nodes { id } } b: orders(first: 1) { nodes { id } } c: orders(first: 1) { nodes { id } } d: orders(first: 1) { nodes { id } } }',
      '{ orders(first: 1) { nodes { lineItems(last: 2) { nodes { sku } } } } }',
      '{ orders(first: 1) { nodes { id(x: 1) } } }',
      '{ productVariants(first: 1) { nodes { inventoryItem { inventoryLevels(first: 1) { nodes { quantities(names: ["damaged"]) { name } } } } } } }',
      '{ orders(first: 251) { nodes { id } } }',
    ]) {
      expect(passes(doc), doc).toBe(false)
    }
    expect(passes('query Q($q: String) { orders(first: 5, query: $q) { nodes { id } } }', { q: 'email:a*' })).toBe(false)
    expect(passes('query Q($q: String = "email:a*") { orders(first: 5, query: $q) { nodes { id } } }')).toBe(false)
    expect(passes('query Q($s: OrderSortKeys) { orders(first: 5, sortKey: $s) { nodes { id } } }', { s: 'CUSTOMER_NAME' })).toBe(false)
    // A variable the operation doesn't declare.
    expect(passes('query Q { orders(first: 5, query: $q) { nodes { id } } }', { q: 'sku:"a"' })).toBe(false)
    // A variable the operation doesn't use or declare is never forwarded (review H1).
    expect(passes('{ orders(first: 5) { nodes { id } } }', { junk: 'x'.repeat(100) })).toBe(false)
    expect(passes('query Q($q: String) { orders(first: 5, query: $q) { nodes { id } } }', { q: 'sku:"a"', extra: 1 })).toBe(false)
    expect(passes('{ a: orders(first: 1) { nodes { id } } b: orders(first: 1) { nodes { id } } c: shop { currencyCode } }')).toBe(true)
  })

  it('refuses a mutation, two operations, and garbage', () => {
    expect(passes('mutation { orderCancel(orderId: "1") { userErrors { message } } }')).toBe(false)
    expect(passes('query A { shop { currencyCode } } query B { shop { currencyCode } }')).toBe(false)
    expect(passes('{ shop { currencyCode }')).toBe(false)
  })
})
