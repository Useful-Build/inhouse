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
export const SMOKE_MEMBER = 'm_smoke'

/** The config as INHOUSE_ACCESS carries it (before parsing). */
export const config: z.input<typeof AccessConfigSchema> = {
  teamDomain: TEAM,
  apps: [{ ...BRAND }, { ...INHOUSE }],
  serviceTokens: { [MONITOR_ID]: 'monitor', [SMOKE_ID]: 'smoke' },
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

export const principals = {
  member: (memberId = 'm_member'): Principal => ({ kind: 'person', memberId, role: 'member', subject: 's_m', requestId: 'r' }),
  admin: (memberId = 'm_admin'): Principal => ({ kind: 'person', memberId, role: 'admin', subject: 's_a', requestId: 'r' }),
  inhouse: (grant: ActiveGrant | null = null): Principal => ({ kind: 'inhouse', memberId: 'm_ih', subject: 's_i', grant, requestId: 'r' }),
  smoke: (): Principal => ({ kind: 'service', name: 'smoke', memberId: SMOKE_MEMBER, requestId: 'r' }),
  monitor: (): Principal => ({ kind: 'service', name: 'monitor', requestId: 'r' }),
}

/**
 * The 21 rows of p2-design section 3 as written there (row 12 with `admin` in `allow` and row 21 a `report` row, per
 * the review round 1 calls): the properties' rows, and the independent copy server/access-matrix.ts must equal
 * (matrix.test.ts).
 */
export const DESIGN_ROWS: readonly AccessRow[] = [
  { method: 'GET', pattern: '/api/health', class: 'open', allow: [], services: ['monitor'] },
  { method: 'GET', pattern: '/api/me', class: 'baseline', allow: ['member', 'admin', 'inhouse'], services: ['smoke'] },
  { method: 'GET', pattern: '/api/members', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'POST', pattern: '/api/members/invites', class: 'brand_data', allow: ['admin'] },
  { method: 'PUT', pattern: '/api/members/:id/role', class: 'brand_data', allow: ['admin'] },
  { method: 'DELETE', pattern: '/api/members/:id', class: 'brand_data', allow: ['admin'] },
  { method: 'GET', pattern: '/api/settings/personal', class: 'personal', allow: ['member', 'admin'], services: ['smoke'] },
  { method: 'PUT', pattern: '/api/settings/personal/:key', class: 'personal', allow: ['member', 'admin'] },
  { method: 'GET', pattern: '/api/settings/brand', class: 'baseline', allow: ['member', 'admin', 'inhouse'], services: ['smoke'] },
  { method: 'PUT', pattern: '/api/settings/brand/:key', class: 'baseline', allow: ['admin'] },
  { method: 'GET', pattern: '/api/settings/technical', class: 'technical', allow: ['member', 'admin', 'inhouse'] },
  { method: 'PUT', pattern: '/api/settings/technical/:key', class: 'technical', allow: ['inhouse', 'admin'], adminWrite: true },
  { method: 'PUT', pattern: '/api/photo', class: 'personal', allow: ['member', 'admin'] },
  { method: 'DELETE', pattern: '/api/photo', class: 'personal', allow: ['member', 'admin'] },
  { method: 'GET', pattern: '/api/members/:id/photo', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/grants', class: 'baseline', allow: ['admin', 'inhouse'] },
  { method: 'POST', pattern: '/api/grants', class: 'baseline', allow: ['admin'] },
  { method: 'POST', pattern: '/api/grants/:id/end', class: 'baseline', allow: ['admin'] },
  { method: 'GET', pattern: '/api/audit', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/audit/export.csv', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  // Its own class (review round 1 call): the reporter posts from both hosts, and its handler gets no stores.
  { method: 'POST', pattern: '/api/client-error', class: 'report', allow: ['member', 'admin', 'inhouse'] },
]

/** `CanRows` as section 3 maps them. */
export const DESIGN_CAN_ROWS: CanRows = {
  invite: { method: 'POST', pattern: '/api/members/invites' },
  changeRole: { method: 'PUT', pattern: '/api/members/:id/role' },
  remove: { method: 'DELETE', pattern: '/api/members/:id' },
  editBrandSettings: { method: 'PUT', pattern: '/api/settings/brand/:key' },
  editTechnical: { method: 'PUT', pattern: '/api/settings/technical/:key' },
  switchModelOff: { method: 'PUT', pattern: '/api/settings/technical/:key', as: 'adminWrite' },
  grantSupport: { method: 'POST', pattern: '/api/grants' },
  viewMembers: { method: 'GET', pattern: '/api/members' },
  viewAudit: { method: 'GET', pattern: '/api/audit' },
  exportAudit: { method: 'GET', pattern: '/api/audit/export.csv' },
}
