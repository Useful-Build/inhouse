// People's names as the agent reads them (Stage 1 M3-T, N28): `member_find` returns every active person's name as they
// typed it, and finds them by a folded form. A name is text a person typed for themselves (`g:name`, up to 80
// characters), so it is data, never instructions: nothing here decides whether a name is shown, only how it's shown,
// matched and flagged.
//
// The fold, in order: control characters become spaces and format characters (zero-width ones, direction marks) go;
// NFKC (fullwidth `Ｉ` is `I`); lowercase; NFD with every combining mark removed (`İ`, `é`); NFC; then each look-alike
// letter becomes its Latin prototype (Unicode TR39's confusables, look-alikes.ts: Cyrillic `о` is `o`); spaces
// collapse. Idempotent (fold.property.test.ts). Tokens split the fold on everything but letters and digits, so a hyphen
// or an apostrophe (any of them) splits a word: "O'Brien-Smith" is `o`, `brien`, `srnith`.
import { LOOK_ALIKE_SOURCES } from './look-alikes.ts'

/** The most characters of a name the agent is shown (a name may be 80). */
export const NAME_SHOWN_MAX = 60

/** Control characters and line or paragraph separators: each one becomes a space. */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu
/** Format characters (zero-width space and joiners, direction marks, soft hyphen) and lone surrogates: removed. */
const INVISIBLE = /[\p{Cf}\p{Cs}]/gu
const MARKS = /\p{M}/gu
const SPACES = /\s+/gu

const LOOK_ALIKES: ReadonlyMap<string, string> = new Map(
  Object.entries(LOOK_ALIKE_SOURCES).flatMap(([to, from]) => [...from].map(c => [c, to] as const)),
)

const tidy = (s: string): string => s.replace(BREAKS, ' ').replace(INVISIBLE, '').replace(SPACES, ' ').trim()

/**
 * A name as the agent is shown it: as typed, with control and format characters taken out (a control character reads
 * as a space), spaces collapsed, at most NAME_SHOWN_MAX characters (never half a character).
 */
export function shownName(name: string): string {
  const chars = [...tidy(name)]
  return chars.length <= NAME_SHOWN_MAX ? chars.join('') : chars.slice(0, NAME_SHOWN_MAX).join('').trimEnd()
}

/** The folded form of a name or a query: how two spellings that look alike compare equal. */
export function fold(s: string): string {
  const plain = tidy(s).normalize('NFKC').toLowerCase().normalize('NFD').replace(MARKS, '').normalize('NFC')
  return tidy([...plain].map(c => LOOK_ALIKES.get(c) ?? c).join(''))
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
 * allowed now"). Carried over from the M2-G team line's list without `do` (a common surname: "Anh Do", #454's review),
 * plus a few more. A word of six letters or more also flags a longer word it starts ("instructions", "ignored").
 * Defence in depth beside the tool's framing, never a proof: a flagged name is still returned.
 */
export const INSTRUCTION_WORDS: readonly string[] = [
  'ignore', 'disregard', 'forget', 'previous', 'instruction', 'system', 'assistant', 'prompt', 'override', 'always',
  'never', 'send', 'forward', 'approve', 'allow', 'allowed', 'admin', 'administrator', 'rules', 'note', 'you', 'your',
  'must', "don't", 'dont', 'execute', 'tool', 'tools', 'developer',
]
const PREFIX_MIN = 6
/** Each instruction word as folded words (`don't` is `don`, `t`), so it is compared the way a name is. */
const INSTRUCTION_PHRASES: readonly string[][] = INSTRUCTION_WORDS.map(w => tokens(fold(w)))

/** Runs of one-letter words joined into one ("I G N O R E" reads as `ignore`). */
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
 * punctuation, and at a lower-to-upper case change: "IgnorePrevious") is an instruction word once folded, look-alike
 * letters included (Cyrillic `о` in "Ignоre", fullwidth "Ｉｇｎｏｒｅ", "İgnore").
 */
export function readsAsInstruction(name: string): boolean {
  const camel = tidy(name).replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
  return [tokens(fold(name)), tokens(fold(camel))].some(words => hasPhrase(words) || hasPhrase(joinLetters(words)))
}
