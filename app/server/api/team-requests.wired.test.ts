// Routes 80 to 83 through the whole /api/* path (real sign-in, the committed matrix, the owner rule). Ways it can fail,
// written first: a role the matrix should refuse reaches a handler (an Admin declining, a Member setting done, the
// Inhouse team withdrawing or creating); the withdraw handler skips the owner rule (api.ts turns that into 500) or lets
// another person's request go; an unknown id answers anything but 404 where the matrix lets the caller in.
import { env as baseEnv } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import { accessMatrix } from '../access-matrix.ts'
import { authenticate, checkAccess, checkOrigin } from '../auth/index.ts'
import { mintPerson } from '../auth/test-issuer-mint.ts'
import { routes } from '../routes.ts'
import { BRAND, INHOUSE, TEAM, authEnv, issuer } from '../testing/auth-fixtures.ts'
import type { Issuer } from '../testing/auth-fixtures.ts'
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import { openStores } from '../db/stores.ts'
import { at, reset } from '../db/test-support.ts'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
const env = { ...baseEnv, ...authEnv() } as Env
const db = env.DB
let good: Issuer
let k = 0
let tokens: { admin: string; member: string; other: string; inhouse: string }
let who: { member: string }
const MISSING = 'tr_AAAAAAAAAAAAAAAAAAAAAA'

const parts = (): ApiParts => ({
  authenticate: (r, e, st, n, id) => authenticate(r, e, st, n, id, good.keys),
  checkOrigin, checkAccess, stores: e => openStores(e), routes, accessMatrix,
})
const call = async (path: string, method: string, token: string, body?: unknown, inhouse = false) => {
  const origin = inhouse ? INHOUSE.origin : BRAND.origin
  const res = await api(parts(), new Request(`${origin}${path}`, {
    method,
    headers: { 'Cf-Access-Jwt-Assertion': token, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx, `req-w3-${++k}`)
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}
const mint = (role: string, aud: string) => mintPerson({ key: good.key.privateJwk, iss: TEAM, aud, sub: `${role}-${k}`, email: `${role}-${k}@example.test` })

beforeAll(async () => { good = await issuer() })
beforeEach(async () => {
  await reset(db)
  await db.prepare('DELETE FROM team_requests').run()
  k++
  const stores = openStores(env)
  for (const role of ['admin', 'member', 'other'] as const) {
    const r = await stores.members.invite({ name: 'Wren Example', email: `${role}-${k}@example.test`, role: role === 'admin' ? 'admin' : 'member' }, at(SYSTEM_MEMBER_ID))
    if (!('ok' in r)) throw new Error('invite')
  }
  tokens = { admin: await mint('admin', BRAND.aud), member: await mint('member', BRAND.aud), other: await mint('other', BRAND.aud), inhouse: await mint('inhouse', INHOUSE.aud) }
  const ids = await Promise.all((['admin', 'member', 'other'] as const).map(async r => (await stores.members.resolvePerson({ subject: `${r}-${k}`, email: `${r}-${k}@example.test`, requestId: 'r', nowMs: Date.now() })) as { ok: { memberId: string } }))
  await stores.members.resolveInhouse({ subject: `inhouse-${k}`, email: `inhouse-${k}@example.test`, requestId: 'r', nowMs: Date.now() })
  who = { member: ids[1]!.ok.memberId }
})

/** A request the Member made, over the route. */
const filed = async () => (await call('/api/team-requests', 'POST', tokens.member, { kind: 'tool', subject: `s${k}`, text: 'Connect a thing' })).body

describe('the role rules on the real path', () => {
  it('create: Member and Admin 201; the Inhouse team 403', async () => {
    expect((await call('/api/team-requests', 'POST', tokens.member, { kind: 'job', text: 'x' })).status).toBe(201)
    expect((await call('/api/team-requests', 'POST', tokens.admin, { kind: 'job', text: 'y' })).status).toBe(201)
    expect((await call('/api/team-requests', 'POST', tokens.inhouse, { kind: 'job', text: 'z' }, true)).status).toBe(403)
  })
  it('82: an Admin cannot decline and a Member cannot set done (403, unchanged); the Inhouse team can', async () => {
    const r = await filed()
    expect((await call(`/api/team-requests/${r.id}/status`, 'PUT', tokens.admin, { status: 'declined', ifRev: 1 })).status).toBe(403)
    expect((await call(`/api/team-requests/${r.id}/status`, 'PUT', tokens.member, { status: 'done', ifRev: 1 })).status).toBe(403)
    expect((await db.prepare('SELECT status FROM team_requests WHERE id = ?').bind(r.id).first<string>('status'))).toBe('open')
    const ok = await call(`/api/team-requests/${r.id}/status`, 'PUT', tokens.inhouse, { status: 'done', ifRev: 1 }, true)
    expect([ok.status, ok.body.status, 'requestedBy' in ok.body]).toEqual([200, 'done', false])
  })
  it('83: the Inhouse team cannot withdraw (403); another Member is refused not_owner; the owner withdraws (200, so the owner rule ran)', async () => {
    const r = await filed()
    expect((await call(`/api/team-requests/${r.id}/withdrawn`, 'PUT', tokens.inhouse, { ifRev: 1 }, true)).status).toBe(403)
    const other = await call(`/api/team-requests/${r.id}/withdrawn`, 'PUT', tokens.other, { ifRev: 1 })
    expect([other.status, other.body.error?.reason]).toEqual([403, 'not_owner'])
    expect((await call(`/api/team-requests/${r.id}/withdrawn`, 'PUT', tokens.admin, { ifRev: 1 })).status).toBe(403)
    const mine = await call(`/api/team-requests/${r.id}/withdrawn`, 'PUT', tokens.member, { ifRev: 1 })
    expect([mine.status, mine.body.status, mine.body.requestedBy]).toEqual([200, 'withdrawn', who.member])
  })
  it('an unknown id is 404 where the matrix lets the caller in, and the matrix still answers first for the rest', async () => {
    expect((await call(`/api/team-requests/${MISSING}/withdrawn`, 'PUT', tokens.member, { ifRev: 1 })).status).toBe(404)
    expect((await call(`/api/team-requests/${MISSING}/status`, 'PUT', tokens.inhouse, { status: 'done', ifRev: 1 }, true)).status).toBe(404)
    expect((await call(`/api/team-requests/${MISSING}/status`, 'PUT', tokens.member, { status: 'done', ifRev: 1 })).status).toBe(403)
    expect((await call(`/api/team-requests/${MISSING}/withdrawn`, 'PUT', tokens.inhouse, { ifRev: 1 }, true)).status).toBe(403)
  })
  it('80: the window lists open and closed with no member ids for the Inhouse team; the requester sees `mine`', async () => {
    const r = await filed()
    expect((await call(`/api/team-requests/${r.id}/status`, 'PUT', tokens.inhouse, { status: 'done', ifRev: 1 }, true)).status).toBe(200)
    const open = await filed()
    const path = '/api/team-requests?view=window'
    const ih = await call(path, 'GET', tokens.inhouse, undefined, true)
    expect(ih.status).toBe(200)
    expect(JSON.stringify(ih.body)).not.toContain(who.member)
    expect(ih.body.items.map((item: { status: string; mine: boolean }) => [item.status, item.mine])).toEqual([['open', false], ['done', false]])
    const m = await call(path, 'GET', tokens.member)
    expect(m.status).toBe(200)
    expect(m.body.items).toMatchObject([
      { id: open.id, status: 'open', mine: true, requestedBy: who.member },
      { id: r.id, status: 'done', mine: true, requestedBy: who.member },
    ])
  })
})
