// Properties of the fold, the shown name and the flags (Stage 1 M3-T, N28). Folding is idempotent on any text. A name the
// agent is shown (`nameShown` and no flag) is checked against rules stated apart from fold.ts's own regexes: no
// invisible or default-ignorable character, no digit, at most 40 characters, at most 4 parts split on spaces, hyphens,
// apostrophes, dots and script changes next to a Latin letter, no word mixing Latin, Greek and Cyrillic letters, and no
// word holding a Latin letter and a letter or mark of any other script (#478). A Latin name, hyphens and apostrophes
// included, with one letter swapped for a look-alike of another script (CJK ones too), or with a CJK letter joining or
// inside a word, is flagged `mixed_script`. Generators draw from every CJK letter (Han, Hiragana, Katakana, Hangul,
// Bopomofo) and every format, bidi-control and default-ignorable code point Unicode assigns, and on purpose from the
// blank letters, marks and symbols (#536): a name holding one is never shown, and one between a CJK and a Latin letter
// joins them into one word that is flagged. They also draw on purpose from every letter and mark of a script outside
// the 32 a shown name may use (#534): a name holding one is never shown and is flagged `unlisted_script`, and a word
// holding letters of two such scripts is flagged `mixed_script`. That every active person is found by their own name,
// through the tool and D1, is in tools/team/member-find.test.ts.
import { fc } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { fold, nameFlags, nameShown } from './fold.ts'

const RUNS = Number(import.meta.env.VITE_PROP_RUNS) || 1000

/** Every code point (lone surrogates skipped) matching a pattern, built once. */
function codePoints(re: RegExp): string[] {
  const out: string[] = []
  for (let cp = 0; cp <= 0x10FFFF; cp++) {
    if (cp >= 0xD800 && cp <= 0xDFFF) continue
    const c = String.fromCodePoint(cp)
    if (re.test(c)) out.push(c)
  }
  return out
}
/**
 * CJK letters: what UTS #39's Highly Restrictive level lets a Latin word mix (#478). The Hangul fillers are default
 * ignorable (a space in the fold, never shown), so they are in formatChar instead.
 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u
const cjkLetter = fc.constantFrom(...codePoints(/^(?!\p{Default_Ignorable_Code_Point})\p{L}$/u).filter(c => CJK.test(c)))
/** Format characters, bidi controls (embeddings, overrides, isolates, marks) and other default-ignorable code points. */
const formatChar = fc.constantFrom(...codePoints(/^[\p{Cf}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]$/u))
/**
 * Blank letters, marks and symbols (no visible glyph; none is Allowed in UTS #39's IdentifierStatus.txt): the Hangul
 * fillers (default ignorable), the Braille pattern blank, the Egyptian hieroglyph full and half blanks and the Khitan
 * small script filler (not default ignorable). Drawn on purpose, not 4 in formatChar's 4,206 (#536).
 */
const BLANKS = ['\u115F', '\u1160', '\u3164', '\uFFA0', '\u2800', '\u{13441}', '\u{13442}', '\u{16FE4}']
const BLANK = /[\u115F\u1160\u3164\uFFA0\u2800\u{13441}\u{13442}\u{16FE4}]/u
const blankChar = fc.constantFrom(...BLANKS)

/**
 * The scripts a shown name may use, stated apart from fold.ts: UAX #31's Recommended scripts plus Syriac, Cherokee and
 * Mongolian. Common and Inherited letters and marks belong to no script.
 */
const LISTED = ['Latin', 'Greek', 'Cyrillic', 'Armenian', 'Hebrew', 'Arabic', 'Syriac', 'Thaana', 'Devanagari', 'Bengali', 'Gurmukhi',
  'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Thai', 'Lao', 'Tibetan', 'Myanmar', 'Georgian',
  'Hangul', 'Ethiopic', 'Cherokee', 'Khmer', 'Mongolian', 'Hiragana', 'Katakana', 'Bopomofo', 'Han']
const LISTED_OR_SHARED = new RegExp(`[${[...LISTED, 'Common', 'Inherited'].map(sc => `\\p{Script=${sc}}`).join('')}]`, 'u')
/**
 * Every letter and mark of any other script (#534): Lisu and its tone letters, Tifinagh, Coptic, Vai, Yi, the hieroglyphs
 * and their blanks, the Khitan filler, the marks that draw nothing (U+13440, U+1BC9D, the SignWriting modifiers). Drawn
 * by index (about 37,000 code points, too many to spread into fc.constantFrom safely).
 */
const UNLISTED_POOL = codePoints(/^[\p{L}\p{M}]$/u).filter(c => !LISTED_OR_SHARED.test(c))
const unlistedChar = fc.nat({ max: UNLISTED_POOL.length - 1 }).map(i => UNLISTED_POOL[i])
/** Some of those scripts, each with its letters, for words that mix two of them or use one alone. */
const UNLISTED_SCRIPTS = ['Lisu', 'Tifinagh', 'Coptic', 'Vai', 'Yi', 'Adlam', 'Nko', 'Canadian_Aboriginal', 'Javanese', 'Deseret', 'Osage',
  'Egyptian_Hieroglyphs', 'Khitan_Small_Script', 'Tangut', 'Brahmi', 'Duployan', 'Glagolitic', 'Runic', 'Ol_Chiki', 'Balinese', 'Bamum', 'Cham']
const UNLISTED_LETTERS: readonly (readonly string[])[] = UNLISTED_SCRIPTS.map(sc => {
  const re = new RegExp(`^\\p{Script=${sc}}$`, 'u')
  return UNLISTED_POOL.filter(c => /\p{L}/u.test(c) && re.test(c))
})
const unlistedRun = (script: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...UNLISTED_LETTERS[script]), { minLength: 1, maxLength: 4 }).map(ls => ls.join(''))
/** One to three words, each of letters of one of those scripts: often shown before #534. */
const unlistedName = fc.array(fc.nat({ max: UNLISTED_SCRIPTS.length - 1 }).chain(unlistedRun), { minLength: 1, maxLength: 3 }).map(ws => ws.join(' '))

/** Characters a name could smuggle with: marks, format, control and default-ignorable characters, fillers, look-alikes. */
const TRICKY = [
  '\u0307', '\u0301', '\u200B', '\u200D', '\u202E', '\u00AD', '\n', '\u2028', '\u0000', 'İ', 'ẞ', 'ß', 'Σ', 'ς', 'ﬁ', 'Ⅻ',
  '한', 'ᄀ', 'ᅡ', 'ᆨ', 'Ｉ', '’', 'ʼ', '-', "'", ' ', '.', 'ǅ', 'ﷺ', '㍿', 'K', 'Å', 'Ω', 'о', 'е', 'а', 'ο', 'ー',
  '\u115F', '\u1160', '\u3164', '\uFFA0', '\uFE00', '\uFE0F', '\u{E0100}', '\u{E01EF}', '\u180B', '\u180D', '\u034F',
  '\u17B4', '\u2060', '\u{E0041}', 'ꞌ', 'Ꞌ', 'ー', 'ｰ', '\uFE70', '\uFE71', '\uFCF2', 'ŀ', '·',
  // #478: CJK joiners and look-alikes, bidi controls, mark-like Latin letters.
  'ㅡ', 'ヽ', '々', 'あ', 'ア', 'ㅣ', 'ㅇ', 'エ', '丅', 'ㄒ', '王', '\u200E', '\u200F', '\u061C', '\u202A', '\u202B', '\u202C', '\u202D',
  '\u2066', '\u2067', '\u2068', '\u2069', '\uFEFF', 'ꜥ', 'Ɂ', 'ʘ',
  // #536: blanks that aren't default ignorable.
  '\u2800', '\u{13441}', '\u{13442}', '\u{16FE4}',
]
const char = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...TRICKY) },
  { weight: 2, arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }) },
  { weight: 6, arbitrary: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') },
  { weight: 1, arbitrary: fc.constantFrom(...'0123456789') },
  { weight: 1, arbitrary: cjkLetter },
  { weight: 1, arbitrary: formatChar },
  { weight: 1, arbitrary: blankChar },
  { weight: 1, arbitrary: unlistedChar },
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

/** CJK letters that look like Latin ones (confusables.txt: `ㅇ` is `o`, `ㄒ` and `丅` are `T`), from #478. */
const CJK_LOOK_ALIKE: Readonly<Record<string, string>> = { l: 'ㅣ', i: 'ㅣ', o: 'ㅇ', I: 'エ', T: '丅', t: 'ㄒ' }
/** Latin letters and their Cyrillic, Greek or CJK look-alikes, for names that mix scripts inside a word. */
const MIXED_LETTERS = [...'abcehiopxyAEHKMOTlt', ...Object.values(LOOK_ALIKE), ...Object.values(CJK_LOOK_ALIKE)]
/**
 * Ways to join two parts of one word (no space): hyphens, apostrophes, invisible and bidi characters, marks, NFKC-space
 * letters, CJK letters (#478: `ㅡ`, `ヽ`, `々`, kana then `ー`) and any format or CJK letter Unicode assigns.
 */
const IN_WORD = ['-', "'", '’', '', '\u200B', '\u034F', '\u0332', '\u037A', '\uFE70', '\uFE71', '\u17D2', 'ꞌ', 'ー', 'ｰ', 'ŀ',
  'ㅡ', 'ヽ', '々', 'あー', 'アー', '\u2066', '\u202E', '\u200F', '\u061C']
const inWord = fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...IN_WORD) }, { weight: 1, arbitrary: cjkLetter }, { weight: 1, arbitrary: formatChar },
  { weight: 1, arbitrary: blankChar })
/** A part: Latin letters, look-alikes or both, so a word can join a Latin part to a look-alike-only one. */
const mixedPart = fc.oneof(
  fc.stringMatching(/^[A-Za-z]{1,4}$/),
  fc.array(fc.constantFrom(...Object.values(LOOK_ALIKE), ...Object.values(CJK_LOOK_ALIKE)), { minLength: 1, maxLength: 3 }).map(ls => ls.join('')),
  fc.array(fc.constantFrom(...MIXED_LETTERS), { minLength: 1, maxLength: 4 }).map(ls => ls.join('')),
)
const mixedWord = fc.array(mixedPart, { minLength: 1, maxLength: 3 })
  .chain(parts => fc.array(inWord, { minLength: parts.length - 1, maxLength: parts.length - 1 })
    .map(joins => parts.map((p, i) => p + (joins[i] ?? '')).join('')))
const mixedName = fc.array(mixedWord, { minLength: 1, maxLength: 3 }).map(ws => ws.join(' '))

describe('a name the agent is shown', () => {
  it('has no invisible or default-ignorable character, no digit, and at most 40 characters', () => {
    fc.assert(fc.property(fc.oneof(text, mixedName), s => {
      if (!shown(s)) return
      expect(s).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{N}]/u)
      expect(s).not.toMatch(BLANK)
      expect([...s].length).toBeLessThanOrEqual(40)
    }), { numRuns: RUNS })
  })

  it('is never one holding a blank letter, mark or symbol, wherever it sits, though the name without it is shown (#536)', () => {
    const plain = fc.stringMatching(/^[A-Z][a-z]{1,6}( [A-Z][a-z]{1,6}){0,2}$/)
    fc.assert(fc.property(fc.oneof(plain, mixedName, text), blankChar, fc.nat(), (s, b, at) => {
      const cs = [...s]
      cs.splice(at % (cs.length + 1), 0, b)
      const n = cs.join('')
      expect(nameShown(n), n).toBe(false)
    }), { numRuns: RUNS, examples: [['Leo', '\u{13441}', 3], ['Leo Park', '\u2800', 3], ['A', '\u{13441}', 0], ['\u{18B00}', '\u{16FE4}', 1]] })
  })

  it('is never one holding a letter or mark of a script outside the 32 listed, wherever it sits, and it is flagged unlisted_script (#534)', () => {
    const plain = fc.stringMatching(/^[A-Z][a-z]{1,6}( [A-Z][a-z]{1,6}){0,2}$/)
    fc.assert(fc.property(fc.oneof(plain, unlistedName, mixedName, text), unlistedChar, fc.nat(), (s, u, at) => {
      const cs = [...s]
      cs.splice(at % (cs.length + 1), 0, u)
      const n = cs.join('')
      expect(nameShown(n), n).toBe(false)
      expect(nameFlags(n), n).toContain('unlisted_script')
    }), { numRuns: RUNS, examples: [['\u{18B00}', '\u{16FE4}', 1], ['ꓡꓰꓳꓑꓮ', '\u{13440}', 3], ['ꓬꓳꓴꓟꓴꓢꓔ', 'ꓸ', 3], ['Leo', 'ⵐ', 3]] })
  })

  it('holds no letter or mark of a script outside the 32 listed, as typed or after NFKC (#534)', () => {
    fc.assert(fc.property(fc.oneof(text, mixedName, unlistedName), s => {
      if (!shown(s)) return
      for (const c of s + s.normalize('NFKC')) if (/[\p{L}\p{M}]/u.test(c)) expect(c, s).toMatch(LISTED_OR_SHARED)
    }), { numRuns: RUNS, examples: [['ꓡꓰꓳ ꓑꓮ'], ['ⵜⵉⴼⵉⵏⴰⵖ']] })
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

  // ー splits only after a non-kana letter, and a script change next to a Latin letter splits too (#478).
  it('has at most 4 parts, split on spaces, hyphens, apostrophes, dots, marks, the saltillo, ー and what NFKC breaks', () => {
    // A part is Latin letters or kana with long-vowel marks ("アーイーウ" is one part: ー after kana doesn't split).
    const part = fc.oneof(
      { weight: 3, arbitrary: fc.stringMatching(/^[A-Za-z]{1,6}$/) },
      { weight: 1, arbitrary: fc.array(fc.constantFrom('ア', 'イ', 'ウ', 'エ', 'オ', 'あ', 'い', 'アー', 'イー', 'らー'), { minLength: 1, maxLength: 5 }).map(ks => ks.join('')) },
    )
    const sep = fc.oneof(
      { weight: 4, arbitrary: fc.constantFrom(' ', '-', "'", '’', '. ', '\u0332', '\u0301', '\u17D2', '\u0305', 'ꞌ', 'Ꞌ', 'ー', 'ｰ', '\uFE70', '\uFE71', 'ŀ', 'ㅡ', 'ヽ', '々', 'あー', 'ꜥ', 'Ɂ', 'ʘ') },
      { weight: 1, arbitrary: cjkLetter },
    )
    const parted = fc.array(fc.tuple(part, sep), { minLength: 1, maxLength: 9 })
      .map(ps => ps.map(([w, sp]) => w + sp).join('').replace(/[\s'’.\p{M}-]+$/u, ''))
    fc.assert(fc.property(fc.oneof(parted, text), s => {
      if (!shown(s)) return
      // Split as NFKC leaves it, so presentation forms (a space or tatweel) and `ŀ` (`l·`) split too; a letter of another
      // script next to a Latin letter and `ー` after anything but kana or `ー` split too.
      const k = s.normalize('NFKC')
        .replace(/(?<=\p{Script=Latin})(?=(?![\p{Script=Latin}\p{Script=Common}])\p{L})|(?<=(?![\p{Script=Latin}\p{Script=Common}])\p{L})(?=\p{Script=Latin})/gu, ' ')
        .replace(/(?<![\p{Script=Hiragana}\p{Script=Katakana}\u30FC])\u30FC/gu, ' ')
      expect(k.split(/[\s'’.\p{M}\-\uA78B\uA78C\uFF70\u0640\u00B7]+/u).filter(p => p !== '').length, s).toBeLessThanOrEqual(4)
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

  it('has no word holding a Latin letter and a letter or mark of any other script (no CJK joiner or look-alike), format characters taken out', () => {
    fc.assert(fc.property(fc.oneof({ weight: 3, arbitrary: mixedName }, { weight: 1, arbitrary: text }), s => {
      if (!shown(s)) return
      for (const word of s.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '').split(/\s+/u)) {
        if (![...word].some(c => LATIN.test(c))) continue
        for (const c of word) if (/[\p{L}\p{M}]/u.test(c)) expect(c, word).toMatch(/[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u)
      }
    }), { numRuns: RUNS })
  })
})

describe('mixed_script', () => {
  it('flags a Latin word with any CJK letter inside or at either end, joiners, bidi and format characters included (#478)', () => {
    const latin = fc.stringMatching(/^[A-Za-z]{1,5}$/)
    const word = fc.tuple(fc.array(fc.tuple(latin, fc.array(fc.oneof(cjkLetter, formatChar, blankChar), { minLength: 1, maxLength: 2 })), { minLength: 1, maxLength: 4 }), fc.option(latin), fc.boolean())
      .map(([parts, last, cjkFirst]) => {
        const body = parts.map(([l, js]) => l + js.join('')).join('') + (last ?? '')
        return cjkFirst ? body.slice(parts[0][0].length) + parts[0][0] : body
      })
      .filter(w => [...w].some(c => CJK.test(c) && !/\p{Default_Ignorable_Code_Point}/u.test(c)))
    const name = fc.tuple(word, fc.array(fc.stringMatching(/^[A-Z][a-z]{0,5}$/), { maxLength: 2 }), fc.nat())
      .map(([w, others, at]) => { const ws = [...others]; ws.splice(at % (ws.length + 1), 0, w); return ws.join(' ') })
    fc.assert(fc.property(name, n => {
      expect(nameFlags(n), n).toContain('mixed_script')
      expect(shown(n), n).toBe(false)
      // #536: fast-check's counterexample, a Hangul choseong, U+3164 HANGUL FILLER and a Latin letter, and its kin.
    }), { numRuns: RUNS, examples: ['ᄀ\u3164A', 'ᄀ\u115FA', 'ᄀ\u1160A', 'ᄀ\uFFA0A', 'ᄀ\u2800A', 'A\u3164ᄀ'].map(n => [n]) })
  })

  it('flags a Latin letter and a CJK letter joined by blank letters, marks or symbols in one word, either way round (#536)', () => {
    const word = fc.tuple(fc.stringMatching(/^[A-Za-z]{1,5}$/), fc.array(blankChar, { minLength: 1, maxLength: 3 }), cjkLetter, fc.boolean())
      .map(([l, bs, c, cjkFirst]) => (cjkFirst ? c + bs.join('') + l : l + bs.join('') + c))
    const name = fc.tuple(word, fc.array(fc.stringMatching(/^[A-Z][a-z]{0,5}$/), { maxLength: 2 }), fc.nat())
      .map(([w, others, at]) => { const ws = [...others]; ws.splice(at % (ws.length + 1), 0, w); return ws.join(' ') })
    fc.assert(fc.property(name, n => {
      expect(nameFlags(n), n).toContain('mixed_script')
      expect(shown(n), n).toBe(false)
    }), { numRuns: RUNS, examples: BLANKS.flatMap(b => [[`ᄀ${b}A`], [`A${b}ᄀ`], [`Leo${b}王`]]) })
  })


  it('flags a word holding letters of two scripts outside the 32 listed, and never shows it (#534)', () => {
    const pair = fc.tuple(fc.nat({ max: UNLISTED_SCRIPTS.length - 1 }), fc.nat({ max: UNLISTED_SCRIPTS.length - 2 }))
      .map(([a, b]) => [a, b >= a ? b + 1 : b] as const)
    const word = pair.chain(([a, b]) => fc.tuple(unlistedRun(a), unlistedRun(b), fc.constantFrom('', '-', "'", '\u200B')))
      .map(([x, y, join]) => x + join + y)
    const name = fc.tuple(word, fc.array(fc.stringMatching(/^[A-Z][a-z]{0,5}$/), { maxLength: 2 }), fc.nat())
      .map(([w, others, at]) => { const ws = [...others]; ws.splice(at % (ws.length + 1), 0, w); return ws.join(' ') })
    // The examples are #534's names: Lisu and Tifinagh, Lisu and Coptic.
    fc.assert(fc.property(name, n => {
      expect(nameFlags(n), n).toContain('mixed_script')
      expect(shown(n), n).toBe(false)
    }), { numRuns: RUNS, examples: [['ꓪꓲꓣꓰⵐꓮꓡꓡⵐꓝꓴꓠꓓꓢ'], ['ꓮꓓꓟꓲꓠⲞ']] })
  })

  // The look-alike may be Cyrillic, Greek or CJK (#478).
  it('flags a Latin name, hyphens and apostrophes included, with one letter swapped for a look-alike of another script', () => {
    const word = fc.array(fc.stringMatching(/^[A-Za-z][a-z]{0,5}$/), { minLength: 1, maxLength: 3 })
      .chain(parts => fc.array(fc.constantFrom('-', "'", '’', '\u200B', ''), { minLength: parts.length - 1, maxLength: parts.length - 1 })
        .map(joins => parts.map((p, i) => p + (joins[i] ?? '')).join('')))
    const name = fc.array(word, { minLength: 1, maxLength: 3 }).map(ws => ws.join(' '))
    fc.assert(fc.property(name, fc.nat(), fc.constantFrom(LOOK_ALIKE, CJK_LOOK_ALIKE), (n, pick, map) => {
      expect(nameFlags(n), n).not.toContain('mixed_script')
      const spots = [...n].flatMap((c, i) => (map[c] === undefined ? [] : [i]))
      fc.pre(spots.length > 0)
      const at = spots[pick % spots.length]
      const swapped = [...n].map((c, i) => (i === at ? map[c] : c)).join('')
      // Only when the swapped letter shares its word with another Latin letter (a one-letter word is one script).
      const wordOf = swapped.split(' ').find(w => w.includes(map[[...n][at]]))!
      fc.pre([...wordOf].some(c => LATIN.test(c)))
      expect(nameFlags(swapped), swapped).toContain('mixed_script')
    }), { numRuns: RUNS })
  })
})
