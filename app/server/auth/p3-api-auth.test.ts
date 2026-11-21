// P3's auth changes through the whole /api/* path (server/api.ts) with the real sign-in, a local key set and in-memory
// stores (p3-design section 3). Ways it can fail, written down first:
//  1. a `release` token reaches a route other than drain and warm-up, or a write without the brand `Origin`;
//  2. `release` signs in on the Inhouse host;
//  3. `smoke` writes or reads a chat that isn't its own;
//  4. on an `ownerObject` row, another member's chat answers anything but 404 when the handler prefilters by owner, or
//     a handler that skips `requireObject` answers 2xx (must be 500), or one that passes another owner answers 2xx (403);
//  5. Inhouse under a live grant can't read an `ownerObject` row without naming an owner, or reads it without a grant;
//  6. a P3 route stub answers anything but 503 `not_built` to a caller the matrix lets through.
// Expected rows and statuses are literals here, never read from the matrix.
import { env as baseEnv } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import type { Handler, Route } from '../routes.ts'
import { routes } from '../routes.ts'
import { accessMatrix } from '../access-matrix.ts'
import { apiError, apiJson } from '../http.ts'
import { authenticate, checkAccess, checkOrigin } from './index.ts'
import { mintPerson, mintService } from './test-issuer-mint.ts'
import { BRAND, DESIGN_ROWS, INHOUSE, RELEASE_ID, SMOKE_ID, SMOKE_MEMBER, TEAM, authEnv, fakeStores, issuer } from '../testing/auth-fixtures.ts'
import type { Issuer } from '../testing/auth-fixtures.ts'

let good: Issuer
beforeAll(async () => { good = await issuer() })
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
const ok: Handler = async () => apiJson({ ok: true })

/** Who owns which chat in these tests (the handler's "store"). */
const CHAT_OWNER: Record<string, string> = { c_member: 'm_member', c_admin: 'm_admin', c_smoke: SMOKE_MEMBER }

/** A handler written the way p3-design section 3 asks: prefilter by owner (404), then `requireObject` with the owner found. */
const prefiltered: Handler = async ({ params, principal, access }) => {
  const owner = CHAT_OWNER[params.id]
  const self = 'memberId' in principal ? principal.memberId : null
  if (owner === undefined || (principal.kind !== 'inhouse' && owner !== self)) return apiError('not_found')
  access.requireObject({ ownerId: owner })
  return apiJson({ id: params.id })
}

function setup(o: { table?: readonly Route[]; rows?: typeof DESIGN_ROWS; handlers?: Partial<Record<string, Handler>>; grant?: boolean } = {}) {
  const s = fakeStores({ people: { member: { role: 'member' }, admin: { role: 'admin' } }, grant: o.grant ? { id: 'g_1', endsAtMs: Date.now() + 3_600_000 } : null })
  const rows = o.rows ?? DESIGN_ROWS
  const table = o.table ?? rows.map(r => ({ method: r.method, pattern: r.pattern, handler: o.handlers?.[`${r.method} ${r.pattern}`] ?? ok }))
  const parts: ApiParts = {
    authenticate: (r, e, st, n, id) => authenticate(r, e, st, n, id, good.keys),
    checkOrigin, checkAccess, stores: () => s.stores, routes: table, accessMatrix: rows,
  }
  const env = { ...baseEnv, ...authEnv() } as Env
  const call = (origin: string, path: string, init: RequestInit = {}) => api(parts, new Request(`${origin}${path}`, init), env, ctx, 'req-1')
  return { call, calls: s.calls }
}
const person = (who: 'admin' | 'member' | 'inhouse') =>
  mintPerson({ key: good.key.privateJwk, iss: TEAM, aud: who === 'inhouse' ? INHOUSE.aud : BRAND.aud, sub: who, email: `${who}@example.test` })
const service = (clientId: string, aud: string = BRAND.aud) => mintService({ key: good.key.privateJwk, iss: TEAM, aud, clientId })
const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}
const bodyOf = async (r: Response) => JSON.parse(await r.text())

describe('the release token (failures 1 and 2)', () => {
  it('reaches drain and warm-up, POST only with the brand Origin, GET without one', async () => {
    quiet()
    const { call } = setup()
    const token = await service(RELEASE_ID)
    const h = { 'Cf-Access-Jwt-Assertion': token }
    expect((await call(BRAND.origin, '/api/ops/drain', { method: 'POST', headers: { ...h, Origin: BRAND.origin } })).status).toBe(200)
    expect((await call(BRAND.origin, '/api/ops/warmup', { method: 'POST', headers: { ...h, Origin: BRAND.origin } })).status).toBe(200)
    expect((await call(BRAND.origin, '/api/ops/drain', { headers: h })).status).toBe(200)
    for (const origin of [undefined, INHOUSE.origin, 'https://evil.example.test', `${BRAND.origin}/`]) {
      const res = await call(BRAND.origin, '/api/ops/drain', { method: 'POST', headers: origin === undefined ? h : { ...h, Origin: origin } })
      expect(res.status, String(origin)).toBe(403)
      expect(await bodyOf(res)).toEqual({ error: { code: 'forbidden', reason: 'bad_origin' } })
    }
    const cross = await call(BRAND.origin, '/api/ops/warmup', { method: 'POST', headers: { ...h, Origin: BRAND.origin, 'Sec-Fetch-Site': 'cross-site' } })
    expect(cross.status).toBe(403)
    vi.restoreAllMocks()
  })

  it('gets 403 on every other route, its writes with the brand Origin included', async () => {
    quiet()
    const { call } = setup()
    const h = { 'Cf-Access-Jwt-Assertion': await service(RELEASE_ID), Origin: BRAND.origin }
    // DELETE drain is the test build's undrain: the matrix lets the release token through, and its handler answers 404
    // outside the test build (this harness's handlers are all `ok`, so it reads 200 here like the others).
    const allowed = ['POST /api/ops/drain', 'GET /api/ops/drain', 'DELETE /api/ops/drain', 'POST /api/ops/warmup']
    for (const r of DESIGN_ROWS) {
      const res = await call(BRAND.origin, r.pattern.replace(/:[A-Za-z]+/g, 'x1'), { method: r.method, headers: h })
      expect(res.status, `${r.method} ${r.pattern}`).toBe(allowed.includes(`${r.method} ${r.pattern}`) ? 200 : 403)
    }
    vi.restoreAllMocks()
  })

  it('is refused on the Inhouse host (401) before any route', async () => {
    quiet()
    const { call } = setup()
    const res = await call(INHOUSE.origin, '/api/ops/drain', { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': await service(RELEASE_ID, INHOUSE.aud), Origin: INHOUSE.origin } })
    expect(res.status).toBe(401)
    vi.restoreAllMocks()
  })
})

describe('smoke on its own chat (failure 3)', () => {
  it('reads and sends into its own chat; another member\'s chat is 404; it never renames, deletes or pauses', async () => {
    quiet()
    const { call } = setup({ handlers: { 'GET /api/chats/:id': prefiltered, 'POST /api/chats/:id/turns': prefiltered } })
    const h = { 'Cf-Access-Jwt-Assertion': await service(SMOKE_ID), Origin: BRAND.origin }
    expect((await call(BRAND.origin, '/api/chats/c_smoke', { headers: h })).status).toBe(200)
    expect((await call(BRAND.origin, '/api/chats/c_smoke/turns', { method: 'POST', headers: h })).status).toBe(200)
    expect((await call(BRAND.origin, '/api/chats/c_member', { headers: h })).status).toBe(404)
    expect((await call(BRAND.origin, '/api/chats/c_member/turns', { method: 'POST', headers: h })).status).toBe(404)
    for (const [method, path] of [['PUT', '/api/chats/c_smoke/title'], ['POST', '/api/chats/delete'], ['POST', '/api/pause'], ['POST', '/api/turns/t_1/stop'], ['GET', '/api/traces/c_smoke']]) {
      expect((await call(BRAND.origin, path, { method, headers: h })).status, `${method} ${path}`).toBe(403)
    }
    vi.restoreAllMocks()
  })

  it('a turns handler that passes another owner to requireObject answers 403, never 2xx', async () => {
    quiet()
    const aimed: Handler = async ({ access }) => {
      access.requireObject({ ownerId: 'm_member' })
      return apiJson({ ok: true })
    }
    const { call } = setup({ handlers: { 'POST /api/chats/:id/turns': aimed } })
    const res = await call(BRAND.origin, '/api/chats/c_member/turns', { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': await service(SMOKE_ID), Origin: BRAND.origin } })
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: { code: 'forbidden', reason: 'not_owner' } })
    vi.restoreAllMocks()
  })
})

describe('ownerObject rows (failures 4 and 5)', () => {
  it('another member\'s chat is 404 for a Member and an Admin alike; their own is 200', async () => {
    quiet()
    const { call } = setup({ handlers: { 'GET /api/chats/:id': prefiltered } })
    const member = { 'Cf-Access-Jwt-Assertion': await person('member') }
    const admin = { 'Cf-Access-Jwt-Assertion': await person('admin') }
    expect((await call(BRAND.origin, '/api/chats/c_member', { headers: member })).status).toBe(200)
    expect((await call(BRAND.origin, '/api/chats/c_admin', { headers: member })).status).toBe(404)
    expect((await call(BRAND.origin, '/api/chats/c_member', { headers: admin })).status).toBe(404)
    expect((await call(BRAND.origin, '/api/chats/c_admin', { headers: admin })).status).toBe(200)
    vi.restoreAllMocks()
  })

  it('a handler that skips requireObject answers 500, and one that names another owner 403, on every ownerObject row', async () => {
    quiet()
    const ownerRows = ['/api/chats', '/api/chats/:id', '/api/runs/active', '/api/traces/:id', '/api/socket', '/api/chats/:id/files']
    const skipped: Handler = async () => apiJson({ leaked: true })
    const other: Handler = async ({ access }) => {
      access.requireObject({ ownerId: 'm_admin' })
      return apiJson({ leaked: true })
    }
    const member = { 'Cf-Access-Jwt-Assertion': await person('member') }
    for (const [handler, status] of [[skipped, 500], [other, 403]] as const) {
      const { call } = setup({ handlers: Object.fromEntries(ownerRows.map(p => [`GET ${p}`, handler])) })
      for (const p of ownerRows) expect((await call(BRAND.origin, p.replace(/:[A-Za-z]+/g, 'c_admin'), { headers: member })).status, p).toBe(status)
    }
    vi.restoreAllMocks()
  })

  it('Inhouse under a live grant reads any member\'s chat with its support.access line; without a grant never', async () => {
    quiet()
    const live = setup({ grant: true, handlers: { 'GET /api/chats/:id': prefiltered } })
    const h = { 'Cf-Access-Jwt-Assertion': await person('inhouse') }
    expect((await live.call(INHOUSE.origin, '/api/chats/c_member', { headers: h })).status).toBe(200)
    expect(live.calls.supportAccess).toEqual([expect.objectContaining({ method: 'GET', route: '/api/chats/:id' })])
    const none = setup({ grant: false, handlers: { 'GET /api/chats/:id': prefiltered } })
    const res = await none.call(INHOUSE.origin, '/api/chats/c_member', { headers: h })
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: { code: 'forbidden', reason: 'grant_required' } })
    vi.restoreAllMocks()
  })
})

describe('the committed P3 routes are PR0 stubs (failure 6)', () => {
  it('every route 22 to 49 not yet built answers 503 not_built to a caller the matrix lets through (W1 PR 2 built 29-33, 35-37, 49; W1 PR 4 built 34; W2 built 46-48; W3 built 38-41)', async () => {
    quiet()
    const { call } = setup({ table: routes, rows: accessMatrix })
    const member = { 'Cf-Access-Jwt-Assertion': await person('member'), Origin: BRAND.origin }
    const P3 = [
      ['GET', '/api/chats', member], ['POST', '/api/chats', member], ['GET', '/api/chats/c1', member], ['PUT', '/api/chats/c1/title', member],
      ['PUT', '/api/chats/c1/pin', member], ['POST', '/api/chats/delete', member], ['POST', '/api/chats/restore', member],
    ] as const
    // Built and so off this list: 38-41 (W3), 42 (W4 PR 1), 43-45 (W6), 29-33, 35-37 and 49 (W1 PR 2,
    // server/api/runs.test.ts), 46-48 (W2 built routes 46-48: server/ops/drain.test.ts) and 34 (W1 PR 4,
    // server/api/socket.test.ts).
    expect(P3).toHaveLength(7)
    for (const [method, path, headers] of P3) {
      const res = await call(BRAND.origin, path, { method, headers })
      expect(res.status, `${method} ${path}`).toBe(503)
      expect(await bodyOf(res), `${method} ${path}`).toEqual({ error: { code: 'unavailable', reason: 'not_built' } })
    }
    vi.restoreAllMocks()
  })
})
