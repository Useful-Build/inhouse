// A streamed answer's text arrives in blocks; this shows each block a few words at a time, so new text fades in
// instead of whole sentences jumping in. Pure steps (`nextShown`) plus the hook that ticks them. A person who asks for
// reduced motion, and any text that was already there when the chat opened, gets everything at once.
import { useEffect, useState } from 'react'

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

/**
 * Whether a cut here would show half of some markdown: a code fence not closed yet, a table row not finished, or an
 * inline mark (backtick, bold, italic star, link) opened on the last line and not closed. Cutting there makes the
 * renderer change its tree when the rest arrives (a literal `**` becomes bold), which mounts the words again and so fades them twice.
 */
export function cutsMarkdown(shown: string): boolean {
  const lines = shown.split('\n')
  if (lines.filter(l => /^\s*```/.test(l)).length % 2 === 1) return true
  const last = lines[lines.length - 1].trimEnd()
  if (/^\s*\|/.test(last) && !/\|\s*$/.test(last)) return true
  const plain = last.replace(/^\s*[-*+]\s+/, '').replace(/\*\*/g, '')
  return (last.match(/`/g)?.length ?? 0) % 2 === 1 || (last.match(/\*\*/g)?.length ?? 0) % 2 === 1 || (plain.match(/\*/g)?.length ?? 0) % 2 === 1
    || last.lastIndexOf('[') > last.lastIndexOf(']') || /\]\([^)]*$/.test(last)
}

/**
 * The length of `text` to show after `shown`: a few more whole words (each with the space after it). The step size comes
 * from the block's whole word count, so any block is all shown within MAX_STEPS steps however long it is. A cut that would
 * show half of some markdown moves on to the next word until it doesn't (only ever faster, so the bound holds).
 */
export function nextShown(text: string, shown: number): number {
  if (shown >= text.length) return text.length
  const total = text.match(WORD)?.length ?? 0
  if (total === 0) return text.length
  const take = Math.max(MIN_WORDS, Math.ceil(total / Math.max(1, MAX_STEPS - 1)))
  let n = shown
  for (let i = 0; i < take && n < text.length; i++) n = wordEnd(text, n)
  while (n < text.length && cutsMarkdown(text.slice(0, n))) n = wordEnd(text, n)
  return n
}

export const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * `animate`: this text belongs to a turn the view saw running. Whether a block is revealed is decided once, when it first
 * shows: a block of a turn seen running is, one that was already there (a saved chat, a reload, a reopened chat) or any
 * block under reduced motion is not. Once started it runs to the end, even if the run has finished meanwhile (it is bounded,
 * about a second). Returns the part of `text` to show, whether it is all there and whether its words fade in now (not
 * once it is all there, so a finished answer keeps no span per word).
 */
export function useRevealed(text: string, animate: boolean): { shown: string; done: boolean; fading: boolean } {
  const [reveals] = useState(() => animate && !prefersReducedMotion())
  const [n, setN] = useState(0)
  const len = reveals ? Math.min(n, text.length) : text.length
  useEffect(() => {
    if (!reveals || len >= text.length) return
    const t = setTimeout(() => setN(nextShown(text, len)), TICK_MS)
    return () => clearTimeout(t)
  }, [reveals, text, len])
  const done = len >= text.length
  return { shown: done ? text : text.slice(0, len), done, fading: reveals && !done }
}
