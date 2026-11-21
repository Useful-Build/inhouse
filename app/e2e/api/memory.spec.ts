// Memory (p3-design sections 3 and 10, routes 43 to 45). No route makes a fact (only the agent's tools write memory, and
// a model can't run on the test build), so the facts are seeded into D1 against migration 0140's columns; the spec runs on
// the local test build and skips on a deployed one. Oracles: design 10's visibility rule (active team facts and the member's
// own active facts; nothing waiting, forgotten or another member's), person facts only by their owner (anyone else's is
// 404, the Admin's included), a team fact only by an Admin, a stale `ifRev` is a 409 with the line as it is now, and
// undoing a forget returns a team fact to `waiting` (an admin's OK again) and a person's fact to `active`.
import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call, endLiveGrants, expectConflict, expectError, me } from './kit.ts'
import { readSql, writeSql } from './db.ts'

const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
const inhouse = actor('inhouse')
test.describe.configure({ mode: 'serial' })

const mid = () => `mem_${randomBytes(16).toString('base64url')}`
const ids = { teamActive: mid(), teamWaiting: mid(), teamGone: mid(), danaActive: mid(), danaGone: mid(), leoActive: mid(), adminActive: mid() }
const status = (id: string) => readSql<{ status: string; rev: number }>('SELECT status, rev FROM memories WHERE id = ?', id)[0]!

function seed(id: string, scope: 'brand' | 'person', owner: string | null, text: string, st: 'active' | 'waiting' | 'forgotten') {
  const now = Date.now()
  writeSql('INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, scope, owner, text, st, owner ?? 'e2e', now, now)
}

test.beforeAll(async ({ request }) => {
  await endLiveGrants(request)
  const [d, l, a] = await Promise.all([me(request, dana), me(request, leo), me(request, admin)])
  seed(ids.teamActive, 'brand', null, 'E2E team fact: returns within 45 days.', 'active')
  seed(ids.teamWaiting, 'brand', null, 'E2E team fact waiting for an admin.', 'waiting')
  seed(ids.teamGone, 'brand', null, 'E2E team fact already forgotten.', 'forgotten')
  seed(ids.danaActive, 'person', d.memberId, 'E2E Dana prefers a table.', 'active')
  seed(ids.danaGone, 'person', d.memberId, 'E2E Dana old preference.', 'forgotten')
  seed(ids.leoActive, 'person', l.memberId, 'E2E Leo prefers bullets.', 'active')
  seed(ids.adminActive, 'person', a.memberId, 'E2E Admin note.', 'active')
})
test.afterAll(async ({ request }) => {
  if (process.env.E2E_TEST_BUILD_REMOTE) return // nothing was seeded: writeSql skips there, and a skip inside a hook is not relied on
  await endLiveGrants(request)
  for (const id of Object.values(ids)) writeSql('DELETE FROM memories WHERE id = ?', id)
})

const keys = (page: { team: { lines: { key: string }[] }[]; personal: { key: string }[] }) => ({
  team: page.team.flatMap(g => g.lines.map(l => l.key)),
  personal: page.personal.map(l => l.key),
})
const read = async (request: APIRequestContext, who: typeof dana) => {
  const r = await call(request, who, 'GET', '/api/memory')
  expect(r.status, r.text).toBe(200)
  return r.json
}
const forget = (request: APIRequestContext, who: typeof dana, scope: 'personal' | 'brand', id: string, forgotten: boolean, ifRev: number) =>
  call(request, who, 'PUT', `/api/memory/${scope}/${id}/forgotten`, { json: { forgotten, ifRev } })

test('GET /api/memory shows active team facts and the caller\'s own, never waiting, forgotten or another member\'s', async ({ request }) => {
  const d = keys(await read(request, dana))
  expect(d.team).toContain(ids.teamActive)
  expect(d.team).not.toContain(ids.teamWaiting)
  expect(d.team).not.toContain(ids.teamGone)
  expect(d.personal).toEqual(expect.arrayContaining([ids.danaActive]))
  for (const other of [ids.danaGone, ids.leoActive, ids.adminActive]) expect([...d.team, ...d.personal]).not.toContain(other)
  const l = keys(await read(request, leo))
  expect(l.personal).toContain(ids.leoActive)
  expect(l.personal).not.toContain(ids.danaActive)
  const a = keys(await read(request, admin))
  expect(a.personal).toContain(ids.adminActive)
  expect([...a.team, ...a.personal]).not.toContain(ids.danaActive)
  // A line carries its scope and rev.
  const line = (await read(request, dana)).personal.find((x: { key: string }) => x.key === ids.danaActive)
  expect(line).toMatchObject({ text: 'E2E Dana prefers a table.', scope: 'person', rev: 1 })
})

test('Inhouse is refused without a live grant and, under one, reads the team lines but none of a member\'s own', async ({ request }) => {
  expectError(await call(request, inhouse, 'GET', '/api/memory'), 403, 'forbidden', 'grant_required')
  const grant = await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })
  expect(grant.status, grant.text).toBe(201)
  const page = keys(await read(request, inhouse))
  expect(page.team).toContain(ids.teamActive)
  expect([...page.team, ...page.personal]).not.toEqual(expect.arrayContaining([ids.danaActive]))
  await endLiveGrants(request)
})

test('a member forgets their own fact, it leaves the page, and undoing brings it back at once', async ({ request }) => {
  const f = await forget(request, dana, 'personal', ids.danaActive, true, 1)
  expect(f.status, f.text).toBe(200)
  expect(f.json).toMatchObject({ key: ids.danaActive, forgotten: true, rev: 2 })
  expect(status(ids.danaActive)).toEqual({ status: 'forgotten', rev: 2 })
  expect(keys(await read(request, dana)).personal).not.toContain(ids.danaActive)
  const u = await forget(request, dana, 'personal', ids.danaActive, false, 2)
  expect(u.status, u.text).toBe(200)
  expect(u.json).toMatchObject({ key: ids.danaActive, rev: 3 })
  expect(u.json.forgotten).not.toBe(true)
  expect(status(ids.danaActive)).toEqual({ status: 'active', rev: 3 })
  expect(keys(await read(request, dana)).personal).toContain(ids.danaActive)
})

test('a stale ifRev is a 409 with the line as it is now, and changes nothing', async ({ request }) => {
  const current = expectConflict(await forget(request, dana, 'personal', ids.danaActive, true, 1))
  expect(current).toMatchObject({ key: ids.danaActive, rev: 3 })
  expect(status(ids.danaActive).status).toBe('active')
})

test('route 44 is the owner\'s alone: another member, the Admin and a team fact\'s id get 404', async ({ request }) => {
  for (const who of [leo, admin]) expectError(await forget(request, who, 'personal', ids.danaActive, true, 3), 404, 'not_found')
  expectError(await forget(request, dana, 'personal', ids.teamActive, true, 1), 404, 'not_found')
  expectError(await forget(request, dana, 'personal', mid(), true, 1), 404, 'not_found')
  expectError(await call(request, dana, 'PUT', '/api/memory/personal/not-an-id/forgotten', { json: { forgotten: true, ifRev: 1 } }), 404, 'not_found')
  expect(status(ids.danaActive).status).toBe('active')
})

test('route 44 refuses a body that isn\'t exactly { forgotten, ifRev }', async ({ request }) => {
  for (const json of [{ forgotten: true }, { ifRev: 3 }, { forgotten: 'yes', ifRev: 3 }, { forgotten: true, ifRev: 0 }, { forgotten: true, ifRev: 3, extra: 1 }]) {
    const r = await call(request, dana, 'PUT', `/api/memory/personal/${ids.danaActive}/forgotten`, { json })
    expect(r.status, JSON.stringify(json)).toBe(400)
    expect(r.json.error.code).toBe('invalid')
  }
  expect(status(ids.danaActive).rev).toBe(3)
})

test('route 45: only an Admin forgets a team fact; undoing returns it to waiting, not to the page', async ({ request }) => {
  expectError(await forget(request, dana, 'brand', ids.teamActive, true, 1), 403, 'forbidden')
  expect(status(ids.teamActive).status).toBe('active')
  const f = await forget(request, admin, 'brand', ids.teamActive, true, 1)
  expect(f.status, f.text).toBe(200)
  expect(f.json).toMatchObject({ key: ids.teamActive, forgotten: true, rev: 2 })
  expect(keys(await read(request, dana)).team).not.toContain(ids.teamActive)
  const u = await forget(request, admin, 'brand', ids.teamActive, false, 2)
  expect(u.status, u.text).toBe(200)
  expect(status(ids.teamActive)).toEqual({ status: 'waiting', rev: 3 })
  expect(keys(await read(request, dana)).team).not.toContain(ids.teamActive)
})

test('route 45 is for team facts only: a person\'s fact id is 404 and a stale rev is a 409', async ({ request }) => {
  expectError(await forget(request, admin, 'brand', ids.danaActive, true, 3), 404, 'not_found')
  expectError(await forget(request, admin, 'brand', mid(), true, 1), 404, 'not_found')
  const current = expectConflict(await forget(request, admin, 'brand', ids.teamActive, true, 1))
  expect(current).toMatchObject({ key: ids.teamActive, rev: 3 })
})
