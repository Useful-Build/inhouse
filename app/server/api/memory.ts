// Memory (P3, p3-design sections 3 and 10): routes 43 to 45. Owner: W6 (p3-w6.md). PR0's stubs, each answering 503
// `not_built` until W6 replaces it here.
import { notBuilt } from './not-built.ts'
import type { Handler } from '../routes.ts'

/** Route 43, `GET /api/memory`. W6. */
export const listMemory: Handler = notBuilt
/** Route 44, `PUT /api/memory/personal/:id/forgotten`. W6. */
export const forgetPersonalMemory: Handler = notBuilt
/** Route 45, `PUT /api/memory/brand/:id/forgotten`. W6. */
export const forgetBrandMemory: Handler = notBuilt
