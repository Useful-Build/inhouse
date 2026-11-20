// P3's run signals (W1, p3-w1.md "Runs signal"; the rules in do/brand-agent/runs-read.ts): `runs_failed` (over 20% of
// the last hour's turns failed for a reason other than a stop, an interrupt or a cap), `runs_stuck` (a turn the
// watchdog should have ended), `session_damaged` (any chat damaged in the last 24 hours), `scheduler` (any quarantined
// due task). Counts only. Each asks the BrandAgent (`runsHealth`).
import { brandAgent } from '../../do/brand-agent/client.ts'
import type { RunsHealth } from '../../do/brand-agent/ports.ts'
import type { Signal } from './types.ts'

const fromRuns = (name: string, pick: keyof RunsHealth): Signal => ({
  name,
  check: async ({ env }) => (await brandAgent(env).runsHealth())[pick],
})

/**
 * Built, not yet listed: the health route's test (`ops/health.test.ts`, the orchestrator's) runs the registry on an env
 * without `BRAND_AGENT`, so listing these turns it red. The orchestrator lists them (with W2's `POOL_SIGNALS`) by
 * setting `runsSignals = RUNS_SIGNALS` and giving that test the binding.
 */
export const RUNS_SIGNALS: readonly Signal[] = [
  fromRuns('runs_failed', 'failures'),
  fromRuns('runs_stuck', 'stuck'),
  fromRuns('session_damaged', 'damaged'),
  fromRuns('scheduler', 'quarantined'),
]

export const runsSignals: readonly Signal[] = []
