// The `privacy_requests` health signal (P8a F2): red while any Shopify privacy request is open, so the monitor that reads
// the health route alerts the Inhouse team, and stays red until the runbook closes it (route 94). The detail is counts
// only: how many are open and the fewest whole days left before Shopify's 30-day limit (negative once past it).
import type { Signal, SignalResult } from '../../ops/signals/types.ts'
import type { PrivacyRequestStore } from './store.ts'

const DAY = 86_400_000

export async function privacySignal(store: Pick<PrivacyRequestStore, 'open'>, nowMs: number): Promise<SignalResult> {
  const open = await store.open()
  if (open.length === 0) return { ok: true }
  const left = Math.min(...open.map(r => Math.floor((r.due_at_ms - nowMs) / DAY)))
  return { ok: false, detail: `${open.length} open, ${left} days left on the oldest` }
}

export function privacyHealth(now: () => number = () => Date.now()): Signal {
  return { name: 'privacy_requests', check: ({ stores }) => privacySignal(stores.privacyRequests, now()) }
}

export const privacySignals: readonly Signal[] = [privacyHealth()]
