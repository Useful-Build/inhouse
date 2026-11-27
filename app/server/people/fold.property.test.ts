// Properties of the fold, the shown name and the flags (Stage 1 M3-T, N28). Folding is idempotent on any text. A name the
// agent is shown (`nameShown` and no flag) is checked against rules stated apart from fold.ts's own regexes: no
// invisible or default-ignorable character, no digit, at most 40 characters, at most 4 parts split on spaces, hyphens,
// apostrophes and dots, and no word mixing Latin, Greek and Cyrillic letters. A Latin name, hyphens and apostrophes
// included, with one letter swapped for a look-alike of another script is flagged `mixed_script`. That every active
// person is found by their own name, through the tool and D1, is in tools/team/member-find.test.ts.
import { fc } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { fold, nameFlags, nameShown } from './fold.ts'

const RUNS = Number(import.meta.env.VITE_PROP_RUNS) || 1000

/** Characters a name could smuggle with: marks, format, control and default-ignorable characters, fillers, look-alikes. */
const TRICKY = [
  '\u0307', '\u0301', '\u200B', '\u200D', '\u202E', '\u00AD', '\n', '\u2028', '\u0000', 'İ', 'ẞ', 'ß', 'Σ', 'ς', 'ﬁ', 'Ⅻ',
  '한', 'ᄀ', 'ᅡ', 'ᆨ', 'Ｉ', '’', 'ʼ', '-', "'", ' ', '.', 'ǅ', 'ﷺ', '㍿', 'K', 'Å', 'Ω', 'о', 'е', 'а', 'ο', 'ー',
  '\u115F', '\u1160', '\u3164', '\uFFA0', '\uFE00', '\uFE0F', '\u{E0100}', '\u{E01EF}', '\u180B', '\u180D', '\u034F',
  '\u17B4', '\u2060', '\u{E0041}', 'ꞌ', 'Ꞌ', 'ー', 'ｰ', '\uFE70', '\uFE71', '\uFCF2', 'ŀ', '·',
]
const char = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...TRICKY) },
  { weight: 2, arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }) },
  { weight: 6, arbitrary: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') },
  { weight: 1, arbitrary: fc.constantFrom(...'0123456789') },
)
const text = fc.array(char, { maxLength: 40 }).map(cs => cs.join(''))

/** Latin letters and a look-alike from Cyrillic or Greek for each. */
const LOOK_ALIKE: Readonly<Record<string, string>> = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', i: 'і', A: 'А', O: 'Ο', E: 'Ε', H: 'Н', K: 'Κ', M: 'М', T: 'Т' }

const shown = (s: string): boolean => nameShown(s) && nameFlags(s).length === 0
const LATIN = /\p{Script=Latin}/u
const GREEK = /\p{Script=Greek}/u
const CYRILLIC = /\p{Script=Cyrillic}/u

describe('the fold', () => {
  it('is idempotent on any text', () => {
    fc.assert(fc.property(text, s => { expect(fold(fold(s))).toBe(fold(s)) }), { numRuns: RUNS })
  })
})

/** Latin letters and their Cyrillic or Greek look-alikes, for names that mix scripts inside a word. */
const MIXED_LETTERS = [...'abcehiopxyAEHKMOT', ...Object.values(LOOK_ALIKE)]
/** Ways to join two parts of one word (no space): hyphens, apostrophes, invisible characters, marks, NFKC-space letters. */
const IN_WORD = ['-', "'", '’', '', '\u200B', '\u034F', '\u0332', '\u037A', '\uFE70', '\uFE71', '\u17D2', 'ꞌ', 'ー', 'ｰ', 'ŀ']
/** A part: Latin letters, look-alikes or both, so a word can join a Latin part to a look-alike-only one. */
const mixedPart = fc.oneof(
  fc.stringMatching(/^[A-Za-z]{1,4}$/),
  fc.array(fc.constantFrom(...Object.values(LOOK_ALIKE)), { minLength: 1, maxLength: 3 }).map(ls => ls.join('')),
  fc.array(fc.constantFrom(...MIXED_LETTERS), { minLength: 1, maxLength: 4 }).map(ls => ls.join('')),
)
const mixedWord = fc.array(mixedPart, { minLength: 1, maxLength: 3 })
  .chain(parts => fc.array(fc.constantFrom(...IN_WORD), { minLength: parts.length - 1, maxLength: parts.length - 1 })
    .map(joins => parts.map((p, i) => p + (joins[i] ?? '')).join('')))
const mixedName = fc.array(mixedWord, { minLength: 1, maxLength: 3 }).map(ws => ws.join(' '))

describe('a name the agent is shown', () => {
  it('has no invisible or default-ignorable character, no digit, and at most 40 characters', () => {
    fc.assert(fc.property(fc.oneof(text, mixedName), s => {
      if (!shown(s)) return
      expect(s).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{N}]/u)
      expect([...s].length).toBeLessThanOrEqual(40)
    }), { numRuns: RUNS })
  })

  it('has no mark left after NFC on a Latin, Greek, Cyrillic or Common letter, and only cased letters of those three scripts', () => {
    fc.assert(fc.property(fc.oneof(text, mixedName), s => {
      if (!shown(s)) return
      const cs = [...s.normalize('NFC')]
      cs.forEach((c, i) => {
        const lgc = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u.test(c)
        if (lgc && /\p{L}/u.test(c)) expect(c, s).toMatch(/[\p{Lu}\p{Ll}\p{Lt}]/u)
        if (i > 0 && /\p{M}/u.test(c)) expect(cs[i - 1], s).not.toMatch(/[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}]/u)
      })
    }), { numRuns: RUNS })
  })

  it('has at most 4 parts, split on spaces, hyphens, apostrophes, dots, marks, the saltillo, ー and what NFKC breaks', () => {
    const parted = fc.array(fc.tuple(fc.stringMatching(/^[A-Za-z]{1,6}$/), fc.constantFrom(' ', '-', "'", '’', '. ', '\u0332', '\u0301', '\u17D2', '\u0305', 'ꞌ', 'Ꞌ', 'ー', 'ｰ', '\uFE70', '\uFE71', 'ŀ')), { minLength: 1, maxLength: 9 })
      .map(ps => ps.map(([w, sep]) => w + sep).join('').replace(/[\s'’.\p{M}-]+$/u, ''))
    fc.assert(fc.property(fc.oneof(parted, text), s => {
      if (!shown(s)) return
      // Split as NFKC leaves it, so presentation forms (a space or tatweel) and `ŀ` (`l·`) split too.
      expect(s.normalize('NFKC').split(/[\s'’.\p{M}\-\uA78B\uA78C\u30FC\uFF70\u0640\u00B7]+/u).filter(p => p !== '').length, s).toBeLessThanOrEqual(4)
    }), { numRuns: RUNS })
  })

  it('has no word mixing Latin, Greek and Cyrillic letters, invisible characters taken out', () => {
    fc.assert(fc.property(fc.oneof({ weight: 3, arbitrary: mixedName }, { weight: 1, arbitrary: text }), s => {
      if (!shown(s)) return
      for (const word of s.replace(/\p{Default_Ignorable_Code_Point}/gu, '').split(/\s+/u)) {
        const scripts = [LATIN, GREEK, CYRILLIC].filter(re => [...word].some(c => re.test(c)))
        expect(scripts.length, word).toBeLessThanOrEqual(1)
      }
    }), { numRuns: RUNS })
  })
})

describe('mixed_script', () => {
  it('flags a Latin name, hyphens and apostrophes included, with one letter swapped for a look-alike of another script', () => {
    const word = fc.array(fc.stringMatching(/^[A-Za-z][a-z]{0,5}$/), { minLength: 1, maxLength: 3 })
      .chain(parts => fc.array(fc.constantFrom('-', "'", '’', '\u200B', ''), { minLength: parts.length - 1, maxLength: parts.length - 1 })
        .map(joins => parts.map((p, i) => p + (joins[i] ?? '')).join('')))
    const name = fc.array(word, { minLength: 1, maxLength: 3 }).map(ws => ws.join(' '))
    fc.assert(fc.property(name, fc.nat(), (n, pick) => {
      expect(nameFlags(n), n).not.toContain('mixed_script')
      const spots = [...n].flatMap((c, i) => (LOOK_ALIKE[c] === undefined ? [] : [i]))
      fc.pre(spots.length > 0)
      const at = spots[pick % spots.length]
      const swapped = [...n].map((c, i) => (i === at ? LOOK_ALIKE[c] : c)).join('')
      // Only when the swapped letter shares its word with another Latin letter (a one-letter word is one script).
      const wordOf = swapped.split(' ').find(w => w.includes(LOOK_ALIKE[[...n][at]]))!
      fc.pre([...wordOf].some(c => LATIN.test(c)))
      expect(nameFlags(swapped), swapped).toContain('mixed_script')
    }), { numRuns: RUNS })
  })
})
