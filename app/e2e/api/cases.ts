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
  class: 'open' | 'baseline' | 'brand_data' | 'personal' | 'technical' | 'report' | 'webhook'
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
  /** The status of a caller the matrix lets through (a `webhook` row lets none: its sweep expects 401). */
  passes: number
  /** Other statuses that are right too (the warm-up route while a container deployment is still warming). */
  alsoPasses?: number[]
}

const NO_MEMBER = 'm_e2e_nobody'
const NO_GRANT = 'g_e2e_nobody'

const d = (cls: Design['class'], allow: Role[], services: Design['services'] = [], adminWrite = false, ownerObject = false): Design => ({ class: cls, allow, services, adminWrite, ownerObject })
/** P3's chat reads (p3-design section 3): `ownerObject`. */
const owned = (allow: Role[], services: Design['services'] = []): Design => d('brand_data', allow, services, false, true)
const NO_CHAT = 'c_e2e_nobody'
/**
 * A memory id of the right shape (`mem_` + 22) that names nothing. Sent with a valid body, routes 44 and 45 get past the
 * id and body checks to the store's lookup, which finds no fact: 404, and nothing changes.
 */
const NO_MEMORY = 'mem_e2eNobodyAAAAAAAAAAAAA'
/** A Today item id of the right shape (`p_` + 22) that names nothing. */
const NO_TODAY = 'p_e2eNobodyAAAAAAAAAAAAA'
/** A routine id nobody has (`rt_` + 22, audit.ts `RoutineIdSchema`). */
const NO_ROUTINE = 'rt_e2eNobodyAAAAAAAAAAAAA'
/** A team request id nobody has (`tr_` + 22, audit.ts `TeamRequestIdSchema`). */
const NO_TEAM_REQUEST = 'tr_e2eNobodyAAAAAAAAAAAAA'
/** A brand skill id that names nothing: `bs_` + 22 characters (BrandSkillIdSchema). */
const NO_BRAND_SKILL = 'bs_e2eNobodyAAAAAAAAAAAAA'
/** A permission id nobody has (`pg_` + 22, permissions.ts `PermissionIdSchema`). */
const NO_PERMISSION = 'pg_e2eNobodyAAAAAAAAAAAAA'
/** A job id nobody has (`j_` + 22, jobs.ts `JobIdSchema`). */
const NO_JOB = 'j_e2eNobodyAAAAAAAAAAAAA'
/** An action id nobody has (`ac_` + 22, actions.ts `ActionIdSchema`). */
const NO_ACTION = 'ac_e2eNobodyAAAAAAAAAAAAA'
/** A question id nobody has (`q_` + 22, questions.ts `QuestionIdSchema`). */
const NO_QUESTION = 'q_e2eNobodyAAAAAAAAAAAAA'
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
  'GET /api/chats': { design: owned(ALL, ['smoke']), path: '/api/chats', passes: 200 },
  'POST /api/chats': { design: d('personal', PEOPLE, ['smoke']), path: '/api/chats', json: {}, passes: 400 },
  'GET /api/chats/:id': { design: owned(ALL, ['smoke']), path: `/api/chats/${NO_CHAT}`, passes: 404 },
  'PUT /api/chats/:id/title': { design: d('personal', PEOPLE), path: `/api/chats/${NO_CHAT}/title`, json: {}, passes: 400 },
  'PUT /api/chats/:id/pin': { design: d('personal', PEOPLE), path: `/api/chats/${NO_CHAT}/pin`, json: {}, passes: 400 },
  'POST /api/chats/delete': { design: d('personal', PEOPLE), path: '/api/chats/delete', json: {}, passes: 400 },
  'POST /api/chats/restore': { design: d('personal', PEOPLE), path: '/api/chats/restore', json: {}, passes: 400 },
  'POST /api/chats/:id/turns': { design: d('personal', PEOPLE, ['smoke']), path: `/api/chats/${NO_CHAT}/turns`, json: {}, passes: 400 },
  'POST /api/turns/:turnId/interrupt': { design: d('personal', PEOPLE), path: '/api/turns/t_e2e_nobody/interrupt', json: {}, passes: 404 },
  'POST /api/turns/:turnId/stop': { design: d('personal', PEOPLE), path: '/api/turns/t_e2e_nobody/stop', json: {}, passes: 404 },
  'GET /api/runs/active': { design: owned(ALL, ['smoke']), path: '/api/runs/active', passes: 200 },
  'GET /api/traces/:id': { design: owned(ALL), path: '/api/traces/r_e2e_nobody', passes: 404 },
  // Route 34 is built (W1 PR 4): the sweep sends a plain GET, which this route answers 400 (it only upgrades).
  'GET /api/socket': { design: owned(ALL, ['smoke']), path: '/api/socket?v=1', passes: 400 },
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
  'GET /api/memory': { design: d('brand_data', ALL), path: '/api/memory', passes: 200 },
  'PUT /api/memory/personal/:id/forgotten': { design: d('personal', PEOPLE), path: `/api/memory/personal/${NO_MEMORY}/forgotten`, json: { forgotten: true, ifRev: 1 }, passes: 404 },
  'PUT /api/memory/brand/:id/forgotten': { design: d('brand_data', ['admin', 'inhouse']), path: `/api/memory/brand/${NO_MEMORY}/forgotten`, json: { forgotten: true, ifRev: 1 }, passes: 404 },
  // Routes 46-48 are built (W2 #162). The drain POST really drains the test build's brand for 30 minutes; the test
  // build's undrain (route 50, DELETE: swept right after the GET that follows the POST, and matrix.spec's and
  // origin.spec's afterAll) clears it, so later specs and the next run see an undrained pool. Warm-up can't prove a
  // runner with no containers: 503 `unavailable`.
  'POST /api/ops/drain': { design: d('open', [], ['release']), path: '/api/ops/drain', json: {}, passes: 200 },
  'GET /api/ops/drain': { design: d('open', [], ['release']), path: '/api/ops/drain', passes: 200 },
  // Route 50, the test build's undrain (W2): 200 here (the test build); the product build answers 404 (server/ops/drain.test.ts).
  'DELETE /api/ops/drain': { design: d('open', [], ['release']), path: '/api/ops/drain', passes: 200 },
  // The warm-up has no container to wake on the local test build (503); on a deployed test build with containers (the per-PR
  // deployment, the same remote detection as chat-kit's needsContainer()) it answers 200 once warmed, and 503 only while warming.
  'POST /api/ops/warmup': { design: d('open', [], ['release']), path: '/api/ops/warmup', json: {}, ...(process.env.E2E_TEST_BUILD_REMOTE ? { passes: 200, alsoPasses: [503] } : { passes: 503 }) },
  // Route 51 (W1 PR 6): an empty body passes access, then fails its schema (400), so the sweep revives nothing.
  'POST /api/ops/tasks/revive': { design: d('open', [], ['release']), path: '/api/ops/tasks/revive', json: {}, passes: 400 },
  // Route 67 (P4 wave 4): the test build's alarm-now control runs one scheduler pass (200); the product build answers 404
  // (server/ops/alarm-now.test.ts).
  'POST /api/ops/alarm': { design: d('open', [], ['release']), path: '/api/ops/alarm', json: {}, passes: 200 },
  // Route 76 (P5 W5): the test build's test-fakes hook, release token only (a person's session is refused by the matrix before the handler).
  // An empty body passes access, then fails the op parse (400), so the sweep changes no fake; the product build answers 404 (server/ops/test-fakes.test.ts).
  'POST /api/ops/test-fakes': { design: d('open', [], ['release']), path: '/api/ops/test-fakes', json: {}, passes: 400 },
  // Rows 59 to 61 (P4 W4): Activity (brand data) and the bell (personal, no Inhouse). Reading an id nobody has is a 200 that marks nothing.
  'GET /api/activity': { design: d('brand_data', ALL), path: '/api/activity', passes: 200 },
  'GET /api/notifications': { design: d('personal', PEOPLE), path: '/api/notifications', passes: 200 },
  'POST /api/notifications/read': { design: d('personal', PEOPLE), path: '/api/notifications/read', json: { ids: ['n_e2e_nobody'] }, passes: 200 },
  // Rows 57 and 58 (P4 W3): Today (brand data). An id of the right shape that names nothing passes access and the body check to the store's lookup: 404, nothing changes.
  'GET /api/today': { design: d('brand_data', ALL), path: '/api/today', passes: 200 },
  'PUT /api/today/:id/aside': { design: d('brand_data', ALL), path: `/api/today/${NO_TODAY}/aside`, json: { reason: 'dismissed', ifRev: 0 }, passes: 404 },
  // Rows 62 to 66 (P4 W5): the Library. An upload with no X-File-Name, a write with no items: 400; an id nobody has: 404.
  'GET /api/library': { design: d('brand_data', ALL), path: '/api/library', passes: 200 },
  'POST /api/library/uploads': { design: d('brand_data', PEOPLE), path: '/api/library/uploads', json: {}, passes: 400 },
  'GET /api/library/:id/download': { design: d('brand_data', ALL), path: `/api/library/f_${'0'.repeat(22)}/download`, passes: 404 },
  'POST /api/library/delete': { design: d('brand_data', ALL), path: '/api/library/delete', json: {}, passes: 400 },
  'POST /api/library/restore': { design: d('brand_data', ALL), path: '/api/library/restore', json: {}, passes: 400 },
  // Rows 52 to 56 (P4 W2): the Routines page. The list reads (200); a write names a routine nobody has (404, nothing written).
  'GET /api/routines': { design: d('brand_data', ALL), path: '/api/routines', passes: 200 },
  'PUT /api/routines/:id/enabled': { design: d('brand_data', ALL), path: `/api/routines/${NO_ROUTINE}/enabled`, json: { on: false, ifRev: 1 }, passes: 404 },
  'POST /api/routines/:id/run': { design: d('brand_data', ALL), path: `/api/routines/${NO_ROUTINE}/run`, json: { clientKey: 'e2e-run-key-1' }, passes: 404 },
  'POST /api/routines/:id/delete': { design: d('brand_data', ALL), path: `/api/routines/${NO_ROUTINE}/delete`, json: { ifRev: 1 }, passes: 404 },
  'POST /api/routines/:id/restore': { design: d('brand_data', ALL), path: `/api/routines/${NO_ROUTINE}/restore`, json: { ifRev: 1 }, passes: 404 },
  // P5 W1, routes 68 and 69. The start names an account no connector has, so the hub answers unknown_tool (404) and
  // nothing is written; the callback with no code or state redirects to /tools?connect_error=state_invalid (303) and
  // writes nothing (connect.test.ts proves both).
  'POST /api/connect/:accountId/start': { design: d('technical', ['inhouse']), path: '/api/connect/nothing:here/start', json: {}, passes: 404 },
  'GET /api/connect/callback': { design: d('technical', ['inhouse']), path: '/api/connect/callback', passes: 303 },
  // P5 W3, routes 70 to 72. The read answers 200 from the hub's account list; the writes name an account no connector has, so
  // they are 404 before any hub call and nothing is written (tools.test.ts proves it).
  'GET /api/tools': { design: d('technical', ALL), path: '/api/tools', passes: 200 },
  'PUT /api/tools/:accountId/paused': { design: d('technical', ['inhouse']), path: '/api/tools/nothing:here/paused', json: { paused: true }, passes: 404 },
  'POST /api/tools/:accountId/disconnect': { design: d('technical', ['inhouse']), path: '/api/tools/nothing:here/disconnect', json: {}, passes: 404 },
  // P5 W4, routes 73 to 75. The list reads 200; the picker reaches the test hub, where Slack isn't connected (503
  // slack_not_connected); the save's empty body is 400 before any hub call or write (routes.test.ts proves the rest).
  'GET /api/notify/channels': { design: d('baseline', ALL), path: '/api/notify/channels', passes: 200 },
  'GET /api/notify/channels/available': { design: d('baseline', ['admin', 'inhouse']), path: '/api/notify/channels/available', passes: 503 },
  'PUT /api/notify/channels': { design: d('baseline', ['admin', 'inhouse']), path: '/api/notify/channels', json: {}, passes: 400 },
  'POST /api/chats/:id/session/reset': { design: d('personal', PEOPLE), path: `/api/chats/${NO_CHAT}/session/reset`, json: {}, passes: 404 },
  // Rows 77 to 83: lists return 200, an empty create body returns 400, and writes to unknown ids return 404.
  // Row 83 is personal: with a well-formed { ifRev } body, an unknown id returns 404 before the owner check.
  'GET /api/memory/waiting': { design: d('brand_data', ['admin', 'inhouse']), path: '/api/memory/waiting', passes: 200 },
  'PUT /api/memory/brand/:id/approved': { design: d('brand_data', ['admin', 'inhouse']), path: `/api/memory/brand/${NO_MEMORY}/approved`, json: { approved: true, ifRev: 1 }, passes: 404 },
  'GET /api/skills': { design: d('technical', ALL), path: '/api/skills', passes: 200 },
  'GET /api/team-requests': { design: d('baseline', ALL), path: '/api/team-requests?view=window', passes: 200 },
  'POST /api/team-requests': { design: d('baseline', PEOPLE), path: '/api/team-requests', json: {}, passes: 400 },
  'PUT /api/team-requests/:id/status': { design: d('baseline', ['inhouse']), path: `/api/team-requests/${NO_TEAM_REQUEST}/status`, json: { status: 'done', ifRev: 1 }, passes: 404 },
  'PUT /api/team-requests/:id/withdrawn': { design: d('personal', PEOPLE), path: `/api/team-requests/${NO_TEAM_REQUEST}/withdrawn`, json: { ifRev: 1 }, passes: 404 },
  // Rows 84 and 85 (P6a brand skills): a name and an id that name nothing, so a caller the matrix lets in gets 404.
  'GET /api/skills/:name': { design: d('brand_data', ALL), path: '/api/skills/no-such-skill', passes: 404 },
  'POST /api/skills/brand/:id/delete': { design: d('brand_data', PEOPLE), path: `/api/skills/brand/${NO_BRAND_SKILL}/delete`, json: { ifRev: 1 }, passes: 404 },
  // Row 86: routine runs.
  'GET /api/routines/:id/runs': { design: d('brand_data', ALL), path: `/api/routines/${NO_ROUTINE}/runs`, passes: 404 },
  // Rows 91 to 93 (P8a F2): Shopify's privacy webhooks, outside sign-in. A JWT counts for nothing there: without Shopify's
  // signature every caller gets 401 (webhooks.spec.ts sends signed deliveries).
  'POST /api/webhooks/shopify/customers-data-request': { design: d('webhook', []), path: '/api/webhooks/shopify/customers-data-request', json: {}, passes: 401 },
  'POST /api/webhooks/shopify/customers-redact': { design: d('webhook', []), path: '/api/webhooks/shopify/customers-redact', json: {}, passes: 401 },
  'POST /api/webhooks/shopify/shop-redact': { design: d('webhook', []), path: '/api/webhooks/shopify/shop-redact', json: {}, passes: 401 },
  // Row 94 (P8a F2): the runbook's close, release only. A well-formed id nobody has: 404, nothing written.
  'POST /api/ops/privacy-requests/:id/close': { design: d('open', [], ['release']), path: `/api/ops/privacy-requests/pr_${'0'.repeat(22)}/close`, json: {}, passes: 404 },
  // Row 95 (P8a D): Export everything. A caller the matrix lets in gets the whole export as a 200 download (it changes
  // nothing; its audit line holds counts only).
  'GET /api/data-access/export': { design: d('brand_data', ['admin', 'inhouse']), path: '/api/data-access/export', passes: 200 },
  // Row 96 (P8a D): Export everything's check. It plans only: a 200 with the size, nothing written.
  'GET /api/data-access/export/check': { design: d('brand_data', ['admin', 'inhouse']), path: '/api/data-access/export/check', passes: 200 },
  // Stage 1 M2-A (N15): brand people only.
  'GET /api/permissions': { design: d('baseline', PEOPLE), path: '/api/permissions', passes: 200 },
  'POST /api/permissions/:id/remove': { design: d('baseline', PEOPLE), path: `/api/permissions/${NO_PERMISSION}/remove`, json: { ifRev: 1 }, passes: 404 },
  // Stage 1 M1-B (N3): a chat nobody has is 404; a well-formed job id nobody has is 404, nothing written.
  'GET /api/chats/:id/job': { design: d('personal', PEOPLE), path: `/api/chats/${NO_CHAT}/job`, passes: 404 },
  'POST /api/jobs/:id/cancel': { design: d('personal', PEOPLE), path: `/api/jobs/${NO_JOB}/cancel`, json: {}, passes: 404 },
  // Stage 1 M2-B (N15): brand people only. No route makes an action, so the object routes answer 404 here.
  'GET /api/actions': { design: d('baseline', PEOPLE), path: '/api/actions', passes: 200 },
  'GET /api/actions/:id': { design: d('baseline', PEOPLE), path: `/api/actions/${NO_ACTION}`, passes: 404 },
  'POST /api/actions/:id/answer': { design: d('baseline', PEOPLE), path: `/api/actions/${NO_ACTION}/answer`, json: { choice: 'deny', ifRev: 1 }, passes: 404 },
  'POST /api/actions/:id/undo': { design: d('baseline', PEOPLE), path: `/api/actions/${NO_ACTION}/undo`, json: { ifRev: 1 }, passes: 404 },
  'POST /api/actions/:id/resolve': { design: d('baseline', PEOPLE), path: `/api/actions/${NO_ACTION}/resolve`, json: { outcome: 'sent', ifRev: 1 }, passes: 404 },
  // Stage 1 M2-Q (N16): brand people only. An answer to a question nobody asked: 404, nothing written.
  'GET /api/questions': { design: d('baseline', PEOPLE), path: '/api/questions', passes: 200 },
  'POST /api/questions/:id/answer': { design: d('baseline', PEOPLE), path: `/api/questions/${NO_QUESTION}/answer`, json: { choice: 'Yes' }, passes: 404 },
}

/** The case for a row, or an error naming it (routes.spec.ts reports the gap on its own; this is for the specs that use it). */
export function caseFor(row: Pick<Row, 'method' | 'pattern'>): RouteCase {
  const found = CASES[rowKey(row)]
  if (!found) throw new Error(`cases.ts has no case for ${rowKey(row)}.`)
  return found
}
