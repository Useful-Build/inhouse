// Pause and resume (P3, p3-design sections 3 and 4.11): routes 35 to 37. Owner: W1 (p3-w1.md). PR0's stubs, each
// answering 503 `not_built` until W1 replaces it here.
import { notBuilt } from './not-built.ts'
import type { Handler } from '../routes.ts'

/** Route 35, `GET /api/pause`. W1. */
export const getPause: Handler = notBuilt
/** Route 36, `POST /api/pause`. W1. */
export const pauseAgent: Handler = notBuilt
/** Route 37, `POST /api/resume`. W1. */
export const resumeAgent: Handler = notBuilt
