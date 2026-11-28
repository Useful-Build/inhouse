// Stage 1 M2-H: how many of the agent's actions and questions wait on this person, for the sidebar's Approvals badge. A
// card counts when its viewer can act on it (an answer while it waits, a resolve when it needs a check), never an
// admin's view of someone else's card; every open question asked of them counts. Read when the app starts, when the
// window gets focus again or the tab is shown, when the socket is live again, on an `action.updated`, after each answer
// or conflict, when a card read again changes state, and whenever the bell's list changes (a run ended, or a new notice:
// a question waiting on them is one); Approvals hands over what it read itself. The demo's cards are its sample ones
// (mock-actions.ts).
import { useEffect, useSyncExternalStore } from 'react'
import { agent } from '../agent'
import type { ActionCard, Question } from '../agent/types'
import { NEEDS_CHECK } from '../../shared/contract/action-states'

/** The cards and questions that wait on this viewer. */
export function countAsks(actions: readonly ActionCard[], questions: readonly Question[]): number {
  const mine = actions.filter(a => (a.state === 'waiting' && (a.can.allowOnce || a.can.alwaysAllow || a.can.approve || a.can.deny))
    || (a.state === NEEDS_CHECK && a.can.resolve))
  return mine.length + questions.filter(q => q.state === 'open').length
}

/** What each list last gave: one list's failed read keeps its own last number, never the other's. */
let parts = { actions: 0, questions: 0 }
let count = 0
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const get = () => count
const put = (next: Partial<typeof parts>) => {
  parts = { ...parts, ...next }
  const total = parts.actions + parts.questions
  if (total === count) return
  count = total
  listeners.forEach(l => l())
}

/** Bumped by each published read, so an older read still out can't overwrite it when it lands. */
let gen = 0

/** Puts a fresh read in the badge (Approvals' own read passes its lists here too). */
export function publishAsks(actions: readonly ActionCard[], questions: readonly Question[]): void {
  gen++
  put({ actions: countAsks(actions, []), questions: countAsks([], questions) })
}

let inFlight: Promise<void> | null = null
let again: Promise<void> | null = null
/**
 * Reads both lists again, one read at a time. Asked while a read is out, it runs one more read after that one (shared by
 * every ask made meanwhile), so an answer that lands mid-read is never counted from the older read. A list whose read
 * fails keeps its last number and says so in the console.
 */
export function readAsks(): Promise<void> {
  if (inFlight !== null) {
    again ??= inFlight.then(() => { again = null; return readAsks() })
    return again
  }
  const warn = (e: unknown) => { console.warn('Inhouse: could not read what waits for you.', e) }
  // A list published after this read started (Approvals' own read) is newer: this read's answer for it is dropped, and
  // the lists are read once more after it, so a count that changed since the publish can't stick.
  const started = gen
  let dropped = false
  const fresh = (next: Partial<typeof parts>) => { if (gen === started) put(next); else dropped = true }
  inFlight = Promise.all([
    agent.actions({ states: ['waiting', NEEDS_CHECK] }).then(a => fresh({ actions: countAsks(a, []) }), warn),
    agent.questions().then(q => fresh({ questions: countAsks([], q) }), warn),
  ]).then(() => undefined).finally(() => {
    inFlight = null
    if (dropped) void readAsks()
  })
  return inFlight
}

/**
 * Whether the signed-in viewer is a brand person (a member or an admin): only they have actions, permissions and
 * questions (routes 110, 120 and 140 refuse anyone else, the Inhouse team included). False until `me()` is in. The
 * screens of Stage 1 M2-H read nothing, and show nothing, unless this is true.
 */
export function useBrandPerson(): boolean {
  const role = useSyncExternalStore(agent.subscribe, () => agent.me()?.role ?? null)
  return role === 'member' || role === 'admin'
}

/**
 * The badge's number, kept current while the sidebar is up. Only a brand person has actions and questions: nothing is
 * read until `me()` says who is signed in, nor for the Inhouse team.
 */
export function useAsksCount(): number {
  const reads = useBrandPerson()
  useEffect(() => {
    if (!reads) return
    void readAsks()
    const onFocus = () => { void readAsks() }
    window.addEventListener('focus', onFocus)
    const onShown = () => { if (document.visibilityState === 'visible') void readAsks() }
    document.addEventListener('visibilitychange', onShown)
    const offLink = agent.onLink(state => { if (state === 'live') void readAsks() })
    const off = agent.onActionUpdated(() => { void readAsks() })
    // The bell's list is read again after every run and changes with a new notice, such as a question waiting on them.
    let notices = agent.listNotifications()
    const offNotices = agent.subscribe(() => {
      const next = agent.listNotifications()
      if (next === notices) return
      notices = next
      void readAsks()
    })
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onShown); offLink(); off(); offNotices() }
  }, [reads])
  const n = useSyncExternalStore(subscribe, get)
  return reads ? n : 0
}
