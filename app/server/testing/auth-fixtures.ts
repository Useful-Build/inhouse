// Shared fixtures for the auth tests (server project, Workers runtime): an invented access config, a local RS256 issuer
// standing in for the Access team domain, and in-memory fakes of the stores. No network anywhere.
import { createLocalJWKSet } from 'jose'
import type { JWTVerifyGetKey } from 'jose'
import { newTestIssuerKey } from '../auth/test-issuer-mint.ts'
import type { TestIssuerKey } from '../auth/test-issuer-mint.ts'
import type { AccessConfig } from '../auth/config.ts'
import type { ActiveGrant, Principal } from '../auth/principal.ts'
import type { AuthStores, SignIn, SignInRefusal } from '../auth/stores.ts'

export const TEAM = 'https://example-team.cloudflareaccess.com'
export const BRAND = { name: 'brand', origin: 'https://brand.example.test', aud: 'a1'.repeat(32) } as const
export const INHOUSE = { name: 'inhouse', origin: 'https://inhouse.example.test', aud: 'b2'.repeat(32) } as const
export const MONITOR_ID = 'monitor-client.access'
export const SMOKE_ID = 'smoke-client.access'
export const SMOKE_MEMBER = 'm_smoke'

export const config: AccessConfig = {
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
  const calls = { resolvePerson: [] as SignIn[], resolveInhouse: [] as SignIn[], supportAccess: [] as { method: string; route: string }[] }
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
        return { kind: 'inhouse', memberId: `m_ih_${s.subject}`, subject: s.subject, grant: opts.grant ?? null, requestId: s.requestId }
      },
      async serviceMember() { boom(); return SMOKE_MEMBER },
      async profile(id) { boom(); return { name: `Name ${id}`, email: `${id}@example.test`, photoKey: null } },
    },
    grants: { async active() { boom(); return opts.grant ?? null } },
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
