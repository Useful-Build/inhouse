// The Shopify search-query check (P5 W2, A.3a). Code mode lets a script send its own `query:` filter, and a filter is
// an oracle (`email:a*` answers "does such a customer exist", a prefix at a time), so every `query` string SignIn.query
// sends is parsed with exactly the grammar H0's builder emits (connectors/shopify/search.ts) and its keys are checked per
// root. Anything else is refused. Written apart from the recorded upstream's parser (the hub can't import app/test/);
// search-query.test.ts runs both over generated clauses.
//
//   query  := clause (' ' clause)*
//   clause := '(' eq (' OR ' eq)+ ')' | eq | range | below | phrase
//   eq     := '-'? KEY ':' QUOTED
//   range  := KEY ':' ('>=' | '<') "'" YYYY-MM-DDTHH:MM:SSZ "'"
//   below  := KEY ':<' INTEGER
//   phrase := QUOTED                     QUOTED: "...", with \\ and \" the only escapes
import { QUERY_INSTANT, type Clause, type EqClause, type EqField } from '../connectors/shopify/documents'

export type SearchRoot = 'orders' | 'products' | 'productVariants'

/** The keys each root may filter on, as the six tools use them. Anything else (email, phone, note, tag...) is refused. */
export const SEARCH_KEYS: Readonly<Record<SearchRoot, { eq: readonly EqField[]; range: readonly string[]; below: readonly string[]; phrase: boolean }>> = {
  orders: { eq: ['financial_status', 'fulfillment_status', 'return_status', 'sku', 'name'], range: ['processed_at', 'updated_at'], below: [], phrase: false },
  // Product titles carry no protected data; products_search sends a phrase. Orders match free text against customers.
  products: { eq: ['status', 'sku'], range: [], below: ['inventory_total'], phrase: true },
  productVariants: { eq: ['sku'], range: [], below: [], phrase: false },
}

class Cursor {
  i = 0
  readonly s: string
  constructor(s: string) {
    this.s = s
  }
  get done(): boolean {
    return this.i >= this.s.length
  }
  at(t: string): boolean {
    return this.s.startsWith(t, this.i)
  }
  eat(t: string): void {
    if (!this.at(t)) throw new SyntaxError('search query')
    this.i += t.length
  }
  quoted(): string {
    this.eat('"')
    let out = ''
    while (!this.done) {
      const c = this.s[this.i]!
      if (c === '"') {
        this.i++
        return out
      }
      if (c === '\\') {
        const n = this.s[this.i + 1]
        if (n !== '"' && n !== '\\') break
        out += n
        this.i += 2
        continue
      }
      out += c
      this.i++
    }
    throw new SyntaxError('search query')
  }
  key(): string {
    const m = /^[a-z_]+/.exec(this.s.slice(this.i))
    if (!m) throw new SyntaxError('search query')
    this.i += m[0].length
    return m[0]
  }
}

function eqClause(r: Cursor, keys: readonly EqField[]): EqClause {
  const negate = r.at('-')
  if (negate) r.eat('-')
  const field = r.key()
  if (!(keys as readonly string[]).includes(field)) throw new SyntaxError('search query')
  r.eat(':')
  const value = r.quoted()
  return negate ? { kind: 'eq', field: field as EqField, value, negate: true } : { kind: 'eq', field: field as EqField, value }
}

function oneClause(r: Cursor, root: SearchRoot): Clause {
  const k = SEARCH_KEYS[root]
  if (r.at('(')) {
    r.eat('(')
    const of = [eqClause(r, k.eq)]
    while (r.at(' OR ')) {
      r.eat(' OR ')
      of.push(eqClause(r, k.eq))
    }
    r.eat(')')
    if (of.length < 2 || of.some(o => o.negate)) throw new SyntaxError('search query')
    return { kind: 'any', of }
  }
  if (r.at('"')) {
    if (!k.phrase) throw new SyntaxError('search query')
    return { kind: 'phrase', value: r.quoted() }
  }
  if (r.at('-')) return eqClause(r, k.eq)
  const start = r.i
  const key = r.key()
  if (k.range.includes(key) && (r.at(":>='") || r.at(":<'"))) {
    r.eat(':')
    const op = r.at('>=') ? '>=' : '<'
    r.eat(op)
    r.eat("'")
    const at = r.s.slice(r.i, r.i + 20)
    if (!QUERY_INSTANT.test(at)) throw new SyntaxError('search query')
    r.i += 20
    r.eat("'")
    return { kind: 'range', field: key as 'processed_at' | 'updated_at', op, at }
  }
  if (k.below.includes(key) && r.at(':<')) {
    r.eat(':<')
    const m = /^-?(?:0|[1-9]\d{0,14})(?!\d)/.exec(r.s.slice(r.i))
    if (!m || m[0] === '-0') throw new SyntaxError('search query')
    r.i += m[0].length
    return { kind: 'below', field: 'inventory_total', value: Number(m[0]) }
  }
  r.i = start
  return eqClause(r, k.eq)
}

/** The clauses of `query` under `root`'s keys, or null when anything is outside the grammar or the keys. */
export function parseSearchQuery(root: SearchRoot, query: string): Clause[] | null {
  if (typeof query !== 'string' || query.length === 0 || !Object.hasOwn(SEARCH_KEYS, root)) return null
  const r = new Cursor(query)
  const out: Clause[] = []
  try {
    for (;;) {
      out.push(oneClause(r, root))
      if (r.done) return out
      r.eat(' ')
    }
  } catch {
    return null
  }
}
