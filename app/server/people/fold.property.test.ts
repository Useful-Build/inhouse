// Properties of the fold, the shown-name shape and the flags (Stage 1 M3-T, N28): folding is idempotent on any text; a
// shown name fits the team line's shape; a Latin name with one letter swapped for a look-alike from another script is
// flagged `mixed_script`. That every active person is found by their own name, through the tool
// and D1, is in tools/team/member-find.test.ts.
import { fc } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { NAME_SHAPE, NAME_SHOWN_MAX, fold, nameFlags, nameShown } from './fold.ts'

const RUNS = Number(import.meta.env.VITE_PROP_RUNS) || 1000

/** Characters the fold treats specially: marks, format and control characters, Hangul, final sigma, look-alikes, ... */
const TRICKY = [
  '\u0307', '\u0301', '\u200B', '\u200D', '\u202E', '\u00AD', '\n', '\u2028', '\u0000', 'İ', 'ẞ', 'ß', 'Σ', 'ς', 'ﬁ', 'Ⅻ',
  '한', 'ᄀ', 'ᅡ', 'ᆨ', 'Ｉ', '’', 'ʼ', '-', "'", ' ', '.', 'ǅ', 'ﷺ', '㍿', 'K', 'Å', 'Ω', 'о', 'е', 'а', 'ο', 'ー',
]
const char = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...TRICKY) },
  { weight: 3, arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }) },
  { weight: 3, arbitrary: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') },
)
const text = fc.array(char, { maxLength: 40 }).map(cs => cs.join(''))

/** Latin letters and a look-alike from Cyrillic or Greek for each. */
const LOOK_ALIKE: Readonly<Record<string, string>> = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', i: 'і', A: 'А', O: 'Ο', E: 'Ε', H: 'Н', K: 'Κ', M: 'М', T: 'Т' }

describe('the fold', () => {
  it('is idempotent on any text', () => {
    fc.assert(fc.property(text, s => { expect(fold(fold(s))).toBe(fold(s)) }), { numRuns: RUNS })
  })
})

describe('what the agent is shown', () => {
  it("a shown name is in the team line's shape and at most 40 characters", () => {
    fc.assert(fc.property(text, s => {
      if (!nameShown(s)) return
      expect(NAME_SHAPE.test(s)).toBe(true)
      expect([...s].length).toBeLessThanOrEqual(NAME_SHOWN_MAX)
    }), { numRuns: RUNS })
  })

  it('a Latin name with one letter swapped for a look-alike of another script is flagged mixed_script', () => {
    const word = fc.stringMatching(/^[A-Z][a-z]{1,9}$/)
    const name = fc.array(word, { minLength: 1, maxLength: 3 }).map(ws => ws.join(' '))
    fc.assert(fc.property(name, fc.nat(), (n, pick) => {
      expect(nameFlags(n)).not.toContain('mixed_script')
      const spots = [...n].flatMap((c, i) => (LOOK_ALIKE[c] === undefined ? [] : [i]))
      fc.pre(spots.length > 0)
      const at = spots[pick % spots.length]
      const swapped = [...n].map((c, i) => (i === at ? LOOK_ALIKE[c] : c)).join('')
      expect(nameFlags(swapped), swapped).toContain('mixed_script')
    }), { numRuns: RUNS })
  })
})
