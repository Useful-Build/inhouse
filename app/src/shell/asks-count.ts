// Stage 1 M2-H: how many of the agent's actions and questions wait on this person, for the sidebar's Approvals badge. A
// card counts when its viewer can act on it (an answer while it waits, a resolve when it needs a check), never an
// admin's view of someone else's card; every open question asked of them counts. Read when the app starts, when the
// window gets focus again, on an `action.updated`, and after each answer; Approvals hands over what it read itself. The
// demo has none, so its badge is as before.
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

/** Puts a fresh read in the badge (Approvals' own read passes its lists here too). */
export function publishAsks(actions: readonly ActionCard[], questions: readonly Question[]): void {
  put({ actions: countAsks(actions, []), questions: countAsks([], questions) })
}

let inFlight: Promise<void> | null = null
/** Reads both lists again (one read at a time). A list whose read fails keeps its last number and says so in the console. */
export function readAsks(): Promise<void> {
  const warn = (e: unknown) => { console.warn('Inhouse: could not read what waits for you.', e) }
  inFlight ??= Promise.all([
    agent.actions({ states: ['waiting', NEEDS_CHECK] }).then(a => put({ actions: countAsks(a, []) }), warn),
    agent.questions().then(q => put({ questions: countAsks([], q) }), warn),
  ]).then(() => undefined).finally(() => { inFlight = null })
  return inFlight
}

/**
 * The badge's number, kept current while the sidebar is up. Only a brand person has actions and questions (routes 120
 * and 140 are member and admin only): nothing is read until `me()` says who is signed in, nor for the Inhouse team.
 */
export function useAsksCount(): number {
  const role = useSyncExternalStore(agent.subscribe, () => agent.me()?.role ?? null)
  const reads = role === 'member' || role === 'admin'
  useEffect(() => {
    if (!reads) return
    void readAsks()
    const onFocus = () => { void readAsks() }
    window.addEventListener('focus', onFocus)
    const off = agent.onActionUpdated(() => { void readAsks() })
    return () => { window.removeEventListener('focus', onFocus); off() }
  }, [reads])
  const n = useSyncExternalStore(subscribe, get)
  return reads ? n : 0
}
