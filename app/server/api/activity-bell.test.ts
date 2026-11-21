// Routes 59 to 61 (P4 W4) through the real request path (api.ts, the matrix rule, the stores and the migrations; only
// sign-in is stood in for). The three route and matrix rows are the orchestrator's to add to routes.ts and
// access-matrix.ts; the test adds them itself when they aren't there yet, with the exact rows the PR body lists.
// Ways it can fail, written down first:
//  1. the bell shows a person a notice outside its audience (team, admins, a named member), or marks one they can't see
//     (the answer must not tell which ids exist); reading twice differs from once;
//  2. read state is lost on a reload, or one member's reading clears another's dot;
//  3. Activity paging repeats or drops a line, or isn't newest first, with lines at the same instant;
//  4. a role that shouldn't reach a route does: Inhouse on the bell with or without a grant, Inhouse on Activity without a
//     grant, a grant read that writes no support.access line; a bad cursor, limit, body or extra parameter reaches a store;
//  5. a name is read from a stored row instead of the members table: a pseudonymised member still shows their name, an
//     UPDATE of the append-only table is needed to remove it, or a raw dump of either table holds a member's name.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { accessMatrix } from '../access-matrix.ts'
import type { AccessRow } from '../access-matrix.ts'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import { checkAccess } from '../auth/matrix.ts'
import type { Principal } from '../auth/principal.ts'
import { openStores } from '../db/stores.ts'
import { lastLineId, linesSince } from '../db/test-support.ts'
import { routes } from '../routes.ts'
import type { Route } from '../routes.ts'
import { recordActivity } from '../activity/store.ts'
import { addNotice } from '../notices/store.ts'
import { listActivity } from './activity.ts'
import { listNotifications, markNotificationsRead } from './bell.ts'

const db = env.DB
const NOW = 1_800_000_000_000
const A = 'm_ab_a'
const B = 'm_ab_b'
const D = 'm_ab_d'
const ADMIN = 'm_ab_admin'
const IH = 'm_ab_ih'
const GRANT = 'g_abtest'
const NAMES = { [A]: 'Ada Fixture-One', [B]: 'Bo Fixture-Two', [D]: 'Di Fixture-Three', [ADMIN]: 'Cy Fixture-Four' }

const ROWS: AccessRow[] = [
  { method: 'GET', pattern: '/api/activity', class: 'brand_data', allow: ['member', 'admin', 'inhouse'] },
  { method: 'GET', pattern: '/api/notifications', class: 'personal', allow: ['member', 'admin'] },
  { method: 'POST', pattern: '/api/notifications/read', class: 'personal', allow: ['member', 'admin'] },
]
const ROUTES: Route[] = [
  { method: 'GET', pattern: '/api/activity', handler: listActivity },
  { method: 'GET', pattern: '/api/notifications', handler: listNotifications },
  { method: 'POST', pattern: '/api/notifications/read', handler: markNotificationsRead },
]
const missing = <T extends { method: string; pattern: string }>(have: readonly T[], want: readonly T[]) => want.filter(w => !have.some(h => h.method === w.method && h.pattern === w.pattern))
const matrix = [...accessMatrix, ...missing(accessMatrix, ROWS)]
const table = [...routes, ...missing(routes, ROUTES)]

const person = (memberId: string, role: 'member' | 'admin'): Principal => ({ kind: 'person', memberId, role, subject: `s-${memberId}`, requestId: `req-${Math.random()}`, expMs: NOW + 600_000 })
const inhouse = (live: boolean): Principal => ({ kind: 'inhouse', memberId: IH, subject: 's-ih', grant: live ? { id: GRANT, endsAtMs: NOW + 60_000 } : null, requestId: `req-${Math.random()}`, expMs: NOW + 600_000 })
const WHO = { a: person(A, 'member'), b: person(B, 'member'), d: person(D, 'member'), admin: person(ADMIN, 'admin') }

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
async function send(principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) {
  const parts: ApiParts = { authenticate: async () => ({ principal }), checkOrigin: () => null, checkAccess, stores: e => openStores(e), routes: table, accessMatrix: matrix }
  const req = new Request(`http://brand.localhost:8787${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', Origin: 'http://brand.localhost:8787' },
  })
  const res = await api(parts, req, env, ctx, 'req-test')
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
type Item = { id: string; unread: boolean; person?: string; text: string }
const bell = async (p: Principal) => (await send(p, 'GET', '/api/notifications')).body.items as Item[]
const readRows = async (member: string) => (await db.prepare('SELECT notice_id FROM notice_reads WHERE member_id = ? ORDER BY notice_id').bind(member).all<{ notice_id: string }>()).results.map(r => r.notice_id)

const LINK = { to: 'page', page: 'routines' } as const
const base = { icon: 'error', link: LINK, atMs: 1000 }
// The audience rule, in words (the test's oracle): the team's notices reach every member; the admins' only an Admin; a
// member's own only that member.
const NOTICES = [
  { id: 'n_team', audience: 'team', who: 'everyone' },
  { id: 'n_admins', audience: 'admins', who: 'admins' },
  { id: 'n_a', audience: 'member', who: 'a' },
  { id: 'n_b', audience: 'member', who: 'b' },
] as const
const sees = (who: keyof typeof WHO, n: (typeof NOTICES)[number]): boolean => n.who === 'everyone' || (n.who === 'admins' && who === 'admin') || n.who === who

beforeAll(async () => {
  const m = (id: string, role: 'member' | 'admin') => db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', ?, 'active', ?, 1)").bind(id, role, NAMES[id as keyof typeof NAMES])
  await db.batch([
    m(A, 'member'), m(B, 'member'), m(D, 'member'), m(ADMIN, 'admin'),
    db.prepare("INSERT INTO members (id, kind, status, name, subject, created_at_ms) VALUES (?, 'inhouse', 'active', 'Ian', 's-ih', 1)").bind(IH),
  ])
})
beforeEach(async () => {
  await db.batch([db.prepare('DELETE FROM notice_reads'), db.prepare('DELETE FROM notices'), db.prepare('DELETE FROM activity_lines')])
  await db.batch([
    addNotice(db, { ...base, id: 'n_team', audience: 'team', template: 'morning_check_found', fields: { items: 2 }, atMs: 1000 }),
    addNotice(db, { ...base, id: 'n_admins', audience: 'admins', template: 'routine_failed', fields: { code: 'run_failed' }, atMs: 2000 }),
    addNotice(db, { ...base, id: 'n_a', audience: 'member', audienceMemberId: A, template: 'routine_failed', fields: { code: 'run_failed' }, atMs: 3000 }),
    addNotice(db, { ...base, id: 'n_b', audience: 'member', audienceMemberId: B, template: 'routine_failed', fields: { code: 'run_failed' }, atMs: 4000 }),
  ])
})

describe('the bell: who sees what (failure 1)', () => {
  test.prop([fc.constantFrom(...(Object.keys(WHO) as (keyof typeof WHO)[]))], { numRuns: 20 })('each member lists exactly the notices the audience rule allows, newest first', async who => {
    const items = await bell(WHO[who])
    expect(items.map(i => i.id)).toEqual(NOTICES.filter(n => sees(who, n)).map(n => n.id).reverse())
  })

  test.prop([fc.constantFrom(...(Object.keys(WHO) as (keyof typeof WHO)[])), fc.subarray(['n_team', 'n_admins', 'n_a', 'n_b', 'n_nobody'], { minLength: 1 })], { numRuns: 30 })('marking never marks a notice the member can\'t see, answers the same for a hidden id as for a missing one, and twice is once', async (who, pick) => {
    await db.prepare('DELETE FROM notice_reads').run()
    const me = WHO[who]
    const memberId = (me as Extract<Principal, { kind: 'person' }>).memberId
    const oracle = pick.filter(id => NOTICES.some(n => n.id === id && sees(who, n))).sort()
    const first = await send(me, 'POST', '/api/notifications/read', { ids: pick })
    expect(first).toEqual({ status: 200, body: { ok: true } })
    expect(await readRows(memberId)).toEqual(oracle)
    const again = await send(me, 'POST', '/api/notifications/read', { ids: pick })
    expect(again).toEqual(first)
    expect(await readRows(memberId)).toEqual(oracle)
    for (const other of Object.values(WHO)) if (other !== me) expect(await readRows((other as Extract<Principal, { kind: 'person' }>).memberId)).toEqual([])
  })
})

describe('read state is on the server (failure 2)', () => {
  it('list, mark one, list again from a fresh request: that one is read, the rest unread, and only for that member', async () => {
    expect((await bell(WHO.a)).map(i => [i.id, i.unread])).toEqual([['n_a', true], ['n_team', true]])
    await send(WHO.a, 'POST', '/api/notifications/read', { ids: ['n_a'] })
    expect((await bell(WHO.a)).map(i => [i.id, i.unread])).toEqual([['n_a', false], ['n_team', true]])
    expect((await bell(WHO.b)).map(i => [i.id, i.unread])).toEqual([['n_b', true], ['n_team', true]])
    await send(WHO.b, 'POST', '/api/notifications/read', { ids: ['n_team', 'n_b'] })
    expect((await bell(WHO.a)).find(i => i.id === 'n_team')?.unread).toBe(true)
  })
})

describe('Activity paging (failure 3)', () => {
  const total = (n: number) => db.batch(Array.from({ length: n }, (_, i) => recordActivity(db,
    { template: 'morning_check_ran', fields: { items: i }, kind: 'read', atMs: NOW + Math.floor(i / 2) * 1000 }, { source: 'routine-slot', key: `k${i}` })))
  type Line = { result: string; at: { ms: number } }
  test.prop([fc.integer({ min: 0, max: 15 }), fc.integer({ min: 1, max: 9 })], { numRuns: 15 })('every line once, newest first, ties included', async (count, limit) => {
    await db.prepare('DELETE FROM activity_lines').run()
    if (count > 0) await total(count)
    const got: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 40; page++) {
      const r = await send(WHO.a, 'GET', `/api/activity?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`)
      expect(r.status).toBe(200)
      const items = r.body.items as Line[]
      expect(items.length).toBeLessThanOrEqual(limit)
      got.push(...items.map(l => l.result))
      cursor = r.body.nextCursor as string | null
      if (!cursor) break
    }
    // Written in order with times that never go down, so newest first is the reverse of the writes.
    expect(got).toEqual(Array.from({ length: count }, (_, i) => `Found ${count - 1 - i}`))
  })
})

describe('roles and bad input (failure 4)', () => {
  it('members and Admins read Activity and the bell; Inhouse reads Activity under a grant, after one support.access line, and never the bell', async () => {
    for (const p of [WHO.a, WHO.admin]) {
      expect((await send(p, 'GET', '/api/activity')).status).toBe(200)
      expect((await send(p, 'GET', '/api/notifications')).status).toBe(200)
      expect((await send(p, 'POST', '/api/notifications/read', { ids: ['n_team'] })).status).toBe(200)
    }
    const before = await lastLineId(db)
    expect(await send(inhouse(false), 'GET', '/api/activity')).toEqual({ status: 403, body: { error: { code: 'forbidden', reason: 'grant_required' } } })
    expect(await linesSince(db, before)).toEqual([])
    expect((await send(inhouse(true), 'GET', '/api/activity')).status).toBe(200)
    expect((await linesSince(db, before)).map(l => [l.action, l.actor_id, JSON.parse(l.args_json)])).toEqual([['support.access', IH, { grantId: GRANT, method: 'GET', route: '/api/activity' }]])
    for (const live of [false, true]) {
      expect((await send(inhouse(live), 'GET', '/api/notifications')).status).toBe(403)
      expect((await send(inhouse(live), 'POST', '/api/notifications/read', { ids: ['n_team'] })).status).toBe(403)
    }
    expect(await readRows(IH)).toEqual([])
  })
  it('a bad cursor, limit, body or an extra parameter is 400 and writes nothing', async () => {
    expect((await send(WHO.a, 'GET', '/api/activity?cursor=not-ours')).status).toBe(400)
    expect((await send(WHO.a, 'GET', '/api/activity?cursor=MTIz')).status).toBe(400)
    expect((await send(WHO.a, 'GET', '/api/activity?limit=0')).status).toBe(400)
    expect((await send(WHO.a, 'GET', '/api/activity?limit=101')).status).toBe(400)
    expect((await send(WHO.a, 'GET', '/api/activity?x=1')).status).toBe(400)
    expect((await send(WHO.a, 'GET', '/api/notifications?x=1')).status).toBe(400)
    for (const body of [{}, { ids: [] }, { ids: ['a'], extra: 1 }, { ids: [1] }, { ids: Array.from({ length: 101 }, (_, i) => `n${i}`) }, { ids: [''] }])
      expect((await send(WHO.a, 'POST', '/api/notifications/read', body)).status, JSON.stringify(body).slice(0, 40)).toBe(400)
    expect(await readRows(A)).toEqual([])
  })
  it('a hundred ids at once work (D1 binds at most 100 parameters per statement)', async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => `n_none_${i}`)
    expect(await send(WHO.a, 'POST', '/api/notifications/read', { ids: [...hundred.slice(0, 98), 'n_a', 'n_team'] })).toEqual({ status: 200, body: { ok: true } })
    expect(await readRows(A)).toEqual(['n_a', 'n_team'])
  })
})

describe('names render at read, from ids (failure 5)', () => {
  const dump = async () => JSON.stringify([(await db.prepare('SELECT * FROM activity_lines ORDER BY n').all()).results, (await db.prepare('SELECT * FROM notices ORDER BY id').all()).results])
  it('a pseudonymised member reads A former member, with no UPDATE of either table, and no name is ever stored', async () => {
    await db.batch([
      recordActivity(db, { template: 'routine_made', fields: {}, kind: 'change', actorId: A, atMs: NOW }, { source: 'routine', key: 'made-a' }),
      recordActivity(db, { template: 'library_uploaded', fields: { files: 2 }, kind: 'change', actorId: B, atMs: NOW + 1 }, { source: 'library', key: 'up-b' }),
      db.prepare("INSERT INTO notices (id, audience, template, fields_json, icon, person_id, at_ms, link_json, source) VALUES ('n_person_a', 'team', 'morning_check_found', '{\"items\":1}', 'x', ?, 9000, '{\"to\":\"page\",\"page\":\"today\"}', 'morning-check')").bind(A),
    ])
    const lines = async () => ((await send(WHO.admin, 'GET', '/api/activity')).body.items as { text: string; who: string; actorId?: string }[]).map(l => [l.text, l.who, l.actorId])
    const person = async () => (await bell(WHO.admin)).find(i => i.id === 'n_person_a')?.person
    expect(await lines()).toEqual([[`${NAMES[B]} added 2 files to the Library`, NAMES[B], B], [`${NAMES[A]} set up a routine`, NAMES[A], A]])
    expect(await person()).toBe(NAMES[A])
    const rawBefore = await dump()
    for (const name of Object.values(NAMES)) expect(rawBefore).not.toContain(name)
    // P2's deletion path, as its SQL: the member row loses its name and identity, nothing else is touched.
    await db.prepare("UPDATE members SET status = 'removed', name = NULL, email_norm = NULL, subject = NULL, photo_key = NULL, pseudonymised_at_ms = ? WHERE id = ?").bind(NOW, A).run()
    expect(await lines()).toEqual([[`${NAMES[B]} added 2 files to the Library`, NAMES[B], B], ['A former member set up a routine', 'A former member', A]])
    expect(await person()).toBeUndefined()
    expect((await bell(WHO.admin)).find(i => i.id === 'n_person_a')?.text).toBe('The morning check found 1 thing')
    expect(await dump()).toBe(rawBefore)
    await expect(db.prepare("UPDATE activity_lines SET actor_id = NULL WHERE actor_id = ?").bind(A).run()).rejects.toThrow(/append-only/)
  })
  it('a removed member who is not deleted keeps their name', async () => {
    await db.batch([recordActivity(db, { template: 'routine_deleted', fields: {}, kind: 'change', actorId: D, atMs: NOW }, { source: 'routine', key: 'del-d' })])
    await db.prepare("UPDATE members SET status = 'removed', removed_at_ms = ? WHERE id = ?").bind(NOW, D).run()
    expect(((await send(WHO.a, 'GET', '/api/activity')).body.items as { who: string }[])[0].who).toBe(NAMES[D])
  })
})
