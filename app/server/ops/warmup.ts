// Warm-up after a deploy (P3, p3-design sections 3 and 7): route 48, the `release` service token only. Owner: W2
// (p3-w2.md). PR0's stub answers 503 `not_built` until W2 replaces it here.
import { notBuilt } from '../api/not-built.ts'
import type { Handler } from '../routes.ts'

/** Route 48, `POST /api/ops/warmup`. W2. */
export const warmup: Handler = notBuilt
