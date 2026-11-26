// The canary-token test (P5 W5, acceptance 3). The fake Slack issues the canaries as its access tokens (and, with rotation on,
// its refresh tokens: `xoxe-test-`/`xoxp-test-` shaped), the recorded Shopify issues `shpat_test_<n>`, and both client secrets
// are canaries too. A Slack connect with rotation on, a Slack read, a Shopify read, a code-mode ask (when listed) and a
// `notification_send` run through the hook; then none of the canaries may be in: the Worker logs of BOTH Workers (the hook's
// `logs` op, the orchestrator's capture of `wrangler dev`'s output; the egress log is among them), every API answer this spec
// received and, on the per-PR deployment, the transcript of a scripted run that calls the connector tools through the runner.
// The runner's environment is not tested: the hook has no `runnerEnv` op (annotated as skipped). Ways it can fail, written first:
//  1. a token, refresh token or client secret reaches a log line, an API answer or the transcript;
//  2. the check passes because nothing was captured or nothing happened: each capture must be non-empty, both Workers must have
//     logged, the recorded Shopify must have been asked, and the transcript must hold the tool result (a positive control);
//  3. a failure prints a secret: only labels (`slack#0`, `secret#1`, `shopify#0`, `refresh-token`) are ever printed.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call, me } from './kit.ts'
import { answerOf, createChat, send } from './chat-kit.ts'
import {
  CHANNEL, ensureDisconnected, fakeReset, fakeSet, fakeState, freshConnect, hook, hubCall, hubToolNames, inhouse, logMark, newRun, notifySend, seedFake,
  setListedChannels, setStage, workerLogEntries,
} from './fakes-kit.ts'

const dana = actor('memberA')
test.describe.configure({ mode: 'serial' })

/** Fixed secrets of the test build (invented, in wrangler.hub.test.jsonc): found nowhere but where they are configured. */
const SECRETS = ['test-only-slack-client-secret-9f3b', 'test-only-client-secret-0RW9rVbhXFbVnJw6t1jyOWrJ1E7bMlc6']
/** The shapes of the fake's tokens beyond the literal ones: a Slack refresh token, and the Shopify token's prefix. */
const REFRESH_SHAPE = /xox[pe]-test-/
const SHOPIFY_SHAPE = /shpat_test_\d+/
/** The seeded message the scripted run's Slack search finds: the positive control that the transcript holds a tool result. */
const KESTREL = 'Kestrel'

type Needle = { label: string; literal?: string; shape?: RegExp }
const matches = (n: Needle, text: string): boolean => (n.literal !== undefined && text.includes(n.literal)) || (n.shape !== undefined && n.shape.test(text))
/** The labels of the needles found in any text. Never a value. */
const found = (needles: readonly Needle[], texts: readonly string[]): string[] => needles.filter(n => texts.some(t => matches(n, t))).map(n => n.label)

/** Every canary known now: the fake's access tokens, the recorded Shopify's, the client secrets and the token shapes. Labels carry an index, never a value. */
async function canaries(request: APIRequestContext): Promise<Needle[]> {
  const s = await fakeState(request)
  expect(s.mcp.issuedTokens.length, 'the fake issued the Slack canaries').toBeGreaterThan(0)
  expect(s.shopify.issuedTokens.length, 'the recorded Shopify issued a token').toBeGreaterThan(0)
  return [
    ...s.mcp.issuedTokens.map((t, i) => ({ label: `slack#${i}`, literal: t })),
    ...s.shopify.issuedTokens.map((t, i) => ({ label: `shopify#${i}`, literal: t })),
    ...SECRETS.map((t, i) => ({ label: `secret#${i}`, literal: t })),
    { label: 'refresh-token', shape: REFRESH_SHAPE },
    { label: 'shopify-token-shape', shape: SHOPIFY_SHAPE },
  ]
}

test.beforeAll(async ({ request }) => { await fakeReset(request); await ensureDisconnected(request) })
test.afterAll(async ({ request }) => {
  await setStage(request, 'Watch')
  await setListedChannels(request, [])
  await fakeReset(request)
  await ensureDisconnected(request)
})

test('no token, refresh token or client secret is in a Worker log (both Workers) or any API answer', async ({ request }) => {
  const answers: string[] = []
  await fakeSet(request, { mcp: { rotation: true } })
  const shopifyBefore = (await fakeState(request)).shopify.requests.length

  const c = await freshConnect(request)
  answers.push(c.start.text, c.callback.text, JSON.stringify(c.start.headers), JSON.stringify(c.callback.headers))
  answers.push((await call(request, inhouse, 'GET', '/api/tools')).text)
  const slackRead = await hubCall(request, 'callTool', 'slack_search_public', { keywords: ['supplier'] })
  expect(slackRead.ok, 'the Slack read answers').toBe(true)
  answers.push(JSON.stringify(slackRead))
  const shopifyRead = await hubCall(request, 'callTool', 'orders_search', { first: 1 })
  expect(shopifyRead.ok, 'the recorded Shopify answers a read').toBe(true)
  answers.push(JSON.stringify(shopifyRead))
  if ((await hubToolNames(request)).includes('shopify_script_run')) {
    answers.push(JSON.stringify(await hubCall(request, 'callTool', 'shopify_script_run', { code: 'const r = await shop.graphql(`query { orders(first: 1) { nodes { id } } }`); return r.data' })))
  }
  await setStage(request, 'Act')
  await setListedChannels(request, [CHANNEL.opsAlerts], true)
  const owner = (await me(request, dana)).memberId as string
  const notice = JSON.stringify(await notifySend(request, newRun(owner), { to: { channels: ['#ops-alerts'] }, title: 'Stock low', text: `Fern mug ${crypto.randomUUID()}`, format: 'message' }))
  answers.push(notice)

  // Positive controls: the flows really happened, so an empty result means "nothing leaked", not "nothing ran".
  const state = await fakeState(request)
  expect(state.shopify.requests.length, 'the recorded Shopify was asked').toBeGreaterThan(shopifyBefore)
  // Since M2-N the agent's post goes through the outbox; with no operation on (this spec's state) it reached the bell instead.
  expect(notice, 'the notice ran and reached the bell').toContain('#ops-alerts: sent to the bell (not Slack)')
  expect(state.web.posts.length, 'nothing was posted').toBe(0)
  const needles = await canaries(request)
  expect(answers.length).toBeGreaterThan(5)
  expect(found(needles, answers), 'canaries found in an API answer').toEqual([])

  // Both Workers were captured, each with at least one line (an empty capture of either proves nothing).
  const logs = await workerLogEntries(request)
  for (const worker of ['product', 'hub'] as const) expect(logs.filter(e => e.worker === worker).length, `the ${worker} Worker's log was captured`).toBeGreaterThan(0)
  expect(found(needles, logs.map(e => e.line)), 'canaries found in a Worker log line').toEqual([])
  await fakeSet(request, { mcp: { rotation: false } })
})

test('a scripted run that calls the connector tools leaves no canary in the transcript or the logs', async ({ request }) => {
  test.skip(!process.env.E2E_TEST_BUILD_REMOTE, 'needs a container (runner, session store): it runs on the per-PR test deployment (E2E_TEST_BUILD_REMOTE)')
  await fakeReset(request)
  await freshConnect(request)
  await seedFake(request, { slack: { messages: [{ channel: CHANNEL.general, text: `Supplier ${KESTREL} Mills says the restock ships late` }] } })
  await setStage(request, 'Act')
  await setListedChannels(request, [CHANNEL.opsAlerts], true)

  // The run goes first: the checks below read what it left.
  const mark = await logMark(request)
  const chat = await createChat(request, dana)
  const sent = await send(request, dana, chat, 'scenario:connectors check the connectors')
  await answerOf(request, dana, chat, sent.turnId)
  const needles = await canaries(request)

  const tr = await hook(request, { op: 'transcripts' })
  expect(tr.status, 'the transcripts op answers').toBe(200)
  const texts = tr.json.texts as string[]
  expect(texts.length, 'the session store held a transcript').toBeGreaterThan(0)
  // Positive control: the transcript holds a connector tool result, so "no canary" is about real content.
  expect(texts.some(t => t.includes(KESTREL)), 'the transcript holds the Slack tool result').toBe(true)
  expect(found(needles, texts), 'canaries found in the transcript').toEqual([])

  // The runner's environment is NOT checked here: the hook can't read it (a route in the runner image would be shared by every build
  // and no bundle check could fence it). The session env is wholly `sessionEnv()` (runner/src/session/env.ts), which takes no token by construction.
  test.info().annotations.push({ type: 'skipped', description: "runner environment: the hook has no runnerEnv op (it would need a runner-image route no bundle check can fence)" })

  const logs = await workerLogEntries(request, mark)
  for (const worker of ['product', 'hub'] as const) expect(logs.filter(e => e.worker === worker).length, `the ${worker} Worker's log was captured during the run`).toBeGreaterThan(0)
  expect(found(needles, logs.map(e => e.line)), 'canaries found in a Worker log line after the run').toEqual([])
})
