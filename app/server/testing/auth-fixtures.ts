// Shared fixtures for the auth tests (server project, Workers runtime): an invented access config, a local RS256 issuer
// standing in for the Access team domain, and in-memory fakes of the stores. No network anywhere.
import { createLocalJWKSet } from 'jose'
import type { JWTVerifyGetKey } from 'jose'
import { newTestIssuerKey } from '../auth/test-issuer-mint.ts'
import type { TestIssuerKey } from '../auth/test-issuer-mint.ts'
import type { AccessConfigSchema } from '../auth/config.ts'
import type { z } from 'zod'
import type { ActiveGrant, Principal } from '../auth/principal.ts'
import type { AuthStores, SignIn, SignInRefusal } from '../auth/stores.ts'
import type { AccessRow, CanRows } from '../auth/matrix.ts'

export const TEAM = 'https://example-team.cloudflareaccess.com'
export const BRAND = { name: 'brand', origin: 'https://brand.example.test', aud: 'a1'.repeat(32) } as const
export const INHOUSE = { name: 'inhouse', origin: 'https://inhouse.example.test', aud: 'b2'.repeat(32) } as const
export const MONITOR_ID = 'monitor-client.access'
export const SMOKE_ID = 'smoke-client.access'
export const RELEASE_ID = 'release-client.access'
export const SMOKE_MEMBER = 'm_smoke'

/** The config as INHOUSE_ACCESS carries it (before parsing). */
export const config: z.input<typeof AccessConfigSchema> = {
  teamDomain: TEAM,
  apps: [{ ...BRAND }, { ...INHOUSE }],
  serviceTokens: { [MONITOR_ID]: 'monitor', [SMOKE_ID]: 'smoke', [RELEASE_ID]: 'release' },
}
export const authEnv = (c: unknown = config) => ({ INHOUSE_ACCESS: typeof c === 'string' ? c : JSON.stringify(c) })

export interface Issuer { key: TestIssuerKey; keys: JWTVerifyGetKey }
export async function issuer(): Promise<Issuer> {
  const key = await newTestIssuerKey()
  return { key, keys: createLocalJWKSet(key.jwks) }
}

/** In-memory stores. `people` maps a subject to its outcome on the brand app; calls are recorded. */
export function fakeStores(opts: { people?: Record<string, { role: 'member' | 'admin' } | SignInRefusal>; grant?: ActiveGrant | null; auditFails?: boolean; fail?: boolean } = {}) {
  const calls = { resolvePerson: [] as SignIn[], resolveInhouse: [] as SignIn[], active: [] as { nowMs: number; requestId: string }[], supportAccess: [] as { method: string; route: string; nowMs: number }[] }
  const boom = () => { if (opts.fail) throw new Error('D1 down') }
  const stores: AuthStores = {
    members: {
      async resolvePerson(s) {
        boom()
        calls.resolvePerson.push(s)
        const found = opts.people?.[s.subject] ?? 'not_invited'
        if (typeof found === 'string') return { refused: found }
        return { ok: { kind: 'person', memberId: `m_${s.subject}`, role: found.role, subject: s.subject, requestId: s.requestId } }
      },
      async resolveInhouse(s) {
        boom()
        calls.resolveInhouse.push(s)
        return { kind: 'inhouse', memberId: `m_ih_${s.subject}`, subject: s.subject, requestId: s.requestId }
      },
      async serviceMember() { boom(); return SMOKE_MEMBER },
      async profile(id) { boom(); return { name: `Name ${id}`, email: `${id}@example.test`, photoKey: null } },
    },
    grants: { async active(at) { boom(); calls.active.push(at); return opts.grant ?? null } },
    audit: {
      async supportAccess(_p, at) {
        if (opts.auditFails) throw new Error('audit write failed')
        calls.supportAccess.push(at)
      },
    },
  }
  return { stores, calls }
}

export const req = (origin: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  new Request(`${origin}/api/me`, { ...init, headers })

/** A sign-in's `expMs` in the fixtures: an hour past the matrix tests' clock. */
export const FIXTURE_EXP_MS = Date.parse('2026-11-20T11:00:00.000Z')

export const principals = {
  member: (memberId = 'm_member'): Principal => ({ kind: 'person', memberId, role: 'member', subject: 's_m', requestId: 'r', expMs: FIXTURE_EXP_MS }),
  admin: (memberId = 'm_admin'): Principal => ({ kind: 'person', memberId, role: 'admin', subject: 's_a', requestId: 'r', expMs: FIXTURE_EXP_MS }),
  inhouse: (grant: ActiveGrant | null = null): Principal => ({ kind: 'inhouse', memberId: 'm_ih', subject: 's_i', grant, requestId: 'r', expMs: FIXTURE_EXP_MS }),
  smoke: (): Principal => ({ kind: 'service', name: 'smoke', memberId: SMOKE_MEMBER, requestId: 'r' }),
  monitor: (): Principal => ({ kind: 'service', name: 'monitor', requestId: 'r' }),
  release: (): Principal => ({ kind: 'service', name: 'release', requestId: 'r' }),
}

/**
 * The 21 rows of p2-design section 3 as written there (row 12 with `admin` in `allow` and row 21 a `report` row, per
 * the review round 1 calls), as decision 19 amends them (rows 3 to 6 and 15 `baseline`; 4, 6 and 10 list `inhouse`,
 * and 5 doesn't, decision 19b), then P3's rows 22 to 49 as p3-design section 3's table writes them: the properties' rows, and the
 * independent copy server/access-matrix.ts must equal (matrix.test.ts).
 */
export const DESIGN_ROWS: readonly AccessRow[] = [
  { method: 'GET', pattern: '/api/health', class: 'open', allow: [], services: ['monitor'] },
  { method: 'GET', pattern: '/api/me', class: 'baseline', allow: ['member', 'admin', 'inhouse'], services: ['smoke'] },
  { method: 'GET', pattern: '/api/members', class: 'baseline', allow: ['member', 'admin', 'inhouse'] },
  { method: 'POST', pattern: '/api/members/invites', class: 'baseline', allow: ['admin', 'inhouse'] },
  { method: 'PUT', pattern: '/api/members/:id/role', class: 'baseline', allow: ['admin'] },
  { method: 'DELETE', pattern: '/api/members/:id', class: 'baseline', allow: ['admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/settings/personal', class: 'personal', allow: ['member', 'admin'], services: ['smoke'] },
  { method: 'PUT', pattern: '/api/settings/personal/:key', class: 'personal', allow: ['member', 'admin'] },
  { method: 'GET', pattern: '/api/settings/brand', class: 'baseline', allow: ['member', 'admin', 'inhouse'], services: ['smoke'] },
  { method: 'PUT', pattern: '/api/settings/brand/:key', class: 'baseline', allow: ['admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/settings/technical', class: 'technical', allow: ['member', 'admin', 'inhouse'] },
  { method: 'PUT', pattern: '/api/settings/technical/:key', class: 'technical', allow: ['inhouse', 'admin'], adminWrite: true },
  { method: 'PUT', pattern: '/api/photo', class: 'personal', allow: ['member', 'admin'] },
  { method: 'DELETE', pattern: '/api/photo', class: 'personal', allow: ['member', 'admin'] },
  { method: 'GET', pattern: '/api/members/:id/photo', class: 'baseline', allow: ['member', 'admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/grants', class: 'baseline', allow: ['admin', 'inhouse'] },
  { method: 'POST', pattern: '/api/grants', class: 'baseline', allow: ['admin'] },
  { method: 'POST', pattern: '/api/grants/:id/end', class: 'baseline', allow: ['admin'] },
  { method: 'GET', pattern: '/api/audit', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/audit/export.csv', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  // Its own class (review round 1 call): the reporter posts from both hosts, and its handler gets no stores.
  { method: 'POST', pattern: '/api/client-error', class: 'report', allow: ['member', 'admin', 'inhouse'] },
  // P3, p3-design section 3.
  { method: 'GET', pattern: '/api/chats', class: 'brand_data', allow: ['member', 'admin', 'inhouse'], services: ['smoke'], ownerObject: true },
  { method: 'POST', pattern: '/api/chats', class: 'personal', allow: ['member', 'admin'], services: ['smoke'] },
  { method: 'GET', pattern: '/api/chats/:id', class: 'brand_data', allow: ['member', 'admin', 'inhouse'], services: ['smoke'], ownerObject: true },
  { method: 'PUT', pattern: '/api/chats/:id/title', class: 'personal', allow: ['member', 'admin'] },
  { method: 'PUT', pattern: '/api/chats/:id/pin', class: 'personal', allow: ['member', 'admin'] },
  { method: 'POST', pattern: '/api/chats/delete', class: 'personal', allow: ['member', 'admin'] },
  { method: 'POST', pattern: '/api/chats/restore', class: 'personal', allow: ['member', 'admin'] },
  { method: 'POST', pattern: '/api/chats/:id/turns', class: 'personal', allow: ['member', 'admin'], services: ['smoke'] },
  { method: 'POST', pattern: '/api/turns/:turnId/interrupt', class: 'personal', allow: ['member', 'admin'] },
  { method: 'POST', pattern: '/api/turns/:turnId/stop', class: 'personal', allow: ['member', 'admin'] },
  { method: 'GET', pattern: '/api/runs/active', class: 'brand_data', allow: ['member', 'admin', 'inhouse'], services: ['smoke'], ownerObject: true },
  { method: 'GET', pattern: '/api/traces/:id', class: 'brand_data', allow: ['member', 'admin', 'inhouse'], ownerObject: true },
  { method: 'GET', pattern: '/api/socket', class: 'brand_data', allow: ['member', 'admin', 'inhouse'], services: ['smoke'], ownerObject: true },
  { method: 'GET', pattern: '/api/pause', class: 'baseline', allow: ['member', 'admin', 'inhouse'] },
  { method: 'POST', pattern: '/api/pause', class: 'baseline', allow: ['admin', 'inhouse'] },
  { method: 'POST', pattern: '/api/resume', class: 'baseline', allow: ['admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/models', class: 'baseline', allow: ['member', 'admin', 'inhouse'], services: ['smoke'] },
  { method: 'POST', pattern: '/api/chats/:id/attachments', class: 'personal', allow: ['member', 'admin'] },
  { method: 'GET', pattern: '/api/chats/:id/files', class: 'brand_data', allow: ['member', 'admin', 'inhouse'], ownerObject: true },
  { method: 'GET', pattern: '/api/files/:fileId', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/usage', class: 'baseline', allow: ['member', 'admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/memory', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'PUT', pattern: '/api/memory/personal/:id/forgotten', class: 'personal', allow: ['member', 'admin'] },
  { method: 'PUT', pattern: '/api/memory/brand/:id/forgotten', class: 'brand_data', allow: ['admin', 'inhouse'] },
  { method: 'POST', pattern: '/api/ops/drain', class: 'open', allow: [], services: ['release'] },
  { method: 'GET', pattern: '/api/ops/drain', class: 'open', allow: [], services: ['release'] },
  // Route 50 (W2): the test build's undrain, release only like drain (its handler answers 404 outside the test build).
  { method: 'DELETE', pattern: '/api/ops/drain', class: 'open', allow: [], services: ['release'] },
  { method: 'POST', pattern: '/api/ops/warmup', class: 'open', allow: [], services: ['release'] },
  { method: 'POST', pattern: '/api/chats/:id/session/reset', class: 'personal', allow: ['member', 'admin'] },
  // Route 51 (W1 PR 6): revive one quarantined due task, release only like drain.
  { method: 'POST', pattern: '/api/ops/tasks/revive', class: 'open', allow: [], services: ['release'] },
  // Route 67 (P4 wave 4, p4-w6.md OC 2): the test build's alarm-now control, release only (404 outside the test build).
  { method: 'POST', pattern: '/api/ops/alarm', class: 'open', allow: [], services: ['release'] },
  // Rows 59 to 61 (P4 W4): Activity is brand data; the bell is personal, no Inhouse.
  { method: 'GET', pattern: '/api/activity', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/notifications', class: 'personal', allow: ['member', 'admin'] },
  { method: 'POST', pattern: '/api/notifications/read', class: 'personal', allow: ['member', 'admin'] },
  // Rows 57 and 58 (P4 W3): Today is brand data; the set-aside write is open to the Inhouse team under a live grant.
  { method: 'GET', pattern: '/api/today', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'PUT', pattern: '/api/today/:id/aside', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  // Rows 62 to 66 (P4 W5): the Library is brand data; the upload is people only.
  { method: 'GET', pattern: '/api/library', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'POST', pattern: '/api/library/uploads', class: 'brand_data', allow: ['member', 'admin'] },
  { method: 'GET', pattern: '/api/library/:id/download', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'POST', pattern: '/api/library/delete', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'POST', pattern: '/api/library/restore', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  // Rows 52 to 56 (P4 W2): the Routines page, brand data; Inhouse writes under a live grant.
  { method: 'GET', pattern: '/api/routines', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'PUT', pattern: '/api/routines/:id/enabled', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'POST', pattern: '/api/routines/:id/run', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'POST', pattern: '/api/routines/:id/delete', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'POST', pattern: '/api/routines/:id/restore', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  // Rows 77 to 83 (P6a PR0; rows 68 to 76 are P5's). Team memory approval: brand data, admins and the Inhouse team
  // (the PUT under a live grant, INHOUSE_BRAND_WRITES). Skills: technical, everyone reads. Team requests: baseline,
  // since a request is addressed to the Inhouse team, which reads it and alone marks it done or declined without a
  // grant; withdrawing is personal, the requester's own.
  { method: 'GET', pattern: '/api/memory/waiting', class: 'brand_data', allow: ['admin', 'inhouse'] },
  { method: 'PUT', pattern: '/api/memory/brand/:id/approved', class: 'brand_data', allow: ['admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/skills', class: 'technical', allow: ['member', 'admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/team-requests', class: 'baseline', allow: ['member', 'admin', 'inhouse'] },
  { method: 'POST', pattern: '/api/team-requests', class: 'baseline', allow: ['member', 'admin'] },
  { method: 'PUT', pattern: '/api/team-requests/:id/status', class: 'baseline', allow: ['inhouse'] },
  { method: 'PUT', pattern: '/api/team-requests/:id/withdrawn', class: 'personal', allow: ['member', 'admin'] },
]

/** `CanRows` as section 3 maps them. */
export const DESIGN_CAN_ROWS: CanRows = {
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
}

const unwired = () => Promise.reject(new Error('stores not wired'))

/**
 * Stores whose every call throws (test-only, so it never reaches the product bundle): every sign-in that needs D1
 * answers 503 and nothing is let through. Only `monitor` (no member row) gets a principal.
 */
export const unwiredStores: AuthStores = {
  members: { resolvePerson: unwired, resolveInhouse: unwired, serviceMember: unwired, profile: unwired },
  grants: { active: unwired },
  audit: { supportAccess: unwired },
}
