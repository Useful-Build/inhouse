// The chat socket (P3, p3-design sections 3 and 4.10): route 34, the WebSocket upgrade. Owner: W1 (p3-w1.md). PR0's
// stub answers 503 `not_built` (no upgrade) until W1 replaces it here.
import { notBuilt } from './not-built.ts'
import type { Handler } from '../routes.ts'

/** Route 34, `GET /api/socket?v=` (upgrade). W1. */
export const openSocket: Handler = notBuilt
