// The /api/* path (server/api.ts) with W1's real sign-in and access parts, a local key set and in-memory stores:
// an invalid config is 503 on every route, OPTIONS is 405, the audit duty and the object check are enforced from the
// decision, `me` answers a schema-valid Me, and a handler's WebSocket 101 keeps its socket through withSecurityHeaders.
import { env as baseEnv } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import type { Handler, Route } from '../routes.ts'
import { apiJson } from '../http.ts'
import { authenticate, checkAccess, checkOrigin } from './index.ts'
import { mintPerson, mintService } from './test-issuer-mint.ts'
import { buildMe, meHandler } from './me-handler.ts'
import { MeSchema } from '../../shared/contract/me.ts'
import { BRAND, DESIGN_CAN_ROWS, DESIGN_ROWS, INHOUSE, MONITOR_ID, SMOKE_ID, TEAM, authEnv, fakeStores, issuer } from '../testing/auth-fixtures.ts'
import type { Issuer } from '../testing/auth-fixtures.ts'

let good: Issuer
beforeAll(async () => { good = await issuer() })
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
const ok: Handler = async () => apiJson({ ok: true })
const routeTable = (handlers: Partial<Record<string, Handler>> = {}): Route[] =>
  DESIGN_ROWS.map(r => ({ method: r.method, pattern: r.pattern, handler: handlers[`${r.method} ${r.pattern}`] ?? ok }))

function setup(o: { access?: unknown; stores?: ReturnType<typeof fakeStores>; handlers?: Partial<Record<string, Handler>> } = {}) {
  const s = o.stores ?? fakeStores({ people: { admin: { role: 'admin' }, member: { role: 'member' } }, grant: { id: 'g_1', endsAtMs: Date.now() + 3_600_000 } })
  const parts: ApiParts = {
    authenticate: (r, e, st, n, id) => authenticate(r, e, st, n, id, good.keys),
    checkOrigin, checkAccess,
    stores: () => s.stores,
    routes: routeTable(o.handlers),
    accessMatrix: DESIGN_ROWS,
  }
  const env = { ...baseEnv, ...authEnv(o.access) } as Env
  const call = (origin: string, path: string, init: RequestInit = {}) => api(parts, new Request(`${origin}${path}`, init), env, ctx, 'req-1')
  return { call, calls: s.calls }
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
    const handler = meHandler({ stores: () => s.stores, rows: DESIGN_ROWS, canRows: DESIGN_CAN_ROWS })
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
