// The bell (P4 W4 routes 60 and 61, p4-w4.md section 2): the 50 newest notices the signed-in person may see, and the read
// call. The audience rule is written here from the brief, not read from the code: `team` for everyone, `admins` for an
// Admin, `member` only for that member; Inhouse has no bell. Read state is per person and on the server, so a reload shows it
// (S5). Notices are seeded into the local D1 (the producers are routines, the morning check and P5), dated just ahead of now
// so they are among the 50 newest. Skips anywhere but the local test build.
import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call, endLiveGrants, expectError, me } from './kit.ts'
import { writeSql } from './db.ts'
import { caseFor } from './cases.ts'

const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
const inhouse = actor('inhouse')
test.describe.configure({ mode: 'serial' })

const run = randomBytes(6).toString('hex')
const id = (name: string) => `e2e-bell-${run}-${name}`
const N = { team: id('team'), admins: id('admins'), dana: id('dana'), leo: id('leo') }
/** The notices each person may see, by the audience rule in words. */
const MAY_SEE: Record<'dana' | 'leo' | 'admin', string[]> = { dana: [N.team, N.dana], leo: [N.team, N.leo], admin: [N.team, N.admins] }

interface Item { id: string; text: string; who: string; unread: boolean; icon: string; link: { to: string; page?: string }; waiting?: boolean }

test.beforeAll(async ({ request }) => {
  await endLiveGrants(request)
  const [d, l] = [(await me(request, dana)).memberId as string, (await me(request, leo)).memberId as string]
  const at = Date.now() + 60_000
  const add = (n: string, audience: string, member: string | null, template: string, fields: object, source: string, i: number) =>
    writeSql(
      'INSERT INTO notices (id, audience, audience_member_id, template, fields_json, icon, person_id, at_ms, waiting, link_json, source) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)',
      n, audience, member, template, JSON.stringify(fields), 'sun', at + i, JSON.stringify({ to: 'page', page: 'today' }), source,
    )
  add(N.team, 'team', null, 'morning_check_found', { items: 3 }, 'morning-check', 0)
  add(N.admins, 'admins', null, 'routine_failed', { code: 'run_failed' }, 'routine-slot', 1)
  add(N.dana, 'member', d, 'morning_check_found', { items: 1 }, 'morning-check', 2)
  add(N.leo, 'member', l, 'morning_check_found', { items: 2 }, 'morning-check', 3)
})
test.afterAll(async ({ request }) => {
  if (process.env.E2E_TEST_BUILD_REMOTE) return // nothing was seeded there
  await endLiveGrants(request)
  for (const n of Object.values(N)) {
    writeSql('DELETE FROM notice_reads WHERE notice_id = ?', n)
    writeSql('DELETE FROM notices WHERE id = ?', n)
  }
})

const list = async (request: APIRequestContext, who: typeof dana): Promise<Item[]> => {
  const r = await call(request, who, 'GET', '/api/notifications')
  expect(r.status, r.text).toBe(200)
  expect(r.json.items.length).toBeLessThanOrEqual(50)
  return r.json.items
}
const mine = (items: Item[]) => items.filter(i => Object.values(N).includes(i.id))
const read = (request: APIRequestContext, who: typeof dana, ids: unknown) => call(request, who, 'POST', '/api/notifications/read', { json: { ids } })

test('without a JWT, or with a garbage one, routes 60 and 61 are 401', async ({ request }) => {
  for (const key of [{ method: 'GET', pattern: '/api/notifications' }, { method: 'POST', pattern: '/api/notifications/read' }]) {
    const c = caseFor(key)
    for (const token of [null, 'not-a-jwt']) expectError(await call(request, dana, key.method, c.path, { token, ...(c.json === undefined ? {} : { json: c.json }) }), 401, 'unauthorized')
  }
})

test('each person lists exactly the notices the audience rule allows, newest first, unread, with fixed words', async ({ request }) => {
  for (const [who, a] of [['dana', dana], ['leo', leo], ['admin', admin]] as const) {
    const items = mine(await list(request, a))
    expect(items.map(i => i.id).sort(), `${who}'s bell`).toEqual([...MAY_SEE[who]].sort())
    expect(items.every(i => i.unread)).toBe(true)
    const times = items.map(i => i.id)
    expect(times, 'newest first').toEqual([...MAY_SEE[who]].sort((x, y) => Object.values(N).indexOf(y) - Object.values(N).indexOf(x)))
  }
  const team = mine(await list(request, dana)).find(i => i.id === N.team)!
  expect(team).toMatchObject({ text: 'The morning check found 3 things', who: 'Your Inhouse agent', icon: 'sun', link: { to: 'page', page: 'today' } })
  expect(mine(await list(request, admin)).find(i => i.id === N.admins)).toMatchObject({ text: 'A routine failed', who: 'Your Inhouse agent' })
})

test('Inhouse has no bell: 403 with or without a live grant', async ({ request }) => {
  expect((await call(request, inhouse, 'GET', '/api/notifications')).status).toBe(403)
  expect((await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })).status).toBe(201)
  expect((await call(request, inhouse, 'GET', '/api/notifications')).status).toBe(403)
  expect((await call(request, inhouse, 'POST', '/api/notifications/read', { json: { ids: [N.team] } })).status).toBe(403)
  await endLiveGrants(request)
})

test('marking read: only the notices the person can see change, the answer never says which ids exist, and one person\'s read is not another\'s', async ({ request }) => {
  // Dana names her own team notice, Leo's notice (not hers) and an id nobody has: all three answer the same.
  const a = await read(request, dana, [N.team, N.leo, 'e2e-no-such-notice'])
  const b = await read(request, dana, ['e2e-no-such-notice'])
  expect([a.status, a.json]).toEqual([200, { ok: true }])
  expect([b.status, b.json]).toEqual([200, { ok: true }])
  const danas = mine(await list(request, dana))
  expect(danas.find(i => i.id === N.team)!.unread).toBe(false)
  expect(danas.find(i => i.id === N.dana)!.unread).toBe(true)
  // Leo's notice was not marked by Dana's call, and the team notice is still unread for Leo and the Admin.
  expect(mine(await list(request, leo)).map(i => [i.id, i.unread]).sort()).toEqual([[N.leo, true], [N.team, true]].sort())
  expect(mine(await list(request, admin)).find(i => i.id === N.team)!.unread).toBe(true)
})

test('read state is on the server: reading twice is the same as once, and a fresh list after it shows the dot gone (S5)', async ({ request }) => {
  const once = await read(request, dana, [N.dana])
  const twice = await read(request, dana, [N.dana])
  expect([once.status, twice.status]).toEqual([200, 200])
  expect(mine(await list(request, dana)).every(i => !i.unread)).toBe(true)
  // The Admin may not mark a member's own notice: it is skipped, not an error.
  expect((await read(request, admin, [N.dana, N.admins])).status).toBe(200)
  const adminItems = mine(await list(request, admin))
  expect(adminItems.find(i => i.id === N.admins)!.unread).toBe(false)
  expect(mine(await list(request, dana)).find(i => i.id === N.dana)!.unread).toBe(false)
})

test('route 61 refuses a body that is not exactly 1 to 100 ids', async ({ request }) => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `e2e-id-${i}`)
  for (const ids of [[], many(101), [''], [1], 'x', null]) {
    const r = await read(request, dana, ids)
    expect(r.status, JSON.stringify(ids).slice(0, 40)).toBe(400)
    expect(r.json.error.code).toBe('invalid')
  }
  expect((await call(request, dana, 'POST', '/api/notifications/read', { json: { ids: [N.team], extra: 1 } })).status).toBe(400)
  expect((await read(request, dana, many(100))).status).toBe(200)
  expect((await call(request, dana, 'GET', '/api/notifications?limit=1')).status).toBe(400)
})
