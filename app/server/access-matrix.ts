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
  /* 5 */ { method: 'PUT', pattern: '/api/members/:id/role', class: 'baseline', allow: ['admin'] },
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
  // P3 (p3-design section 3). `ownerObject`: a chat is its starter's (BD11); `smoke` reaches only its own chat.
  /* 22 */ { method: 'GET', pattern: '/api/chats', class: 'brand_data', allow: ['member', 'admin', 'inhouse'], services: ['smoke'], ownerObject: true },
  /* 23 */ { method: 'POST', pattern: '/api/chats', class: 'personal', allow: ['member', 'admin'], services: ['smoke'] },
  /* 24 */ { method: 'GET', pattern: '/api/chats/:id', class: 'brand_data', allow: ['member', 'admin', 'inhouse'], services: ['smoke'], ownerObject: true },
  /* 25 */ { method: 'PUT', pattern: '/api/chats/:id/title', class: 'personal', allow: ['member', 'admin'] },
  /* 26 */ { method: 'PUT', pattern: '/api/chats/:id/pin', class: 'personal', allow: ['member', 'admin'] },
  /* 27 */ { method: 'POST', pattern: '/api/chats/delete', class: 'personal', allow: ['member', 'admin'] },
  /* 28 */ { method: 'POST', pattern: '/api/chats/restore', class: 'personal', allow: ['member', 'admin'] },
  /* 29 */ { method: 'POST', pattern: '/api/chats/:id/turns', class: 'personal', allow: ['member', 'admin'], services: ['smoke'] },
  /* 30 */ { method: 'POST', pattern: '/api/turns/:turnId/interrupt', class: 'personal', allow: ['member', 'admin'] },
  /* 31 */ { method: 'POST', pattern: '/api/turns/:turnId/stop', class: 'personal', allow: ['member', 'admin'] },
  /* 32 */ { method: 'GET', pattern: '/api/runs/active', class: 'brand_data', allow: ['member', 'admin', 'inhouse'], services: ['smoke'], ownerObject: true },
  /* 33 */ { method: 'GET', pattern: '/api/traces/:id', class: 'brand_data', allow: ['member', 'admin', 'inhouse'], ownerObject: true },
  /* 34 */ { method: 'GET', pattern: '/api/socket', class: 'brand_data', allow: ['member', 'admin', 'inhouse'], services: ['smoke'], ownerObject: true },
  /* 35 */ { method: 'GET', pattern: '/api/pause', class: 'baseline', allow: ['member', 'admin', 'inhouse'] },
  /* 36 */ { method: 'POST', pattern: '/api/pause', class: 'baseline', allow: ['admin', 'inhouse'] },
  /* 37 */ { method: 'POST', pattern: '/api/resume', class: 'baseline', allow: ['admin', 'inhouse'] },
  /* 38 */ { method: 'GET', pattern: '/api/models', class: 'baseline', allow: ['member', 'admin', 'inhouse'], services: ['smoke'] },
  /* 39 */ { method: 'POST', pattern: '/api/chats/:id/attachments', class: 'personal', allow: ['member', 'admin'] },
  /* 40 */ { method: 'GET', pattern: '/api/chats/:id/files', class: 'brand_data', allow: ['member', 'admin', 'inhouse'], ownerObject: true },
  /* 41 */ { method: 'GET', pattern: '/api/files/:fileId', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  /* 42 */ { method: 'GET', pattern: '/api/usage', class: 'baseline', allow: ['member', 'admin', 'inhouse'] },
  /* 43 */ { method: 'GET', pattern: '/api/memory', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  /* 44 */ { method: 'PUT', pattern: '/api/memory/personal/:id/forgotten', class: 'personal', allow: ['member', 'admin'] },
  /* 45 */ { method: 'PUT', pattern: '/api/memory/brand/:id/forgotten', class: 'brand_data', allow: ['admin', 'inhouse'] },
  /* 46 */ { method: 'POST', pattern: '/api/ops/drain', class: 'open', allow: [], services: ['release'] },
  /* 47 */ { method: 'GET', pattern: '/api/ops/drain', class: 'open', allow: [], services: ['release'] },
  /* 50 */ { method: 'DELETE', pattern: '/api/ops/drain', class: 'open', allow: [], services: ['release'] },
  /* 48 */ { method: 'POST', pattern: '/api/ops/warmup', class: 'open', allow: [], services: ['release'] },
  /* 49 */ { method: 'POST', pattern: '/api/chats/:id/session/reset', class: 'personal', allow: ['member', 'admin'] },
  // W1 PR 6 (A7): revive one quarantined due task, a runbook action for the release token like drain.
  /* 51 */ { method: 'POST', pattern: '/api/ops/tasks/revive', class: 'open', allow: [], services: ['release'] },
  // P4 wave 4 (p4-w6.md OC 2): the test build's alarm-now control, release only like the undrain (its handler answers
  // 404 outside the test build).
  /* 67 */ { method: 'POST', pattern: '/api/ops/alarm', class: 'open', allow: [], services: ['release'] },
  // P4 W4 (p4-w4.md section 3, OC 3 and 4): Activity is brand data (as the audit log); the bell is personal and the Inhouse team has none.
  /* 59 */ { method: 'GET', pattern: '/api/activity', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  /* 60 */ { method: 'GET', pattern: '/api/notifications', class: 'personal', allow: ['member', 'admin'] },
  /* 61 */ { method: 'POST', pattern: '/api/notifications/read', class: 'personal', allow: ['member', 'admin'] },
  // P5 W1 (p5-w1.md section 9): technical, the Inhouse team alone. Route B is a GET the AS redirects the browser to, on
  // the Inhouse team's host (OC-W1-11): it needs that host's Access session like any route (401 before routing without
  // one; a top-level redirect carries it), so no open row. Its CSRF guard is the state's member binding at the hub.
  /* 68 */ { method: 'POST', pattern: '/api/connect/:accountId/start', class: 'technical', allow: ['inhouse'] },
  /* 69 */ { method: 'GET', pattern: '/api/connect/callback', class: 'technical', allow: ['inhouse'] },
  // P5 W3 (p5-w3.md): the Tools page. Everyone reads; only the Inhouse team pauses, resumes and disconnects (an Admin's write is read-only).
  /* 70 */ { method: 'GET', pattern: '/api/tools', class: 'technical', allow: ['member', 'admin', 'inhouse'] },
  /* 71 */ { method: 'PUT', pattern: '/api/tools/:accountId/paused', class: 'technical', allow: ['inhouse'] },
  /* 72 */ { method: 'POST', pattern: '/api/tools/:accountId/disconnect', class: 'technical', allow: ['inhouse'] },
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
