// Routes 77 and 78 through the real request path (api.ts with the real matrix rows, stores and migrations; only sign-in
// is stood in for). Ways they can fail, written down first:
//  1. a Member reads the waiting list or approves; the Inhouse team does either without a live grant, or with one but
//     without its support.access line;
//  2. the waiting list holds an active, forgotten or person fact, passes 200, or takes a query string;
//  3. approve takes a bad id, an unknown id or a person fact as anything but 404; a loose body (extra key, no ifRev)
//     isn't 400;
//  4. a stale rev applies, or a decision isn't the line route 45 answers (the fact, or conflict with `current`);
//  5. a service principal gets an answer from the waiting list.
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
import { waitingLimit } from './memory-approvals.ts'

const db = env.DB
const NOW = 1_800_000_000_000
const A = 'm_appr_route_a'
const ADMIN = 'm_appr_route_admin'
const IH = 'm_appr_route_ih'
const GRANT = 'g_apprtest'

const person = (memberId: string, role: 'member' | 'admin'): Principal => ({ kind: 'person', memberId, role, subject: `s-${memberId}`, requestId: `req-${Math.random()}`, expMs: NOW + 600_000 })
const inhouse = (live: boolean): Principal => ({ kind: 'inhouse', memberId: IH, subject: 's-ih', grant: live ? { id: GRANT, endsAtMs: NOW + 60_000 } : null, requestId: `req-${Math.random()}`, expMs: NOW + 600_000 })

function parts(principal: Principal): ApiParts {
  return { authenticate: async () => ({ principal }), checkOrigin: () => null, checkAccess, stores: e => openStores(e), routes, accessMatrix }
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
async function send(principal: Principal, method: 'GET' | 'PUT', path: string, body?: unknown) {
  const req = new Request(`http://brand.localhost:8787${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'Content-Type': 'application/json', Origin: 'http://brand.localhost:8787' } })
  const res = await api(parts(principal), req, env, ctx, 'req-test')
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const waiting = (p: Principal, query = '') => send(p, 'GET', `/api/memory/waiting${query}`)
const decide = (p: Principal, id: string, body: unknown) => send(p, 'PUT', `/api/memory/brand/${id}/approved`, body)
const row = (id: string) => db.prepare('SELECT status, rev FROM memories WHERE id = ?').bind(id).first<{ status: string; rev: number }>()
const keys = (r: { body: Record<string, unknown> }) => (r.body.facts as { key: string }[]).map(f => f.key)

const F = {
  team: 'mem_apprRouteTeamaaaaaaaaa',
  waitOld: 'mem_apprRouteWaitOldaaaaaa',
  waitNew: 'mem_apprRouteWaitNewaaaaaa',
  gone: 'mem_apprRouteGoneaaaaaaaaa',
  own: 'mem_apprRouteOwnaaaaaaaaaa',
}

beforeAll(async () => {
  await db.batch([
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Ada', 1)").bind(A),
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'admin', 'active', 'Cy', 1)").bind(ADMIN),
    db.prepare("INSERT INTO members (id, kind, status, name, subject, created_at_ms) VALUES (?, 'inhouse', 'active', 'Ian', 's-ih', 1)").bind(IH),
  ])
})
beforeEach(async () => {
  await db.prepare('DELETE FROM memories').run()
  const fact = (id: string, scope: string, owner: string | null, text: string, status: string) =>
    db.prepare('INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, 1, 1)').bind(id, scope, owner, text, status, owner ?? A)
  await db.batch([
    fact(F.team, 'brand', null, 'We restock on Fridays', 'active'),
    fact(F.waitOld, 'brand', null, 'Kestrel wants PDFs', 'waiting'),
    fact(F.gone, 'brand', null, 'Old cutoff was Thursday', 'forgotten'),
    fact(F.own, 'person', A, 'Ada likes tables sorted by date', 'active'),
    fact(F.waitNew, 'brand', null, 'Ship gifts in the blue box', 'waiting'),
  ])
})

describe('route 77, GET /api/memory/waiting (failures 1, 2 and 5)', () => {
  it('an Admin sees the waiting team facts only, newest first, each a memory line with kind memory', async () => {
    const r = await waiting(person(ADMIN, 'admin'))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      facts: [
        { kind: 'memory', key: F.waitNew, text: 'Ship gifts in the blue box', source: 'Ada told your Inhouse agent in a chat', at: { iso: '1970-01-01T00:00:00.001Z', ms: 1 }, rev: 1, scope: 'brand' },
        { kind: 'memory', key: F.waitOld, text: 'Kestrel wants PDFs', source: 'Ada told your Inhouse agent in a chat', at: { iso: '1970-01-01T00:00:00.001Z', ms: 1 }, rev: 1, scope: 'brand' },
      ],
    })
  })
  it('a Member is refused', async () => {
    expect(await waiting(person(A, 'member'))).toEqual({ status: 403, body: { error: { code: 'forbidden' } } })
  })
  it('the Inhouse team only under a live grant, after its support.access line', async () => {
    const before = await lastLineId(db)
    expect(await waiting(inhouse(false))).toEqual({ status: 403, body: { error: { code: 'forbidden', reason: 'grant_required' } } })
    expect(await linesSince(db, before)).toEqual([])
    const r = await waiting(inhouse(true))
    expect(r.status).toBe(200)
    expect(keys(r)).toEqual([F.waitNew, F.waitOld])
    expect((await linesSince(db, before)).map(l => [l.action, l.actor_id, JSON.parse(l.args_json)])).toEqual([['support.access', IH, { grantId: GRANT, method: 'GET', route: '/api/memory/waiting' }]])
  })
  it('a query string is invalid', async () => {
    expect((await waiting(person(ADMIN, 'admin'), '?limit=5')).status).toBe(400)
  })
  it('at most 200', async () => {
    const stmts = Array.from({ length: 205 }, (_, i) => db.prepare("INSERT INTO memories (id, scope, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, 'brand', ?, 'waiting', ?, 1, 1)")
      .bind(`mem_apprMany${String(i).padStart(14, '0')}`, `Waiting ${i}`, A))
    await db.batch(stmts)
    const r = await waiting(person(ADMIN, 'admin'))
    expect(keys(r)).toHaveLength(200)
    expect(keys(r)[0]).toBe(`mem_apprMany${String(204).padStart(14, '0')}`)
  })
  it('a service principal gets no answer (it throws, as route 43)', async () => {
    const svc: Principal = { kind: 'service', name: 'smoke', memberId: 'm_smoke', requestId: 'r' }
    expect((await waiting(svc)).status).not.toBe(200)
  })
})

describe('route 78, PUT /api/memory/brand/:id/approved (failures 1, 3 and 4)', () => {
  it('an Admin approves: the line as it is now, active; gone from the waiting list, on the Memory page', async () => {
    const before = await lastLineId(db)
    expect(await decide(person(ADMIN, 'admin'), F.waitOld, { approved: true, ifRev: 1 })).toMatchObject({ status: 200, body: { key: F.waitOld, rev: 2, scope: 'brand', text: 'Kestrel wants PDFs' } })
    expect(await row(F.waitOld)).toEqual({ status: 'active', rev: 2 })
    expect(keys(await waiting(person(ADMIN, 'admin')))).toEqual([F.waitNew])
    const page = await send(person(A, 'member'), 'GET', '/api/memory')
    expect(JSON.stringify(page.body)).toContain('Kestrel wants PDFs')
    expect((await linesSince(db, before)).map(l => [l.action, l.actor_id, l.target_id, JSON.parse(l.args_json)])).toEqual([['memory.approved', ADMIN, F.waitOld, { memoryId: F.waitOld, rev: 1 }]])
  })
  it('an Admin rejects: forgotten; route 45 can bring it back, waiting', async () => {
    const before = await lastLineId(db)
    expect(await decide(person(ADMIN, 'admin'), F.waitOld, { approved: false, ifRev: 1 })).toMatchObject({ status: 200, body: { key: F.waitOld, rev: 2, forgotten: true } })
    expect(await row(F.waitOld)).toEqual({ status: 'forgotten', rev: 2 })
    expect((await send(person(ADMIN, 'admin'), 'PUT', `/api/memory/brand/${F.waitOld}/forgotten`, { forgotten: false, ifRev: 2 })).status).toBe(200)
    expect(await row(F.waitOld)).toEqual({ status: 'waiting', rev: 3 })
    expect((await linesSince(db, before)).map(l => [l.action, JSON.parse(l.args_json)])).toEqual([
      ['memory.rejected', { memoryId: F.waitOld, rev: 1 }],
      ['memory.restored', { memoryId: F.waitOld }],
    ])
  })
  it('a stale rev, an active or a forgotten fact: 409 with the fact as it is, nothing logged', async () => {
    expect((await decide(person(ADMIN, 'admin'), F.waitOld, { approved: true, ifRev: 1 })).status).toBe(200)
    const before = await lastLineId(db)
    expect(await decide(person(ADMIN, 'admin'), F.waitOld, { approved: true, ifRev: 1 })).toMatchObject({ status: 409, body: { error: { code: 'conflict', current: { key: F.waitOld, rev: 2 } } } })
    expect(await decide(person(ADMIN, 'admin'), F.team, { approved: false, ifRev: 1 })).toMatchObject({ status: 409, body: { error: { code: 'conflict', current: { key: F.team, rev: 1 } } } })
    expect(await decide(person(ADMIN, 'admin'), F.gone, { approved: true, ifRev: 1 })).toMatchObject({ status: 409, body: { error: { code: 'conflict', current: { key: F.gone, forgotten: true } } } })
    expect(await linesSince(db, before)).toEqual([])
    expect(await row(F.team)).toEqual({ status: 'active', rev: 1 })
  })
  it('a Member is refused, and nothing changes', async () => {
    expect(await decide(person(A, 'member'), F.waitOld, { approved: true, ifRev: 1 })).toEqual({ status: 403, body: { error: { code: 'forbidden' } } })
    expect(await row(F.waitOld)).toEqual({ status: 'waiting', rev: 1 })
  })
  it('the Inhouse team: refused without a grant; with one, support.access (PUT on the /approved pattern), then its own line', async () => {
    const before = await lastLineId(db)
    expect(await decide(inhouse(false), F.waitOld, { approved: true, ifRev: 1 })).toEqual({ status: 403, body: { error: { code: 'forbidden', reason: 'grant_required' } } })
    expect(await linesSince(db, before)).toEqual([])
    expect(await row(F.waitOld)).toEqual({ status: 'waiting', rev: 1 })
    expect((await decide(inhouse(true), F.waitOld, { approved: true, ifRev: 1 })).status).toBe(200)
    expect((await linesSince(db, before)).map(l => [l.action, l.actor_id, JSON.parse(l.args_json)])).toEqual([
      ['support.access', IH, { grantId: GRANT, method: 'PUT', route: '/api/memory/brand/:id/approved' }],
      ['memory.approved', IH, { memoryId: F.waitOld, rev: 1 }],
    ])
  })
  it('a bad id, an unknown id or a person fact is 404; nothing changes', async () => {
    for (const id of ['mem_short', 'nope', 'mem_apprRouteNoneaaaaaaaaa', F.own]) {
      expect(await decide(person(ADMIN, 'admin'), id, { approved: true, ifRev: 1 }), id).toEqual({ status: 404, body: { error: { code: 'not_found' } } })
    }
    expect(await row(F.own)).toEqual({ status: 'active', rev: 1 })
  })
  it('a strict body: an extra key, no ifRev, a wrong type or an ifRev out of bounds is 400', async () => {
    for (const body of [{ approved: true }, { ifRev: 1 }, { approved: 'yes', ifRev: 1 }, { approved: true, ifRev: 0 }, { approved: true, ifRev: 1_000_000_000 }, { approved: true, ifRev: 1, extra: 1 }, { forgotten: true, ifRev: 1 }]) {
      expect((await decide(person(ADMIN, 'admin'), F.waitOld, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(await row(F.waitOld)).toEqual({ status: 'waiting', rev: 1 })
  })
})

describe("the waiting list's limit is clamped (A10)", () => {
  it('1 to 200, whatever a caller passes; a non-number throws', () => {
    for (const [n, want] of [[200, 200], [201, 200], [1e12, 200], [Number.MAX_SAFE_INTEGER, 200], [1, 1], [0, 1], [-5, 1], [0.5, 1], [57.9, 57]] as const) {
      expect(waitingLimit(n), String(n)).toBe(want)
    }
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(() => waitingLimit(n), String(n)).toThrow()
  })
})
