// The usage health signal (p3-design section 9's sweep): `usage_stranded` goes red while any turn still holds budget
// longer than a turn can live and the sweep can settle it (the token's 45 minutes + the 15-minute grace + one hourly
// pass). Held budget then never piles up unseen, whether the sweep's reader isn't wired yet or a settle keeps failing.
// The detail is a count only. The orchestrator lists `usageSignals` in ops/signals/index.ts.
import { RUN_TOKEN_TTL_MS } from '../do/brand-agent/tokens.ts'
import type { Signal } from '../ops/signals/types.ts'
import { SWEEP_EVERY_MS, SWEEP_GRACE_MS } from './sweep.ts'

export const STRANDED_AFTER_MS = RUN_TOKEN_TTL_MS + SWEEP_GRACE_MS + SWEEP_EVERY_MS

/** `now`: the health route's clock (signals get none of their own). */
export function usageStranded(now: () => number = () => Date.now()): Signal {
  return {
    name: 'usage_stranded',
    async check({ stores }) {
      const n = await stores.usage.strandedTurns({ beforeMs: now() - STRANDED_AFTER_MS })
      return n === 0 ? { ok: true } : { ok: false, detail: `${n} ${n === 1 ? 'turn holds' : 'turns hold'} budget past the sweep window` }
    },
  }
}

export const usageSignals: readonly Signal[] = [usageStranded()]
