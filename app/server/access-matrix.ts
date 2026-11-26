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
  // P4 W3 (p4-w3.md section 5): Today is brand data; setting an item aside is a write the Inhouse team may make under a live grant (audited; INHOUSE_BRAND_WRITES).
  /* 57 */ { method: 'GET', pattern: '/api/today', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  /* 58 */ { method: 'PUT', pattern: '/api/today/:id/aside', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  // P4 W5 (p4-w5.md section 3, OC 4): the Library is brand data; the upload is people only.
  /* 62 */ { method: 'GET', pattern: '/api/library', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  /* 63 */ { method: 'POST', pattern: '/api/library/uploads', class: 'brand_data', allow: ['member', 'admin'] },
  /* 64 */ { method: 'GET', pattern: '/api/library/:id/download', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  /* 65 */ { method: 'POST', pattern: '/api/library/delete', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  /* 66 */ { method: 'POST', pattern: '/api/library/restore', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  // P4 W2 (p4-w2.md section 9, OC 5): the Routines page is brand data; the Inhouse team writes under a live grant
  // (support.access pairs these with audit.ts's PUT and POST lists). Who may switch, delete or restore is the handler's.
  /* 52 */ { method: 'GET', pattern: '/api/routines', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  /* 53 */ { method: 'PUT', pattern: '/api/routines/:id/enabled', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  /* 54 */ { method: 'POST', pattern: '/api/routines/:id/run', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  /* 55 */ { method: 'POST', pattern: '/api/routines/:id/delete', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  /* 56 */ { method: 'POST', pattern: '/api/routines/:id/restore', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  // P5 W1 (p5-w1.md section 9): technical, the Inhouse team alone. Route B is a GET the AS redirects the browser to, on
  // the Inhouse team's host (OC-W1-11): it needs that host's Access session like any route (401 before routing without
  // one; a top-level redirect carries it), so no open row. Its CSRF guard is the state's member binding at the hub.
  /* 68 */ { method: 'POST', pattern: '/api/connect/:accountId/start', class: 'technical', allow: ['inhouse'] },
  /* 69 */ { method: 'GET', pattern: '/api/connect/callback', class: 'technical', allow: ['inhouse'] },
  // P5 W3 (p5-w3.md): the Tools page. Everyone reads; only the Inhouse team pauses, resumes and disconnects (an Admin's write is read-only).
  /* 70 */ { method: 'GET', pattern: '/api/tools', class: 'technical', allow: ['member', 'admin', 'inhouse'] },
  /* 71 */ { method: 'PUT', pattern: '/api/tools/:accountId/paused', class: 'technical', allow: ['inhouse'] },
  /* 72 */ { method: 'POST', pattern: '/api/tools/:accountId/disconnect', class: 'technical', allow: ['inhouse'] },
  // P5 W4 (p5-w4.md section 10): the Slack channels listed for notices. Everyone reads; an Admin or the Inhouse team picks and saves.
  /* 73 */ { method: 'GET', pattern: '/api/notify/channels', class: 'baseline', allow: ['member', 'admin', 'inhouse'] },
  /* 74 */ { method: 'GET', pattern: '/api/notify/channels/available', class: 'baseline', allow: ['admin', 'inhouse'] },
  /* 75 */ { method: 'PUT', pattern: '/api/notify/channels', class: 'baseline', allow: ['admin', 'inhouse'] },
  // P5 W5: the test build's test-fakes hook, release only like route 67 (its handler answers 404 outside the test build).
  // Close to auth: its ops call notification_send as a named member and the hub's ReadGateway as a run.
  /* 76 */ { method: 'POST', pattern: '/api/ops/test-fakes', class: 'open', allow: [], services: ['release'] },
  // P6a PR0 (docs/plans/2026-11-22-p6a-memory-skills.md). Rows 68 to 76 are P5's (fleet/connectors), so P6a holds 77 to 85 and 87 to 89 (86 is main's
  // routine runs, master plan decision 8).
  // Team memory approval (W2): brand data, admins and the Inhouse team; the Inhouse team's approve is a write under a
  // live grant (support.access PUT, INHOUSE_BRAND_WRITES). Members are refused here.
  /* 77 */ { method: 'GET', pattern: '/api/memory/waiting', class: 'brand_data', allow: ['admin', 'inhouse'] },
  /* 78 */ { method: 'PUT', pattern: '/api/memory/brand/:id/approved', class: 'brand_data', allow: ['admin', 'inhouse'] },
  // Skills (W3): `technical`, everyone reads (names and short summaries aren't sensitive). A skill's full text (84) is
  // brand data, read by the Inhouse team only under a live grant; people delete a brand skill (85), and who may (its
  // maker or an admin, or admins only after the maker's data is deleted) is the store's, in its statement.
  /* 79 */ { method: 'GET', pattern: '/api/skills', class: 'technical', allow: ['member', 'admin', 'inhouse'] },
  // Team requests (W3). Row 80 is baseline: the Inhouse team reads a request's text without a grant. That's an accepted
  // exception to "brand data needs a grant", because a request is addressed to the Inhouse team (review L1, #328). An
  // agent can file a request carrying tool-result brand data, so W4's read-side set includes that case. People create
  // (81). The Inhouse team alone marks a request done or declined (82, no grant). The requester alone withdraws their own
  // (83: personal, so the owner check on `requested_by` is mandatory and the Inhouse team never reaches it).
  /* 80 */ { method: 'GET', pattern: '/api/team-requests', class: 'baseline', allow: ['member', 'admin', 'inhouse'] },
  /* 81 */ { method: 'POST', pattern: '/api/team-requests', class: 'baseline', allow: ['member', 'admin'] },
  /* 82 */ { method: 'PUT', pattern: '/api/team-requests/:id/status', class: 'baseline', allow: ['inhouse'] },
  /* 83 */ { method: 'PUT', pattern: '/api/team-requests/:id/withdrawn', class: 'personal', allow: ['member', 'admin'] },
  /* 84 */ { method: 'GET', pattern: '/api/skills/:name', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  /* 85 */ { method: 'POST', pattern: '/api/skills/brand/:id/delete', class: 'brand_data', allow: ['member', 'admin'] },
  // Rows 87 to 89 stay P6a's spare numbers (86 is main's, below); line A holds 90 to 99.
  // Master plan decision 8: a routine's recent runs, read like route 52.
  /* 86 */ { method: 'GET', pattern: '/api/routines/:id/runs', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  // P8a F2: Shopify's privacy webhooks, the closed exception outside sign-in (routes.ts `webhookRoutes`): no principal
  // passes these rows; server/index.ts serves them before sign-in, authenticated by Shopify's HMAC.
  /* 91 */ { method: 'POST', pattern: '/api/webhooks/shopify/customers-data-request', class: 'webhook', allow: [] },
  /* 92 */ { method: 'POST', pattern: '/api/webhooks/shopify/customers-redact', class: 'webhook', allow: [] },
  /* 93 */ { method: 'POST', pattern: '/api/webhooks/shopify/shop-redact', class: 'webhook', allow: [] },
  // P8a F2: the runbook closes a privacy request, release only like revive.
  /* 94 */ { method: 'POST', pattern: '/api/ops/privacy-requests/:id/close', class: 'open', allow: [], services: ['release'] },
  // P8a D: Data and access's "Export everything", the brand's whole export (ops/export, brand scope) as one download.
  // Brand data: Admins, and the Inhouse team only under a live grant (support.access). Members never.
  /* 95 */ { method: 'GET', pattern: '/api/data-access/export', class: 'brand_data', allow: ['admin', 'inhouse'] },
  // P8a D: the check the page makes before route 95 (its plan only: the size or the `too_large` refusal). Row 95's access.
  /* 96 */ { method: 'GET', pattern: '/api/data-access/export/check', class: 'brand_data', allow: ['admin', 'inhouse'] },
  // Stage 1 M2-A (N15): a person's own "Always allow" permissions; an admin sees and removes any (the store's statement
  // decides the object). Brand people only: the Inhouse team sees none in M2.
  /* 110 */ { method: 'GET', pattern: '/api/permissions', class: 'baseline', allow: ['member', 'admin'] },
  /* 111 */ { method: 'POST', pattern: '/api/permissions/:id/remove', class: 'baseline', allow: ['member', 'admin'] },
  // Stage 1 M1-B (N3): a chat's long job is its owner's (BD11), read and cancelled by brand people only.
  /* 100 */ { method: 'GET', pattern: '/api/chats/:id/job', class: 'personal', allow: ['member', 'admin'] },
  /* 101 */ { method: 'POST', pattern: '/api/jobs/:id/cancel', class: 'personal', allow: ['member', 'admin'] },
  // Stage 1 M2-B (N15): the outbox's cards. Brand people only: the asker sees their own; an admin sees every card's facts
  // (never another person's chat) and may resolve a "Needs a check"; only the approver answers or undoes (the outbox's
  // statements decide the object). The Inhouse team sees none in M2.
  /* 120 */ { method: 'GET', pattern: '/api/actions', class: 'baseline', allow: ['member', 'admin'] },
  /* 121 */ { method: 'GET', pattern: '/api/actions/:id', class: 'baseline', allow: ['member', 'admin'] },
  /* 122 */ { method: 'POST', pattern: '/api/actions/:id/answer', class: 'baseline', allow: ['member', 'admin'] },
  /* 123 */ { method: 'POST', pattern: '/api/actions/:id/undo', class: 'baseline', allow: ['member', 'admin'] },
  /* 124 */ { method: 'POST', pattern: '/api/actions/:id/resolve', class: 'baseline', allow: ['member', 'admin'] },
  // Stage 1 M2-Q (N16): the questions asked of this person (a member's own; a routine's to its creator or every admin;
  // the question's `asked_of` decides, in its statement). Never the Inhouse team: a question is the brand's to answer.
  /* 140 */ { method: 'GET', pattern: '/api/questions', class: 'baseline', allow: ['member', 'admin'] },
  /* 141 */ { method: 'POST', pattern: '/api/questions/:id/answer', class: 'baseline', allow: ['member', 'admin'] },
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
  approveMemory: { method: 'PUT', pattern: '/api/memory/brand/:id/approved' },
  exportData: { method: 'GET', pattern: '/api/data-access/export' },
}
