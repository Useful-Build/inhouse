// Warm-up after a deploy (P3, p3-design sections 3 and 7): route 48, the `release` service token only. Owner: W2.
// The BrandAgent (pool.ts `warmup`) proves runners 0 .. min(2, N) - 1 on a container newer than the one at the drain
// (`/protocol` with a shared version, then `/health`), then clears the drain, starts the placement queue and advances
// every live run. Any runner failing: 503 `unavailable`, and the drain holds.
// How the release job calls it: until it answers 200, again 5 s after each 503, and the deploy aborts if it hasn't
// passed within 10 minutes. One call can already wait out a cold start (a runner gives a new container up to
// runner.ts `BOOT_TIMEOUT_MS`, 150 s, to answer), but a start that fails at once (a fresh image not on the host yet)
// answers 503 in a few seconds, and the next call starts the container again. Those failed starts are not restarts
// (pool.ts `containerExited` counts only a container that came up), so the retries never turn `pool_restarts` red.
import { apiError, apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'
import { brandAgent } from '../do/brand-agent/client.ts'

/** Route 48, `POST /api/ops/warmup`. */
export const warmup: Handler = async c => {
  const r = await brandAgent(c.env).warmup()
  return 'refused' in r ? apiError(r.refused.code, r.refused.reason === undefined ? {} : { reason: r.refused.reason }) : apiJson(r)
}
