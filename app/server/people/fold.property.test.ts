// Properties of the fold (Stage 1 M3-T, N28): folding is idempotent on any text, the shown name is stable, and a name
// spelled with look-alike letters folds as its Latin spelling does (so an instruction word can't hide behind them). That
// every active person is found by their own name, through the tool and D1, is in tools/team/member-find.test.ts.
import { fc } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { fold, readsAsInstruction, shownName } from './fold.ts'
import { LOOK_ALIKE_SOURCES } from './look-alikes.ts'

const RUNS = Number(import.meta.env.VITE_PROP_RUNS) || 1000

/** Characters the fold treats specially: look-alikes, marks, format and control characters, Hangul, final sigma, ... */
const TRICKY = [
  ...Object.values(LOOK_ALIKE_SOURCES).flatMap(s => [...s]),
  '\u0307', '\u0301', '\u200B', '\u200D', '\u202E', '\u00AD', '\n', '\u2028', '\u0000', 'İ', 'ẞ', 'ß', 'Σ', 'ς', 'ﬁ', 'Ⅻ',
  '한', 'ᄀ', 'ᅡ', 'ᆨ', 'Ｉ', '’', 'ʼ', '-', "'", ' ', 'ǅ', 'ﷺ', '㍿', 'K', 'Å', 'Ω',
]
const char = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...TRICKY) },
  { weight: 3, arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }) },
  { weight: 2, arbitrary: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') },
)
const text = fc.array(char, { maxLength: 40 }).map(cs => cs.join(''))

/** Each Latin letter's look-alikes (from the table). */
const lookAlikesOf = new Map<string, string[]>()
for (const [to, from] of Object.entries(LOOK_ALIKE_SOURCES)) if (to.length === 1) lookAlikesOf.set(to, [...from])

describe('the fold', () => {
  it('is idempotent on any text', () => {
    fc.assert(fc.property(text, s => { expect(fold(fold(s))).toBe(fold(s)) }), { numRuns: RUNS })
  })
  it('the shown name is stable, and never longer than the name', () => {
    fc.assert(fc.property(text, s => {
      expect(shownName(shownName(s))).toBe(shownName(s))
      expect([...shownName(s)].length).toBeLessThanOrEqual([...s].length)
    }), { numRuns: RUNS })
  })
  it('a word spelled with look-alike letters folds as its Latin spelling, so an instruction word is still flagged', () => {
    const word = fc.constantFrom('ignore', 'system', 'admin', 'approve', 'instructions', 'override', 'never')
    fc.assert(fc.property(word, fc.infiniteStream(fc.nat()), fc.infiniteStream(fc.boolean()), (w, picks, swaps) => {
      const spelled = [...w].map(c => {
        const alikes = lookAlikesOf.get(c)
        return alikes !== undefined && swaps.next().value ? alikes[picks.next().value % alikes.length] : c
      }).join('')
      expect(fold(spelled)).toBe(fold(w))
      expect(readsAsInstruction(`Sam ${spelled}`), spelled).toBe(true)
    }), { numRuns: RUNS })
  })
})
