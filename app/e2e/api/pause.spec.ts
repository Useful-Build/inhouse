// Pause and resume (p3-design sections 3 and 4.11, routes 35 to 37; acceptance 9). Oracles: an Admin or, in an emergency, the
// Inhouse team pauses with no grant (item 19); a Member can read the state but not change it; nothing new is admitted while
// paused (a send is `forbidden` with reason `paused`, section 4.3); resuming starts nothing; each change writes its audit
// line. No container needed: a paused send is refused before any run. What a container run adds (a live turn stopped by a
// pause) needs a scenario that stays live, which the scripted model doesn't have yet; the PR body says so.
import { expect, test } from '@playwright/test'
import { actor, call, endLiveGrants, expectError, me } from './kit.ts'
import { readSql } from './db.ts'
import { createChat, sendTurn } from './chat-kit.ts'

const admin = actor('admin')
const dana = actor('memberA')
const inhouse = actor('inhouse')
test.describe.configure({ mode: 'serial' })

const state = async (request: Parameters<typeof call>[0], who = dana) => {
  const r = await call(request, who, 'GET', '/api/pause')
  expect(r.status, r.text).toBe(200)
  return r.json as { paused: boolean; at: { iso: string; ms: number } | null; by: string | null }
}
const resume = async (request: Parameters<typeof call>[0]) => expect((await call(request, admin, 'POST', '/api/resume', { json: {} })).status).toBe(200)

test.beforeAll(async ({ request }) => { await endLiveGrants(request); await resume(request) })
test.afterAll(async ({ request }) => { await resume(request); await endLiveGrants(request) })

test('the brand is not paused, and every role reads the state', async ({ request }) => {
  for (const who of [dana, admin]) expect((await state(request, who)).paused).toBe(false)
  // Inhouse reads it with no grant (baseline row).
  expect((await call(request, inhouse, 'GET', '/api/pause')).status).toBe(200)
})

test('a Member can\'t pause or resume; an Admin pauses, and everyone then reads who and when', async ({ request }) => {
  expectError(await call(request, dana, 'POST', '/api/pause', { json: {} }), 403, 'forbidden')
  expectError(await call(request, dana, 'POST', '/api/resume', { json: {} }), 403, 'forbidden')
  expect((await state(request)).paused).toBe(false)
  const adminId = (await me(request, admin)).memberId
  const paused = await call(request, admin, 'POST', '/api/pause', { json: {} })
  expect(paused.status, paused.text).toBe(200)
  expect(paused.json).toMatchObject({ paused: true, by: adminId, at: { ms: expect.any(Number) } })
  for (const who of [dana, admin]) expect(await state(request, who)).toEqual(paused.json)
  // The body is `{}` and nothing else.
  expect((await call(request, admin, 'POST', '/api/pause', { json: { reason: 'x' } })).status).toBe(400)
  await resume(request)
  expect((await state(request)).paused).toBe(false)
})

test('while paused a send is refused with reason paused, and resuming starts no run on its own', async ({ request }) => {
  const chat = await createChat(request, dana)
  expect((await call(request, admin, 'POST', '/api/pause', { json: {} })).status).toBe(200)
  const refused = await sendTurn(request, dana, chat, 'scenario:hello are you there?')
  expectError(refused, 403, 'forbidden', 'paused')
  // The refusal left no turn behind: no run, no message.
  expect((await call(request, dana, 'GET', '/api/runs/active')).json).toEqual({ runs: [] })
  expect((await call(request, dana, 'GET', `/api/chats/${chat}`)).json).toMatchObject({ messages: [], runs: [] })
  await resume(request)
  // Resume admits new sends again but starts nothing by itself: the refused text is not sent again.
  expect((await call(request, dana, 'GET', '/api/runs/active')).json).toEqual({ runs: [] })
  expect((await call(request, dana, 'GET', `/api/chats/${chat}`)).json).toMatchObject({ messages: [], runs: [] })
})

test('the Inhouse team pauses and resumes in an emergency with no grant, as the actor of the change', async ({ request }) => {
  const alexId = (await me(request, inhouse)).memberId
  const paused = await call(request, inhouse, 'POST', '/api/pause', { json: {} })
  expect(paused.status, paused.text).toBe(200)
  expect(paused.json).toMatchObject({ paused: true, by: alexId })
  expect((await state(request)).by).toBe(alexId)
  const resumed = await call(request, inhouse, 'POST', '/api/resume', { json: {} })
  expect(resumed.status, resumed.text).toBe(200)
  expect(resumed.json.paused).toBe(false)
})

test('each pause and each resume writes its audit line with the actor (local database only)', async ({ request }) => {
  const adminId = (await me(request, admin)).memberId
  const before = readSql<{ n: number }>("SELECT COALESCE(MAX(id), 0) AS n FROM audit_log")[0]!.n
  await call(request, admin, 'POST', '/api/pause', { json: {} })
  await resume(request)
  const lines = readSql<{ action: string; actor_id: string }>("SELECT action, actor_id FROM audit_log WHERE id > ? AND action IN ('agent.paused', 'agent.resumed') ORDER BY id", before)
  expect(lines.map(l => l.action)).toEqual(['agent.paused', 'agent.resumed'])
  expect(lines.every(l => l.actor_id === adminId)).toBe(true)
})
