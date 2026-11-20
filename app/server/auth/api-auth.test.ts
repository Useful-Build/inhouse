// The /api/* path (server/api.ts) with W1's real sign-in and access parts, a local key set and in-memory stores:
// an invalid config is 503 on every route, OPTIONS is 405, the audit duty and the object check are enforced from the
// decision, `me` answers a schema-valid Me, and a handler's WebSocket 101 keeps its socket through withSecurityHeaders.
import { env as baseEnv } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import type { Handler, Route } from '../routes.ts'
import { apiJson } from '../http.ts'
import { StoresClosedError, authenticate, checkAccess, checkOrigin } from './index.ts'
import type { AuthStores } from './index.ts'
import { mintPerson, mintService } from './test-issuer-mint.ts'
import { buildMe, meHandler } from './me-handler.ts'
import { MeSchema } from '../../shared/contract/me.ts'
import { accessMatrix } from '../access-matrix.ts'
import { reportClientError, routes } from '../routes.ts'
import { BRAND, DESIGN_CAN_ROWS, DESIGN_ROWS, INHOUSE, MONITOR_ID, SMOKE_ID, TEAM, authEnv, fakeStores, issuer } from '../testing/auth-fixtures.ts'
import type { Issuer } from '../testing/auth-fixtures.ts'

let good: Issuer
beforeAll(async () => { good = await issuer() })
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
const ok: Handler = async () => apiJson({ ok: true })
const routeTable = (handlers: Partial<Record<string, Handler>> = {}): Route[] =>
  DESIGN_ROWS.map(r => ({ method: r.method, pattern: r.pattern, handler: handlers[`${r.method} ${r.pattern}`] ?? ok }))

function setup(o: { access?: unknown; stores?: ReturnType<typeof fakeStores>; handlers?: Partial<Record<string, Handler>>; storesThrow?: boolean } = {}) {
  const s = o.stores ?? fakeStores({ people: { admin: { role: 'admin' }, member: { role: 'member' } }, grant: { id: 'g_1', endsAtMs: Date.now() + 3_600_000 } })
  const parts: ApiParts = {
    authenticate: (r, e, st, n, id) => authenticate(r, e, st, n, id, good.keys),
    checkOrigin, checkAccess,
    stores: () => {
      if (o.storesThrow) throw new TypeError('no D1 binding')
      return s.stores
    },
    routes: routeTable(o.handlers),
    accessMatrix: DESIGN_ROWS,
  }
  const env = { ...baseEnv, ...authEnv(o.access) } as Env
  const call = (origin: string, path: string, init: RequestInit = {}) => api(parts, new Request(`${origin}${path}`, init), env, ctx, 'req-1')
  return { call, calls: s.calls, parts, env }
}
const as = async (who: 'admin' | 'member' | 'inhouse') =>
  mintPerson({ key: good.key.privateJwk, iss: TEAM, aud: who === 'inhouse' ? INHOUSE.aud : BRAND.aud, sub: who, email: `${who}@example.test` })
const concrete = (pattern: string) => pattern.replace(/:[a-z]+/g, 'x1')

describe('the request path', () => {
  it('answers 503 on every route when INHOUSE_ACCESS is invalid, even with a valid token', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { call } = setup({ access: '{"teamDomain":' })
    const token = await as('admin')
    for (const r of DESIGN_ROWS) {
      const res = await call(BRAND.origin, concrete(r.pattern), { method: r.method, headers: { 'Cf-Access-Jwt-Assertion': token, Origin: BRAND.origin } })
      expect(res.status, `${r.method} ${r.pattern}`).toBe(503)
    }
    vi.restoreAllMocks()
  })
  it('is 401 for an unknown path without a token, 404 with one, and 405 for OPTIONS', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { call } = setup()
    expect((await call(BRAND.origin, '/api/nope')).status).toBe(401)
    const headers = { 'Cf-Access-Jwt-Assertion': await as('admin') }
    expect((await call(BRAND.origin, '/api/nope', { headers })).status).toBe(404)
    const pre = await call(BRAND.origin, '/api/me', { method: 'OPTIONS', headers: { ...headers, Origin: 'https://evil.example.test' } })
    expect(pre.status).toBe(405)
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(pre.headers.get('Cache-Control')).toBe('no-store')
    vi.restoreAllMocks()
  })
  it('answers 503 unavailable and logs auth_store_failed (class only) when the stores cannot be made', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handler = vi.fn(ok)
    const { call } = setup({ storesThrow: true, handlers: { 'GET /api/me': handler } })
    const res = await call(BRAND.origin, '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': await as('member') } })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: { code: 'unavailable' } })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(error.mock.calls).toEqual([[{ event: 'auth_store_failed', requestId: 'req-1', error: 'TypeError' }]])
    expect(handler).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
  it('refuses a write without the exact Origin (403 bad_origin) before the handler', async () => {
    const handler = vi.fn(ok)
    const { call } = setup({ handlers: { 'POST /api/members/invites': handler } })
    const headers = { 'Cf-Access-Jwt-Assertion': await as('admin') }
    const res = await call(BRAND.origin, '/api/members/invites', { method: 'POST', headers })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: { code: 'forbidden', reason: 'bad_origin' } })
    expect((await call(BRAND.origin, '/api/members/invites', { method: 'POST', headers: { ...headers, Origin: BRAND.origin, 'Sec-Fetch-Site': 'same-site' } })).status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
    expect((await call(BRAND.origin, '/api/members/invites', { method: 'POST', headers: { ...headers, Origin: BRAND.origin, 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200)
  })
})

describe('the audit duty', () => {
  it('writes support.access before an Inhouse read of brand data, with the request nowMs', async () => {
    const { call, calls } = setup()
    const res = await call(INHOUSE.origin, '/api/members', { headers: { 'Cf-Access-Jwt-Assertion': await as('inhouse') } })
    expect(res.status).toBe(200)
    expect(calls.supportAccess).toEqual([{ method: 'GET', route: '/api/members', nowMs: calls.active[0].nowMs }])
  })
  it('answers 503 and never runs the handler when the line cannot be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const handler = vi.fn(ok)
    const { call } = setup({ stores: fakeStores({ grant: { id: 'g', endsAtMs: Date.now() + 60_000 }, auditFails: true }), handlers: { 'GET /api/members': handler } })
    expect((await call(INHOUSE.origin, '/api/members', { headers: { 'Cf-Access-Jwt-Assertion': await as('inhouse') } })).status).toBe(503)
    expect(handler).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
  it('refuses an Inhouse read of brand data without a grant (403 grant_required)', async () => {
    const { call } = setup({ stores: fakeStores({ grant: null }) })
    const res = await call(INHOUSE.origin, '/api/audit', { headers: { 'Cf-Access-Jwt-Assertion': await as('inhouse') } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: { code: 'forbidden', reason: 'grant_required' } })
  })
})

describe('the object check', () => {
  const put = async (handler: Handler) => {
    const { call } = setup({ handlers: { 'PUT /api/settings/technical/:key': handler } })
    return call(BRAND.origin, '/api/settings/technical/tm:gpt:on', { method: 'PUT', headers: { 'Cf-Access-Jwt-Assertion': await as('admin'), Origin: BRAND.origin } })
  }
  it('turns a 2xx from a handler that never called requireObject into 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await put(ok)).status).toBe(500)
    vi.restoreAllMocks()
  })
  it('answers 403 when the handler swallows a refusal and writes anyway', async () => {
    const res = await put(async c => {
      try { c.access.requireObject({ settingKey: c.params.key, value: 'on' }) } catch { /* the bug under test */ }
      return apiJson({ wrote: true })
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: { code: 'forbidden', reason: 'admin_read_only' } })
  })
  it('closes the stores at the refusal: a handler that swallows it and then writes stores nothing', async () => {
    const s = fakeStores({ people: { admin: { role: 'admin' } } })
    let thrown: unknown
    const { call } = setup({ stores: s, handlers: { 'PUT /api/settings/technical/:key': async c => {
      try { c.access.requireObject({ settingKey: c.params.key, value: 'on' }) } catch { /* the bug under test */ }
      try {
        await c.stores!.audit.supportAccess({ kind: 'inhouse', memberId: 'm_x', subject: 's', grant: null, requestId: c.requestId }, { method: 'PUT', route: '/x', nowMs: c.nowMs })
      } catch (err) { thrown = err }
      return apiJson({ wrote: true })
    } } })
    const res = await call(BRAND.origin, '/api/settings/technical/tm:gpt:on', { method: 'PUT', headers: { 'Cf-Access-Jwt-Assertion': await as('admin'), Origin: BRAND.origin } })
    expect(thrown).toBeInstanceOf(StoresClosedError)
    expect(s.calls.supportAccess).toEqual([])
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: { code: 'forbidden', reason: 'admin_read_only' } })
  })
  it('answers 403, not 500, when the closed store throws out of the handler', async () => {
    const res = await put(async c => {
      try { c.access.requireObject({ settingKey: c.params.key, value: 'on' }) } catch { /* the bug under test */ }
      await c.stores!.members.profile('m_x')
      return apiJson({})
    })
    expect(res.status).toBe(403)
  })
  it('a spread of the stores still reaches a method, and still closes at the refusal', async () => {
    const s = fakeStores({ people: { admin: { role: 'admin' } } })
    let seen: { keys: string[]; has: boolean; before: unknown; after: unknown } | undefined
    const { call } = setup({ stores: s, handlers: { 'PUT /api/settings/technical/:key': async c => {
      const spread = { ...c.stores! }
      const members = { ...spread.members }
      const before = await members.profile('m_x')
      try { c.access.requireObject({ settingKey: c.params.key, value: 'on' }) } catch { /* the bug under test */ }
      let after: unknown
      try { await members.profile('m_y') } catch (err) { after = err }
      seen = { keys: Object.keys(c.stores!).sort(), has: 'audit' in c.stores!, before, after }
      return apiJson({})
    } } })
    const res = await call(BRAND.origin, '/api/settings/technical/tm:gpt:on', { method: 'PUT', headers: { 'Cf-Access-Jwt-Assertion': await as('admin'), Origin: BRAND.origin } })
    expect(res.status).toBe(403)
    expect(seen?.keys).toEqual(['audit', 'grants', 'members'])
    expect(seen?.has).toBe(true)
    expect(seen?.before).toMatchObject({ name: 'Name m_x' })
    expect(seen?.after).toBeInstanceOf(StoresClosedError)
  })
  it('leaves the stores open while no check has refused', async () => {
    const res = await put(async c => {
      const before = await c.stores!.members.profile('m_x')
      c.access.requireObject({ settingKey: c.params.key, value: 'off' })
      return apiJson({ before, after: await c.stores!.members.profile('m_y') })
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ before: { name: 'Name m_x' }, after: { name: 'Name m_y' } })
  })
  it('needs a passing call for a 1xx too: a 101 upgrade without one is 500, with one it stays 101', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const upgrade = (check: boolean): Handler => async c => {
      if (check) c.access.requireObject({ ownerId: 'm_member' })
      const pair = new WebSocketPair()
      pair[1].accept()
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    for (const check of [false, true]) {
      const { call } = setup({ handlers: { 'GET /api/settings/personal': upgrade(check) } })
      const res = await call(BRAND.origin, '/api/settings/personal', { headers: { 'Cf-Access-Jwt-Assertion': await as('member'), Upgrade: 'websocket', Origin: BRAND.origin } })
      expect(res.status, `requireObject called: ${check}`).toBe(check ? 101 : 500)
    }
    vi.restoreAllMocks()
  })
  it('answers 403 admin_read_only when the object fails, and 200 when it passes', async () => {
    const refused = await put(async c => { c.access.requireObject({ settingKey: c.params.key, value: 'on' }); return apiJson({}) })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: { code: 'forbidden', reason: 'admin_read_only' } })
    expect((await put(async c => { c.access.requireObject({ settingKey: c.params.key, value: 'off' }); return apiJson({}) })).status).toBe(200)
  })
  it('lets only the owner through a personal row', async () => {
    const handler: Handler = async c => { c.access.requireObject({ ownerId: 'm_member' }); return apiJson({}) }
    const { call } = setup({ handlers: { 'PUT /api/settings/personal/:key': handler } })
    const send = async (who: 'admin' | 'member') => call(BRAND.origin, '/api/settings/personal/k', { method: 'PUT', headers: { 'Cf-Access-Jwt-Assertion': await as(who), Origin: BRAND.origin } })
    expect((await send('member')).status).toBe(200)
    expect((await send('admin')).status).toBe(403)
  })
})

describe('me', () => {
  const NOW = Date.parse('2026-11-20T10:00:00.000Z')
  const profile = { name: 'A Person', email: 'a@example.test', photoKey: 'photos/1' }
  it('builds a schema-valid Me for every principal with a member row', () => {
    const withRows: Parameters<typeof buildMe>[0][] = [
      { kind: 'person', memberId: 'm_member', role: 'member', subject: 's', requestId: 'r' },
      { kind: 'person', memberId: 'm_admin', role: 'admin', subject: 's', requestId: 'r' },
      { kind: 'inhouse', memberId: 'm_ih', subject: 's', grant: { id: 'g', endsAtMs: NOW + 1 }, requestId: 'r' },
      { kind: 'inhouse', memberId: 'm_ih', subject: 's', grant: null, requestId: 'r' },
      { kind: 'service', name: 'smoke', memberId: 'm_smoke', requestId: 'r' },
    ]
    for (const p of withRows) {
      const me = buildMe(p, profile, DESIGN_ROWS, DESIGN_CAN_ROWS, NOW)
      expect(MeSchema.safeParse(me).success, p.kind).toBe(true)
      expect(me.photoUrl).toBe(`/api/members/${p.memberId}/photo`)
      expect(me.grant !== null).toBe(p.kind === 'inhouse' && p.grant !== null)
    }
    expect(buildMe(withRows[0], { ...profile, photoKey: null }, DESIGN_ROWS, DESIGN_CAN_ROWS, NOW).photoUrl).toBeNull()
  })
  it('answers GET /api/me through the path, for a person and for smoke', async () => {
    const s = fakeStores({ people: { member: { role: 'member' } } })
    const handler = meHandler({ rows: DESIGN_ROWS, canRows: DESIGN_CAN_ROWS })
    const { call } = setup({ stores: s, handlers: { 'GET /api/me': handler } })
    const res = await call(BRAND.origin, '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': await as('member') } })
    expect(res.status).toBe(200)
    const me = MeSchema.parse(await res.json())
    expect(me).toMatchObject({ memberId: 'm_member', role: 'member', grant: null })
    const smoke = await mintService({ key: good.key.privateJwk, iss: TEAM, aud: BRAND.aud, clientId: SMOKE_ID })
    expect((await call(BRAND.origin, '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': smoke } })).status).toBe(200)
    const monitor = await mintService({ key: good.key.privateJwk, iss: TEAM, aud: BRAND.aud, clientId: MONITOR_ID })
    expect((await call(BRAND.origin, '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': monitor } })).status).toBe(403)
  })
})

describe('the clock', () => {
  it("me reads the request's one nowMs: a grant ending after it but before a later clock read is still live", async () => {
    const token = await as('inhouse')
    const T = Date.now()
    const s = fakeStores({ grant: { id: 'g_1', endsAtMs: T + 1 } })
    const { call } = setup({ stores: s, handlers: { 'GET /api/me': meHandler({ rows: DESIGN_ROWS, canRows: DESIGN_CAN_ROWS }) } })
    // api.ts reads the clock once (T); any later read sees T + 10, after the grant ended.
    vi.spyOn(Date, 'now').mockReturnValueOnce(T).mockReturnValue(T + 10)
    const res = await call(INHOUSE.origin, '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': token } })
    vi.restoreAllMocks()
    expect(res.status).toBe(200)
    const me = MeSchema.parse(await res.json())
    expect(me.grant).toEqual({ id: 'g_1', endsAt: { iso: new Date(T + 1).toISOString(), ms: T + 1 } })
    expect(me.can.viewMembers).toBe(true)
  })
})

describe('a report row', () => {
  it('reaches its handler from both hosts with no stores in the context', async () => {
    let seen: { stores: AuthStores | undefined; has: boolean } | undefined
    const { call } = setup({ handlers: { 'POST /api/client-error': async c => { seen = { stores: c.stores, has: 'stores' in c && c.stores !== undefined }; return new Response(null, { status: 204 }) } } })
    for (const [who, origin] of [['member', BRAND.origin], ['inhouse', INHOUSE.origin]] as const) {
      seen = undefined
      const res = await call(origin, '/api/client-error', { method: 'POST', body: '{}', headers: { 'Cf-Access-Jwt-Assertion': await as(who), Origin: origin } })
      expect(res.status, who).toBe(204)
      expect(seen).toEqual({ stores: undefined, has: false })
    }
  })
})

describe("a handler's env", () => {
  it('has no D1 or R2 binding, even cast, but keeps the other bindings', async () => {
    let seen: Record<string, unknown> | undefined
    const { call, env } = setup({ handlers: { 'GET /api/me': async c => { seen = c.env as unknown as Record<string, unknown>; return apiJson({}) } } })
    // The env api() was given has both, so the test isn't empty.
    expect(env.DB).toBeTruthy()
    expect(env.FILES).toBeTruthy()
    const res = await call(BRAND.origin, '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': await as('member') } })
    expect(res.status).toBe(200)
    expect(seen?.DB).toBeUndefined()
    expect(seen?.FILES).toBeUndefined()
    expect('DB' in seen!).toBe(false)
    expect(seen?.INHOUSE_ACCESS).toBe(env.INHOUSE_ACCESS)
    expect(Object.keys(seen!).sort()).toEqual(Object.keys(env).filter(k => k !== 'DB' && k !== 'FILES').sort())
    expect(Object.isFrozen(seen)).toBe(true)
  })
})

describe('a WebSocket upgrade', () => {
  it("keeps the handler's 101 and its socket, with the security headers", async () => {
    const handler: Handler = async () => {
      const pair = new WebSocketPair()
      pair[1].accept()
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    const { call } = setup({ handlers: { 'GET /api/me': handler } })
    const res = await call(BRAND.origin, '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': await as('member'), Upgrade: 'websocket', Origin: BRAND.origin } })
    expect(res.status).toBe(101)
    expect(res.webSocket).toBeTruthy()
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('the committed route table (server/routes.ts)', () => {
  const committed = () => {
    const { parts, env } = setup()
    const committedParts: ApiParts = { ...parts, routes, accessMatrix }
    return (origin: string, path: string, init: RequestInit = {}) => api(committedParts, new Request(`${origin}${path}`, init), env, ctx, 'req-1')
  }
  it('answers GET /api/me with a schema-valid Me whose can comes from the committed rows', async () => {
    const res = await committed()(BRAND.origin, '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': await as('admin') } })
    expect(res.status).toBe(200)
    const me = MeSchema.parse(await res.json())
    expect(me).toMatchObject({ memberId: 'm_admin', role: 'admin', can: { invite: true, switchModelOff: true, editTechnical: false } })
  })
  it('answers every route without a handler yet with 503 unavailable, after access (a Member still gets 403 on an admin row)', async () => {
    const call = committed()
    const member = await as('member')
    const admin = await as('admin')
    for (const r of accessMatrix.filter(x => x.pattern !== '/api/me' && x.pattern !== '/api/client-error' && x.class !== 'open')) {
      const res = await call(BRAND.origin, concrete(r.pattern), { method: r.method, headers: { 'Cf-Access-Jwt-Assertion': r.allow.includes('admin') ? admin : member, Origin: BRAND.origin } })
      expect(res.status, `${r.method} ${r.pattern}`).toBe(503)
      expect(await res.json()).toEqual({ error: { code: 'unavailable' } })
    }
    expect((await call(BRAND.origin, '/api/members/invites', { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': member, Origin: BRAND.origin } })).status).toBe(403)
  })
  it('wires POST /api/client-error to the reporter (204, logged as client_error)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await committed()(BRAND.origin, '/api/client-error', { method: 'POST', body: '{"kind":"error"}', headers: { 'Cf-Access-Jwt-Assertion': await as('member'), Origin: BRAND.origin, 'Sec-Fetch-Site': 'same-origin' } })
      expect(res.status).toBe(204)
      expect(error.mock.calls.some(([line]) => (line as { event?: string }).event === 'client_error')).toBe(true)
    } finally {
      vi.restoreAllMocks()
    }
  })
  it('answers GET /api/health for monitor with 503 unavailable: intended, until W2 PR 3 replaces the stub with the health handler', async () => {
    const monitor = await mintService({ key: good.key.privateJwk, iss: TEAM, aud: BRAND.aud, clientId: MONITOR_ID })
    const res = await committed()(BRAND.origin, '/api/health', { headers: { 'Cf-Access-Jwt-Assertion': monitor } })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: { code: 'unavailable' } })
  })
})

describe("row 21's error bodies (reportClientError, p2-design section 4)", () => {
  // The reporter's rate limit is per IP and per isolate, so each case posts from its own address.
  const post = (ip: string, body: string, headers: Record<string, string> = {}) =>
    reportClientError(new Request(`${BRAND.origin}/api/client-error`, { method: 'POST', body, headers: { 'CF-Connecting-IP': ip, ...headers } }))
  const errorOf = async (res: Response) => ({ status: res.status, body: await res.json(), noStore: res.headers.get('Cache-Control') })
  it('400 becomes invalid', async () => {
    expect(await errorOf(await post('192.0.2.1', 'not json'))).toEqual({ status: 400, body: { error: { code: 'invalid' } }, noStore: 'no-store' })
  })
  it('403 becomes forbidden', async () => {
    expect(await errorOf(await post('192.0.2.2', '{}', { 'Sec-Fetch-Site': 'cross-site' }))).toEqual({ status: 403, body: { error: { code: 'forbidden' } }, noStore: 'no-store' })
  })
  it('413 becomes invalid with reason too_large', async () => {
    expect(await errorOf(await post('192.0.2.3', 'x'.repeat(9 * 1024)))).toEqual({ status: 400, body: { error: { code: 'invalid', reason: 'too_large' } }, noStore: 'no-store' })
  })
  it('429 becomes rate_limited and keeps Retry-After', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let res = await post('192.0.2.4', '{}')
      for (let i = 0; i < 20 && res.status !== 429; i++) res = await post('192.0.2.4', '{}')
      expect(res.headers.get('Retry-After')).toBe('60')
      expect(await errorOf(res)).toEqual({ status: 429, body: { error: { code: 'rate_limited' } }, noStore: 'no-store' })
    } finally {
      vi.restoreAllMocks()
    }
  })
  it('any other status passes through (204)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await post('192.0.2.5', '{}')
      expect(res.status).toBe(204)
      expect(await res.text()).toBe('')
    } finally {
      vi.restoreAllMocks()
    }
  })
})
