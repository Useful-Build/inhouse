// The chat socket (p3-design section 3 route 34 and 4.10; acceptance 1 and 2). A WebSocket client with the test issuer's
// token and the app's own Origin (chat-kit.ts's Tab). The handshake refusals need no container; frames, two tabs, the
// reconnect and the closes by authority need a turn, so they run on the per-PR deployment (`needsContainer()`).
// Oracles, written from the design and never from the handler: no valid JWT is 401, a wrong Origin on the upgrade is 403
// (P2's rule that an upgrade carries the app's Origin); a run's frames reach every attached tab in the same order, seq 1, 2, 3
// with no gap and no repeat; two tabs sending into one chat give one `starting` turn and one `queued` turn, one run, and one
// ordered stream in which the second turn starts only after the first finished; a reconnect that attaches from the last seq it saw
// gets the rest, so the two sockets' frames together are one gapless sequence; removing a member closes their socket with
// 4401 and ending a support grant closes the Inhouse socket with 4403. Grant expiry is not tested here: the shortest grant is
// an hour and a deployed build has no clock to move; W1's unit tests cover the expiry task.
import { expect, test } from '@playwright/test'
import { actor, appOrigin, call, endLiveGrants, expectError, mint, newIdentity, personActor } from './kit.ts'
import { Tab, contiguousFrom, createChat, needsContainer, send, sendTurn, answerOf } from './chat-kit.ts'

const dana = actor('memberA')
const admin = actor('admin')
const inhouse = actor('inhouse')
test.describe.configure({ mode: 'serial' })

const UPGRADE = { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }

test.beforeAll(async ({ request }) => { await endLiveGrants(request) })
test.afterAll(async ({ request }) => { await endLiveGrants(request) })

test('the upgrade without a valid JWT is 401, and with a wrong Origin 403', async ({ request }) => {
  expect((await call(request, dana, 'GET', '/api/socket?v=1', { headers: UPGRADE, token: null, origin: appOrigin('brand') })).status).toBe(401)
  expect((await call(request, dana, 'GET', '/api/socket?v=1', { headers: UPGRADE, token: 'not-a-jwt', origin: appOrigin('brand') })).status).toBe(401)
  // A token for another application's audience is no sign-in here.
  expect((await call(request, dana, 'GET', '/api/socket?v=1', { headers: UPGRADE, token: await mint(dana, { aud: 'some-other-application' }), origin: appOrigin('brand') })).status).toBe(401)
  for (const origin of ['https://evil.example.test', 'http://brand.localhost.evil.test', appOrigin('inhouse')]) {
    const r = await call(request, dana, 'GET', '/api/socket?v=1', { headers: UPGRADE, origin })
    expect(r.status, origin).toBe(403)
  }
  // No Origin on an upgrade is refused too.
  expect((await call(request, dana, 'GET', '/api/socket?v=1', { headers: UPGRADE, origin: null })).status).toBe(403)
})

test('a plain GET to the socket route is 400: it only upgrades', async ({ request }) => {
  expectError(await call(request, dana, 'GET', '/api/socket?v=1'), 400, 'invalid')
})

test('a valid sign-in and the app\'s Origin open a socket; one with a wrong Origin never opens', async () => {
  const tab = await Tab.open(dana)
  expect(tab.closed).toBeNull()
  tab.close()
  await expect(Tab.open(dana, { origin: 'https://evil.example.test' })).rejects.toThrow('the socket did not open')
})

test('a run\'s frames reach an attached tab in order: seq 1, 2, 3, no gap, the turn\'s events in their place', async ({ request }) => {
  needsContainer()
  const chat = await createChat(request, dana)
  const tab = await Tab.open(dana)
  const sent = await send(request, dana, chat, 'scenario:hello frames please')
  tab.attach(sent.runId, 0)
  await tab.until(() => tab.turnFinished(sent.turnId), 'the turn to finish')
  const seqs = tab.seqs(sent.runId)
  expect(seqs).toEqual(contiguousFrom(seqs))
  const types = tab.types(sent.runId)
  expect(types.slice(0, 3)).toEqual(['run.started', 'turn.queued', 'turn.started'])
  expect(types.indexOf('part')).toBeGreaterThan(types.indexOf('turn.started'))
  expect(types.indexOf('turn.finished')).toBeGreaterThan(types.indexOf('part'))
  const text = tab.frames(sent.runId).filter(f => f.event.type === 'part').map(f => (f.event.part as { text?: string }).text).join('')
  expect(text).toBe('Hello from the scripted model.')
  expect(tab.messages.find(m => m.type === 'attached')).toMatchObject({ runId: sent.runId })
  tab.close()
})

test('another member\'s run can\'t be attached: the answer is a refusal, and no frame', async ({ request }) => {
  needsContainer()
  const chat = await createChat(request, dana)
  const sent = await send(request, dana, chat, 'scenario:hello mine')
  await answerOf(request, dana, chat, sent.turnId)
  const intruder = await Tab.open(admin)
  intruder.attach(sent.runId, 0)
  await intruder.until(() => intruder.messages.some(m => m.type === 'refused'), 'a refusal')
  expect(intruder.frames()).toEqual([])
  expect(intruder.messages.find(m => m.type === 'refused')).toMatchObject({ runId: sent.runId, code: expect.stringMatching(/^(not_found|forbidden)$/) })
  intruder.close()
})

test('two tabs sending into one chat give one writer: one run, one starting turn, one queued, one ordered stream', async ({ request }) => {
  needsContainer()
  const chat = await createChat(request, dana)
  const [one, two] = await Promise.all([Tab.open(dana), Tab.open(dana)])
  const [a, b] = await Promise.all([sendTurn(request, dana, chat, 'scenario:hello from tab one'), sendTurn(request, dana, chat, 'scenario:hello from tab two')])
  for (const r of [a, b]) expect([200, 201, 202], r.text).toContain(r.status)
  expect(a.json.runId).toBe(b.json.runId)
  expect([a.json.position, b.json.position].sort()).toEqual(['queued', 'starting'])
  const first = a.json.position === 'starting' ? a.json : b.json
  const second = a.json.position === 'starting' ? b.json : a.json
  const runId: string = first.runId
  one.attach(runId, 0)
  two.attach(runId, 0)
  for (const tab of [one, two]) await tab.until(() => tab.turnFinished(first.turnId) && tab.turnFinished(second.turnId), 'both turns to finish')
  // One ordered stream: both tabs saw the same frames in the same order, gapless.
  expect(one.frames(runId).map(f => f.seq)).toEqual(contiguousFrom(one.seqs(runId)))
  expect(two.frames(runId)).toEqual(one.frames(runId))
  // One writer: the second turn starts only after the first has finished.
  const at = (type: string, turnId: string) => one.frames(runId).findIndex(f => f.event.type === type && f.event.turnId === turnId)
  expect(at('turn.started', first.turnId)).toBeGreaterThanOrEqual(0)
  expect(at('turn.finished', first.turnId)).toBeGreaterThan(at('turn.started', first.turnId))
  expect(at('turn.started', second.turnId)).toBeGreaterThan(at('turn.finished', first.turnId))
  expect(at('turn.finished', second.turnId)).toBeGreaterThan(at('turn.started', second.turnId))
  one.close()
  two.close()
})

test('a reconnect that attaches from the last seq it saw gets the rest: no seq doubled, none dropped', async ({ request }) => {
  needsContainer()
  const chat = await createChat(request, dana)
  const first = await Tab.open(dana)
  // `write-output` has the most events: a tool step, a file, two parts.
  const sent = await send(request, dana, chat, 'scenario:write-output make the table')
  first.attach(sent.runId, 0)
  await first.until(() => first.seqs(sent.runId).length >= 3, 'three frames')
  const seen = first.seqs(sent.runId)
  const last = seen.at(-1)!
  first.close()
  await first.until(() => first.closed !== null, 'the first socket to close')
  const second = await Tab.open(dana)
  second.attach(sent.runId, last)
  await second.until(() => second.turnFinished(sent.turnId), 'the turn to finish')
  const rest = second.seqs(sent.runId)
  expect(rest[0]).toBe(last + 1)
  expect(rest).toEqual(contiguousFrom(rest, last + 1))
  // Together: one gapless sequence from 1, and a fresh attach from 0 sees the same total.
  const together = [...seen.filter(s => s <= last), ...rest]
  expect(together).toEqual(contiguousFrom(together))
  const whole = await Tab.open(dana)
  whole.attach(sent.runId, 0)
  await whole.until(() => whole.turnFinished(sent.turnId), 'the replay to finish')
  expect(whole.seqs(sent.runId)).toEqual(together)
  second.close()
  whole.close()
})

test('removing a member closes their socket with 4401', async ({ request }) => {
  const who = newIdentity('socket-removed')
  const invited = await call(request, admin, 'POST', '/api/members/invites', { json: { name: who.name, email: who.email, role: 'member' } })
  expect(invited.status, invited.text).toBe(201)
  expect((await call(request, personActor(who), 'GET', '/api/me')).status).toBe(200)
  const tab = await Tab.open(personActor(who))
  const removed = await call(request, admin, 'DELETE', `/api/members/${invited.json.id}?ifRev=${await currentRev(request, invited.json.id)}`)
  expect(removed.status, removed.text).toBe(200)
  await tab.until(() => tab.closed !== null, 'the socket to close')
  expect(tab.closed!.code).toBe(4401)
  // And a new socket for them is refused at the door.
  await expect(Tab.open(personActor(who))).rejects.toThrow('the socket did not open')
})

test('ending a support grant closes the Inhouse socket with 4403', async ({ request }) => {
  const grant = await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })
  expect(grant.status, grant.text).toBe(201)
  const tab = await Tab.open(inhouse)
  const ended = await call(request, admin, 'POST', `/api/grants/${grant.json.id}/end`, { json: { ifRev: grant.json.rev } })
  expect(ended.status, ended.text).toBe(200)
  await tab.until(() => tab.closed !== null, 'the socket to close')
  expect(tab.closed!.code).toBe(4403)
  // Without a grant the Inhouse team gets no socket.
  await expect(Tab.open(inhouse)).rejects.toThrow('the socket did not open')
})

async function currentRev(request: Parameters<typeof call>[0], id: string): Promise<number> {
  const r = await call(request, admin, 'GET', '/api/members?limit=100')
  expect(r.status, r.text).toBe(200)
  let page = r.json as { items: { id: string; rev: number }[]; nextCursor: string | null }
  for (let n = 0; n < 100; n++) {
    const found = page.items.find(m => m.id === id)
    if (found) return found.rev
    if (page.nextCursor === null) break
    page = (await call(request, admin, 'GET', `/api/members?limit=100&cursor=${encodeURIComponent(page.nextCursor)}`)).json
  }
  throw new Error(`member ${id} not found`)
}
