// A strict reader of the GraphQL documents the fake write upstream takes (Stage 1 M3-S2, #489). The fake used to pick an
// operation by its name alone and never read the text, so a malformed document or the wrong mutation under a known name
// passed every test. Now each fake operation names the exact document it answers (its own text, written here in the
// fake, not imported from the hub), and the fake answers only a request whose document reads the same:
// - it parses (operation, variable definitions, fields with aliases, arguments, directives, inline fragments,
//   selections); anything else, including a literal value in an argument, is a parse error: the hub sends every value
//   as a variable;
// - its canonical form (whitespace, commas and comments dropped, nothing else) equals the expected document's;
// - its declared variables are exactly the request's variables, and every one is used.
// No npm packages (bundled into the hub's test build).

type Tok = { t: 'name' | 'punct'; v: string }

/** Thrown for a document the reader doesn't take; the fake answers it as Shopify does a parse failure. */
export class GqlError extends Error {}

function tokens(text: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ',') { i++; continue }
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (text.startsWith('...', i)) { out.push({ t: 'punct', v: '...' }); i += 3; continue }
    if ('{}()[]:!$@'.includes(c)) { out.push({ t: 'punct', v: c }); i++; continue }
    const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(text.slice(i))
    if (!m) throw new GqlError(`unexpected character at ${i}`)
    out.push({ t: 'name', v: m[0] })
    i += m[0].length
  }
  return out
}

/** The parsed document: its kind and name, its canonical form, the variables it declares and the ones it uses. */
export type GqlDoc = { kind: 'query' | 'mutation'; name: string; canonical: string; declared: string[]; used: string[] }

export function parseDocument(text: string): GqlDoc {
  const toks = tokens(text)
  let p = 0
  const peek = (v?: string) => (v === undefined ? toks[p] : toks[p]?.v === v ? toks[p] : undefined)
  const take = (v: string) => {
    if (toks[p]?.v !== v || (/^[_A-Za-z]/.test(v) && toks[p]?.t !== 'name')) throw new GqlError(`expected ${v}`)
    p++
  }
  const name = () => {
    const tk = toks[p]
    if (tk?.t !== 'name') throw new GqlError('expected a name')
    p++
    return tk.v
  }
  const declared: string[] = []
  const used: string[] = []
  const variable = () => { take('$'); const n = name(); used.push(n); return `$${n}` }
  const type = (): string => {
    let s: string
    if (peek('[')) { take('['); s = `[${type()}]`; take(']') } else s = name()
    if (peek('!')) { take('!'); s += '!' }
    return s
  }
  const args = (): string => {
    if (!peek('(')) return ''
    take('(')
    const parts: string[] = []
    while (!peek(')')) { const n = name(); take(':'); parts.push(`${n}:${variable()}`) }
    take(')')
    if (parts.length === 0) throw new GqlError('empty arguments')
    return `(${parts.join(',')})`
  }
  const directives = (): string => {
    let s = ''
    while (peek('@')) { take('@'); s += `@${name()}${args()}` }
    return s
  }
  const selections = (): string => {
    take('{')
    const parts: string[] = []
    while (!peek('}')) {
      if (peek('...')) {
        take('...'); take('on')
        parts.push(`...on ${name()}${selections()}`)
        continue
      }
      let field = name()
      if (peek(':')) { take(':'); field = `${field}:${name()}` }
      parts.push(`${field}${args()}${directives()}${peek('{') ? selections() : ''}`)
    }
    take('}')
    if (parts.length === 0) throw new GqlError('empty selection')
    return `{${parts.join(' ')}}`
  }

  const kind = name()
  if (kind !== 'query' && kind !== 'mutation') throw new GqlError('expected query or mutation')
  const opName = peek()?.t === 'name' ? name() : ''
  let vars = ''
  if (peek('(')) {
    take('(')
    const parts: string[] = []
    while (!peek(')')) {
      take('$'); const n = name(); take(':')
      if (declared.includes(n)) throw new GqlError(`variable $${n} declared twice`)
      declared.push(n)
      parts.push(`$${n}:${type()}`)
    }
    take(')')
    vars = `(${parts.join(',')})`
  }
  const body = selections()
  if (p !== toks.length) throw new GqlError('more than one operation')
  return { kind, name: opName, canonical: `${kind} ${opName}${vars}${body}`, declared, used }
}

/**
 * Null when `text` is exactly the `expected` document and `variables` are exactly what it declares; else why not.
 * Throws `GqlError` when `text` doesn't parse. `expected` is the fake's own text and must parse.
 */
export function mismatch(text: string, expected: string, variables: Record<string, unknown>): string | null {
  const got = parseDocument(text)
  const want = parseDocument(expected)
  if (got.canonical !== want.canonical) return 'document differs from the operation the fake answers'
  const unused = got.declared.find(n => !got.used.includes(n))
  if (unused) return `variable $${unused} declared and not used`
  const undeclared = got.used.find(n => !got.declared.includes(n))
  if (undeclared) return `variable $${undeclared} used and not declared`
  const keys = Object.keys(variables)
  const missing = got.declared.find(n => !keys.includes(n))
  if (missing) return `variable $${missing} not given`
  const extra = keys.find(k => !got.declared.includes(k))
  if (extra) return `variable ${extra} given and not declared`
  return null
}
