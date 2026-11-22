// The canary-token test (P5 W5, acceptance 3). The fake Slack issues the canary as the Slack access token and the recorded
// Shopify issues `shpat_test_<n>` as the Shopify token; both client secrets are canaries too. The spec runs a Slack connect,
// a Slack read, a Shopify read, a code-mode ask (when it is listed) and a `notification_send`, then asserts none of the canaries
// is in: the Worker logs of both Workers (the hook's `logs` op, the orchestrator's capture of `wrangler dev`'s output; the
// egress log is among them), the runner's environment (the hook's `runnerEnv` op, which answers hits per needle and never
// values, remote only), the transcript (the hook's `transcripts` op over the R2 session store, remote only) and every API
// answer this spec received. Ways it can fail, written first:
//  1. a token or client secret reaches a log line, an API answer or the runner's environment;
//  2. the check passes because nothing was captured (every capture below must be non-empty, so an empty log is a failure);
//  3. the canary list is empty, so nothing could be found.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call, me } from './kit.ts'
import { answerOf, createChat, send } from './chat-kit.ts'
import {
  CHANNEL, ensureDisconnected, fakeReset, fakeState, freshConnect, hook, hubCall, hubToolNames, inhouse, newRun, notifySend, setListedChannels, setStage, workerLogs,
} from './fakes-kit.ts'

const dana = actor('memberA')
test.describe.configure({ mode: 'serial' })

/** Fixed secrets of the test build (invented, in wrangler.hub.test.jsonc and the fakes): found nowhere but where they are configured. */
const SECRETS = ['test-only-slack-client-secret-9f3b', 'test-only-client-secret-0RW9rVbhXFbVnJw6t1jyOWrJ1E7bMlc6']
/** The recorded Shopify's token shape: `shpat_test_` and a counter. */
const SHOPIFY_TOKEN = /shpat_test_\d+/

test.beforeAll(async ({ request }) => { await fakeReset(request); await ensureDisconnected(request) })
test.afterAll(async ({ request }) => {
  await setStage(request, 'Watch')
  await setListedChannels(request, [])
  await fakeReset(request)
  await ensureDisconnected(request)
})

test('no token or client secret is in the logs, the runner environment, the transcript or any API answer', async ({ request }) => {
  const answers: string[] = []

  // The flows: a connect, a Slack read, a Shopify read, a code-mode ask, a notification.
  const c = await freshConnect(request)
  answers.push(c.start.text, c.callback.text, JSON.stringify(c.start.headers), JSON.stringify(c.callback.headers))
  answers.push((await call(request, inhouse, 'GET', '/api/tools')).text)
  const slackRead = await hubCall(request, 'callTool', 'slack_search_public', { keywords: ['supplier'] })
  expect(slackRead.ok, JSON.stringify(slackRead)).toBe(true)
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
  answers.push(JSON.stringify(await notifySend(request, newRun(owner), { to: { channels: ['#ops-alerts'] }, title: 'Stock low', text: `Fern mug ${crypto.randomUUID()}`, format: 'message' })))

  // The canaries: every token the fake issued this run, plus the secrets and the Shopify token shape.
  const state = await fakeState(request)
  const slackTokens = state.mcp.issuedTokens
  expect(slackTokens.length, 'the fake issued the Slack canary').toBeGreaterThan(0)
  const needles = [...slackTokens, ...SECRETS]
  const found = (texts: readonly string[]) => [...needles.filter(n => texts.some(t => t.includes(n))), ...(texts.some(t => SHOPIFY_TOKEN.test(t)) ? ['shopify token'] : [])]

  // 1. API answers.
  expect(answers.length).toBeGreaterThan(5)
  expect(found(answers), 'a canary is in an API answer').toEqual([])
  // 2. Worker logs of both Workers (the egress log included). An empty capture proves nothing.
  const logs = await workerLogs(request)
  expect(logs.length, 'the Worker logs were captured').toBeGreaterThan(0)
  expect(found(logs), 'a canary is in a Worker log line').toEqual([])
  // 3. The runner's environment and the transcript need a container: the per-PR test deployment only.
  await runnerAndTranscript(request, needles, slackTokens)
})

async function runnerAndTranscript(request: APIRequestContext, needles: string[], slackTokens: string[]): Promise<void> {
  if (!process.env.E2E_TEST_BUILD_REMOTE) {
    test.info().annotations.push({ type: 'skipped', description: 'the runner environment and transcript checks need a container (E2E_TEST_BUILD_REMOTE)' })
    return
  }
  // A scripted turn first, so the runner has a session and the store has a transcript with the connector tools around.
  const chat = await createChat(request, dana)
  const sent = await send(request, dana, chat, 'scenario:hello say hello')
  await answerOf(request, dana, chat, sent.turnId)
  const env = await hook(request, { op: 'runnerEnv', needles })
  expect(env.status, env.text).toBe(200)
  expect(env.json.keys.length, 'the runner environment was read').toBeGreaterThan(0)
  expect(env.json.hits, 'no canary is in the runner environment').toEqual([])
  const tr = await hook(request, { op: 'transcripts' })
  expect(tr.status, tr.text).toBe(200)
  const texts = tr.json.texts as string[]
  expect(texts.length, 'the session store held a transcript').toBeGreaterThan(0)
  for (const n of [...slackTokens, ...needles]) expect(texts.some(t => t.includes(n)), 'a canary is in the transcript').toBe(false)
  expect(texts.some(t => SHOPIFY_TOKEN.test(t)), 'a Shopify token is in the transcript').toBe(false)
}
