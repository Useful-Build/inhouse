// Turns, runs and traces (P3, p3-design sections 3, 4.3 and 4.9): routes 29 to 33. Owner: W1 (p3-w1.md). PR0's stubs,
// each answering 503 `not_built` until W1 replaces it here.
import { notBuilt } from './not-built.ts'
import type { Handler } from '../routes.ts'

/** Route 29, `POST /api/chats/:id/turns` (body cap 1 MiB). W1. */
export const sendTurn: Handler = notBuilt
/** Route 30, `POST /api/turns/:turnId/interrupt`. W1. */
export const interruptTurn: Handler = notBuilt
/** Route 31, `POST /api/turns/:turnId/stop`. W1. */
export const stopTurn: Handler = notBuilt
/** Route 32, `GET /api/runs/active`. W1. */
export const activeRuns: Handler = notBuilt
/** Route 33, `GET /api/traces/:id`. W1. */
export const getTrace: Handler = notBuilt
