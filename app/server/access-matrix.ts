// The access matrix (p2-design section 3): one row per route in routes.ts, read by `checkAccess`, and the `CanRows`
// map `me().can` reads from the same rows. Orchestrator only. The test fixture keeps its own copy of the design's rows
// (server/testing/auth-fixtures.ts, `DESIGN_ROWS`), and matrix.test.ts checks the two are equal.

import type { AccessRow, CanRows } from './auth/matrix.ts'

export type { AccessRow }

export const accessMatrix: readonly AccessRow[] = [
  /* 1 */ { method: 'GET', pattern: '/api/health', class: 'open', allow: [], services: ['monitor'] },
  /* 2 */ { method: 'GET', pattern: '/api/me', class: 'baseline', allow: ['member', 'admin', 'inhouse'], services: ['smoke'] },
  /* 3 */ { method: 'GET', pattern: '/api/members', class: 'baseline', allow: ['member', 'admin', 'inhouse'] },
  /* 4 */ { method: 'POST', pattern: '/api/members/invites', class: 'baseline', allow: ['admin', 'inhouse'] },
  /* 5 */ { method: 'PUT', pattern: '/api/members/:id/role', class: 'baseline', allow: ['admin', 'inhouse'] },
  /* 6 */ { method: 'DELETE', pattern: '/api/members/:id', class: 'baseline', allow: ['admin', 'inhouse'] },
  /* 7 */ { method: 'GET', pattern: '/api/settings/personal', class: 'personal', allow: ['member', 'admin'], services: ['smoke'] },
  /* 8 */ { method: 'PUT', pattern: '/api/settings/personal/:key', class: 'personal', allow: ['member', 'admin'] },
  /* 9 */ { method: 'GET', pattern: '/api/settings/brand', class: 'baseline', allow: ['member', 'admin', 'inhouse'], services: ['smoke'] },
  /* 10 */ { method: 'PUT', pattern: '/api/settings/brand/:key', class: 'baseline', allow: ['admin', 'inhouse'] },
  /* 11 */ { method: 'GET', pattern: '/api/settings/technical', class: 'technical', allow: ['member', 'admin', 'inhouse'] },
  /* 12 */ { method: 'PUT', pattern: '/api/settings/technical/:key', class: 'technical', allow: ['inhouse', 'admin'], adminWrite: true },
  /* 13 */ { method: 'PUT', pattern: '/api/photo', class: 'personal', allow: ['member', 'admin'] },
  /* 14 */ { method: 'DELETE', pattern: '/api/photo', class: 'personal', allow: ['member', 'admin'] },
  /* 15 */ { method: 'GET', pattern: '/api/members/:id/photo', class: 'baseline', allow: ['member', 'admin', 'inhouse'] },
  /* 16 */ { method: 'GET', pattern: '/api/grants', class: 'baseline', allow: ['admin', 'inhouse'] },
  /* 17 */ { method: 'POST', pattern: '/api/grants', class: 'baseline', allow: ['admin'] },
  /* 18 */ { method: 'POST', pattern: '/api/grants/:id/end', class: 'baseline', allow: ['admin'] },
  /* 19 */ { method: 'GET', pattern: '/api/audit', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  /* 20 */ { method: 'GET', pattern: '/api/audit/export.csv', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  /* 21 */ { method: 'POST', pattern: '/api/client-error', class: 'report', allow: ['member', 'admin', 'inhouse'] },
]

/** Each `CanKey`'s row (section 3). */
export const canRows: CanRows = {
  invite: { method: 'POST', pattern: '/api/members/invites' },
  changeRole: { method: 'PUT', pattern: '/api/members/:id/role' },
  remove: { method: 'DELETE', pattern: '/api/members/:id' },
  editBrandSettings: { method: 'PUT', pattern: '/api/settings/brand/:key' },
  editTechnical: { method: 'PUT', pattern: '/api/settings/technical/:key' },
  switchModel: { method: 'PUT', pattern: '/api/settings/technical/:key', as: 'adminWrite' },
  grantSupport: { method: 'POST', pattern: '/api/grants' },
  viewMembers: { method: 'GET', pattern: '/api/members' },
  viewAudit: { method: 'GET', pattern: '/api/audit' },
  exportAudit: { method: 'GET', pattern: '/api/audit/export.csv' },
}
