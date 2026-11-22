// The validator and the normaliser (p4-w3.md tests 1 and 1b). Ways it can fail, written down first:
//  1. a structurally wrong result (a missing field, an extra key, a decimal `minor`, a malformed currency, an unknown `sev`,
//     `area`, `coverage` or gap, a wrong type) saves anyway, or a cosmetic overrun fails the whole result;
//  2. a cut string is over its maximum, doesn't end with `…`, or splits a surrogate pair; a repeated key keeps the later item;
//  3. a bad `since` fails the result (it must become null at save: the validator keeps it a string);
//  4. 11 items, with or without the model's own `too_many`, aren't capped at 10 with the gap added.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { MorningCheckResultSchema } from '../../shared/contract/today.ts'
import { cut, normaliseResult } from './normalise.ts'

const item = (key: string, over: Record<string, unknown> = {}) => ({
  key, sev: '#b23c22', area: 'Orders', title: 'Late orders', sub: '4 orders are past their ship date', cost: { minor: 119000, currency: 'USD' },
  costNote: 'in orders at risk', next: 'Email the 4 customers', found: [['Late orders', '4']], sources: [{ n: '#1042', text: 'Placed 9 days ago' }],
  since: '2026-11-20T09:00:00-05:00', ...over,
})
const result = (over: Record<string, unknown> = {}) => ({ coverage: 'complete', gaps: [], items: [item('late-orders')], ...over })
const bad = (raw: unknown) => 'invalid' in normaliseResult(raw, 'USD')
const ok = (raw: unknown) => {
  const r = normaliseResult(raw, 'USD')
  if ('invalid' in r) throw new Error('expected a valid result')
  return r.ok
}

describe('structural errors are invalid_result', () => {
  it('accepts the valid literal as it is', () => {
    expect(ok(result())).toEqual({ result: result(), counts: { truncated: 0, dropped: 0, deduped: 0, overflow: 0 } })
  })
  const MUTATIONS: [string, (r: ReturnType<typeof result>) => unknown][] = [
    ['not an object', () => 'text'],
    ['an array', () => []],
    ['a missing coverage', r => ({ gaps: r.gaps, items: r.items })],
    ['a missing items', r => ({ coverage: r.coverage, gaps: r.gaps })],
    ['an extra key on the result', r => ({ ...r, note: 'x' })],
    ['an extra key on an item', () => result({ items: [item('late-orders', { logos: ['shopify'] })] })],
    ['an item missing next', () => result({ items: [(({ next: _n, ...rest }) => rest)(item('late-orders'))] })],
    ['a decimal minor', () => result({ items: [item('late-orders', { cost: { minor: 12.5, currency: 'USD' } })] })],
    ['a minor as text', () => result({ items: [item('late-orders', { cost: { minor: '1190', currency: 'USD' } })] })],
    ['a lowercase currency', () => result({ items: [item('late-orders', { cost: { minor: 1, currency: 'usd' } })] })],
    ['an unknown sev', () => result({ items: [item('late-orders', { sev: 'red' })] })],
    ['an unknown area', () => result({ items: [item('late-orders', { area: 'Staff' })] })],
    ['an unknown coverage', () => result({ coverage: 'partial' })],
    ['an unknown gap', () => result({ gaps: ['payments'] })],
    ['the server-only gap sent by the model', () => result({ gaps: ['too_many'] })],
    ['a key that breaks its pattern', () => result({ items: [item('Late Orders')] })],
    ['a key over 48 characters (never cut)', () => result({ items: [item('a'.repeat(49))] })],
    ['an empty title', () => result({ items: [item('late-orders', { title: '' })] })],
    ['a title of the wrong type', () => result({ items: [item('late-orders', { title: 5 })] })],
    ['an item that is not an object', () => result({ items: ['late-orders'] })],
    ['a source with no n', () => result({ items: [item('late-orders', { sources: [{ text: 'x' }] })] })],
    ['a missing since', () => result({ items: [(({ since: _s, ...rest }) => rest)(item('late-orders'))] })],
  ]
  for (const [name, mutate] of MUTATIONS) it(`${name}`, () => expect(bad(mutate(result()))).toBe(true))

  test.prop([fc.constantFrom(...MUTATIONS), fc.integer({ min: 0, max: 9 })])('a mutation stays invalid whatever else the result holds', ([, mutate], extra) => {
    // The mutation carries its own valid-or-not items; padding with valid items can't make an invalid result valid, because the
    // structural error is in the one it mutated (or the result itself).
    const m = mutate(result()) as Record<string, unknown>
    const padded = typeof m === 'object' && m !== null && Array.isArray(m.items) && m.items.length > 0
      ? { ...m, items: [...(m.items as unknown[]), ...Array.from({ length: extra }, (_, i) => item(`pad-${i}`))].slice(0, 10) }
      : m
    expect(bad(padded)).toBe(true)
  })

  it('keeps a bad since a string (the server nulls it at save, not here)', () => {
    expect(ok(result({ items: [item('late-orders', { since: 'last Tuesday' })] })).result.items[0].since).toBe('last Tuesday')
  })
})

describe('cosmetic overruns are fixed and counted', () => {
  it('nulls a cost in another currency than the brand\'s, keeps the item and counts it', () => {
    const r = ok(result({ items: [item('late-orders', { cost: { minor: 1, currency: 'GBP' } })] }))
    expect(r.result.items).toHaveLength(1)
    expect(r.result.items[0].cost).toBeNull()
    expect(r.counts).toEqual({ truncated: 0, dropped: 1, deduped: 0, overflow: 0 })
  })
  it('cuts a 121-character title to 119 characters and an ellipsis', () => {
    const r = ok(result({ items: [item('late-orders', { title: 'a'.repeat(121) })] }))
    expect(r.result.items[0].title).toBe(`${'a'.repeat(119)}…`)
    expect(r.counts).toEqual({ truncated: 1, dropped: 0, deduped: 0, overflow: 0 })
  })
  it('drops a found row that is not a pair, and keeps the first 6 rows and the first 10 sources', () => {
    const found = [['a', '1'], ['b', '2', '3'], ['c'], ['d', '4'], ['e', '5'], ['f', '6'], ['g', '7'], ['h', '8'], ['i', '9']]
    const sources = Array.from({ length: 12 }, (_, i) => ({ n: `#${i}`, text: 't' }))
    const r = ok(result({ items: [item('late-orders', { found, sources })] }))
    expect(r.result.items[0].found).toEqual([['a', '1'], ['d', '4'], ['e', '5'], ['f', '6'], ['g', '7'], ['h', '8']])
    expect(r.result.items[0].sources.map(s => s.n)).toEqual(['#0', '#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8', '#9'])
    // 2 bad rows, 1 row past 6 (7 pairs left), 2 sources past 10.
    expect(r.counts).toEqual({ truncated: 0, dropped: 5, deduped: 0, overflow: 0 })
  })
  it('keeps the first of a repeated key', () => {
    const r = ok(result({ items: [item('late-orders', { title: 'first' }), item('low-stock'), item('late-orders', { title: 'second' })] }))
    expect(r.result.items.map(i => [i.key, i.title])).toEqual([['late-orders', 'first'], ['low-stock', 'Late orders']])
    expect(r.counts.deduped).toBe(1)
  })
  it('keeps the first 10 of 11 items and makes the result incomplete with the gap too_many', () => {
    const items = Array.from({ length: 11 }, (_, i) => item(`k-${i}`))
    const r = ok(result({ items, gaps: ['refunds'] }))
    expect(r.result.items.map(i => i.key)).toEqual(Array.from({ length: 10 }, (_, i) => `k-${i}`))
    expect(r.result).toMatchObject({ coverage: 'incomplete', gaps: ['refunds', 'too_many'] })
    expect(r.counts).toEqual({ truncated: 0, dropped: 0, deduped: 0, overflow: 1 })
  })
  it('does not count a duplicate toward the cap', () => {
    const items = [...Array.from({ length: 10 }, (_, i) => item(`k-${i}`)), item('k-0')]
    const r = ok(result({ items }))
    expect(r.counts).toEqual({ truncated: 0, dropped: 0, deduped: 1, overflow: 0 })
    expect(r.result.coverage).toBe('complete')
  })
  it('cuts a long string with an astral character at the cut without splitting the pair', () => {
    expect(cut('a'.repeat(4) + '😀' + 'b', 6)).toBe('aaaa…')
    expect(cut('abc', 3)).toBe('abc')
    expect(cut('abcd', 3)).toBe('ab…')
  })

  test.prop([fc.string({ minLength: 1, maxLength: 400 }), fc.string({ maxLength: 700 })])('any title and sub length saves, each cut to its maximum', (title, sub) => {
    const r = normaliseResult(result({ items: [item('late-orders', { title, sub })] }), 'USD')
    expect('ok' in r).toBe(true)
    if ('ok' in r) {
      const it = r.ok.result.items[0]
      expect(it.title.length).toBeLessThanOrEqual(120)
      expect(it.sub.length).toBeLessThanOrEqual(200)
      expect(MorningCheckResultSchema.safeParse({ ...r.ok.result, gaps: [] }).success).toBe(true)
      if (title.length <= 120) expect(it.title).toBe(title)
      else expect(it.title.endsWith('…')).toBe(true)
    }
  })
})
