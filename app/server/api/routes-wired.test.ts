// Routes 3 to 12 as server/routes.ts wires them, through the whole /api/* path (server/api.ts): W1's real sign-in (a
// local issuer), the committed access rows, W2's stores on the test D1. Ways it can fail, written down first:
//  1. a route still answers the `notYet` stub (503), or another handler than its own;
//  2. a principal the row refuses reaches a store call (a read or a write) before the 403;
//  3. a handler on a row whose rule needs the object (7, 8, and 12 for an Admin) answers 2xx without calling
//     requireObject: api.ts must turn that into 500, so the wiring can't pass with a skipped check.
import { env as baseEnv } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import { accessMatrix } from '../access-matrix.ts'
import { authenticate, checkAccess, checkOrigin } from '../auth/index.ts'
import { mintPerson, mintService } from '../auth/test-issuer-mint.ts'
import { routes } from '../routes.ts'
import type { Handler, Route } from '../routes.ts'
import { BRAND, INHOUSE, MONITOR_ID, SMOKE_ID, TEAM, authEnv, issuer } from '../testing/auth-fixtures.ts'
import type { Issuer } from '../testing/auth-fixtures.ts'
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import { openStores } from '../db/stores.ts'
import type { Stores } from '../db/stores.ts'
import { at, reset } from '../db/test-support.ts'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
const env = { ...baseEnv, ...authEnv() } as Env
const db = env.DB
/** What sign-in itself calls; anything else is a handler's store call. */
const AUTH_CALLS = new Set(['resolvePerson', 'resolveInhouse', 'serviceMember', 'active', 'supportAccess'])

let good: Issuer
let calls: string[] = []
let k = 0
let who: { admin: string; member: string; inhouse: string }

/** W2's stores with every method call recorded by name. */
function recorded(s: Stores): Stores {
  const wrap = <T extends object>(o: T): T => new Proxy(o, {
    get(t, prop, r) {
      const v = Reflect.get(t, prop, r)
      if (typeof v === 'function') return (...a: unknown[]) => { calls.push(String(prop)); return (v as (...x: unknown[]) => unknown).apply(t, a) }
      return v !== null && typeof v === 'object' ? wrap(v) : v
    },
  })
  return wrap(s)
}

const parts = (table: readonly Route[] = routes): ApiParts => ({
  authenticate: (r, e, st, n, id) => authenticate(r, e, st, n, id, good.keys),
  checkOrigin, checkAccess, stores: e => recorded(openStores(e)), routes: table, accessMatrix,
})
const call = async (path: string, init: { method?: string; token: string; body?: unknown; origin?: string; table?: readonly Route[] }) => {
  const origin = init.origin ?? BRAND.origin
  const res = await api(parts(init.table), new Request(`${origin}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'Cf-Access-Jwt-Assertion': init.token, Origin: origin, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }), env, ctx, `req-${++k}`)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const token = (role: 'admin' | 'member' | 'inhouse') =>
  mintPerson({ key: good.key.privateJwk, iss: TEAM, aud: role === 'inhouse' ? INHOUSE.aud : BRAND.aud, sub: `${role}-${k}`, email: `${role}-${k}@example.test` })
const handlerCalls = () => calls.filter(c => !AUTH_CALLS.has(c))

let tokens: { admin: string; member: string; inhouse: string; smoke: string }

beforeAll(async () => { good = await issuer() })
beforeEach(async () => {
  await reset(db)
  k++
  const stores = openStores(env)
  for (const role of ['admin', 'member'] as const) {
    const r = await stores.members.invite({ name: 'Wren Example', email: `${role}-${k}@example.test`, role }, at(SYSTEM_MEMBER_ID))
    if (!('ok' in r)) throw new Error('invite')
  }
  tokens = {
    admin: await token('admin'), member: await token('member'), inhouse: await token('inhouse'),
    smoke: await mintService({ key: good.key.privateJwk, iss: TEAM, aud: BRAND.aud, clientId: SMOKE_ID }),
  }
  // First requests bind the invites and make the Inhouse row.
  const ids = await Promise.all((['admin', 'member'] as const).map(async r => (await stores.members.resolvePerson({ subject: `${r}-${k}`, email: `${r}-${k}@example.test`, requestId: 'r', nowMs: Date.now() })) as { ok: { memberId: string } }))
  const ih = await stores.members.resolveInhouse({ subject: `inhouse-${k}`, email: `inhouse-${k}@example.test`, requestId: 'r', nowMs: Date.now() })
  who = { admin: ids[0].ok.memberId, member: ids[1].ok.memberId, inhouse: ih.memberId }
  calls = []
})

describe('each wired route runs its handler (failure 1)', () => {
  it('3 to 6: list, invite, role change, removal', async () => {
    const list = await call('/api/members', { token: tokens.member })
    expect(list.status).toBe(200)
    expect((list.body.items as { id: string }[]).map(m => m.id)).toEqual(expect.arrayContaining([who.admin, who.member]))
    const invited = await call('/api/members/invites', { method: 'POST', token: tokens.admin, body: { name: 'New Example', email: `new-${k}@example.test`, role: 'member' } })
    expect(invited).toMatchObject({ status: 201, body: { status: 'invited' } })
    const id = invited.body.id as string
    expect(await call(`/api/members/${id}/role`, { method: 'PUT', token: tokens.admin, body: { role: 'admin', ifRev: 1 } })).toMatchObject({ status: 200, body: { role: 'admin', rev: 2 } })
    expect(await call(`/api/members/${id}?ifRev=2`, { method: 'DELETE', token: tokens.admin })).toMatchObject({ status: 200, body: { status: 'removed' } })
  })
  it('7 to 12: each scope read and written', async () => {
    expect(await call('/api/settings/personal/g:theme', { method: 'PUT', token: tokens.member, body: { value: 'Dark', ifRev: 0 } })).toMatchObject({ status: 200, body: { key: 'g:theme', value: 'Dark', updatedBy: who.member } })
    expect((await call('/api/settings/personal', { token: tokens.member })).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'g:theme', value: 'Dark' })]))
    expect((await call('/api/settings/personal', { token: tokens.smoke })).status).toBe(200)
    expect(await call('/api/settings/brand/g:tz', { method: 'PUT', token: tokens.admin, body: { value: 'Europe/Paris', ifRev: 0 } })).toMatchObject({ status: 200 })
    expect((await call('/api/settings/brand', { token: tokens.smoke })).body.items).toEqual([expect.objectContaining({ key: 'g:tz', value: 'Europe/Paris' })])
    expect(await call('/api/settings/technical/stage', { method: 'PUT', token: tokens.inhouse, origin: INHOUSE.origin, body: { value: 'Act', ifRev: 0 } })).toMatchObject({ status: 200, body: { updatedBy: who.inhouse } })
    expect(await call('/api/settings/technical/tm:fable:on', { method: 'PUT', token: tokens.admin, body: { value: 'off', ifRev: 0 } })).toMatchObject({ status: 200 })
    expect((await call('/api/settings/technical', { token: tokens.member })).body.items).toEqual([
      expect.objectContaining({ key: 'stage', value: 'Act' }), expect.objectContaining({ key: 'tm:fable:on', value: 'off' }),
    ])
  })
})

describe('a refused principal gets the access error before any store call (failure 2)', () => {
  const cases: [string, string, () => string, unknown, string?, string?][] = [
    ['GET', '/api/members', () => tokens.inhouse, undefined, INHOUSE.origin, 'grant_required'],
    ['POST', '/api/members/invites', () => tokens.member, { name: 'X Example', email: 'x@example.test', role: 'admin' }],
    ['PUT', '/api/members/m_x/role', () => tokens.member, { role: 'admin', ifRev: 1 }],
    ['DELETE', '/api/members/m_x?ifRev=1', () => tokens.member, undefined],
    ['GET', '/api/settings/personal', () => tokens.inhouse, undefined, INHOUSE.origin],
    ['PUT', '/api/settings/personal/g:theme', () => tokens.inhouse, { value: 'Dark', ifRev: 0 }, INHOUSE.origin],
    ['PUT', '/api/settings/brand/g:tz', () => tokens.member, { value: 'Europe/Paris', ifRev: 0 }],
    ['GET', '/api/settings/technical', () => tokens.smoke, undefined],
    ['PUT', '/api/settings/technical/stage', () => tokens.member, { value: 'Run', ifRev: 0 }],
    ['PUT', '/api/settings/technical/stage', () => tokens.admin, { value: 'Run', ifRev: 0 }, undefined, 'admin_read_only'],
    ['PUT', '/api/settings/technical/tm:fable:on', () => tokens.admin, { value: 'on', ifRev: 0 }, undefined, 'admin_read_only'],
  ]
  it.each(cases)('%s %s', async (method, path, tok, body, origin, reason) => {
    const before = await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first<number>('n')
    const res = await call(path, { method, token: tok(), body, origin })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: { code: 'forbidden', ...(reason ? { reason } : {}) } })
    expect(handlerCalls()).toEqual([])
    expect(await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first<number>('n')).toBe(before)
  })
  it('GET /api/settings/brand for the monitor (open rows only) is 403 before any store call', async () => {
    const monitor = await mintService({ key: good.key.privateJwk, iss: TEAM, aud: BRAND.aud, clientId: MONITOR_ID })
    expect((await call('/api/settings/brand', { token: monitor })).status).toBe(403)
    expect(handlerCalls()).toEqual([])
  })
})

describe('an object-check row that skips requireObject is 500, never a 2xx (failure 3)', () => {
  /** The committed table with one route's handler given a requireObject that does nothing (the mutation). */
  const skipping = (method: string, pattern: string): Route[] => routes.map(r => {
    if (r.method !== method || r.pattern !== pattern) return r
    const handler: Handler = c => r.handler({ ...c, access: { requireObject: () => {} } })
    return { ...r, handler }
  })
  it.each([
    ['GET', '/api/settings/personal', '/api/settings/personal', 'member', undefined],
    ['PUT', '/api/settings/personal/:key', '/api/settings/personal/g:theme', 'member', { value: 'Light', ifRev: 0 }],
    ['PUT', '/api/settings/technical/:key', '/api/settings/technical/tm:opus:on', 'admin', { value: 'off', ifRev: 0 }],
  ] as const)('%s %s', async (method, pattern, path, role, body) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await call(path, { method, token: tokens[role], body })).status).toBe(200)
      const mutated = await call(path, { method, token: tokens[role], body: body && { ...body, ifRev: 1 }, table: skipping(method, pattern) })
      expect(mutated).toEqual({ status: 500, body: { error: { code: 'unknown' } } })
      expect(error.mock.calls.some(([l]) => (l as { event?: string }).event === 'object_check_skipped')).toBe(true)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
