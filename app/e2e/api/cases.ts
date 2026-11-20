// matrix.spec.ts's case for each route: what the design says about the route (its class, who is allowed, which service
// tokens; p2-design section 3, written out here by hand and never read from access-matrix.ts, so a row the server
// widens fails routes.spec.ts), the request that proves it, and the status an allowed caller gets. A write is sent with a
// body that passes access and then fails its schema (or names nothing), so the sweep changes nothing but one thing:
// DELETE /api/photo is a real delete. It answers 200 and, with no photo present (the sweep runs before photo.spec.ts and
// no earlier spec leaves one), changes nothing and writes no line. routes.spec.ts fails when a route in
// access-matrix.ts has no case here, or a case here has no route.
import type { Row } from './kit.ts'
import { rowKey } from './kit.ts'

type Role = 'member' | 'admin' | 'inhouse'

/** The design's rule for the route (section 3's table and its classes). */
export interface Design {
  class: 'open' | 'baseline' | 'brand_data' | 'personal' | 'technical' | 'report'
  allow: readonly Role[]
  services: readonly ('monitor' | 'smoke')[]
  /** Row 12 only: an Admin may write, through the object rule. */
  adminWrite: boolean
}

export interface RouteCase {
  design: Design
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

const d = (cls: Design['class'], allow: Role[], services: Design['services'] = [], adminWrite = false): Design => ({ class: cls, allow, services, adminWrite })
const ALL: Role[] = ['member', 'admin', 'inhouse']
const PEOPLE: Role[] = ['member', 'admin']

export const CASES: Record<string, RouteCase> = {
  'GET /api/health': { design: d('open', [], ['monitor']), path: '/api/health', passes: 200 },
  'GET /api/me': { design: d('baseline', ALL, ['smoke']), path: '/api/me', passes: 200 },
  'GET /api/members': { design: d('brand_data', ALL), path: '/api/members', passes: 200 },
  'POST /api/members/invites': { design: d('brand_data', ['admin']), path: '/api/members/invites', json: {}, passes: 400 },
  'PUT /api/members/:id/role': { design: d('brand_data', ['admin']), path: `/api/members/${NO_MEMBER}/role`, json: {}, passes: 400 },
  'DELETE /api/members/:id': { design: d('brand_data', ['admin']), path: `/api/members/${NO_MEMBER}`, passes: 400 },
  'GET /api/settings/personal': { design: d('personal', PEOPLE, ['smoke']), path: '/api/settings/personal', passes: 200 },
  'PUT /api/settings/personal/:key': { design: d('personal', PEOPLE), path: '/api/settings/personal/g:theme', json: {}, passes: 400 },
  'GET /api/settings/brand': { design: d('baseline', ALL, ['smoke']), path: '/api/settings/brand', passes: 200 },
  'PUT /api/settings/brand/:key': { design: d('baseline', ['admin']), path: '/api/settings/brand/g:tz', json: {}, passes: 400 },
  'GET /api/settings/technical': { design: d('technical', ALL), path: '/api/settings/technical', passes: 200 },
  'PUT /api/settings/technical/:key': { design: d('technical', ['inhouse', 'admin'], [], true), path: '/api/settings/technical/stage', json: {}, passes: 400 },
  'PUT /api/photo': { design: d('personal', PEOPLE), path: '/api/photo', bytes: { content: Buffer.from('not an image'), contentType: 'image/png' }, passes: 400 },
  'DELETE /api/photo': { design: d('personal', PEOPLE), path: '/api/photo', passes: 200 },
  'GET /api/members/:id/photo': { design: d('brand_data', ALL), path: `/api/members/${NO_MEMBER}/photo`, passes: 404 },
  'GET /api/grants': { design: d('baseline', ['admin', 'inhouse']), path: '/api/grants', passes: 200 },
  'POST /api/grants': { design: d('baseline', ['admin']), path: '/api/grants', json: {}, passes: 400 },
  'POST /api/grants/:id/end': { design: d('baseline', ['admin']), path: `/api/grants/${NO_GRANT}/end`, json: {}, passes: 400 },
  'GET /api/audit': { design: d('brand_data', ALL), path: '/api/audit', passes: 200 },
  'GET /api/audit/export.csv': { design: d('brand_data', ALL), path: '/api/audit/export.csv', passes: 200 },
  'POST /api/client-error': { design: d('report', ALL), path: '/api/client-error', json: {}, passes: 204 },
}

/** The case for a row, or an error naming it (routes.spec.ts reports the gap on its own; this is for the specs that use it). */
export function caseFor(row: Pick<Row, 'method' | 'pattern'>): RouteCase {
  const found = CASES[rowKey(row)]
  if (!found) throw new Error(`cases.ts has no case for ${rowKey(row)}.`)
  return found
}
