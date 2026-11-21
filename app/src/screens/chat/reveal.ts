// A streamed answer's text arrives in blocks; this shows each block a few words at a time, so new text fades in
// instead of whole sentences jumping in. Pure steps (`nextShown`) plus the hook that ticks them. A person who asks for
// reduced motion, and any text that was already there when the chat opened, gets everything at once.
import { useEffect, useRef, useState } from 'react'
import { FENCE, ROW, SEP } from './md-syntax'

/** How often a few more words show, and the fewest words in a step. */
const TICK_MS = 50
const MIN_WORDS = 3
/** However long the block, it is all shown within this many steps (about a second): the reveal never falls far behind. */
export const MAX_STEPS = 20

const WORD = /\S+\s*/g

/** The end of the first whole word (with the space after it) that starts at or after `from`, or the end of the text. */
function wordEnd(text: string, from: number): number {
  const re = new RegExp(WORD.source, 'g')
  re.lastIndex = from
  const m = re.exec(text)
  return m ? m.index + m[0].length : text.length
}

const isWord = (c: string | undefined) => c !== undefined && /\w/.test(c)

/** The count of `_` marks on a line the renderer reads as italics: an opener (not after a word character, then not a space) or a closer (after a non-space, not before a word character). */
function underscoreMarks(line: string): number {
  let n = 0
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '_') continue
    const prev = line[i - 1], next = line[i + 1]
    if ((!isWord(prev) && next !== undefined && !/[_\s]/.test(next)) || (prev !== undefined && !/[_\s]/.test(prev) && !isWord(next))) n++
  }
  return n
}

/**
 * Whether a cut here would show half of an inline mark: a backtick, bold, italic (star or underscore) or link opened on the
 * last line and not closed. Cutting there makes the renderer change its tree when the rest arrives (a literal `**` becomes
 * bold), which mounts the words again and so fades them twice. Reads only the last line, so it costs the line, not the text.
 * Tables and code fences are `blockEnd`'s.
 */
export function cutsMarkdown(shown: string): boolean {
  const last = shown.slice(shown.lastIndexOf('\n') + 1).trimEnd()
  const plain = last.replace(/^\s*[-*+]\s+/, '').replace(/\*\*/g, '')
  return (last.match(/`/g)?.length ?? 0) % 2 === 1 || (last.match(/\*\*/g)?.length ?? 0) % 2 === 1 || (plain.match(/\*/g)?.length ?? 0) % 2 === 1
    || underscoreMarks(last) % 2 === 1 || last.lastIndexOf('[') > last.lastIndexOf(']') || /\]\([^)]*$/.test(last)
}

/** The spans [start, end) of the text's tables (header, separator and rows) and code fences (opening to closing fence line, or the text's end), found as Markdown.tsx's FENCE, ROW and SEP do. `end` is the start of the line after, or the text's end. */
function blockSpans(text: string): [number, number][] {
  const lines: { s: string; at: number }[] = []
  for (let at = 0; at < text.length;) {
    const nl = text.indexOf('\n', at)
    const end = nl < 0 ? text.length : nl + 1
    lines.push({ s: text.slice(at, nl < 0 ? text.length : nl).replace(/\r$/, ''), at })
    at = end
  }
  const endOf = (i: number) => (i < lines.length ? lines[i].at : text.length)
  const out: [number, number][] = []
  for (let i = 0; i < lines.length;) {
    const { s, at } = lines[i]
    if (FENCE.test(s)) {
      let j = i + 1
      while (j < lines.length && !FENCE.test(lines[j].s)) j++
      i = Math.min(j + 1, lines.length)
      out.push([at, endOf(i)])
    } else if (ROW.test(s) && i + 1 < lines.length && SEP.test(lines[i + 1].s)) {
      let j = i + 2
      while (j < lines.length && ROW.test(lines[j].s)) j++
      i = j
      out.push([at, endOf(i)])
    } else i++
  }
  return out
}

/** `n`, or the end of the table or code fence it falls inside, so such a block shows in one piece. */
function blockEnd(spans: readonly [number, number][], n: number): number {
  const hit = spans.find(([s, e]) => s < n && n < e)
  return hit ? hit[1] : n
}

/**
 * The length of `text` to show after `shown`: a few more whole words (each with the space after it). The step size comes
 * from the block's whole word count, so any block is all shown within MAX_STEPS steps however long it is. A cut inside a
 * table or a code fence moves to the end of it, and one that would show half of an inline mark moves on to the next word
 * until it doesn't (only ever faster, so the bound holds).
 */
export function nextShown(text: string, shown: number): number {
  if (shown >= text.length) return text.length
  const total = text.match(WORD)?.length ?? 0
  if (total === 0) return text.length
  const take = Math.max(MIN_WORDS, Math.ceil(total / Math.max(1, MAX_STEPS - 1)))
  const spans = blockSpans(text)
  let n = shown
  for (let i = 0; i < take && n < text.length; i++) n = wordEnd(text, n)
  for (;;) {
    const e = blockEnd(spans, n)
    if (e !== n) { n = e; while (n < text.length && /\s/.test(text[n])) n++; continue }
    if (n < text.length && cutsMarkdown(text.slice(0, n))) { n = wordEnd(text, n); continue }
    return n
  }
}

export const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** How long a word takes to fade in (index.css, `--animate-word-in`): its span stays this long after the last words show. */
const WORD_FADE_MS = 300

/** The parts that already revealed (or began to) in a chat, so one never reveals again: leaving a chat mid-run and coming back, or Undo of Regenerate, shows the text as it is. At most this many chats are kept, oldest dropped first. */
const MAX_CHATS = 20
const revealed = new Map<string, Set<string>>()
const wasRevealed = (chat: string, id: string) => revealed.get(chat)?.has(id) ?? false
function markRevealed(chat: string, id: string) {
  const set = revealed.get(chat) ?? new Set<string>()
  revealed.delete(chat)
  revealed.set(chat, set.add(id))
  if (revealed.size > MAX_CHATS) revealed.delete(revealed.keys().next().value as string)
}
/** Forgets what was revealed (a reset of the demo, a test). */
export const clearRevealed = () => revealed.clear()

/**
 * `animate`: this text belongs to a turn the view saw running. Whether a block is revealed is decided once, when it first
 * shows: a block of a turn seen running is, one that was already there (a saved chat, a reload, a reopened chat), one that
 * `part` says already revealed in this chat, or any block under reduced motion is not. Once started it runs to the end, even
 * if the run has finished meanwhile (it is bounded, about a second). Returns the part of `text` to show, whether it is all
 * there and whether its words fade in now: until the last words have finished fading (so they fade in like the rest and
 * their spans are not dropped mid-fade), then no longer, so a finished answer keeps no span per word.
 */
export function useRevealed(text: string, animate: boolean, part?: { chat: string; id: string }): { shown: string; done: boolean; fading: boolean } {
  const [reveals] = useState(() => animate && !prefersReducedMotion() && !(part && wasRevealed(part.chat, part.id)))
  const [n, setN] = useState(0)
  // The text length the last fade finished at: the tail is over only while the text is still that long.
  const [tailEnd, setTailEnd] = useState(-1)
  const len = reveals ? Math.min(n, text.length) : text.length
  const done = len >= text.length
  useEffect(() => {
    if (!reveals || done) return
    const t = setTimeout(() => setN(nextShown(text, len)), TICK_MS)
    return () => clearTimeout(t)
  }, [reveals, text, len, done])
  useEffect(() => {
    if (!reveals) return
    if (!done) return
    if (part && text.length > 0) markRevealed(part.chat, part.id)
    const t = setTimeout(() => setTailEnd(text.length), WORD_FADE_MS + TICK_MS)
    return () => clearTimeout(t)
  }, [reveals, done, text.length, part?.chat, part?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving mid-reveal counts as revealed: the part is not revealed again from the start when the chat comes back.
  const last = useRef({ part, started: false })
  useEffect(() => { last.current = { part, started: reveals && len > 0 } })
  useEffect(() => () => { const { part: p, started } = last.current; if (p && started) markRevealed(p.chat, p.id) }, [])
  return { shown: done ? text : text.slice(0, len), done, fading: reveals && (!done || tailEnd !== text.length) }
}
