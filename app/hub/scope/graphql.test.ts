import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { checkReadDocument, MAX_DOCUMENT_CHARS } from './graphql'

const name = fc.stringMatching(/^[a-z][a-zA-Z]{0,8}$/)
const field = fc.tuple(fc.option(name, { nil: undefined }), name).map(([alias, f]) => (alias ? `${alias}: ${f}` : f))
const selection = fc.array(field, { minLength: 1, maxLength: 4 }).map(fs => `{ ${fs.join(' ')} }`)
const fragment = fc.tuple(name, name, selection).map(([n, t, s]) => `fragment F${n} on T${t} ${s}`)
const op = (kind: 'query' | 'mutation' | 'subscription') =>
  fc.tuple(fc.option(name, { nil: undefined }), selection).map(([n, s]) => `${kind}${n ? ` Op${n}` : ''} ${s}`)

describe('the read-only document check', () => {
  test.prop([op('query'), fc.array(fragment, { maxLength: 3 })])('one query, with or without fragments, passes', (q, frags) => {
    expect(checkReadDocument([...frags, q].join('\n'))).toEqual({ ok: true })
  })

  test.prop([selection])('a shorthand query passes', s => {
    expect(checkReadDocument(s)).toEqual({ ok: true })
  })

  test.prop([fc.oneof(op('mutation'), op('subscription')), fc.array(fragment, { maxLength: 2 }), fc.array(op('query'), { maxLength: 2 }), fc.nat()])(
    'a mutation or subscription anywhere is refused',
    (write, frags, queries, at) => {
      const parts = [...frags, ...queries]
      parts.splice(at % (parts.length + 1), 0, write)
      expect(checkReadDocument(parts.join('\n'))).toEqual({ ok: false, code: 'write_refused' })
    },
  )

  test.prop([fc.string({ maxLength: 40 })])('unparsable documents are refused', s => {
    fc.pre(!/^\s*(query|\{)/.test(s))
    const r = checkReadDocument(`${s} {{`)
    expect(r.ok).toBe(false)
  })

  it('hand cases', () => {
    expect(checkReadDocument('# mutation { x }\n{ shop { name } }')).toEqual({ ok: true })
    expect(checkReadDocument('{ orders(query: "mutation { delete }") { id } }')).toEqual({ ok: true })
    expect(checkReadDocument('{ a } mutation { b }')).toEqual({ ok: false, code: 'write_refused' })
    expect(checkReadDocument('query A { a } query B { b }')).toEqual({ ok: false, code: 'invalid_args' })
    expect(checkReadDocument('fragment F on T { a }')).toEqual({ ok: false, code: 'invalid_args' })
    expect(checkReadDocument('subscription S { a } ')).toEqual({ ok: false, code: 'write_refused' })
    expect(checkReadDocument('')).toEqual({ ok: false, code: 'invalid_args' })
    expect(checkReadDocument(42)).toEqual({ ok: false, code: 'invalid_args' })
  })

  it('refuses a document over 20,000 characters', () => {
    const doc = `{ shop { name } }${' '.repeat(MAX_DOCUMENT_CHARS)}`
    expect(checkReadDocument(doc)).toEqual({ ok: false, code: 'invalid_args' })
    expect(checkReadDocument(doc.slice(0, MAX_DOCUMENT_CHARS))).toEqual({ ok: true })
  })
})
