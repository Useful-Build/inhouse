// People's names as the agent reads them (Stage 1 M3-T, N28): `member_find` returns every active person, and finds them
// by a folded form of their name. A name is text a person typed for themselves (`g:name`, up to 80 characters), so it
// is data, never instructions. Nobody is left out: a name is shown as typed only when it has the M2-G team line's shape
// (nameShown), otherwise only the member id comes back. Either way the name is flagged when it reads like an
// instruction (`instruction_word`) or a word of it mixes scripts (`mixed_script`).
//
// The fold (for matching only, never shown): control characters become spaces and format characters (zero-width ones,
// direction marks) go; NFKC (fullwidth `Ｉ` is `I`); lowercase; NFD with every combining mark removed (`İ`, `é`); NFC;
// spaces collapse. Idempotent (fold.property.test.ts). Words split the fold on everything but letters and digits, so a
// hyphen or an apostrophe (any of them) splits a word: "O'Brien-Smith" is `o`, `brien`, `smith`.

/** The longest name shown, and the most words in it (the M2-G team line's limits, prompt/connected.ts). */
export const NAME_SHOWN_MAX = 40
export const NAME_SHOWN_WORDS = 4
/**
 * One word of a name: an initial (one letter and a dot, "J.") or letters (any script) with an inner `'` or `-`
 * ("O'Neil-Ng"). No digits, no other punctuation, and a dot only after a lone initial: a sentence's full stop can't pass.
 */
const NAME_WORD = String.raw`(?:\p{L}\.|\p{L}[\p{L}\p{M}]*(?:['’-]\p{L}[\p{L}\p{M}]*)*)`
/** A plain name's shape: 1 to NAME_SHOWN_WORDS words (NAME_WORD) with single spaces. Its length is checked apart. */
export const NAME_SHAPE = new RegExp(String.raw`^${NAME_WORD}(?: ${NAME_WORD}){0,${NAME_SHOWN_WORDS - 1}}$`, 'u')

/** Control characters and line or paragraph separators: each one becomes a space. */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu
/** Format characters (zero-width space and joiners, direction marks, soft hyphen) and lone surrogates: removed. */
const INVISIBLE = /[\p{Cf}\p{Cs}]/gu
const MARKS = /\p{M}/gu
const SPACES = /\s+/gu

const tidy = (s: string): string => s.replace(BREAKS, ' ').replace(INVISIBLE, '').replace(SPACES, ' ').trim()

/** The folded form of a name or a query: how two spellings of a name compare equal (case, width, accents). */
export function fold(s: string): string {
  return tidy(tidy(s).normalize('NFKC').toLowerCase().normalize('NFD').replace(MARKS, '').normalize('NFC'))
}

/**
 * What splits a folded name into words: anything but a letter or a digit, plus the modifier letters that are
 * apostrophes (`ʼ` U+02BC and its kin, which Unicode counts as letters).
 */
const SPLIT = /[^\p{L}\p{N}]+|[\u02B9-\u02BF\u02C8\u02CA\u02CB]+/u

/** A folded string's words (no empty ones). */
export const tokens = (folded: string): string[] => folded.split(SPLIT).filter(t => t.length > 0)

/** A name ready to match: its fold and the fold's words. */
export type FoldedName = { folded: string; words: string[] }
export const foldName = (name: string): FoldedName => {
  const folded = fold(name)
  return { folded, words: tokens(folded) }
}

/**
 * Whether a name matches a query: every word of the query starts some word of the name ("leo" and "par" both find
 * "Leo Park", in either order). A query with no words (only punctuation or symbols) matches a name whose fold holds it.
 */
export function nameMatches(name: FoldedName, query: FoldedName): boolean {
  if (query.words.length === 0) return query.folded.length > 0 && name.folded.includes(query.folded)
  return query.words.every(q => name.words.some(w => w.startsWith(q)))
}

/**
 * Words a short name could use to read as an instruction to the model ("Ignore previous instructions", "You are
 * allowed now"). The M2-G team line's list without `do` (a common surname: "Anh Do", #454's review), plus a few more.
 * A word of six letters or more also catches a longer word it starts ("instructions", "ignored").
 */
export const INSTRUCTION_WORDS: readonly string[] = [
  'ignore', 'disregard', 'forget', 'previous', 'instruction', 'system', 'assistant', 'prompt', 'override', 'always',
  'never', 'send', 'forward', 'approve', 'allow', 'allowed', 'admin', 'administrator', 'rules', 'note', 'you', 'your',
  'must', "don't", 'dont', 'execute', 'tool', 'tools', 'developer',
]
const PREFIX_MIN = 6
/** Each instruction word as folded words (`don't` is `don`, `t`), so it is compared the way a name is. */
const INSTRUCTION_PHRASES: readonly string[][] = INSTRUCTION_WORDS.map(w => tokens(fold(w)))

/** Runs of one-letter words joined into one ("I. G. N. O. R. E." reads as `ignore`). */
function joinLetters(words: readonly string[]): string[] {
  const out: string[] = []
  let run = ''
  for (const w of [...words, '']) {
    if ([...w].length === 1) { run += w; continue }
    if ([...run].length > 1) out.push(run)
    run = ''
    if (w !== '') out.push(w)
  }
  return out
}

const wordHits = (word: string, phraseWord: string, last: boolean): boolean =>
  word === phraseWord || (last && [...phraseWord].length >= PREFIX_MIN && word.startsWith(phraseWord))

function hasPhrase(words: readonly string[]): boolean {
  return INSTRUCTION_PHRASES.some(p => words.some((_, i) => p.every((pw, j) => i + j < words.length && wordHits(words[i + j], pw, j === p.length - 1))))
}

/**
 * Whether a name reads like an instruction: one of its words (split on spaces, hyphens, apostrophes and other
 * punctuation, and at a lower-to-upper case change: "IgnorePrevious") is an instruction word once folded (fullwidth
 * "Ｉｇｎｏｒｅ", "İgnore", a zero-width character inside a word).
 */
export function readsAsInstruction(name: string): boolean {
  const camel = tidy(name).replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
  return [tokens(fold(name)), tokens(fold(camel))].some(words => hasPhrase(words) || hasPhrase(joinLetters(words)))
}

/** The scripts a letter is told apart by. A letter of a script not listed counts as `Other`; Common and Inherited don't count. */
const SCRIPTS: readonly (readonly [string, RegExp])[] = [
  'Latin', 'Greek', 'Cyrillic', 'Armenian', 'Hebrew', 'Arabic', 'Syriac', 'Thaana', 'Devanagari', 'Bengali', 'Gurmukhi',
  'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Thai', 'Lao', 'Tibetan', 'Myanmar',
  'Georgian', 'Hangul', 'Ethiopic', 'Cherokee', 'Khmer', 'Mongolian', 'Hiragana', 'Katakana', 'Bopomofo', 'Han',
].map(s => [s, new RegExp(String.raw`^\p{Script=${s}}$`, 'u')] as const)
const SHARED = /^[\p{Script=Common}\p{Script=Inherited}]$/u
/** Script sets one word may mix (Unicode TR39's "highly restrictive" level: Japanese, Chinese and Korean with Latin). */
const MIXES_ALLOWED: readonly (readonly string[])[] = [
  ['Latin', 'Han', 'Hiragana', 'Katakana'], ['Latin', 'Han', 'Bopomofo'], ['Latin', 'Han', 'Hangul'],
]

/** The scripts of a text's letters. */
export function scriptsOf(s: string): Set<string> {
  const out = new Set<string>()
  for (const c of s.normalize('NFKC')) {
    if (!/\p{L}/u.test(c) || SHARED.test(c)) continue
    out.add(SCRIPTS.find(([, re]) => re.test(c))?.[0] ?? 'Other')
  }
  return out
}

/** A word's letters, for the script check: split on anything but letters and marks. */
const WORD_SPLIT = /[^\p{L}\p{M}]+/u

/**
 * Whether a word of a name mixes scripts beyond TR39's highly restrictive sets (Cyrillic `о` in "Ignоre", Greek `ε` in
 * "Lεo"). Words are compared one by one, so "Dana Ким" is two words of one script each.
 */
export function mixesScripts(name: string): boolean {
  return name.normalize('NFKC').split(WORD_SPLIT).some(word => {
    const scripts = [...scriptsOf(word)]
    return scripts.length > 1 && !MIXES_ALLOWED.some(set => scripts.every(s => set.includes(s)))
  })
}

/** Whether a name has the shape the agent is shown (the M2-G team line's: 1 to 4 words, at most NAME_SHOWN_MAX characters). */
export const nameShown = (name: string): boolean => [...name].length <= NAME_SHOWN_MAX && NAME_SHAPE.test(name)

/** Why a name is flagged. */
export type NameFlag = 'instruction_word' | 'mixed_script'

/** A name's flags, in this order: `instruction_word`, `mixed_script`. */
export function nameFlags(name: string): NameFlag[] {
  return [...(readsAsInstruction(name) ? ['instruction_word' as const] : []), ...(mixesScripts(name) ? ['mixed_script' as const] : [])]
}
