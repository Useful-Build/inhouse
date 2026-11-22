// Activity (P4 W4 route 59, p4-w4.md sections 1 and 3): the append-only line store served as lines rendered at read time from
// a template, its fields and member ids. Written from the brief's tables: who may read (every Member, the Admin, Inhouse only
// under a live grant), what a line says for each template (the fixed texts below, written out here, not read from the code),
// newest first with every line once across pages, a table that never changes a line, and no member name stored. Lines are
// seeded into the test build's local D1 (no route writes one: the producers are the routines, Today and the Library), far in
// the past (1970) so they never mix with real lines and are told apart by their `at.ms`. Skips anywhere but the local build.
import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, allPages, call, endLiveGrants, expectError, me } from './kit.ts'
import { readSql, writeSql } from './db.ts'
import { P4_ROUTES } from './watch-kit.ts'
import { caseFor } from './cases.ts'

const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
const inhouse = actor('inhouse')
test.describe.configure({ mode: 'serial' })

const run = randomBytes(6).toString('hex')
/** 1970 instants: distinct, far older than any real line, so a page walk meets them last and in a known order. */
const AT = (i: number) => 1_000_000 + i * 1000
interface Line { at: { ms: number }; kind: string; text: string; who: string; why: string; result: string; actorId?: string; minStage?: number; trace?: string }
let danaId: string
let leoId: string

function seed(i: number, template: string, source: string, kind: string, fields: object, actor: string | null, trace: string | null = null) {
  writeSql(
    'INSERT INTO activity_lines (id, at_ms, kind, template, fields_json, actor_id, trace, source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    `al_e2e_${run}_${i}`, AT(i), kind, template, JSON.stringify(fields), actor, trace, source, `e2e-${run}-${i}`,
  )
}

test.beforeAll(async ({ request }) => {
  await endLiveGrants(request)
  danaId = (await me(request, dana)).memberId
  leoId = (await me(request, leo)).memberId
  seed(0, 'routine_made', 'routine', 'change', {}, danaId)
  seed(1, 'routine_ran', 'routine-slot', 'read', {}, null, 'r_e2eTraceAAAAAAAAAAAAAA')
  seed(2, 'library_uploaded', 'library', 'change', { files: 2 }, leoId)
  seed(3, 'library_uploaded', 'library', 'change', { files: 1 }, danaId)
  seed(4, 'routine_failed', 'routine-slot', 'problem', { code: 'run_failed' }, null)
  seed(5, 'morning_check_ran', 'routine-slot', 'read', { items: 3 }, null)
  seed(6, 'routine_deleted', 'routine', 'change', {}, leoId)
})
test.afterAll(async ({ request }) => {
  if (process.env.E2E_TEST_BUILD_REMOTE) return // nothing was seeded there
  await endLiveGrants(request)
  writeSql('DELETE FROM activity_lines WHERE id LIKE ?', `al_e2e_${run}_%`)
})

const page = async (request: APIRequestContext, who: typeof dana, query = '') => {
  const r = await call(request, who, 'GET', `/api/activity${query}`)
  expect(r.status, r.text).toBe(200)
  return r.json as { items: Line[]; nextCursor: string | null }
}
/** Every page of the feed, with the seeded lines picked out by their 1970 instants. */
const walk = async (request: APIRequestContext, who: typeof dana, limit: number) => {
  const { items, pages } = await allPages<Line>(request, who, '/api/activity', limit)
  return { items, pages, seeded: items.filter(l => l.at.ms < 100_000_000) }
}

test('without a JWT, or with a garbage one, route 59 is 401 unauthorized', async ({ request }) => {
  const c = caseFor({ method: 'GET', pattern: '/api/activity' })
  expect(P4_ROUTES).toContain('GET /api/activity')
  for (const token of [null, 'not-a-jwt']) expectError(await call(request, dana, 'GET', c.path, { token }), 401, 'unauthorized')
})

test('every Member and the Admin read the same feed; Inhouse needs a live grant', async ({ request }) => {
  const forDana = await walk(request, dana, 100)
  const forLeo = await walk(request, leo, 100)
  const forAdmin = await walk(request, admin, 100)
  expect(forDana.seeded.map(l => l.at.ms)).toEqual([6, 5, 4, 3, 2, 1, 0].map(AT))
  expect(forLeo.seeded).toEqual(forDana.seeded)
  expect(forAdmin.seeded).toEqual(forDana.seeded)
  expectError(await call(request, inhouse, 'GET', '/api/activity'), 403, 'forbidden', 'grant_required')
  expect((await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })).status).toBe(201)
  const read = await call(request, inhouse, 'GET', '/api/activity')
  expect(read.status, `a 503 here means support.access lacks the route pattern (PR0 #237): ${read.text}`).toBe(200)
  await endLiveGrants(request)
})

test('each template reads as its fixed words, with the member named from the members table at read time', async ({ request }) => {
  const byAt = new Map((await walk(request, dana, 100)).seeded.map(l => [l.at.ms, l]))
  expect(byAt.get(AT(0))).toMatchObject({ kind: 'change', text: 'Dana Kim set up a routine', who: 'Dana Kim', why: 'Dana Kim asked for it', result: 'It runs on its schedule', actorId: danaId })
  expect(byAt.get(AT(1))).toMatchObject({ kind: 'read', text: 'Ran a routine', who: 'Your Inhouse agent', why: 'Its time came', result: 'It finished', trace: 'r_e2eTraceAAAAAAAAAAAAAA' })
  expect(byAt.get(AT(1))?.actorId).toBeUndefined()
  expect(byAt.get(AT(2))).toMatchObject({ text: 'Leo Park added 2 files to the Library', who: 'Leo Park', actorId: leoId })
  expect(byAt.get(AT(3))).toMatchObject({ text: 'Dana Kim added 1 file to the Library' })
  expect(byAt.get(AT(4))).toMatchObject({ kind: 'problem', text: 'A routine failed', why: 'It stopped with run_failed', result: 'Nothing was saved' })
  expect(byAt.get(AT(5))).toMatchObject({ text: 'Ran the morning check and found 3 things', result: 'Found 3' })
  expect(byAt.get(AT(6))).toMatchObject({ text: 'Leo Park deleted a routine', who: 'Leo Park' })
})

test('paging: every line once across pages, newest first, at any page size; a bad cursor or limit is 400', async ({ request }) => {
  const all = await walk(request, dana, 100)
  for (const limit of [1, 3, 4]) {
    const paged = await walk(request, dana, limit)
    expect(paged.items.map(l => l.at.ms), `limit ${limit}: the same lines in the same order`).toEqual(all.items.map(l => l.at.ms))
    expect(paged.pages).toBe(Math.ceil(all.items.length / limit))
  }
  const ms = all.items.map(l => l.at.ms)
  expect(ms, 'newest first').toEqual([...ms].sort((a, b) => b - a))
  expect(new Set(ms).size, 'no line twice').toBe(ms.length)
  const first = await page(request, dana, '?limit=2')
  expect(first.items).toHaveLength(2)
  expect(first.nextCursor).not.toBeNull()
  for (const q of ['?cursor=not*a*cursor', '?cursor=YWJj', '?limit=0', '?limit=101', '?limit=x', '?other=1']) {
    const r = await call(request, dana, 'GET', `/api/activity${q}`)
    expect(r.status, q).toBe(400)
    expect(r.json.error.code).toBe('invalid')
  }
})

test('the store is append-only: an UPDATE is refused by the table, a repeated source and key leaves one line, and no stored row holds a member\'s name', () => {
  expect(() => writeSql('UPDATE activity_lines SET kind = ? WHERE id = ?', 'problem', `al_e2e_${run}_0`)).toThrow(/append-only/)
  expect(readSql<{ kind: string }>('SELECT kind FROM activity_lines WHERE id = ?', `al_e2e_${run}_0`)[0]!.kind).toBe('change')
  writeSql('INSERT OR IGNORE INTO activity_lines (id, at_ms, kind, template, fields_json, source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?)', `al_e2e_${run}_dup`, AT(99), 'read', 'routine_ran', '{}', 'routine-slot', `e2e-${run}-1`)
  expect(readSql('SELECT id FROM activity_lines WHERE source = ? AND source_key = ?', 'routine-slot', `e2e-${run}-1`)).toHaveLength(1)
  const dump = JSON.stringify(readSql('SELECT template, fields_json, source_key FROM activity_lines'))
  for (const name of ['Dana', 'Kim', 'Leo', 'Park', 'Sam', 'Mercer', '@example.test']) expect(dump, `the stored lines never hold "${name}"`).not.toContain(name)
})
