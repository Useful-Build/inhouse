// Drain for a deploy (P3, p3-design sections 3 and 7): routes 46 and 47, the `release` service token only. Owner: W2.
// The BrandAgent does the work in one synchronous step (pool.ts `drain`): nothing is admitted after it, and it undoes
// itself after 30 minutes. The release job polls route 47 until `live`, `starting` and `ending` are 0.
//
// Owed when W1's class lands: the routes still answer PR0's 503 `not_built` (`startDrain`, `drainState`), because the
// BrandAgent class has no `drain`/`drainState` RPC yet. The built handlers are `builtStartDrain` and `builtDrainState`;
// one change swaps them in, with the warm-up route and the pool signals.
import { notBuilt } from '../api/not-built.ts'
import { apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'
import { brandAgentRpc } from '../do/runner/brand-agent-rpc.ts'

/** Route 46, `POST /api/ops/drain`: the drain state after it. */
export const builtStartDrain: Handler = async c => apiJson(await brandAgentRpc(c.env).drain())
/** Route 47, `GET /api/ops/drain`: `{ live, starting, ending, queued, drainingUntilMs }`. */
export const builtDrainState: Handler = async c => apiJson(await brandAgentRpc(c.env).drainState())

/** Route 46, wired: PR0's stub until W1's class delegates to the pool. */
export const startDrain: Handler = notBuilt
/** Route 47, wired: PR0's stub until W1's class delegates to the pool. */
export const drainState: Handler = notBuilt
