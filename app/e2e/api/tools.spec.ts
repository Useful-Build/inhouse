// The connector tools through the hub, pause, disconnect, reconnect, the scope policy and the system prompt (P5 W5,
// acceptance 2, 4 and 6), against the test build's fakes. The hub's ReadGateway is reached through the test-fakes hook's `hub`
// op (the egress route needs a run token a spec can't mint); the prompt through its `prompt` op (the trace's steps carry no
// system prompt). Expected values are literals. Ways it can fail, written first:
//  1. a tool the allowlist doesn't list reaches the model or the upstream, or a write is callable;
//  2. a paused, disconnected or scope-mismatched account still lists or answers a tool;
//  3. the prompt names an app that isn't usable, or leaves one out;
//  4. a same-token reconnect revokes the live token or breaks the account;
//  5. a paused Slack still takes a post;
//  6. a hub tool is always loaded, or a runner route reaches the delivery binding.
import { expect, test } from '@playwright/test'
import { actor, call, expectError } from './kit.ts'
import { ToolsDataSchema } from '../../shared/contract/tools.ts'
import {
  CHANNEL, connectSlack, ensureDisconnected, fakeReset, fakeSet, fakeState, freshConnect, hook, hubCall, hubToolNames, inhouse, newRun, NOTES_ACCOUNT,
  notifySend, readTools, setListedChannels, setStage, SHOPIFY_ACCOUNT, SLACK_ACCOUNT, sourceOf, sourcesUnder, turnPrompt,
} from './fakes-kit.ts'

const dana = actor('memberA')
test.describe.configure({ mode: 'serial' })

const acct = (id: string) => encodeURIComponent(id)
const SEARCH = { keywords: ['supplier'] }
const slackNames = (names: string[]) => names.filter(n => n.startsWith('slack_'))

test.beforeAll(async ({ request }) => { await fakeReset(request); await ensureDisconnected(request) })
test.afterAll(async ({ request }) => {
  await fakeReset(request)
  await hook(request, { op: 'var', name: 'SLACK_PRIVATE_SEARCH', value: 'off' })
  await ensureDisconnected(request)
})

/** The apps a prompt's "Connected apps:" line names, by their display names (empty: no such line). */
function namedApps(prompt: string): string[] {
  const m = /Connected apps: (.+?)\. Search for their tools/.exec(prompt)
  if (!m) return []
  return m[1]!.split(/, | and /)
}

test('the system prompt names exactly the usable apps: before a connect, after it and after a disconnect', async ({ request }) => {
  await ensureDisconnected(request)
  expect(namedApps(await turnPrompt(request)), 'Slack is not named before it is connected').not.toContain('Slack')
  await freshConnect(request)
  expect(namedApps(await turnPrompt(request))).toContain('Slack')
  const gone = await call(request, inhouse, 'POST', `/api/tools/${acct(SLACK_ACCOUNT)}/disconnect`, { json: {} })
  expect(gone.status, gone.text).toBe(200)
  expect(namedApps(await turnPrompt(request)), 'a disconnected app is not named').not.toContain('Slack')
})

test('a tool outside the allowlist is absent and unknown_tool, a write is write_refused, and the fake sees no call for either', async ({ request }) => {
  await ensureDisconnected(request)
  const c = await connectSlack(request, { account: NOTES_ACCOUNT })
  expect(c.location).toBe('/tools/notes?connected=1')

  // The hub lists its allowlist from the registry and never asks the upstream for its tools/list (a tool upstream added later is
  // hidden by construction, not by filtering), so the check is on what the hub answers and on what it never sends.
  let names: string[] = []
  for (let i = 0; i < 3; i++) names = await hubToolNames(request)
  expect(names).toEqual(expect.arrayContaining(['notes_search', 'notes_read']))
  expect(names, 'notes_export is hidden by design').not.toContain('notes_export')
  expect(names).not.toContain('notes_delete')

  const requestsBefore = (await fakeState(request)).notes.requests.length
  const callsBefore = (await fakeState(request)).notes.toolCalls.length
  const unknown = await hubCall(request, 'callTool', 'notes_export', {})
  expect(unknown).toMatchObject({ ok: false, error: { code: 'unknown_tool' } })
  expect(await hubCall(request, 'callTool', 'notes_delete', { id: 'n1' })).toMatchObject({ ok: false, error: { code: 'write_refused' } })
  const after = await fakeState(request)
  expect(after.notes.requests.length, 'no request at all reached the fake for the hidden tool or the write').toBe(requestsBefore)
  expect(after.notes.toolCalls.length, 'no tools/call reached the fake for the hidden tool or the write').toBe(callsBefore)
  expect(after.notes.toolCalls.map(t => t.name)).not.toContain('notes_export')
  expect(after.notes.toolCalls.map(t => t.name)).not.toContain('notes_delete')

  // A Slack write is refused the same way (the runner's hub route has no other answer to give).
  await freshConnect(request)
  const slackCalls = (await fakeState(request)).mcp.toolCalls.length
  expect(await hubCall(request, 'callTool', 'slack_send_message', { channel_id: CHANNEL.general, message: 'hello' })).toMatchObject({ ok: false, error: { code: 'write_refused' } })
  expect((await fakeState(request)).mcp.toolCalls.length, 'the write never reached Slack').toBe(slackCalls)
  const gone = await call(request, inhouse, 'POST', `/api/tools/${acct(NOTES_ACCOUNT)}/disconnect`, { json: {} })
  expect([200, 404, 409], gone.text).toContain(gone.status)
})

test('pause hides: a paused tool leaves the list and answers paused; unpaused it is back', async ({ request }) => {
  await freshConnect(request)
  expect(slackNames(await hubToolNames(request))).toContain('slack_search_public')
  const paused = await call(request, inhouse, 'PUT', `/api/tools/${acct(SLACK_ACCOUNT)}/paused`, { json: { paused: true } })
  expect(paused.json).toEqual({ paused: true })
  expect((await readTools(request)).details.slack?.paused).toBe(true)
  expect(slackNames(await hubToolNames(request)), 'no Slack tool while paused').toEqual([])
  expect(await hubCall(request, 'callTool', 'slack_search_public', SEARCH)).toMatchObject({ ok: false, error: { code: 'paused' } })
  const back = await call(request, inhouse, 'PUT', `/api/tools/${acct(SLACK_ACCOUNT)}/paused`, { json: { paused: false } })
  expect(back.json).toEqual({ paused: false })
  expect(slackNames(await hubToolNames(request))).toContain('slack_search_public')
  expect((await hubCall(request, 'callTool', 'slack_search_public', SEARCH)).ok).toBe(true)
})

test('disconnect: revoked true, then no Slack tool is listed; a Shopify disconnect is a 409', async ({ request }) => {
  await freshConnect(request)
  const gone = await call(request, inhouse, 'POST', `/api/tools/${acct(SLACK_ACCOUNT)}/disconnect`, { json: {} })
  expect(gone.status, gone.text).toBe(200)
  expect(gone.json).toEqual({ revoked: true })
  expect(slackNames(await hubToolNames(request))).toEqual([])
  expect((await readTools(request)).connected).not.toContain('slack')
  expectError(await call(request, inhouse, 'POST', `/api/tools/${acct(SHOPIFY_ACCOUNT)}/disconnect`, { json: {} }), 409, 'conflict', 'not_disconnectable')
})

test('reconnect after a disconnect: a full connect ends active and the Slack tools are listed again', async ({ request }) => {
  await freshConnect(request)
  await call(request, inhouse, 'POST', `/api/tools/${acct(SLACK_ACCOUNT)}/disconnect`, { json: {} })
  expect(slackNames(await hubToolNames(request))).toEqual([])
  const again = await connectSlack(request)
  expect(again.location).toBe('/tools/slack?connected=1')
  expect((await readTools(request)).connected).toContain('slack')
  expect(slackNames(await hubToolNames(request))).toContain('slack_search_public')
})

test('a scope policy change after a connect hides every Slack tool, shows a reconnect, drops Slack from the prompt, and flipping back restores it', async ({ request }) => {
  await freshConnect(request)
  expect(namedApps(await turnPrompt(request))).toContain('Slack')
  const flip = await hook(request, { op: 'var', name: 'SLACK_PRIVATE_SEARCH', value: 'on' })
  expect(flip.status, flip.text).toBe(200)
  try {
    expect(slackNames(await hubToolNames(request)), 'every Slack tool is hidden').toEqual([])
    expect(await hubCall(request, 'callTool', 'slack_search_public', SEARCH)).toMatchObject({ ok: false, error: { code: 'scope_mismatch' } })
    const t = await readTools(request)
    expect(t.connection.slack, 'the account needs a reconnect').toMatchObject({ status: 'disconnected' })
    expect(namedApps(await turnPrompt(request)), 'the prompt no longer names Slack').not.toContain('Slack')
  } finally {
    const back = await hook(request, { op: 'var', name: 'SLACK_PRIVATE_SEARCH', value: 'off' })
    expect(back.status, back.text).toBe(200)
  }
  expect(slackNames(await hubToolNames(request)), 'flipping back restores the tools').toContain('slack_search_public')
  expect((await readTools(request)).connection.slack).toBeUndefined()
  expect(namedApps(await turnPrompt(request))).toContain('Slack')
})

test('a same-token reconnect keeps an active account working and revokes nothing', async ({ request }) => {
  await ensureDisconnected(request)
  await fakeReset(request)
  await fakeSet(request, { mcp: { sameToken: true } })
  const first = await connectSlack(request)
  expect(first.location).toBe('/tools/slack?connected=1')
  const revokedBefore = (await fakeState(request)).mcp.revoked.length
  const second = await connectSlack(request)
  expect(second.location, 'reconnecting an active account').toBe('/tools/slack?connected=1')
  expect((await hubCall(request, 'callTool', 'slack_search_public', SEARCH)).ok, 'the next Slack read succeeds').toBe(true)
  expect((await fakeState(request)).mcp.revoked.length, 'the fake saw no revoke').toBe(revokedBefore)
  await fakeSet(request, { mcp: { sameToken: false } })
})

test('with Slack paused, notification_send to a listed channel at Act answers slack_not_connected and the fake records no post', async ({ request }) => {
  await freshConnect(request)
  await setStage(request, 'Act')
  await setListedChannels(request, [CHANNEL.opsAlerts], true)
  const memberId = (await call(request, dana, 'GET', '/api/me')).json.memberId as string
  const paused = await call(request, inhouse, 'PUT', `/api/tools/${acct(SLACK_ACCOUNT)}/paused`, { json: { paused: true } })
  expect(paused.json).toEqual({ paused: true })
  const postsBefore = (await fakeState(request)).web.posts.length
  const out = await notifySend(request, newRun(memberId), { to: { channels: ['#ops-alerts'] }, title: 'Stock low', text: `Fern mug ${crypto.randomUUID()}`, format: 'message' })
  expect(JSON.stringify(out)).toContain('slack_not_connected')
  expect((await fakeState(request)).web.posts.length, 'the fake recorded no post').toBe(postsBefore)
  await call(request, inhouse, 'PUT', `/api/tools/${acct(SLACK_ACCOUNT)}/paused`, { json: { paused: false } })
  await setStage(request, 'Watch')
})

test('code mode: a script selecting email or note, aliased through a fragment, is refused and the recorded Shopify sees no request', async ({ request }) => {
  const names = await hubToolNames(request)
  test.skip(!names.includes('shopify_script_run'), 'code mode is not listed in this build (branch B)')
  const shopifyBefore = (await fakeState(request)).shopify?.requests.length
  expect(shopifyBefore, 'the hook reports the recorded Shopify upstream\'s requests').toBeDefined()
  for (const field of ['email', 'note']) {
    const code = `const r = await shop.graphql(\`query { orders(first: 1) { nodes { ...F } } } fragment F on Order { alias: ${field} }\`); return r.data`
    const out = await hubCall(request, 'callTool', 'shopify_script_run', { code })
    // A script failure is a successful tool result carrying the script's error text, which names the refusal.
    expect(JSON.stringify(out), `${field} is refused`).toContain('field not allowed')
  }
  expect((await fakeState(request)).shopify?.requests.length, 'the recorded upstream saw no request').toBe(shopifyBefore)
})

// The Tools screen crash (P5, ship recording 45046093071): Shopify (client credentials, no OAuth connect) read once is
// `active` and listed as connected, but had no `since`, and the client's sinceLine threw for the whole screen.
test('Shopify read once through the hub: GET /api/tools lists it connected with a stable since, and the client derive accepts it', async ({ request }) => {
  const read = await hubCall(request, 'callTool', 'orders_search', { first: 1 })
  expect(read.ok, 'the recorded Shopify answers a read').toBe(true)
  const first = await call(request, inhouse, 'GET', '/api/tools')
  expect(first.status, first.text).toBe(200)
  const data = ToolsDataSchema.parse(first.json)
  expect(data.connected).toContain('shopify')
  const since = data.details.shopify?.since
  expect(since, 'connected implies since').toBeDefined()
  // The client's sinceLine (src/state/derive.ts) throws when a listed tool has neither `since` nor `liveBy`: that exact
  // precondition, for every connected tool (this tsconfig's nodenext resolution can't import the client module itself).
  for (const k of data.connected) expect(data.details[k]?.since ?? data.details[k]?.liveBy, `${k} is connected with a date`).toBeDefined()
  // Stable: another read (and another hub call) gives the same date, never the clock.
  expect((await hubCall(request, 'callTool', 'orders_search', { first: 1 })).ok).toBe(true)
  const again = ToolsDataSchema.parse((await call(request, inhouse, 'GET', '/api/tools')).json)
  expect(again.details.shopify?.since).toEqual(since)
})

test('[static] connector tools load on demand: no hub tool is listed with metadata that could load it upfront', async () => {
  // The egress's `tools/list` entry for a hub tool: read only, and no `_meta` (never `anthropic/alwaysLoad`).
  const listed = /export function listedTool\(t: ToolInfo\) \{([\s\S]*?)\n\}/.exec(sourceOf('server/egress/hub.ts'))
  expect(listed, 'listedTool is in server/egress/hub.ts').not.toBeNull()
  expect(listed![1]).not.toMatch(/_meta|alwaysLoad/)
  expect(listed![1]).toContain('readOnlyHint: true')
  // Nothing in the runner's source marks a tool always-loaded (its `apps` MCP entry included).
  for (const [file, text] of sourcesUnder('runner/src')) expect(text, `${file} marks nothing always-loaded`).not.toMatch(/alwaysLoad/)
})
