// Support grants (BD7, p2-design section 9): create, a second create while one is live, end (access refused on the very
// next request), expiry (a grant the test build's prepare step made already past its end: its `grant.expired` line is
// written once, by the first request that reads grants or the audit log), and the audit log showing each step.
import { expect, test } from '@playwright/test'
import { auditText } from '../../shared/audit-text.ts'
import { actor, allPages, call, endLiveGrants, expectConflict, expectError, me } from './kit.ts'
import { auditAfter, auditMax } from './db.ts'

const admin = actor('admin')
const alex = actor('inhouse')

test.describe.configure({ mode: 'serial' })
test.beforeAll(async ({ request }) => { await endLiveGrants(request) })
test.afterAll(async ({ request }) => { await endLiveGrants(request) })

test('an Admin gives a grant of 1 hour: live, with its end an hour on, audited as grant.created', async ({ request }) => {
  const mark = auditMax()
  const adminId = (await me(request, admin)).memberId
  const r = await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })
  expect(r.status, r.text).toBe(201)
  expect(r.json).toMatchObject({ createdBy: adminId, endedAt: null, endedBy: null, rev: 1, live: true })
  expect(r.json.endsAt.ms - r.json.createdAt.ms).toBe(3_600_000)
  expect(r.json.id).toMatch(/^g_/)
  const lines = auditAfter(mark)
  expect(lines.map(l => l.action)).toEqual(['grant.created'])
  expect(lines[0].actor_id).toBe(adminId)
  expect(JSON.parse(lines[0].args_json)).toMatchObject({ grantId: r.json.id, hours: 1 })
  // GET /api/grants lists it live, for the Admin and for the Inhouse team.
  for (const who of [admin, alex]) {
    const list = await call(request, who, 'GET', '/api/grants')
    expect(list.json.items.find((g: { id: string }) => g.id === r.json.id)).toMatchObject({ live: true })
  }
})

test('only an Admin gives a grant, only for 1, 4, 24 or 72 hours', async ({ request }) => {
  await endLiveGrants(request)
  for (const hours of [4, 24, 72]) {
    const r = await call(request, admin, 'POST', '/api/grants', { json: { hours } })
    expect(r.status, r.text).toBe(201)
    expect(r.json.endsAt.ms - r.json.createdAt.ms, `${hours} hours`).toBe(hours * 3_600_000)
    await endLiveGrants(request)
  }
  const mark = auditMax()
  for (const who of ['memberA', 'inhouse', 'smoke'] as const) expectError(await call(request, actor(who), 'POST', '/api/grants', { json: { hours: 1 } }), 403, 'forbidden')
  for (const hours of [0, 2, 5, 100, '1', null]) expectError(await call(request, admin, 'POST', '/api/grants', { json: { hours } }), 400, 'invalid')
  expectError(await call(request, admin, 'POST', '/api/grants', { json: { hours: 1, extra: true } }), 400, 'invalid')
  expect(auditAfter(mark), 'a refused grant writes nothing').toEqual([])
})

test('a second create while one is live is 409 grant_live and writes no line', async ({ request }) => {
  await endLiveGrants(request)
  const first = await call(request, admin, 'POST', '/api/grants', { json: { hours: 4 } })
  expect(first.status, first.text).toBe(201)
  const mark = auditMax()
  expectError(await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } }), 409, 'conflict', 'grant_live')
  expect(auditAfter(mark)).toEqual([])
  const live = (await call(request, admin, 'GET', '/api/grants')).json.items.filter((g: { live: boolean }) => g.live)
  expect(live.map((g: { id: string }) => g.id)).toEqual([first.json.id])
  await endLiveGrants(request)
})

test('ending a grant refuses the Inhouse team on its very next request, and each step is in the audit log', async ({ request }) => {
  await endLiveGrants(request)
  const mark = auditMax()
  const adminId = (await me(request, admin)).memberId
  const made = await call(request, admin, 'POST', '/api/grants', { json: { hours: 24 } })
  expect(made.status, made.text).toBe(201)
  const alexId = (await me(request, alex)).memberId
  expect((await call(request, alex, 'GET', '/api/members')).status).toBe(200)
  expect((await call(request, alex, 'GET', '/api/audit')).status).toBe(200)

  // A stale rev ends nothing; a Member and the Inhouse team can't end it.
  expectConflict(await call(request, admin, 'POST', `/api/grants/${made.json.id}/end`, { json: { ifRev: made.json.rev + 1 } }))
  for (const who of ['memberA', 'inhouse'] as const) expectError(await call(request, actor(who), 'POST', `/api/grants/${made.json.id}/end`, { json: { ifRev: made.json.rev } }), 403, 'forbidden')
  expect((await call(request, alex, 'GET', '/api/members')).status, 'still live').toBe(200)

  const ended = await call(request, admin, 'POST', `/api/grants/${made.json.id}/end`, { json: { ifRev: made.json.rev } })
  expect(ended.status, ended.text).toBe(200)
  expect(ended.json).toMatchObject({ id: made.json.id, live: false, endedBy: adminId, rev: made.json.rev + 1 })
  expect(ended.json.endedAt.ms).toBeLessThan(ended.json.endsAt.ms)

  for (const path of ['/api/members', '/api/audit', '/api/audit/export.csv']) expectError(await call(request, alex, 'GET', path), 403, 'forbidden', 'grant_required')
  expect((await me(request, alex)).grant).toBeNull()
  // Ending it again changes nothing and adds no line.
  const again = await call(request, admin, 'POST', `/api/grants/${made.json.id}/end`, { json: { ifRev: ended.json.rev } })
  expect(again.status, again.text).toBeGreaterThanOrEqual(400)
  expect(again.status).toBeLessThan(500)

  const lines = auditAfter(mark).filter(l => JSON.parse(l.args_json).grantId === made.json.id)
  expect(lines.map(l => l.action)).toEqual(['grant.created', 'support.access', 'support.access', 'support.access', 'grant.ended'])
  expect(lines.map(l => l.actor_id)).toEqual([adminId, alexId, alexId, alexId, adminId])
})

test('the audit log shows grant.created, support.access, grant.ended and grant.expired', async ({ request }) => {
  test.skip(!!process.env.E2E_TEST_BUILD_REMOTE, 'its support.access and grant.expired lines come from tests that need the local D1 or prepare step; proven by the local test-build suite')
  const { items } = await allPages<{ what: string }>(request, admin, '/api/audit', 100)
  const said = new Set(items.map(i => i.what))
  const g = 'g_shape_only'
  for (const args of [
    { action: 'grant.created', grantId: g, hours: 1 }, { action: 'support.access', grantId: g, method: 'GET', route: '/api/audit' },
    { action: 'grant.ended', grantId: g }, { action: 'grant.expired', grantId: g },
  ] as const) {
    expect(said, args.action).toContain(auditText(args, () => null).what)
  }
})
