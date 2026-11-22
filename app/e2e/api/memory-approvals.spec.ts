// Team memory approval (P6a acceptance 4 to 6, routes 77 and 78). A waiting team fact becomes active only when an Admin
// (or the Inhouse team under a live grant) approves that exact revision; rejecting makes it forgotten. Oracles are the
// plan's text, written out here and never read from the server's rows: the fixtures are seeded into D1 against migration
// 0140's columns (no route makes a fact), and every expected status, rev and audit detail is a literal. The spec runs on
// the local test build; the one case that needs the agent to reword a fact also needs containers (E2E_WATCH_BUILD).
import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { actor, call, endLiveGrants, expectConflict, expectError, me, putSetting } from './kit.ts'
import type { Actor, Reply } from './kit.ts'
import { auditAfter, auditMax, expectOneLine, readSql, writeSql } from './db.ts'
import { answerOf, createChat, send } from './chat-kit.ts'
import { SEED_PEOPLE } from '../../server/seed/brand.ts'
import { needsLocalD1, needsWatchBuild } from './watch-kit.ts'
import { MEMORY_REWORD_TEAM_ID, MEMORY_REWORD_TEAM_TEXT } from '../../test/scripted-model/scenarios.ts'

const dana = actor('memberA')
const admin = actor('admin')
const inhouse = actor('inhouse')
test.describe.configure({ mode: 'serial' })

const mid = () => `mem_${randomBytes(16).toString('base64url')}`
const stamp = Date.now().toString(36)
const ids = { w1: mid(), w2: mid(), w3: mid(), w4: mid(), w5: mid(), staleWaiting: mid(), active: mid(), gone: mid(), person: mid() }
const text = (what: string) => `E2E approvals ${what} ${stamp}`
const T = {
  w1: text('older waiting'), w2: text('newer waiting'), w3: text('to approve'), w4: text('to reject'), w5: text('for the Inhouse team'),
  staleWaiting: text('stale'), active: text('already active'), gone: text('already forgotten'), person: text('Dana\'s own'),
}
const row = (id: string) => readSql<{ status: string; rev: number; text: string }>('SELECT status, rev, text FROM memories WHERE id = ?', id)[0]!

function seed(id: string, scope: 'brand' | 'person', owner: string | null, body: string, st: 'active' | 'waiting' | 'forgotten', createdBy: string, atMs: number, rev = 1) {
  writeSql('INSERT INTO memories (id, scope, owner_id, text, status, rev, created_by, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, scope, owner, body, st, rev, createdBy, atMs, atMs)
}

let danaId = ''
let adminId = ''
// The helpers use the running test's `request`, which each test stores first.
let holder: Parameters<typeof call>[0]
const request0 = () => holder
const approve = (who: Actor, id: string, approved: boolean, ifRev: number): Promise<Reply> => call(request0(), who, 'PUT', `/api/memory/brand/${id}/approved`, { json: { approved, ifRev } })
const waiting = async (who: Actor = admin): Promise<{ facts: { key: string; text: string; source: string; rev: number; kind: string; at: { ms: number } }[] }> => {
  const r = await call(request0(), who, 'GET', '/api/memory/waiting')
  expect(r.status, r.text).toBe(200)
  return r.json
}
const teamKeys = async (who: Actor): Promise<string[]> => {
  const r = await call(request0(), who, 'GET', '/api/memory')
  expect(r.status, r.text).toBe(200)
  return (r.json.team as { lines: { key: string }[] }[]).flatMap(g => g.lines.map(l => l.key))
}
const forbidden = (r: Reply): void => expect([r.status, r.json?.error?.code], r.text).toEqual([403, 'forbidden'])

test.beforeAll(async ({ request }) => {
  holder = request
  needsLocalD1()
  await endLiveGrants(request)
  expect((await putSetting(request, admin, 'brand', 'm:ask', null)).status).toBe(200)
  danaId = (await me(request, dana)).memberId
  adminId = (await me(request, admin)).memberId
  const now = Date.now()
  seed(ids.w1, 'brand', null, T.w1, 'waiting', danaId, now + 1)
  seed(ids.w2, 'brand', null, T.w2, 'waiting', danaId, now + 2)
  seed(ids.w3, 'brand', null, T.w3, 'waiting', danaId, now + 3)
  seed(ids.w4, 'brand', null, T.w4, 'waiting', danaId, now + 4)
  seed(ids.w5, 'brand', null, T.w5, 'waiting', danaId, now + 5)
  seed(ids.staleWaiting, 'brand', null, T.staleWaiting, 'waiting', danaId, now + 6, 3)
  seed(ids.active, 'brand', null, T.active, 'active', danaId, now + 7)
  seed(ids.gone, 'brand', null, T.gone, 'forgotten', danaId, now + 8)
  seed(ids.person, 'person', danaId, T.person, 'active', danaId, now + 9)
})
test.afterAll(async ({ request }) => {
  if (process.env.E2E_TEST_BUILD_REMOTE) return
  await endLiveGrants(request)
  for (const id of [...Object.values(ids), MEMORY_REWORD_TEAM_ID]) writeSql('DELETE FROM memories WHERE id = ?', id)
})

test('the waiting list is the team\'s waiting facts only, newest first, each with its text, source, time and rev', async ({ request }) => {
  holder = request
  const { facts } = await waiting()
  const mine = facts.filter(f => Object.values(ids).includes(f.key))
  expect(mine.map(f => f.key)).toEqual([ids.staleWaiting, ids.w5, ids.w4, ids.w3, ids.w2, ids.w1])
  for (const f of mine) {
    expect(f.kind).toBe('memory')
    expect(f.source, 'names who saved it').toContain(SEED_PEOPLE.dana.name)
    expect(f.at.ms).toBeGreaterThan(0)
  }
  expect(mine.map(f => f.text)).toEqual([T.staleWaiting, T.w5, T.w4, T.w3, T.w2, T.w1])
  expect(mine.map(f => f.rev)).toEqual([3, 1, 1, 1, 1, 1])
  const keys = facts.map(f => f.key)
  for (const never of [ids.active, ids.gone, ids.person]) expect(keys, 'an active, forgotten or person fact never waits').not.toContain(never)
  expect(facts.length).toBeLessThanOrEqual(200)
  // Route 43 and the Team memory page still never show a waiting fact (P3's rule is unchanged).
  for (const who of [dana, admin]) expect(await teamKeys(who)).not.toContain(ids.w1)
  expect(await teamKeys(admin)).toContain(ids.active)
  expect(Object.keys((await call(request, admin, 'GET', '/api/memory/waiting')).json)).toEqual(['facts'])
})

test('a Member can\'t read the waiting list or approve; nothing changes; no token is a 401; the list takes no query', async ({ request }) => {
  holder = request
  forbidden(await call(request, dana, 'GET', '/api/memory/waiting'))
  forbidden(await approve(dana, ids.w1, true, 1))
  forbidden(await approve(dana, ids.w1, false, 1))
  expect(row(ids.w1)).toMatchObject({ status: 'waiting', rev: 1 })
  expectError(await call(request, admin, 'GET', '/api/memory/waiting', { token: null }), 401, 'unauthorized')
  expectError(await call(request, admin, 'PUT', `/api/memory/brand/${ids.w1}/approved`, { token: null, json: { approved: true, ifRev: 1 } }), 401, 'unauthorized')
  const q = await call(request, admin, 'GET', '/api/memory/waiting?limit=5')
  expect([q.status, q.json?.error?.code]).toEqual([400, 'invalid'])
})

test('an Admin approves at the right ifRev: the fact is active at rev + 1, on the page for a Member, off the waiting list, one audit line with the id and the revision decided', async ({ request }) => {
  holder = request
  const mark = auditMax()
  const r = await approve(admin, ids.w3, true, 1)
  expect(r.status, r.text).toBe(200)
  expect(r.json).toMatchObject({ key: ids.w3, text: T.w3, rev: 2 })
  expect(row(ids.w3)).toMatchObject({ status: 'active', rev: 2 })
  expect(await teamKeys(dana)).toContain(ids.w3)
  expect((await waiting()).facts.map(f => f.key)).not.toContain(ids.w3)
  const line = expectOneLine(mark, 'memory.approved', adminId, [T.w3])
  expect(JSON.parse(line.args_json)).toEqual({ action: 'memory.approved', memoryId: ids.w3, rev: 1 })
  expect([line.target_kind, line.target_id]).toEqual(['memory', ids.w3])
})

test('an Admin rejects at the right ifRev: the fact is forgotten at rev + 1, on no page, off the waiting list; undoing it brings it back waiting, not active', async ({ request }) => {
  holder = request
  const mark = auditMax()
  const r = await approve(admin, ids.w4, false, 1)
  expect(r.status, r.text).toBe(200)
  expect(r.json).toMatchObject({ key: ids.w4, rev: 2 })
  expect(row(ids.w4)).toMatchObject({ status: 'forgotten', rev: 2 })
  for (const who of [dana, admin]) expect(await teamKeys(who)).not.toContain(ids.w4)
  expect((await waiting()).facts.map(f => f.key)).not.toContain(ids.w4)
  const line = expectOneLine(mark, 'memory.rejected', adminId, [T.w4])
  expect(JSON.parse(line.args_json)).toEqual({ action: 'memory.rejected', memoryId: ids.w4, rev: 1 })
  // Route 45's undo: waits again (an admin's OK), never active.
  const undo = await call(request, admin, 'PUT', `/api/memory/brand/${ids.w4}/forgotten`, { json: { forgotten: false, ifRev: 2 } })
  expect(undo.status, undo.text).toBe(200)
  expect(row(ids.w4)).toMatchObject({ status: 'waiting', rev: 3 })
  expect(await teamKeys(dana)).not.toContain(ids.w4)
  const back = (await waiting()).facts.find(f => f.key === ids.w4)
  expect(back, 'a restored fact is on the waiting list').toMatchObject({ text: T.w4, rev: 3 })
  // And it takes a fresh approval at its new rev.
  expect(expectConflict(await approve(admin, ids.w4, true, 2))).toMatchObject({ key: ids.w4, rev: 3 })
  expect((await approve(admin, ids.w4, true, 3)).status).toBe(200)
  expect(row(ids.w4)).toMatchObject({ status: 'active', rev: 4 })
})

test('a stale ifRev, or a fact that isn\'t waiting, is a 409 with the fact as it is now; nothing changes and no line is written', async ({ request }) => {
  holder = request
  const mark = auditMax()
  expect(expectConflict(await approve(admin, ids.staleWaiting, true, 1))).toMatchObject({ key: ids.staleWaiting, text: T.staleWaiting, rev: 3 })
  expect(expectConflict(await approve(admin, ids.staleWaiting, false, 2))).toMatchObject({ key: ids.staleWaiting, rev: 3 })
  expect(expectConflict(await approve(admin, ids.active, true, 1))).toMatchObject({ key: ids.active, rev: 1 })
  expect(expectConflict(await approve(admin, ids.active, false, 1))).toMatchObject({ key: ids.active, rev: 1 })
  expect(expectConflict(await approve(admin, ids.gone, true, 1))).toMatchObject({ key: ids.gone, rev: 1 })
  // A decided fact can't be decided twice (w3 was approved above).
  expect(expectConflict(await approve(admin, ids.w3, false, 2))).toMatchObject({ key: ids.w3, rev: 2 })
  expect(expectConflict(await approve(admin, ids.w3, true, 1))).toMatchObject({ key: ids.w3, rev: 2 })
  expect(row(ids.staleWaiting)).toMatchObject({ status: 'waiting', rev: 3 })
  expect(row(ids.active)).toMatchObject({ status: 'active', rev: 1 })
  expect(row(ids.gone)).toMatchObject({ status: 'forgotten', rev: 1 })
  expect(auditAfter(mark), 'a refused decision leaves no line').toEqual([])
  // Decided at the current rev it works.
  expect((await approve(admin, ids.staleWaiting, true, 3)).status).toBe(200)
  expect(row(ids.staleWaiting)).toMatchObject({ status: 'active', rev: 4 })
})

test('a person\'s fact, an unknown id and a malformed id are 404; a body that isn\'t exactly { approved, ifRev } is 400', async ({ request }) => {
  holder = request
  expectError(await approve(admin, ids.person, true, 1), 404, 'not_found')
  expectError(await approve(admin, mid(), true, 1), 404, 'not_found')
  expectError(await call(request, admin, 'PUT', '/api/memory/brand/not-an-id/approved', { json: { approved: true, ifRev: 1 } }), 404, 'not_found')
  expect(row(ids.person)).toMatchObject({ status: 'active', rev: 1 })
  for (const json of [{ approved: true }, { ifRev: 1 }, { approved: 'yes', ifRev: 1 }, { approved: true, ifRev: 0 }, { approved: true, ifRev: 1, extra: 1 }, { forgotten: true, ifRev: 1 }, {}]) {
    const r = await call(request, admin, 'PUT', `/api/memory/brand/${ids.w1}/approved`, { json })
    expect([r.status, r.json?.error?.code], JSON.stringify(json)).toEqual([400, 'invalid'])
  }
  expect(row(ids.w1)).toMatchObject({ status: 'waiting', rev: 1 })
})

test('the Inhouse team is refused without a grant, and under one reads the list and approves, each with its support.access line', async ({ request }) => {
  holder = request
  expectError(await call(request, inhouse, 'GET', '/api/memory/waiting'), 403, 'forbidden', 'grant_required')
  expectError(await approve(inhouse, ids.w5, true, 1), 403, 'forbidden', 'grant_required')
  expect(row(ids.w5)).toMatchObject({ status: 'waiting', rev: 1 })
  const grant = await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })
  expect(grant.status, grant.text).toBe(201)
  try {
    const mark = auditMax()
    expect((await waiting(inhouse)).facts.map(f => f.key)).toContain(ids.w5)
    const r = await approve(inhouse, ids.w5, true, 1)
    expect(r.status, r.text).toBe(200)
    expect(row(ids.w5)).toMatchObject({ status: 'active', rev: 2 })
    const lines = auditAfter(mark)
    expect(lines.map(l => l.action).sort()).toEqual(['memory.approved', 'support.access', 'support.access'])
    const access = lines.filter(l => l.action === 'support.access').map(l => JSON.parse(l.args_json))
    expect(access).toEqual([
      { action: 'support.access', grantId: grant.json.id, method: 'GET', route: '/api/memory/waiting' },
      { action: 'support.access', grantId: grant.json.id, method: 'PUT', route: '/api/memory/brand/:id/approved' },
    ])
    const decided = lines.find(l => l.action === 'memory.approved')!
    expect(decided.actor_id, 'the Inhouse team\'s own member id').toBe((await me(request, inhouse)).memberId)
    expect([decided.target_kind, decided.target_id]).toEqual(['memory', ids.w5])
    expect(JSON.parse(decided.args_json)).toEqual({ action: 'memory.approved', memoryId: ids.w5, rev: 1 })
    expect(decided.args_json).not.toContain(T.w5)
  } finally {
    await endLiveGrants(request)
  }
  // The grant ended: refused again.
  expectError(await approve(inhouse, ids.w1, true, 1), 403, 'forbidden', 'grant_required')
  expect(row(ids.w1)).toMatchObject({ status: 'waiting', rev: 1 })
})

test('an agent\'s reword sends an approved team fact back to waiting; approving the old revision is a conflict that shows the new wording', async ({ request }) => {
  needsWatchBuild()
  holder = request
  test.setTimeout(300_000)
  const old = 'E2E approvals the reworded fact: we restock on Fridays.'
  writeSql('DELETE FROM memories WHERE id = ?', MEMORY_REWORD_TEAM_ID)
  seed(MEMORY_REWORD_TEAM_ID, 'brand', null, old, 'active', danaId, Date.now() - 500)
  const chat = await createChat(request, dana)
  const sent = await send(request, dana, chat, 'scenario:memory-reword-team we restock on Thursdays now')
  await answerOf(request, dana, chat, sent.turnId, 150_000)
  expect(row(MEMORY_REWORD_TEAM_ID)).toEqual({ status: 'waiting', rev: 2, text: MEMORY_REWORD_TEAM_TEXT })
  expect(await teamKeys(dana), 'the reworded fact leaves the page until an admin approves').not.toContain(MEMORY_REWORD_TEAM_ID)
  const seen = (await waiting()).facts.find(f => f.key === MEMORY_REWORD_TEAM_ID)
  expect(seen, 'it is on the waiting list with the new wording at rev 2').toMatchObject({ text: MEMORY_REWORD_TEAM_TEXT, rev: 2 })
  // An admin's page from before the reword still holds rev 1.
  const stale = expectConflict(await approve(admin, MEMORY_REWORD_TEAM_ID, true, 1))
  expect(stale).toMatchObject({ key: MEMORY_REWORD_TEAM_ID, text: MEMORY_REWORD_TEAM_TEXT, rev: 2 })
  expect((await approve(admin, MEMORY_REWORD_TEAM_ID, true, 2)).status).toBe(200)
  expect(row(MEMORY_REWORD_TEAM_ID)).toMatchObject({ status: 'active', rev: 3 })
  expect(await teamKeys(dana)).toContain(MEMORY_REWORD_TEAM_ID)
})
