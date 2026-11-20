// matrix.spec.ts's case for each route: the request it sends to prove who may call the route, and the status an
// allowed caller gets. A write is sent with a body that passes access and then fails its schema (or names nothing), so
// the sweep never changes anything: an allowed caller gets 400 or 404 from the handler, a refused one 403 before it.
// routes.spec.ts fails when a route in access-matrix.ts has no case here, or a case here has no route.
import type { Row } from './kit.ts'
import { rowKey } from './kit.ts'

export interface RouteCase {
  /** The concrete path: `:id` segments filled with ids that name nothing. */
  path: string
  json?: unknown
  /** Bytes sent with this `Content-Type` instead of JSON (the photo route). */
  bytes?: { content: Buffer; contentType: string }
  /** The status of a caller the matrix lets through. */
  passes: number
}

const NO_MEMBER = 'm_e2e_nobody'
const NO_GRANT = 'g_e2e_nobody'

export const CASES: Record<string, RouteCase> = {
  'GET /api/health': { path: '/api/health', passes: 200 },
  'GET /api/me': { path: '/api/me', passes: 200 },
  'GET /api/members': { path: '/api/members', passes: 200 },
  'POST /api/members/invites': { path: '/api/members/invites', json: {}, passes: 400 },
  'PUT /api/members/:id/role': { path: `/api/members/${NO_MEMBER}/role`, json: {}, passes: 400 },
  'DELETE /api/members/:id': { path: `/api/members/${NO_MEMBER}`, passes: 400 },
  'GET /api/settings/personal': { path: '/api/settings/personal', passes: 200 },
  'PUT /api/settings/personal/:key': { path: '/api/settings/personal/g:theme', json: {}, passes: 400 },
  'GET /api/settings/brand': { path: '/api/settings/brand', passes: 200 },
  'PUT /api/settings/brand/:key': { path: '/api/settings/brand/g:tz', json: {}, passes: 400 },
  'GET /api/settings/technical': { path: '/api/settings/technical', passes: 200 },
  'PUT /api/settings/technical/:key': { path: '/api/settings/technical/stage', json: {}, passes: 400 },
  'PUT /api/photo': { path: '/api/photo', bytes: { content: Buffer.from('not an image'), contentType: 'image/png' }, passes: 400 },
  'DELETE /api/photo': { path: '/api/photo', passes: 200 },
  'GET /api/members/:id/photo': { path: `/api/members/${NO_MEMBER}/photo`, passes: 404 },
  'GET /api/grants': { path: '/api/grants', passes: 200 },
  'POST /api/grants': { path: '/api/grants', json: {}, passes: 400 },
  'POST /api/grants/:id/end': { path: `/api/grants/${NO_GRANT}/end`, json: {}, passes: 400 },
  'GET /api/audit': { path: '/api/audit', passes: 200 },
  'GET /api/audit/export.csv': { path: '/api/audit/export.csv', passes: 200 },
  'POST /api/client-error': { path: '/api/client-error', json: {}, passes: 400 },
}

/** The case for a row, or an error naming it (routes.spec.ts reports the gap on its own; this is for the specs that use it). */
export function caseFor(row: Pick<Row, 'method' | 'pattern'>): RouteCase {
  const found = CASES[rowKey(row)]
  if (!found) throw new Error(`cases.ts has no case for ${rowKey(row)}.`)
  return found
}
