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

/** The length of `text` to show after `shown`: a few more whole words (each with the space after it), at most MAX_STEPS steps in all. */
export function nextShown(text: string, shown: number): number {
  const rest = text.slice(shown)
  if (rest === '') return text.length
  // Whitespace at the start of what's left is shown with the next word.
  const words = [...rest.matchAll(WORD)]
  if (words.length === 0) return text.length
  const take = Math.max(MIN_WORDS, Math.ceil(words.length / Math.max(1, MAX_STEPS - 1)))
  const last = words[Math.min(take, words.length) - 1]
  return shown + last.index + last[0].length
}

export const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * `live`: the answer is being written. Whether a block is revealed is decided once, when it first shows: a block that
 * arrives while the answer is being written is, one that is already there (a saved chat) or any block under reduced
 * motion is not. A revealed block shows everything the moment the answer ends. Returns the part of `text` to show, whether
 * it is all there and whether its words fade in.
 */
export function useRevealed(text: string, live: boolean): { shown: string; done: boolean; fading: boolean } {
  const [fading] = useState(() => live && !prefersReducedMotion())
  const [n, setN] = useState(0)
  const len = !fading || !live ? text.length : Math.min(n, text.length)
  useEffect(() => {
    if (!fading || !live || len >= text.length) return
    const t = setTimeout(() => setN(nextShown(text, len)), TICK_MS)
    return () => clearTimeout(t)
  }, [fading, live, text, len])
  return { shown: len >= text.length ? text : text.slice(0, len), done: len >= text.length, fading }
}
