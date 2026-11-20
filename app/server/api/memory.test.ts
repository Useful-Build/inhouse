// Routes 43 to 45 through the real request path (api.ts with the real routes, matrix rule, stores and migrations; only
// sign-in is stood in for). Ways they can fail, written down first:
//  1. route 43 shows a member another's person facts, or a waiting or forgotten fact; Inhouse reads it without a grant
//     or without its support.access line;
//  2. route 44 lets anyone but the owner forget a person fact (another member, an Admin, Inhouse), or forgets a team fact;
//  3. route 45 lets a Member forget a team fact; Inhouse forgets one without a live grant, or with one on a row that
//     doesn't list it; an Inhouse forget isn't audited twice (support.access, then the action's own line naming Inhouse);
//  4. a stale ifRev applies, or writes a line; a forget whose answer was lost, sent again, forgets twice or logs twice;
//  5. an undone team fact counts at once instead of waiting for an admin's OK again.
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { accessMatrix } from '../access-matrix.ts'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import { checkAccess } from '../auth/matrix.ts'
import type { Principal } from '../auth/principal.ts'
import { openStores } from '../db/stores.ts'
import { lastLineId, linesSince } from '../db/test-support.ts'
import { routes } from '../routes.ts'

const db = env.DB
const NOW = 1_800_000_000_000
const A = 'm_mem_a'
const B = 'm_mem_b'
const ADMIN = 'm_mem_admin'
const IH = 'm_mem_ih'
const GRANT = 'g_memtest'

const person = (memberId: string, role: 'member' | 'admin'): Principal => ({ kind: 'person', memberId, role, subject: `s-${memberId}`, requestId: `req-${Math.random()}`, expMs: NOW + 600_000 })
const inhouse = (live: boolean): Principal => ({ kind: 'inhouse', memberId: IH, subject: 's-ih', grant: live ? { id: GRANT, endsAtMs: NOW + 60_000 } : null, requestId: `req-${Math.random()}`, expMs: NOW + 600_000 })

/** Row 45 as it was before item 19 (Admins only): a literal, to show `allow` still decides under a live grant. */
const ROW_45_ADMIN_ONLY = accessMatrix.map(r => (r.method === 'PUT' && r.pattern === '/api/memory/brand/:id/forgotten' ? { ...r, allow: ['admin'] as const } : r))

function parts(principal: Principal, matrix = accessMatrix): ApiParts {
  return {
    authenticate: async () => ({ principal }),
    checkOrigin: () => null,
    checkAccess,
    stores: e => openStores(e),
    routes,
    accessMatrix: matrix,
  }
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
async function send(principal: Principal, method: 'GET' | 'PUT', path: string, body?: unknown, matrix = accessMatrix) {
  const req = new Request(`http://brand.localhost:8787${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'Content-Type': 'application/json', Origin: 'http://brand.localhost:8787' } })
  const res = await api(parts(principal, matrix), req, env, ctx, 'req-test')
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const page = async (p: Principal) => {
  const r = await send(p, 'GET', '/api/memory')
  const b = r.body as { team: { group: string; lines: { key: string; text: string }[] }[]; personal: { key: string; text: string }[] }
  return { status: r.status, team: b.team?.flatMap(g => g.lines.map(l => l.text)).sort(), personal: b.personal?.map(l => l.text).sort() }
}
const forget = (p: Principal, kind: 'personal' | 'brand', id: string, body: unknown, matrix = accessMatrix) => send(p, 'PUT', `/api/memory/${kind}/${id}/forgotten`, body, matrix)
const row = (id: string) => db.prepare('SELECT status, rev FROM memories WHERE id = ?').bind(id).first<{ status: string; rev: number }>()

const F = {
  aOwn: 'mem_routeAaaaaaaaaaaaaaaaa',
  bOwn: 'mem_routeBbbbbbbbbbbbbbbbb',
  team: 'mem_routeTeamaaaaaaaaaaaaa',
  waiting: 'mem_routeWaitingaaaaaaaaaa',
  forgotten: 'mem_routeForgottenaaaaaaaa',
}

beforeAll(async () => {
  await db.batch([
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Ada', 1)").bind(A),
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Bo', 1)").bind(B),
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'admin', 'active', 'Cy', 1)").bind(ADMIN),
    db.prepare("INSERT INTO members (id, kind, status, name, subject, created_at_ms) VALUES (?, 'inhouse', 'active', 'Ian', 's-ih', 1)").bind(IH),
  ])
})
beforeEach(async () => {
  await db.prepare('DELETE FROM memories').run()
  const fact = (id: string, scope: string, owner: string | null, text: string, status: string) =>
    db.prepare('INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, 1, 1)').bind(id, scope, owner, text, status, owner ?? A)
  await db.batch([
    fact(F.aOwn, 'person', A, 'Ada likes tables sorted by date', 'active'),
    fact(F.bOwn, 'person', B, 'Bo likes invoices by supplier', 'active'),
    fact(F.team, 'brand', null, 'We restock on Fridays', 'active'),
    fact(F.waiting, 'brand', null, 'Kestrel wants PDFs', 'waiting'),
    fact(F.forgotten, 'brand', null, 'Old cutoff was Thursday', 'forgotten'),
  ])
})

describe('route 43, GET /api/memory (failure 1)', () => {
  it("each person sees the team's active facts and their own, nothing else", async () => {
    expect(await page(person(A, 'member'))).toEqual({ status: 200, team: ['We restock on Fridays'], personal: ['Ada likes tables sorted by date'] })
    expect(await page(person(B, 'member'))).toEqual({ status: 200, team: ['We restock on Fridays'], personal: ['Bo likes invoices by supplier'] })
    expect(await page(person(ADMIN, 'admin'))).toEqual({ status: 200, team: ['We restock on Fridays'], personal: [] })
  })
  it('a line carries its key, rev, scope and where it came from', async () => {
    const r = await send(person(A, 'member'), 'GET', '/api/memory')
    expect(r.body).toEqual({
      team: [{ group: 'Shared with the team', lines: [{ key: F.team, text: 'We restock on Fridays', source: 'Ada told your Inhouse agent in a chat', at: { iso: '1970-01-01T00:00:00.001Z', ms: 1 }, rev: 1, scope: 'brand' }] }],
      personal: [{ key: F.aOwn, text: 'Ada likes tables sorted by date', source: 'Ada told your Inhouse agent in a chat', at: { iso: '1970-01-01T00:00:00.001Z', ms: 1 }, rev: 1, scope: 'person' }],
    })
  })
  it('Inhouse reads it only under a live grant, after its support.access line', async () => {
    const before = await lastLineId(db)
    expect(await send(inhouse(false), 'GET', '/api/memory')).toEqual({ status: 403, body: { error: { code: 'forbidden', reason: 'grant_required' } } })
    expect(await linesSince(db, before)).toEqual([])
    expect(await page(inhouse(true))).toEqual({ status: 200, team: ['We restock on Fridays'], personal: [] })
    expect((await linesSince(db, before)).map(l => [l.action, l.actor_id, JSON.parse(l.args_json)])).toEqual([['support.access', IH, { grantId: GRANT, method: 'GET', route: '/api/memory' }]])
  })
})

describe('route 44, PUT /api/memory/personal/:id/forgotten (failures 2 and 4)', () => {
  it('the owner forgets and undoes; a stale rev is 409 with the line as it is; a lost answer sent again is 409, once', async () => {
    const r1 = await forget(person(A, 'member'), 'personal', F.aOwn, { forgotten: true, ifRev: 1 })
    expect(r1).toMatchObject({ status: 200, body: { key: F.aOwn, rev: 2, forgotten: true, scope: 'person' } })
    expect(await row(F.aOwn)).toEqual({ status: 'forgotten', rev: 2 })
    // The same write again (its answer lost): nothing changes, the answer says how it is.
    expect(await forget(person(A, 'member'), 'personal', F.aOwn, { forgotten: true, ifRev: 1 })).toMatchObject({ status: 409, body: { error: { code: 'conflict', current: { key: F.aOwn, rev: 2, forgotten: true } } } })
    expect(await row(F.aOwn)).toEqual({ status: 'forgotten', rev: 2 })
    expect((await page(person(A, 'member'))).personal).toEqual([])
    const r2 = await forget(person(A, 'member'), 'personal', F.aOwn, { forgotten: false, ifRev: 2 })
    expect(r2.status).toBe(200)
    expect(r2.body.forgotten).toBeUndefined()
    expect(await row(F.aOwn)).toEqual({ status: 'active', rev: 3 })
    expect(await forget(person(A, 'member'), 'personal', F.aOwn, { forgotten: true, ifRev: 2 })).toMatchObject({ status: 409, body: { error: { current: { rev: 3 } } } })
  })
  it("another member's, an Admin's or a team fact is 404; Inhouse is refused; nothing changes", async () => {
    expect(await forget(person(B, 'member'), 'personal', F.aOwn, { forgotten: true, ifRev: 1 })).toEqual({ status: 404, body: { error: { code: 'not_found' } } })
    expect(await forget(person(ADMIN, 'admin'), 'personal', F.aOwn, { forgotten: true, ifRev: 1 })).toEqual({ status: 404, body: { error: { code: 'not_found' } } })
    expect(await forget(person(A, 'member'), 'personal', F.team, { forgotten: true, ifRev: 1 })).toEqual({ status: 404, body: { error: { code: 'not_found' } } })
    expect((await forget(inhouse(true), 'personal', F.aOwn, { forgotten: true, ifRev: 1 })).status).toBe(403)
    expect(await forget(person(A, 'member'), 'personal', 'mem_nope', { forgotten: true, ifRev: 1 })).toEqual({ status: 404, body: { error: { code: 'not_found' } } })
    for (const body of [{ forgotten: true }, { forgotten: 'yes', ifRev: 1 }, { forgotten: true, ifRev: 0 }, { forgotten: true, ifRev: 1, extra: 1 }]) {
      expect((await forget(person(A, 'member'), 'personal', F.aOwn, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(await row(F.aOwn)).toEqual({ status: 'active', rev: 1 })
  })
})

describe('route 45, PUT /api/memory/brand/:id/forgotten (failures 3 to 5)', () => {
  it('an Admin forgets an active or a waiting team fact, with a memory.forgotten line; undone, it waits again', async () => {
    const before = await lastLineId(db)
    expect(await forget(person(ADMIN, 'admin'), 'brand', F.team, { forgotten: true, ifRev: 1 })).toMatchObject({ status: 200, body: { key: F.team, rev: 2, forgotten: true, scope: 'brand' } })
    expect(await forget(person(ADMIN, 'admin'), 'brand', F.waiting, { forgotten: true, ifRev: 1 })).toMatchObject({ status: 200, body: { forgotten: true } })
    expect(await forget(person(ADMIN, 'admin'), 'brand', F.team, { forgotten: false, ifRev: 2 })).toMatchObject({ status: 200, body: { rev: 3 } })
    expect(await row(F.team)).toEqual({ status: 'waiting', rev: 3 })
    expect((await page(person(A, 'member'))).team).toEqual([])
    expect((await linesSince(db, before)).map(l => [l.action, l.actor_id, l.target_kind, l.target_id, JSON.parse(l.args_json)])).toEqual([
      ['memory.forgotten', ADMIN, 'memory', F.team, { memoryId: F.team }],
      ['memory.forgotten', ADMIN, 'memory', F.waiting, { memoryId: F.waiting }],
      ['memory.restored', ADMIN, 'memory', F.team, { memoryId: F.team }],
    ])
  })
  it('a stale rev, or the same forget again after a lost answer, is 409 with the fact as it is, and logs nothing', async () => {
    expect((await forget(person(ADMIN, 'admin'), 'brand', F.team, { forgotten: true, ifRev: 1 })).status).toBe(200)
    const before = await lastLineId(db)
    expect(await forget(person(ADMIN, 'admin'), 'brand', F.team, { forgotten: true, ifRev: 1 })).toMatchObject({ status: 409, body: { error: { code: 'conflict', current: { key: F.team, rev: 2, forgotten: true } } } })
    expect(await forget(person(ADMIN, 'admin'), 'brand', F.forgotten, { forgotten: true, ifRev: 1 })).toMatchObject({ status: 409, body: { error: { current: { key: F.forgotten, forgotten: true } } } })
    expect(await linesSince(db, before)).toEqual([])
  })
  it("a Member is refused; a person's own fact is 404 here", async () => {
    expect(await forget(person(A, 'member'), 'brand', F.team, { forgotten: true, ifRev: 1 })).toEqual({ status: 403, body: { error: { code: 'forbidden' } } })
    expect(await forget(person(ADMIN, 'admin'), 'brand', F.aOwn, { forgotten: true, ifRev: 1 })).toEqual({ status: 404, body: { error: { code: 'not_found' } } })
    expect(await row(F.team)).toEqual({ status: 'active', rev: 1 })
    expect(await row(F.aOwn)).toEqual({ status: 'active', rev: 1 })
  })
  it('item 19: Inhouse forgets only under a live grant, on a row that lists it: support.access (PUT), then its own line', async () => {
    const before = await lastLineId(db)
    // A row 45 that doesn't list inhouse: refused even with a grant.
    expect(await forget(inhouse(true), 'brand', F.team, { forgotten: true, ifRev: 1 }, ROW_45_ADMIN_ONLY)).toEqual({ status: 403, body: { error: { code: 'forbidden' } } })
    // The committed row 45 (it lists inhouse): no grant, refused; a live grant, done and audited twice.
    expect(await forget(inhouse(false), 'brand', F.team, { forgotten: true, ifRev: 1 })).toEqual({ status: 403, body: { error: { code: 'forbidden', reason: 'grant_required' } } })
    expect(await linesSince(db, before)).toEqual([])
    expect(await row(F.team)).toEqual({ status: 'active', rev: 1 })
    expect(await forget(inhouse(true), 'brand', F.team, { forgotten: true, ifRev: 1 })).toMatchObject({ status: 200, body: { forgotten: true } })
    expect((await linesSince(db, before)).map(l => [l.action, l.actor_id, JSON.parse(l.args_json)])).toEqual([
      ['support.access', IH, { grantId: GRANT, method: 'PUT', route: '/api/memory/brand/:id/forgotten' }],
      ['memory.forgotten', IH, { memoryId: F.team }],
    ])
  })
})
