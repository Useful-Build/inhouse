// P3's pool signals (W2, p3-design section 7): `pool_protocol` (a runner with no shared protocol version),
// `pool_restarts` (a runner's container exited more than 3 times in an hour), `pool_shortfall` (a turn queued over 30 s,
// or a `pool_full`, in 15 minutes). Counts only. Each asks the BrandAgent (pool.ts `health`).
import { brandAgent } from '../../do/brand-agent/client.ts'
import type { PoolHealth } from '../../do/brand-agent/ports.ts'
import type { Signal } from './types.ts'

const fromPool = (name: string, pick: keyof PoolHealth): Signal => ({
  name,
  check: async ({ env }) => (await brandAgent(env).poolHealth())[pick],
})

/**
 * Built, not listed yet: `ops/health.test.ts` pins the exact signal list of /api/health, so listing these is a change to
 * that check (the orchestrator's call), not part of wiring routes 46-48.
 */
export const POOL_SIGNALS: readonly Signal[] = [
  fromPool('pool_protocol', 'protocol'),
  fromPool('pool_restarts', 'restarts'),
  fromPool('pool_shortfall', 'shortfall'),
]

export const poolSignals: readonly Signal[] = []
