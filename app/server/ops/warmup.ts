// Warm-up after a deploy (P3, p3-design sections 3 and 7): route 48, the `release` service token only. Owner: W2.
// The BrandAgent (pool.ts `warmup`) proves runners 0 .. min(2, N) - 1 on their new container (`/protocol` with a shared
// version, then `/health`), then clears the drain, starts the placement queue and advances every live run. Any runner
// failing: 503 `unavailable`, and the drain holds.
//
// Owed when W1's class lands: the route still answers PR0's 503 `not_built` (`warmup`); `builtWarmup` is swapped in
// with routes 46 and 47 and the pool signals.
import { notBuilt } from '../api/not-built.ts'
import { apiError, apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'
import { brandAgentRpc } from '../do/runner/brand-agent-rpc.ts'

/** Route 48, `POST /api/ops/warmup`. */
export const builtWarmup: Handler = async c => {
  const r = await brandAgentRpc(c.env).warmup()
  return 'refused' in r ? apiError(r.refused.code, r.refused.reason === undefined ? {} : { reason: r.refused.reason }) : apiJson(r)
}

/** Route 48, wired: PR0's stub until W1's class delegates to the pool. */
export const warmup: Handler = notBuilt
