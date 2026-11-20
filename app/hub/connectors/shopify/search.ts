// The Shopify search-query builder. Typed clauses in, one query string out. Every caller value sits inside a quoted
// value with `\` and `"` backslash-escaped; instants are normalised and single-quoted; clauses are joined by a space
// (implicit AND). Nothing is ever concatenated outside a quoted value, so caller text can't add a clause.
// The recorded upstream's parser (app/test/upstreams/shopify/query.ts) reads exactly this grammar back.
// Docs read 2026-11-20: https://shopify.dev/docs/api/usage/search-syntax
import { QUERY_INSTANT, type Clause, type EqClause } from './documents'

export const quoteValue = (value: string): string => `"${value.replace(/[\\"]/g, c => `\\${c}`)}"`

/** An ISO 8601 instant with an offset, as `YYYY-MM-DDTHH:MM:SSZ` (sub-second digits dropped). Throws on an invalid one. */
export function queryInstant(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) throw new Error('search: invalid instant')
  const at = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!QUERY_INSTANT.test(at)) throw new Error('search: instant out of range')
  return at
}

const eq = (c: EqClause): string => `${c.negate ? '-' : ''}${c.field}:${quoteValue(c.value)}`

function clause(c: Clause): string {
  switch (c.kind) {
    case 'eq':
      return eq(c)
    case 'range':
      if (!QUERY_INSTANT.test(c.at)) throw new Error('search: instant not normalised')
      return `${c.field}:${c.op}'${c.at}'`
    case 'below':
      if (!Number.isSafeInteger(c.value)) throw new Error('search: bad number')
      return `${c.field}:<${c.value}`
    case 'phrase':
      return quoteValue(c.value)
    case 'any':
      if (c.of.length < 2 || c.of.some(o => o.negate)) throw new Error('search: bad OR group')
      return `(${c.of.map(eq).join(' OR ')})`
  }
}

/** The query string, or undefined when there are no clauses (the variable is then omitted). */
export function buildQuery(clauses: readonly Clause[]): string | undefined {
  return clauses.length === 0 ? undefined : clauses.map(clause).join(' ')
}
