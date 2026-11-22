// `getTrace` is async (the steps come from the agent), but the screens read them while they render. This keeps what the
// agent answered, asks once per id, and tells readers when an answer arrived. `useTraces()` makes a component re-render
// then; `traceOf(id)` reads one (undefined until it has arrived, null when the agent has none).
import { useSyncExternalStore } from 'react'
import { agent } from '../../agent'
import type { Trace } from '../../agent/types'
import { useUi } from '../../state/store'

const cache = new Map<string, Trace | null>()
const asked = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

/** Stage and scenario change what the demo's steps say (Run drops approval waits, a tool can fail), so they're part of the key. */
const keyOf = (id: string) => { const s = useUi.getState(); return `${s.stage}|${s.scenario}|${id}` }

export function traceOf(id: string): Trace | null | undefined {
  // A message the client made itself (a send the server refused) has no turn, so no id: there are no steps to ask for.
  if (id === '') return null
  const key = keyOf(id)
  if (cache.has(key)) return cache.get(key)
  if (!asked.has(key)) {
    asked.add(key)
    agent.getTrace(id).then(t => { cache.set(key, t) }, (e: unknown) => { console.warn('Inhouse: could not read the steps.', e); cache.set(key, null) })
      .finally(() => { version++; listeners.forEach(l => l()) })
  }
  return undefined
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
/** Re-renders when a trace arrives. */
export const useTraces = (): number => useSyncExternalStore(subscribe, () => version)
