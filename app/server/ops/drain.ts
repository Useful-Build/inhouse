// Drain for a deploy (P3, p3-design sections 3 and 7): routes 46 and 47, the `release` service token only. Owner: W2
// (p3-w2.md). PR0's stubs, each answering 503 `not_built` until W2 replaces it here.
import { notBuilt } from '../api/not-built.ts'
import type { Handler } from '../routes.ts'

/** Route 46, `POST /api/ops/drain`. W2. */
export const startDrain: Handler = notBuilt
/** Route 47, `GET /api/ops/drain`. W2. */
export const drainState: Handler = notBuilt
