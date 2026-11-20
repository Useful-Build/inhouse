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
  services: readonly ('monitor' | 'smoke' | 'release')[]
  /** Row 12 only: an Admin may write, through the object rule. */
  adminWrite: boolean
  /** P3: a chat read, each object one member's (p3-design section 3). */
  ownerObject: boolean
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

const d = (cls: Design['class'], allow: Role[], services: Design['services'] = [], adminWrite = false, ownerObject = false): Design => ({ class: cls, allow, services, adminWrite, ownerObject })
/** P3's chat reads (p3-design section 3): `ownerObject`. */
const owned = (allow: Role[], services: Design['services'] = []): Design => d('brand_data', allow, services, false, true)
/** P3 PR0: every P3 route is a stub answering 503 `not_built` until its owner builds it (then its case moves to the real status). */
const STUB = 503
const NO_CHAT = 'c_e2e_nobody'
const ALL: Role[] = ['member', 'admin', 'inhouse']
const PEOPLE: Role[] = ['member', 'admin']

export const CASES: Record<string, RouteCase> = {
  'GET /api/health': { design: d('open', [], ['monitor']), path: '/api/health', passes: 200 },
  'GET /api/me': { design: d('baseline', ALL, ['smoke']), path: '/api/me', passes: 200 },
  'GET /api/members': { design: d('baseline', ALL), path: '/api/members', passes: 200 },
  'POST /api/members/invites': { design: d('baseline', ['admin', 'inhouse']), path: '/api/members/invites', json: {}, passes: 400 },
  'PUT /api/members/:id/role': { design: d('baseline', ['admin']), path: `/api/members/${NO_MEMBER}/role`, json: {}, passes: 400 },
  'DELETE /api/members/:id': { design: d('baseline', ['admin', 'inhouse']), path: `/api/members/${NO_MEMBER}`, passes: 400 },
  'GET /api/settings/personal': { design: d('personal', PEOPLE, ['smoke']), path: '/api/settings/personal', passes: 200 },
  'PUT /api/settings/personal/:key': { design: d('personal', PEOPLE), path: '/api/settings/personal/g:theme', json: {}, passes: 400 },
  'GET /api/settings/brand': { design: d('baseline', ALL, ['smoke']), path: '/api/settings/brand', passes: 200 },
  'PUT /api/settings/brand/:key': { design: d('baseline', ['admin', 'inhouse']), path: '/api/settings/brand/g:tz', json: {}, passes: 400 },
  'GET /api/settings/technical': { design: d('technical', ALL), path: '/api/settings/technical', passes: 200 },
  'PUT /api/settings/technical/:key': { design: d('technical', ['inhouse', 'admin'], [], true), path: '/api/settings/technical/stage', json: {}, passes: 400 },
  'PUT /api/photo': { design: d('personal', PEOPLE), path: '/api/photo', bytes: { content: Buffer.from('not an image'), contentType: 'image/png' }, passes: 400 },
  'DELETE /api/photo': { design: d('personal', PEOPLE), path: '/api/photo', passes: 200 },
  'GET /api/members/:id/photo': { design: d('baseline', ALL), path: `/api/members/${NO_MEMBER}/photo`, passes: 404 },
  'GET /api/grants': { design: d('baseline', ['admin', 'inhouse']), path: '/api/grants', passes: 200 },
  'POST /api/grants': { design: d('baseline', ['admin']), path: '/api/grants', json: {}, passes: 400 },
  'POST /api/grants/:id/end': { design: d('baseline', ['admin']), path: `/api/grants/${NO_GRANT}/end`, json: {}, passes: 400 },
  'GET /api/audit': { design: d('brand_data', ALL), path: '/api/audit', passes: 200 },
  'GET /api/audit/export.csv': { design: d('brand_data', ALL), path: '/api/audit/export.csv', passes: 200 },
  // Class 'report' is the agreed change from PR0b (server/auth/matrix.ts:15): both hosts post it, never a service token.
  'POST /api/client-error': { design: d('report', ALL), path: '/api/client-error', json: {}, passes: 204 },
  // P3, p3-design section 3's table, written out by hand.
  'GET /api/chats': { design: owned(ALL, ['smoke']), path: '/api/chats', passes: STUB },
  'POST /api/chats': { design: d('personal', PEOPLE, ['smoke']), path: '/api/chats', json: {}, passes: STUB },
  'GET /api/chats/:id': { design: owned(ALL, ['smoke']), path: `/api/chats/${NO_CHAT}`, passes: STUB },
  'PUT /api/chats/:id/title': { design: d('personal', PEOPLE), path: `/api/chats/${NO_CHAT}/title`, json: {}, passes: STUB },
  'PUT /api/chats/:id/pin': { design: d('personal', PEOPLE), path: `/api/chats/${NO_CHAT}/pin`, json: {}, passes: STUB },
  'POST /api/chats/delete': { design: d('personal', PEOPLE), path: '/api/chats/delete', json: {}, passes: STUB },
  'POST /api/chats/restore': { design: d('personal', PEOPLE), path: '/api/chats/restore', json: {}, passes: STUB },
  'POST /api/chats/:id/turns': { design: d('personal', PEOPLE, ['smoke']), path: `/api/chats/${NO_CHAT}/turns`, json: {}, passes: 400 },
  'POST /api/turns/:turnId/interrupt': { design: d('personal', PEOPLE), path: '/api/turns/t_e2e_nobody/interrupt', json: {}, passes: 404 },
  'POST /api/turns/:turnId/stop': { design: d('personal', PEOPLE), path: '/api/turns/t_e2e_nobody/stop', json: {}, passes: 404 },
  'GET /api/runs/active': { design: owned(ALL, ['smoke']), path: '/api/runs/active', passes: 200 },
  'GET /api/traces/:id': { design: owned(ALL), path: '/api/traces/r_e2e_nobody', passes: 404 },
  'GET /api/socket': { design: owned(ALL, ['smoke']), path: '/api/socket?v=1', passes: STUB },
  'GET /api/pause': { design: d('baseline', ALL), path: '/api/pause', passes: 200 },
  // Item 19 (2026-11-20): the Inhouse team pauses and resumes too (an audited emergency pause), with no grant.
  'POST /api/pause': { design: d('baseline', ['admin', 'inhouse']), path: '/api/pause', json: {}, passes: 200 },
  'POST /api/resume': { design: d('baseline', ['admin', 'inhouse']), path: '/api/resume', json: {}, passes: 200 },
  'GET /api/models': { design: d('baseline', ALL, ['smoke']), path: '/api/models', passes: 200 },
  // Routes 39 to 41 are built (W3 #146): the cases' ids name nothing, so a caller the matrix lets through gets 404.
  'POST /api/chats/:id/attachments': { design: d('personal', PEOPLE), path: `/api/chats/${NO_CHAT}/attachments`, bytes: { content: Buffer.from('x'), contentType: 'application/octet-stream' }, passes: 404 },
  'GET /api/chats/:id/files': { design: owned(ALL), path: `/api/chats/${NO_CHAT}/files`, passes: 404 },
  'GET /api/files/:fileId': { design: d('brand_data', ALL), path: '/api/files/f_e2e_nobody', passes: 404 },
  'GET /api/usage': { design: d('baseline', ALL), path: '/api/usage', passes: 200 },
  'GET /api/memory': { design: d('brand_data', ALL), path: '/api/memory', passes: STUB },
  'PUT /api/memory/personal/:id/forgotten': { design: d('personal', PEOPLE), path: '/api/memory/personal/mem_e2e_nobody/forgotten', json: {}, passes: STUB },
  'PUT /api/memory/brand/:id/forgotten': { design: d('brand_data', ['admin']), path: '/api/memory/brand/mem_e2e_nobody/forgotten', json: {}, passes: STUB },
  'POST /api/ops/drain': { design: d('open', [], ['release']), path: '/api/ops/drain', json: {}, passes: STUB },
  'GET /api/ops/drain': { design: d('open', [], ['release']), path: '/api/ops/drain', passes: STUB },
  'POST /api/ops/warmup': { design: d('open', [], ['release']), path: '/api/ops/warmup', json: {}, passes: STUB },
  'POST /api/chats/:id/session/reset': { design: d('personal', PEOPLE), path: `/api/chats/${NO_CHAT}/session/reset`, json: {}, passes: 404 },
}

/** The case for a row, or an error naming it (routes.spec.ts reports the gap on its own; this is for the specs that use it). */
export function caseFor(row: Pick<Row, 'method' | 'pattern'>): RouteCase {
  const found = CASES[rowKey(row)]
  if (!found) throw new Error(`cases.ts has no case for ${rowKey(row)}.`)
  return found
}
