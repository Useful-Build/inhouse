// P3's pool signals (W2, p3-design section 7): `pool_protocol` (a runner with no shared protocol version),
// `pool_restarts` (a runner's container exited more than 3 times in an hour), `pool_shortfall` (a turn queued over 30 s,
// or a `pool_full`, in 15 minutes). Counts only. Each asks the BrandAgent (pool.ts `health`).
import { brandAgentRpc } from '../../do/runner/brand-agent-rpc.ts'
import type { PoolHealth } from '../../do/brand-agent/ports.ts'
import type { Signal } from './types.ts'

const fromPool = (name: string, pick: keyof PoolHealth): Signal => ({
  name,
  check: async ({ env }) => (await brandAgentRpc(env).poolHealth())[pick],
})

/** Built, not yet listed (owed when W1's class lands, with routes 46-48): the BrandAgent class answers `poolHealth` from W1's next PR; until then these would throw and turn /api/health red. */
export const POOL_SIGNALS: readonly Signal[] = [
  fromPool('pool_protocol', 'protocol'),
  fromPool('pool_restarts', 'restarts'),
  fromPool('pool_shortfall', 'shortfall'),
]

export const poolSignals: readonly Signal[] = []
