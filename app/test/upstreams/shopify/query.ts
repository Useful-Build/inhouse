// The recorded upstream's search-query parser: exactly the grammar app/hub/connectors/shopify/search.ts emits, and
// nothing else. Anything outside it is an error, so a builder change without a fake change fails loud.
//
//   query  := clause (' ' clause)*
//   clause := '(' eq (' OR ' eq)+ ')' | eq | range | below | phrase
//   eq     := '-'? FIELD ':' QUOTED            FIELD in financial_status fulfillment_status return_status sku name status
//   range  := ('processed_at' | 'updated_at') ':' ('>=' | '<') "'" YYYY-MM-DDTHH:MM:SSZ "'"
//   below  := 'inventory_total:<' INTEGER
//   phrase := QUOTED                            QUOTED: "...", with \\ and \" the only escapes
import { QUERY_INSTANT, type Clause, type EqClause, type EqField } from '../../../hub/connectors/shopify/documents'

const EQ_FIELDS: readonly EqField[] = ['financial_status', 'fulfillment_status', 'return_status', 'sku', 'name', 'status']

export type Parsed = { ok: true; clauses: Clause[] } | { ok: false; error: string }

class Reader {
  i = 0
  readonly s: string
  constructor(s: string) {
    this.s = s
  }
  get done() {
    return this.i >= this.s.length
  }
  peek(t: string) {
    return this.s.startsWith(t, this.i)
  }
  take(t: string) {
    if (!this.peek(t)) throw new Error(`expected "${t}" at ${this.i}`)
    this.i += t.length
  }
  quoted(): string {
    this.take('"')
    let out = ''
    for (;;) {
      if (this.done) throw new Error('unterminated quote')
      const c = this.s[this.i]!
      if (c === '\\') {
        const n = this.s[this.i + 1]
        if (n !== '\\' && n !== '"') throw new Error(`bad escape at ${this.i}`)
        out += n
        this.i += 2
      } else if (c === '"') {
        this.i++
        return out
      } else {
        out += c
        this.i++
      }
    }
  }
  word(): string {
    const m = /^[a-z_]+/.exec(this.s.slice(this.i))
    if (!m) throw new Error(`expected a field at ${this.i}`)
    this.i += m[0].length
    return m[0]
  }
}

function eq(r: Reader): EqClause {
  const negate = r.peek('-')
  if (negate) r.take('-')
  const field = r.word() as EqField
  if (!EQ_FIELDS.includes(field)) throw new Error(`unknown field ${field}`)
  r.take(':')
  const value = r.quoted()
  return negate ? { kind: 'eq', field, value, negate: true } : { kind: 'eq', field, value }
}

function clause(r: Reader): Clause {
  if (r.peek('(')) {
    r.take('(')
    const of = [eq(r)]
    while (r.peek(' OR ')) {
      r.take(' OR ')
      of.push(eq(r))
    }
    r.take(')')
    if (of.length < 2 || of.some(o => o.negate)) throw new Error('bad OR group')
    return { kind: 'any', of }
  }
  if (r.peek('"')) return { kind: 'phrase', value: r.quoted() }
  if (r.peek('processed_at:') || r.peek('updated_at:')) {
    const field = r.word() as 'processed_at' | 'updated_at'
    r.take(':')
    const op = r.peek('>=') ? '>=' : '<'
    r.take(op)
    r.take("'")
    const at = r.s.slice(r.i, r.i + 20)
    if (!QUERY_INSTANT.test(at)) throw new Error(`bad instant at ${r.i}`)
    r.i += 20
    r.take("'")
    return { kind: 'range', field, op, at }
  }
  if (r.peek('inventory_total:<')) {
    r.take('inventory_total:<')
    const m = /^-?(0|[1-9]\d{0,14})(?![\d])/.exec(r.s.slice(r.i))
    if (!m || m[0] === '-0') throw new Error(`bad number at ${r.i}`)
    r.i += m[0].length
    return { kind: 'below', field: 'inventory_total', value: Number(m[0]) }
  }
  return eq(r)
}

export function parseQuery(q: string | undefined | null): Parsed {
  if (q === undefined || q === null) return { ok: true, clauses: [] }
  if (typeof q !== 'string' || q.length === 0) return { ok: false, error: 'empty query' }
  const r = new Reader(q)
  const clauses: Clause[] = []
  try {
    for (;;) {
      clauses.push(clause(r))
      if (r.done) break
      r.take(' ')
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'parse error' }
  }
  return { ok: true, clauses }
}
