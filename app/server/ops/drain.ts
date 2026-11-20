// Drain for a deploy (P3, p3-design sections 3 and 7): routes 46 and 47, the `release` service token only. Owner: W2.
// The BrandAgent does the work in one synchronous step (pool.ts `drain`): nothing is admitted after it, and it undoes
// itself after 30 minutes. The release job polls route 47 until `live`, `starting` and `ending` are 0.
import { apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'
import { brandAgent } from '../do/brand-agent/client.ts'

/** Route 46, `POST /api/ops/drain`: the drain state after it. */
export const startDrain: Handler = async c => apiJson(await brandAgent(c.env).drain())
/** Route 47, `GET /api/ops/drain`: `{ live, starting, ending, queued, drainingUntilMs }`. */
export const drainState: Handler = async c => apiJson(await brandAgent(c.env).drainState())
