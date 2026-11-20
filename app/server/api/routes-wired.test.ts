// Routes 1 and 3 to 20 as server/routes.ts wires them, through the whole /api/* path (server/api.ts): W1's real sign-in (a
// local issuer), the committed access rows, W2's stores on the test D1. Ways it can fail, written down first:
//  1. a route still answers the `notYet` stub (503), or another handler than its own;
//  2. a principal the row refuses reaches a store call (a read or a write) before the 403;
//  3. a handler on a row whose rule needs the object (7, 8, 13, 14, and 12 for an Admin) answers 2xx without calling
//     requireObject: api.ts must turn that into 500, so the wiring can't pass with a skipped check;
//  4. such a handler reads or writes a store before its requireObject (harmless while the owner is the caller, but a
//     later owner-from-input change would read another person's data before the refusal);
//  5. an Inhouse principal with a live grant reads brand data without its support.access line, or not at all;
//  6. the photo route's stricter CSP and caching are lost in api.ts's wrap, or another handler can loosen the site's.
import { env as baseEnv } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fc, test } from '@fast-check/vitest'
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
/** A member row's rev, read back: what a photo answer must carry. */
const memberRev = async (id: string) => (await db.prepare('SELECT rev FROM members WHERE id = ?').bind(id).first<number>('rev'))!
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

const parts = (table: readonly Route[] = routes, open: (e: Env) => Stores = e => openStores(e)): ApiParts => ({
  authenticate: (r, e, st, n, id) => authenticate(r, e, st, n, id, good.keys),
  checkOrigin, checkAccess, stores: e => recorded(open(e)), routes: table, accessMatrix,
})
const send = (path: string, init: { method?: string; token: string; body?: unknown; raw?: BodyInit; type?: string; origin?: string; table?: readonly Route[]; open?: (e: Env) => Stores }) => {
  const origin = init.origin ?? BRAND.origin
  const type = init.type ?? (init.body === undefined ? undefined : 'application/json')
  return api(parts(init.table, init.open), new Request(`${origin}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'Cf-Access-Jwt-Assertion': init.token, Origin: origin, ...(type ? { 'Content-Type': type } : {}) },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  }), env, ctx, `req-${++k}`)
}
const call = async (path: string, init: Parameters<typeof send>[1]) => {
  const res = await send(path, init)
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
    ['GET', '/api/audit/export.csv', () => tokens.inhouse, undefined, INHOUSE.origin, 'grant_required'],
    ['POST', '/api/grants/g_x/end', () => tokens.inhouse, { ifRev: 1 }, INHOUSE.origin],
    ['POST', '/api/members/invites', () => tokens.member, { name: 'X Example', email: 'x@example.test', role: 'admin' }],
    ['PUT', '/api/members/m_x/role', () => tokens.member, { role: 'admin', ifRev: 1 }],
    ['DELETE', '/api/members/m_x?ifRev=1', () => tokens.member, undefined],
    ['GET', '/api/settings/personal', () => tokens.inhouse, undefined, INHOUSE.origin],
    ['PUT', '/api/settings/personal/g:theme', () => tokens.inhouse, { value: 'Dark', ifRev: 0 }, INHOUSE.origin],
    ['PUT', '/api/settings/brand/g:tz', () => tokens.member, { value: 'Europe/Paris', ifRev: 0 }],
    ['GET', '/api/settings/technical', () => tokens.smoke, undefined],
    ['PUT', '/api/settings/technical/stage', () => tokens.member, { value: 'Run', ifRev: 0 }],
    ['PUT', '/api/settings/technical/stage', () => tokens.admin, { value: 'Run', ifRev: 0 }, undefined, 'admin_read_only'],
    // An Admin switches a model 'on' or 'off' only: clearing the key (null) is another value, refused.
    ['PUT', '/api/settings/technical/tm:fable:on', () => tokens.admin, { value: null, ifRev: 0 }, undefined, 'admin_read_only'],
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

describe('routes 1 and 13 to 20 run their handlers (failure 1)', () => {
  it('1: health for the monitor', async () => {
    const monitor = await mintService({ key: good.key.privateJwk, iss: TEAM, aud: BRAND.aud, clientId: MONITOR_ID })
    expect(await call('/api/health', { token: monitor })).toMatchObject({ status: 200, body: { ok: true } })
  })
  it('13 to 15: a photo up, served with its own headers through the wrap, and removed (failure 6)', async () => {
    const up = await call('/api/photo', { method: 'PUT', token: tokens.member, raw: PNG, type: 'image/png' })
    expect(up).toEqual({ status: 200, body: { photoUrl: expect.stringMatching(new RegExp(`^/api/members/${who.member}/photo\\?v=[0-9a-f]{32}$`)), rev: await memberRev(who.member) } })
    // The versioned URL goes through the same route, gate and wrap as the bare path.
    const res = await send((up.body as { photoUrl: string }).photoUrl, { token: tokens.admin })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox")
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
    expect(await call('/api/photo', { method: 'DELETE', token: tokens.member })).toEqual({ status: 200, body: { photoUrl: null, rev: await memberRev(who.member) } })
    expect((await call(`/api/members/${who.member}/photo`, { token: tokens.admin })).status).toBe(404)
  })
  it("a handler can't loosen the site's CSP or caching: only the photo's exact values survive the wrap (failure 6)", async () => {
    const loose: Handler = async () => new Response('{}', { headers: { 'Content-Security-Policy': "default-src *", 'Cache-Control': 'public, max-age=600' } })
    const table = routes.map(r => (r.pattern === '/api/members' && r.method === 'GET' ? { ...r, handler: loose } : r))
    const res = await send('/api/members', { token: tokens.member, table })
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
  it('16 to 20: grants listed, made and ended; the audit log read and exported', async () => {
    const made = await call('/api/grants', { method: 'POST', token: tokens.admin, body: { hours: 1 } })
    expect(made).toMatchObject({ status: 201, body: { live: true, rev: 1 } })
    expect((await call('/api/grants', { token: tokens.inhouse, origin: INHOUSE.origin })).body.items).toEqual([expect.objectContaining({ id: made.body.id })])
    expect(await call(`/api/grants/${made.body.id}/end`, { method: 'POST', token: tokens.admin, body: { ifRev: 1 } })).toMatchObject({ status: 200, body: { live: false } })
    const page = await call('/api/audit?limit=2', { token: tokens.member })
    expect(page).toMatchObject({ status: 200, body: { items: [expect.objectContaining({ what: 'ended the Inhouse team’s access' }), expect.objectContaining({ what: 'gave the Inhouse team access' })] } })
    const csv = await send('/api/audit/export.csv', { token: tokens.member })
    expect(csv.status).toBe(200)
    expect(csv.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect((await csv.text()).startsWith('"When","Who","What","Detail"\r\n')).toBe(true)
  })
})

describe('Inhouse under a live grant reads brand data, each read logged first (failure 5)', () => {
  it('routes 19 and 20 through api() on D1: the data served, one support.access line per read; route 3 (baseline) adds none', async () => {
    const made = await call('/api/grants', { method: 'POST', token: tokens.admin, body: { hours: 4 } })
    expect(made.status).toBe(201)
    const before = (await db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM audit_log').first<number>('n'))!
    const list = await call('/api/members', { token: tokens.inhouse, origin: INHOUSE.origin })
    expect(list.status).toBe(200)
    expect((list.body.items as { id: string }[]).map(m => m.id)).toEqual(expect.arrayContaining([who.admin, who.member]))
    expect((await call('/api/audit', { token: tokens.inhouse, origin: INHOUSE.origin })).status).toBe(200)
    expect((await send('/api/audit/export.csv', { token: tokens.inhouse, origin: INHOUSE.origin })).status).toBe(200)
    const lines = (await db.prepare('SELECT actor_id, action, args_json FROM audit_log WHERE id > ? ORDER BY id').bind(before).all<{ actor_id: string; action: string; args_json: string }>()).results
    expect(lines.map(l => [l.actor_id, l.action, JSON.parse(l.args_json)])).toEqual([
      [who.inhouse, 'support.access', { grantId: made.body.id, method: 'GET', route: '/api/audit' }],
      [who.inhouse, 'support.access', { grantId: made.body.id, method: 'GET', route: '/api/audit/export.csv' }],
    ])
    // Ended: the very next audit read is refused; the member list (baseline) still opens.
    await call(`/api/grants/${made.body.id}/end`, { method: 'POST', token: tokens.admin, body: { ifRev: 1 } })
    expect(await call('/api/audit', { token: tokens.inhouse, origin: INHOUSE.origin })).toEqual({ status: 403, body: { error: { code: 'forbidden', reason: 'grant_required' } } })
    expect((await call('/api/members', { token: tokens.inhouse, origin: INHOUSE.origin })).status).toBe(200)
  })
})

describe('the Inhouse team holds every Admin control but the Admin role, each write audited as its own (decisions 19, 19b)', () => {
  const mark = async () => (await db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM audit_log').first<number>('n'))!
  const linesAfter = async (id: number) =>
    (await db.prepare('SELECT actor_id, action, args_json FROM audit_log WHERE id > ? ORDER BY id').bind(id).all<{ actor_id: string; action: string; args_json: string }>()).results
      .map(l => [l.actor_id, l.action, JSON.parse(l.args_json)])
  const asInhouse = (path: string, init: Omit<Parameters<typeof send>[1], 'token' | 'origin'> = {}) => call(path, { ...init, token: tokens.inhouse, origin: INHOUSE.origin })

  it('invites and removes a Member without a grant, and each line names the Inhouse member', async () => {
    const before = await mark()
    const invited = await asInhouse('/api/members/invites', { method: 'POST', body: { name: 'New Example', email: `ih-new-${k}@example.test`, role: 'member' } })
    expect(invited).toMatchObject({ status: 201, body: { status: 'invited', role: 'member' } })
    const id = invited.body.id as string
    expect(await asInhouse(`/api/members/${id}?ifRev=1`, { method: 'DELETE' })).toMatchObject({ status: 200, body: { status: 'removed' } })
    expect(await linesAfter(before)).toEqual([
      [who.inhouse, 'member.invited', { memberId: id, role: 'member' }],
      [who.inhouse, 'member.removed', { memberId: id }],
    ])
    // No grant was live, and none of these is brand data: no support.access line.
  })

  // Decision 19b: the Inhouse team can't create, promote, demote or remove an Admin. Each run makes fresh targets: a
  // Member and an Admin (an invited one, or the brand's active Admin), so every action meets a row it could change.
  type Action = 'invite admin' | 'invite member' | 'promote to admin' | 'demote an admin' | 'remove an admin' | 'remove a member'
  const ACTIONS: Action[] = ['invite admin', 'invite member', 'promote to admin', 'demote an admin', 'remove an admin', 'remove a member']
  const TOUCHES_ADMIN: Action[] = ['invite admin', 'promote to admin', 'demote an admin', 'remove an admin']
  let n = 0
  test.prop([fc.constantFrom(...ACTIONS), fc.boolean()], { numRuns: 24 })(
    'exactly the four Admin-touching actions are refused (403 forbidden, nothing written, no line); the two Member ones pass', async (action, activeAdmin) => {
      const stores = openStores(env)
      const tag = `${k}-${++n}`
      const made = async (role: 'member' | 'admin') => {
        const r = await stores.members.invite({ name: 'Target Example', email: `t-${role}-${tag}@example.test`, role }, at(SYSTEM_MEMBER_ID))
        if (!('ok' in r)) throw new Error('invite')
        return r.ok
      }
      const member = await made('member')
      const admin = activeAdmin ? (await stores.members.get(who.admin))! : await made('admin')
      const target = action.endsWith('admin') && !action.startsWith('invite') ? admin : member
      const revBefore = await memberRev(target.id)
      const before = await mark()
      const res = action.startsWith('invite')
        ? await asInhouse('/api/members/invites', { method: 'POST', body: { name: 'New Example', email: `ih-${tag}@example.test`, role: action === 'invite admin' ? 'admin' : 'member' } })
        : action.startsWith('remove')
          ? await asInhouse(`/api/members/${target.id}?ifRev=${revBefore}`, { method: 'DELETE' })
          : await asInhouse(`/api/members/${target.id}/role`, { method: 'PUT', body: { role: action === 'promote to admin' ? 'admin' : 'member', ifRev: revBefore } })
      const lines = await linesAfter(before)
      if (TOUCHES_ADMIN.includes(action)) {
        expect(res, action).toEqual({ status: 403, body: { error: { code: 'forbidden' } } })
        expect(lines, `${action}: a refusal writes no line`).toEqual([])
        expect(await memberRev(target.id), `${action}: nothing changed`).toBe(revBefore)
        const invitedAdmin = await db.prepare('SELECT COUNT(*) AS n FROM members WHERE email_norm = ?').bind(`ih-${tag}@example.test`).first<number>('n')
        expect(invitedAdmin).toBe(0)
      } else {
        expect(res.status, action).toBe(action === 'invite member' ? 201 : 200)
        expect(lines.map(l => l.slice(0, 2)), action).toEqual([[who.inhouse, action === 'invite member' ? 'member.invited' : 'member.removed']])
      }
    })
  it('edits a brand setting without a grant, audited as the Inhouse member', async () => {
    const before = await mark()
    expect(await asInhouse('/api/settings/brand/g:tz', { method: 'PUT', body: { value: 'Europe/Paris', ifRev: 0 } })).toMatchObject({ status: 200, body: { key: 'g:tz', value: 'Europe/Paris', updatedBy: who.inhouse } })
    const lines = await linesAfter(before)
    expect(lines).toHaveLength(1)
    expect(lines[0].slice(0, 2)).toEqual([who.inhouse, 'setting.changed'])
    expect(lines[0][2]).toMatchObject({ scope: 'brand', key: 'g:tz' })
  })
  it('the role change is refused by the matrix, before any store call; an Admin still invites, promotes, demotes and removes an Admin', async () => {
    const rev = await memberRev(who.admin)
    expect(await asInhouse(`/api/members/${who.admin}/role`, { method: 'PUT', body: { role: 'member', ifRev: rev } })).toEqual({ status: 403, body: { error: { code: 'forbidden' } } })
    expect(handlerCalls()).toEqual([])
    const invited = await call('/api/members/invites', { method: 'POST', token: tokens.admin, body: { name: 'Second Example', email: `adm2-${k}@example.test`, role: 'admin' } })
    expect(invited).toMatchObject({ status: 201, body: { role: 'admin' } })
    const id = invited.body.id as string
    expect(await call(`/api/members/${id}/role`, { method: 'PUT', token: tokens.admin, body: { role: 'member', ifRev: 1 } })).toMatchObject({ status: 200, body: { role: 'member' } })
    expect(await call(`/api/members/${id}/role`, { method: 'PUT', token: tokens.admin, body: { role: 'admin', ifRev: 2 } })).toMatchObject({ status: 200, body: { role: 'admin' } })
    expect(await call(`/api/members/${id}?ifRev=3`, { method: 'DELETE', token: tokens.admin })).toMatchObject({ status: 200, body: { status: 'removed' } })
  })
  it('never grants itself access, and never reads the audit log without a grant', async () => {
    expect(await asInhouse('/api/grants', { method: 'POST', body: { hours: 1 } })).toEqual({ status: 403, body: { error: { code: 'forbidden' } } })
    expect(await asInhouse('/api/audit')).toEqual({ status: 403, body: { error: { code: 'forbidden', reason: 'grant_required' } } })
    expect(handlerCalls()).toEqual([])
  })
})

describe('an Admin turns a model off and back on (decision 27a)', () => {
  it("'off' and 'on' both pass; another key or value is admin_read_only; a Member is refused", async () => {
    const off = await call('/api/settings/technical/tm:fable:on', { method: 'PUT', token: tokens.admin, body: { value: 'off', ifRev: 0 } })
    expect(off).toMatchObject({ status: 200, body: { key: 'tm:fable:on', value: 'off', updatedBy: who.admin } })
    const on = await call('/api/settings/technical/tm:fable:on', { method: 'PUT', token: tokens.admin, body: { value: 'on', ifRev: off.body.rev } })
    expect(on).toMatchObject({ status: 200, body: { key: 'tm:fable:on', value: 'on' } })
    const refused = { status: 403, body: { error: { code: 'forbidden', reason: 'admin_read_only' } } }
    expect(await call('/api/settings/technical/tm:fable:on', { method: 'PUT', token: tokens.admin, body: { value: null, ifRev: on.body.rev } })).toEqual(refused)
    expect(await call('/api/settings/technical/tm:fable:effort', { method: 'PUT', token: tokens.admin, body: { value: 'High', ifRev: 0 } })).toEqual(refused)
    expect(await call('/api/settings/technical/tm:fable:on', { method: 'PUT', token: tokens.member, body: { value: 'off', ifRev: on.body.rev } })).toEqual({ status: 403, body: { error: { code: 'forbidden' } } })
  })
})

describe('refused before any store call: routes 1 and 13 to 20 (failure 2)', () => {
  const cases: [string, string, () => string, unknown, string?][] = [
    ['GET', '/api/health', () => tokens.member, undefined],
    ['GET', '/api/members/m_x/photo', () => tokens.smoke, undefined],
    ['GET', '/api/grants', () => tokens.member, undefined],
    ['POST', '/api/grants', () => tokens.member, { hours: 1 }],
    ['POST', '/api/grants', () => tokens.inhouse, { hours: 1 }, INHOUSE.origin],
    ['POST', '/api/grants/g_x/end', () => tokens.member, { ifRev: 1 }],
    ['GET', '/api/audit', () => tokens.inhouse, undefined, INHOUSE.origin],
    ['GET', '/api/audit/export.csv', () => tokens.smoke, undefined],
  ]
  it.each(cases)('%s %s', async (method, path, tok, body, origin) => {
    const res = await call(path, { method, token: tok(), body, origin })
    expect(res.status).toBe(403)
    expect(handlerCalls()).toEqual([])
  })
  it('PUT and DELETE /api/photo for Inhouse are 403 before any store call', async () => {
    expect((await call('/api/photo', { method: 'PUT', token: tokens.inhouse, origin: INHOUSE.origin, raw: PNG, type: 'image/png' })).status).toBe(403)
    expect((await call('/api/photo', { method: 'DELETE', token: tokens.inhouse, origin: INHOUSE.origin })).status).toBe(403)
    expect(handlerCalls()).toEqual([])
  })
})

describe('object-check rows: requireObject comes before any store call, and skipping it is 500 (failures 3, 4)', () => {
  /** The committed table with one route's requireObject swapped: `refuse` throws, `skip` does nothing. */
  const swapped = (method: string, pattern: string, mode: 'refuse' | 'skip'): Route[] => routes.map(r => {
    if (r.method !== method || r.pattern !== pattern) return r
    const handler: Handler = c => r.handler({ ...c, access: { requireObject: () => { if (mode === 'refuse') throw new Error('refused (test)') } } })
    return { ...r, handler }
  })
  const rows = [
    ['GET', '/api/settings/personal', '/api/settings/personal', 'member', undefined, undefined],
    ['PUT', '/api/settings/personal/:key', '/api/settings/personal/g:theme', 'member', { value: 'Light', ifRev: 0 }, undefined],
    ['PUT', '/api/settings/technical/:key', '/api/settings/technical/tm:opus:on', 'admin', { value: 'off', ifRev: 0 }, undefined],
    ['PUT', '/api/photo', '/api/photo', 'member', undefined, PNG],
    ['DELETE', '/api/photo', '/api/photo', 'member', undefined, undefined],
  ] as const
  it.each(rows)('%s %s: no store call before requireObject', async (method, pattern, path, role, body, raw) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(send(path, { method, token: tokens[role], body, raw, type: raw ? 'image/png' : undefined, table: swapped(method, pattern, 'refuse') })).rejects.toThrow('refused (test)')
      expect(handlerCalls()).toEqual([])
    } finally {
      vi.restoreAllMocks()
    }
  })
  it.each(rows.slice(3))('%s %s: skipping requireObject is 500', async (method, pattern, path, role, body, raw) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await send(path, { method, token: tokens[role], body, raw, type: raw ? 'image/png' : undefined, table: swapped(method, pattern, 'skip') })
      expect(res.status).toBe(500)
      expect(error.mock.calls.some(([l]) => (l as { event?: string }).event === 'object_check_skipped')).toBe(true)
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('a D1 or R2 failure is 503 unavailable; a bug is still 500 (fix round 1, p2-design section 4)', () => {
  /** The test D1 with every statement whose SQL matches `fails` throwing (sign-in's member reads still work). */
  const failingDb = (fails: RegExp): D1Database => new Proxy(env.DB, {
    get(t, prop) {
      if (prop === 'prepare') return (sql: string) => { if (fails.test(sql)) throw new Error('D1_ERROR: storage is down'); return t.prepare(sql) }
      if (prop === 'batch') return (stmts: D1PreparedStatement[]) => t.batch(stmts)
      const v = Reflect.get(t, prop, t)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
  const failingR2 = { ...env.FILES, put: async () => { throw new Error('R2 down') }, get: env.FILES.get.bind(env.FILES), delete: env.FILES.delete.bind(env.FILES) } as unknown as R2Bucket
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})
  it.each([
    ['a read route', 'GET', '/api/settings/brand', 'member', undefined, /FROM settings/],
    ['a write route', 'PUT', '/api/settings/brand/g:tz', 'admin', { value: 'Europe/Paris', ifRev: 0 }, /settings/],
    ['the export, first page', 'GET', '/api/audit/export.csv', 'member', undefined, /FROM audit_log a/],
    ['the members list', 'GET', '/api/members', 'member', undefined, /id > \?/],
  ] as const)('%s: 503 unavailable, logged by name', async (_name, method, path, role, body, fails) => {
    const error = quiet()
    try {
      const res = await call(path, { method, token: tokens[role], body, open: e => openStores({ ...e, DB: failingDb(fails) }) })
      expect(res).toEqual({ status: 503, body: { error: { code: 'unavailable' } } })
      expect(error.mock.calls.some(([l]) => (l as { event?: string; error?: string }).event === 'store_unavailable' && (l as { error?: string }).error === 'StoreUnavailableError')).toBe(true)
    } finally {
      vi.restoreAllMocks()
    }
  })
  it('a throwing R2 put on PUT /api/photo: 503 unavailable, nothing written', async () => {
    quiet()
    try {
      const before = await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first<number>('n')
      const res = await call('/api/photo', { method: 'PUT', token: tokens.member, raw: PNG, type: 'image/png', open: e => openStores({ ...e, FILES: failingR2 }) })
      expect(res).toEqual({ status: 503, body: { error: { code: 'unavailable' } } })
      expect(await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first<number>('n')).toBe(before)
    } finally {
      vi.restoreAllMocks()
    }
  })
  it('a TypeError in a handler is not 503: api() rethrows it (server/index.ts answers 500 unknown)', async () => {
    const bug: Handler = async () => { throw new TypeError('a bug') }
    const table = routes.map(r => (r.pattern === '/api/members' && r.method === 'GET' ? { ...r, handler: bug } : r))
    await expect(send('/api/members', { token: tokens.member, table })).rejects.toThrow(TypeError)
  })
})
