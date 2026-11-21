// Turns, runs and traces (p3-design sections 3 and 4.3, routes 29 to 33). Two kinds of test:
//   - no container: the refusals that come before any run (an unknown or another member's chat, a bad body), the runs list of
//     someone with nothing running, and ids no turn has. These run on the local test build too.
//   - a container (`needsContainer()`: the per-PR deployment, E2E_TEST_BUILD_REMOTE): a turn on the scripted model's scenarios
//     (app/test/scripted-model/scenarios.ts): the answer, the trace, the idempotent send, who may read a trace, a stop or
//     interrupt on an ended turn, and a WebFetch through the sandbox (allowed and refused). No real model is called.
// Every refusal is asserted on its whole body, `{ error: { code, reason? } }` (p2-design section 4: a 400 carries no reason).
// Oracles: design section 3's table (owner 404 before the object check, Inhouse only under a grant), 4.3 (the same
// `(chatId, clientTurnKey)` and payload answers the original turn; another payload is `conflict`/`key_reused`; an ended or
// stale turn is `conflict`/`turn_ended`) and 4.5's step labels (`Reading a web page` for WebFetch).
import { expect, test } from '@playwright/test'
import { actor, call, endLiveGrants, expectError } from './kit.ts'
import { answerOf, createChat, needsContainer, newChatId, send, sendTurn, textOf } from './chat-kit.ts'

const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
const inhouse = actor('inhouse')
test.describe.configure({ mode: 'serial' })

const RUN_ID = /^r_[A-Za-z0-9_-]{22}$/
const TURN_ID = /^t_[A-Za-z0-9_-]{22}$/
const NO_TURN = 't_AAAAAAAAAAAAAAAAAAAAAA'
const NO_RUN = 'r_AAAAAAAAAAAAAAAAAAAAAA'

test.beforeAll(async ({ request }) => { await endLiveGrants(request) })
test.afterAll(async ({ request }) => { await endLiveGrants(request) })

test('a member with nothing running sees an empty runs list (the Admin sends nothing in these specs)', async ({ request }) => {
  const r = await call(request, admin, 'GET', '/api/runs/active')
  expect(r.status, r.text).toBe(200)
  expect(r.json).toEqual({ runs: [] })
})

test('a trace, interrupt or stop for an id no turn has is 404, for every role that may ask', async ({ request }) => {
  for (const id of [NO_TURN, NO_RUN, 'x', 'r_short']) for (const who of [dana, admin]) expectError(await call(request, who, 'GET', `/api/traces/${id}`), 404, 'not_found')
  for (const action of ['interrupt', 'stop']) for (const who of [dana, admin]) expectError(await call(request, who, 'POST', `/api/turns/${NO_TURN}/${action}`, { json: {} }), 404, 'not_found')
})

test('a send into an unknown chat or another member\'s chat is 404, the Admin\'s included', async ({ request }) => {
  const mine = await createChat(request, dana)
  expectError(await sendTurn(request, dana, newChatId(), 'scenario:hello hi'), 404, 'not_found')
  for (const other of [leo, admin]) expectError(await sendTurn(request, other, mine, 'scenario:hello hi'), 404, 'not_found')
  // None of those started a run.
  expect((await call(request, dana, 'GET', `/api/chats/${mine}`)).json).toMatchObject({ messages: [], runs: [] })
})

test('a bad send is 400 before any run: an empty text, a bad key, a model nobody has, a text over the cap', async ({ request }) => {
  const chat = await createChat(request, dana)
  const bad: Record<string, unknown>[] = [
    { text: '' }, { clientTurnKey: 'short' }, { clientTurnKey: 'has spaces in it here' }, { model: 'no-such-model' }, { model: '' }, { text: 'x'.repeat(200_000) },
    { priority: 'urgent' }, { attachments: [{ fileId: 'f_not_a_file', name: 'a.txt' }] },
  ]
  for (const extra of bad) {
    expectError(await sendTurn(request, dana, chat, 'scenario:hello hi', extra), 400, 'invalid')
  }
  expect((await call(request, dana, 'GET', `/api/chats/${chat}`)).json).toMatchObject({ messages: [], runs: [] })
})

test('a turn runs: 2xx with the ids, the answer is stored, the trace has the run\'s steps', async ({ request }) => {
  needsContainer()
  const chat = await createChat(request, dana)
  const sent = await send(request, dana, chat, 'scenario:hello say hello')
  expect(sent).toMatchObject({ runId: expect.stringMatching(RUN_ID), turnId: expect.stringMatching(TURN_ID), position: 'starting' })
  expect(sent.messageId).toBe(`${sent.turnId}.u`)
  const answer = await answerOf(request, dana, chat, sent.turnId)
  expect(textOf(answer)).toBe('Hello from the scripted model.')
  // The history holds the user's message, with the text as sent, and the agent's part, both on this turn and run.
  const page = (await call(request, dana, 'GET', `/api/chats/${chat}`)).json
  expect(page.messages.find((m: { id: string }) => m.id === sent.messageId)).toMatchObject({ role: 'user', text: 'scenario:hello say hello', turnId: sent.turnId, runId: sent.runId })
  expect(page.messages.find((m: { role: string }) => m.role === 'agent')).toMatchObject({ turnId: sent.turnId, runId: sent.runId, part: { type: 'text', text: 'Hello from the scripted model.' } })
  // Both ids read a trace: a root step first, a model step for the one call, a cost in USD.
  for (const id of [sent.turnId, sent.runId]) {
    const t = await call(request, dana, 'GET', `/api/traces/${id}`)
    expect(t.status, t.text).toBe(200)
    expect(t.json).toMatchObject({ id, cost: { currency: 'USD' } })
    expect(t.json.steps[0]).toMatchObject({ kind: 'root', depth: 0 })
    expect(t.json.steps.filter((s: { kind: string }) => s.kind === 'model').length).toBeGreaterThanOrEqual(1)
  }
  expect((await call(request, dana, 'GET', '/api/chats')).json.items.find((c: { id: string }) => c.id === chat)).toMatchObject({ id: chat })
})

test('the same key and payload answers the same turn; the same key with another payload is key_reused', async ({ request }) => {
  needsContainer()
  const chat = await createChat(request, dana)
  const key = 'e2e-key-reuse-0001'
  const first = await sendTurn(request, dana, chat, 'scenario:hello first', { clientTurnKey: key })
  expect([200, 201, 202], first.text).toContain(first.status)
  const retry = await sendTurn(request, dana, chat, 'scenario:hello first', { clientTurnKey: key })
  expect(retry.status, retry.text).toBe(first.status)
  expect(retry.json).toEqual(first.json)
  expectError(await sendTurn(request, dana, chat, 'scenario:hello another', { clientTurnKey: key }), 409, 'conflict', 'key_reused')
  await answerOf(request, dana, chat, first.json.turnId)
  // One user message, not two: the retry made no second turn.
  const users = (await call(request, dana, 'GET', `/api/chats/${chat}`)).json.messages.filter((m: { role: string }) => m.role === 'user')
  expect(users).toHaveLength(1)
})

test('a trace is its owner\'s: other members get 404, Inhouse needs a live grant', async ({ request }) => {
  needsContainer()
  const chat = await createChat(request, dana)
  const sent = await send(request, dana, chat, 'scenario:hello trace me')
  await answerOf(request, dana, chat, sent.turnId)
  for (const id of [sent.turnId, sent.runId]) {
    for (const other of [leo, admin]) expectError(await call(request, other, 'GET', `/api/traces/${id}`), 404, 'not_found')
    expectError(await call(request, inhouse, 'GET', `/api/traces/${id}`), 403, 'forbidden', 'grant_required')
  }
  expect((await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })).status).toBe(201)
  expect((await call(request, inhouse, 'GET', `/api/traces/${sent.turnId}`)).status).toBe(200)
  await endLiveGrants(request)
})

test('interrupt and stop on an ended turn are conflict/turn_ended, and on another member\'s turn 404', async ({ request }) => {
  needsContainer()
  const chat = await createChat(request, dana)
  const sent = await send(request, dana, chat, 'scenario:hello done soon')
  await answerOf(request, dana, chat, sent.turnId)
  for (const action of ['interrupt', 'stop']) {
    expectError(await call(request, dana, 'POST', `/api/turns/${sent.turnId}/${action}`, { json: {} }), 409, 'conflict', 'turn_ended')
    for (const other of [leo, admin]) expectError(await call(request, other, 'POST', `/api/turns/${sent.turnId}/${action}`, { json: {} }), 404, 'not_found')
  }
})

// Note for Q2: `webfetch-allowed` fetches https://example.com/ from the sandbox, so it needs that site reachable from there.
test('WebFetch through the sandbox: an allowed page and a refused address each show one "Reading a web page" step', async ({ request }) => {
  needsContainer()
  for (const [scenario, answerText] of [['webfetch-allowed', 'Read the page.'], ['webfetch-refused', 'The page could not be read.']] as const) {
    const chat = await createChat(request, dana)
    const sent = await send(request, dana, chat, `scenario:${scenario} read the page`)
    expect(textOf(await answerOf(request, dana, chat, sent.turnId))).toBe(answerText)
    const steps = (await call(request, dana, 'GET', `/api/traces/${sent.turnId}`)).json.steps as { kind: string; label: string; detail: string }[]
    expect(steps.filter(s => s.kind === 'tool')).toEqual([expect.objectContaining({ label: 'Reading a web page', detail: 'WebFetch' })])
  }
})
