// A streamed answer's text arrives in blocks; this shows each block a few words at a time, so new text grows
// instead of whole sentences jumping in. Pure steps (`nextShown`) plus the hook that ticks them. A person who asks for
// reduced motion, and any text that was already there when the chat opened, gets everything at once.
import { useEffect, useRef, useState } from 'react'

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
 * The length of `text` to show after `shown`: a few more whole words (each with the space after it). The step size comes
 * from the block's whole word count, so any block is all shown within MAX_STEPS steps however long it is. A cut that
 * leaves a half-written table, code fence or bold is the renderer's to close (markdown/, `live`), not this file's.
 */
export function nextShown(text: string, shown: number): number {
  if (shown >= text.length) return text.length
  const total = text.match(WORD)?.length ?? 0
  if (total === 0) return text.length
  const take = Math.max(MIN_WORDS, Math.ceil(total / Math.max(1, MAX_STEPS - 1)))
  let n = shown
  for (let i = 0; i < take && n < text.length; i++) n = wordEnd(text, n)
  return n
}

export const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

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
 * if the run has finished meanwhile (it is bounded, about a second). Returns the part of `text` to show and whether it is
 * all there.
 */
export function useRevealed(text: string, animate: boolean, part?: { chat: string; id: string }): { shown: string; done: boolean } {
  const [reveals] = useState(() => animate && !prefersReducedMotion() && !(part && wasRevealed(part.chat, part.id)))
  const [n, setN] = useState(0)
  const len = reveals ? Math.min(n, text.length) : text.length
  const done = len >= text.length
  useEffect(() => {
    if (!reveals || done) return
    const t = setTimeout(() => setN(nextShown(text, len)), TICK_MS)
    return () => clearTimeout(t)
  }, [reveals, text, len, done])
  useEffect(() => {
    if (reveals && done && part && text.length > 0) markRevealed(part.chat, part.id)
  }, [reveals, done, text.length, part?.chat, part?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving mid-reveal counts as revealed: the part is not revealed again from the start when the chat comes back.
  const last = useRef({ part, started: false })
  useEffect(() => { last.current = { part, started: reveals && len > 0 } })
  useEffect(() => () => { const { part: p, started } = last.current; if (p && started) markRevealed(p.chat, p.id) }, [])
  return { shown: done ? text : text.slice(0, len), done }
}
