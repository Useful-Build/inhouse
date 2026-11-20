// Warm-up after a deploy (P3, p3-design sections 3 and 7): route 48, the `release` service token only. Owner: W2.
// The BrandAgent (pool.ts `warmup`) proves runners 0 .. min(2, N) - 1 on a container newer than the one at the drain
// (`/protocol` with a shared version, then `/health`), then clears the drain, starts the placement queue and advances
// every live run. Any runner failing: 503 `unavailable`, and the drain holds.
import { apiError, apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'
import { brandAgent } from '../do/brand-agent/client.ts'

/** Route 48, `POST /api/ops/warmup`. */
export const warmup: Handler = async c => {
  const r = await brandAgent(c.env).warmup()
  return 'refused' in r ? apiError(r.refused.code, r.refused.reason === undefined ? {} : { reason: r.refused.reason }) : apiJson(r)
}
