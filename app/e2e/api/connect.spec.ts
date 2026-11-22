// The Slack connect flow, routes A and B, against the test build's fake Slack (P5 W5, acceptance 1, 3, 5 and 7). Oracles are
// literal: the scopes, the redirect locations and the closed outcome codes are written here, never read from the code
// under test. The fake's logs come from the test-fakes hook. Ways it can fail, written first:
//  1. a token, code or verifier shows up in any answer, header or log line;
//  2. a state that is wrong, reused or another member's is accepted, or stores a token;
//  3. an Admin or Member reaches the hub from route A or B;
//  4. a refused connect (another workspace, a wider grant) leaves the received token live at Slack;
//  5. a refresh that races a disconnect brings a token back;
//  6. the hub's answers grow a field beyond the contract.
// The expired state is W1's unit test (the hub's clock isn't injectable in the test build). The refresh-against-disconnect
// interleaving itself is W1's barrier tests; the end-to-end case below can order the two only as far as the hook's alarm
// allows, and says so in the PR body.
import { expect, test } from '@playwright/test'
import { ToolDetailSchema, ToolsDataSchema } from '../../shared/contract/tools.ts'
import { mintTestCode } from '../../test/upstreams/mcp/server.ts'
import { actor, call, expectError, me, newIdentity, personActor } from './kit.ts'
import {
  anyContains, callbackOf, connectSlack, ensureDisconnected, fakeReset, fakeSet, fakeState, freshConnect, hook, inhouse, logMark, readTools, SLACK_ACCOUNT,
  SLACK_SCOPES, TEAM, workerLogs,
} from './fakes-kit.ts'

const admin = actor('admin')
const dana = actor('memberA')
test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ request }) => { await fakeReset(request); await ensureDisconnected(request) })
test.afterAll(async ({ request }) => { await fakeReset(request); await ensureDisconnected(request) })

const START = `/api/connect/${encodeURIComponent(SLACK_ACCOUNT)}/start`

test('a full connect with the fake Slack ends active, and no token is in any answer, header or log line', async ({ request }) => {
  await ensureDisconnected(request)
  const before = await fakeState(request)
  const mark = await logMark(request)
  const c = await freshConnect(request)
  // Route A answers exactly the address and its expiry; route B is a redirect with no body.
  expect(Object.keys(c.start.json).sort()).toEqual(['authorizeUrl', 'expiresAt'])
  expect(c.callback.text).toBe('')

  const tools = await readTools(request)
  expect(tools.connected).toContain('slack')
  expect(tools.connection.slack, 'an active account has no connection problem').toBeUndefined()

  const after = await fakeState(request)
  // Acceptance 7: the granted scopes are the five, exactly.
  expect([...(after.accounts.find(a => a.accountId === SLACK_ACCOUNT)?.scopes ?? [])].sort(), "the account's scopes").toEqual([...SLACK_SCOPES])
  const issued = after.mcp.issuedTokens.filter(t => !before.mcp.issuedTokens.includes(t))
  expect(issued.length, 'the fake issued a token for this connect').toBeGreaterThan(0)
  const surfaces = [c.start.text, c.callback.text, JSON.stringify(c.start.headers), JSON.stringify(c.callback.headers), JSON.stringify(tools), ...(await workerLogs(request, mark))]
  for (const token of issued) expect(anyContains(surfaces, token), 'the token is in no answer, header or log line').toBe(false)
})

test('a wrong state is refused: state_invalid, no token issued, the account unchanged', async ({ request }) => {
  await ensureDisconnected(request)
  const before = await fakeState(request)
  const start = await call(request, inhouse, 'POST', START, { json: {} })
  expect(start.status, start.text).toBe(200)
  const minted = await mintTestCode(start.json.authorizeUrl)
  const forged = new URL(minted.callbackUrl)
  forged.searchParams.set('state', `${crypto.randomUUID()}.${crypto.randomUUID()}`)
  const r = await callbackOf(request, forged.toString())
  expect(r.status, r.text).toBe(303)
  expect(r.headers.location).toBe('/tools?connect_error=state_invalid')
  expect((await readTools(request)).connected).not.toContain('slack')
  expect((await fakeState(request)).mcp.issuedTokens, 'no code was exchanged').toEqual(before.mcp.issuedTokens)
})

test('a reused state is refused the second time, and the first connect stays', async ({ request }) => {
  await ensureDisconnected(request)
  const first = await connectSlack(request)
  expect(first.location).toBe('/tools/slack?connected=1')
  const issued = (await fakeState(request)).mcp.issuedTokens
  // The same callback again (the browser's back button, or a replay).
  const second = await replayOf(request, first)
  expect(second.status, second.text).toBe(303)
  expect(second.headers.location).toMatch(/connect_error=state_invalid$/)
  expect((await readTools(request)).connected, 'the first connect still stands').toContain('slack')
  expect((await fakeState(request)).mcp.issuedTokens, 'the replay exchanged nothing').toEqual(issued)
})

test("another member's state is refused: Inhouse member X starts, Inhouse member Y calls back", async ({ request }) => {
  await ensureDisconnected(request)
  const y = personActor(newIdentity('connect-y'), 'inhouse')
  await me(request, y)
  const before = await fakeState(request)
  const c = await connectSlack(request, { starter: inhouse, finisher: y })
  expect(c.callback.status, c.callback.text).toBe(303)
  expect(c.location).toMatch(/connect_error=/)
  expect(c.location).not.toContain('connected=1')
  expect((await readTools(request)).connected).not.toContain('slack')
  expect((await fakeState(request)).mcp.issuedTokens, 'no code was exchanged for the wrong member').toEqual(before.mcp.issuedTokens)
})

test('Admin and Member get 403 on routes A and B, before any hub call', async ({ request }) => {
  const before = await fakeState(request)
  const tools = await readTools(request)
  for (const who of [admin, dana]) {
    expectError(await call(request, who, 'POST', START, { json: {} }), 403, 'forbidden')
    expectError(await call(request, who, 'GET', '/api/connect/callback?code=x&state=y'), 403, 'forbidden')
  }
  const after = await fakeState(request)
  expect(after.mcp.requests, 'no request reached the fake Slack').toEqual(before.mcp.requests)
  expect(await readTools(request)).toEqual(tools)
})

test('workspace_mismatch: the fake answers another team, the connect is refused and the received token is revoked', async ({ request }) => {
  await fakeSet(request, { mcp: { sameToken: false } })
  await ensureDisconnected(request)
  const before = await fakeState(request)
  const c = await connectSlack(request, { team: TEAM.other })
  expect(c.location).toBe('/tools/slack?connect_error=workspace_mismatch')
  const after = await fakeState(request)
  const received = after.mcp.issuedTokens.filter(t => !before.mcp.issuedTokens.includes(t))
  expect(received.length).toBe(1)
  expect(after.mcp.revoked, 'the received token was revoked at Slack').toContain(received[0])
  expect(after.mcp.liveTokens).not.toContain(received[0])
  expect((await readTools(request)).connected).not.toContain('slack')
})

test('scope_mismatch: an extra scope is granted, the connect is refused and the received token is revoked', async ({ request }) => {
  await fakeSet(request, { mcp: { sameToken: false } })
  await ensureDisconnected(request)
  const before = await fakeState(request)
  const c = await connectSlack(request, { grant: [...SLACK_SCOPES, 'files:read'] })
  expect(c.location).toBe('/tools/slack?connect_error=scope_mismatch')
  const after = await fakeState(request)
  const received = after.mcp.issuedTokens.filter(t => !before.mcp.issuedTokens.includes(t))
  expect(received.length).toBe(1)
  expect(after.mcp.revoked).toContain(received[0])
  expect((await readTools(request)).connected).not.toContain('slack')
})

test('with the same-token switch on, a refused reconnect does not revoke the live token', async ({ request }) => {
  await fakeSet(request, { mcp: { sameToken: true } })
  await freshConnect(request)
  const connected = await fakeState(request)
  const live = connected.mcp.liveTokens
  expect(live.length).toBeGreaterThan(0)
  const revokedBefore = connected.mcp.revoked
  // Reconnecting an active account: the fake re-issues the same token, then the workspace check refuses it.
  const c = await connectSlack(request, { team: TEAM.other })
  expect(c.location).toMatch(/connect_error=workspace_mismatch$/)
  const after = await fakeState(request)
  // Same-token mode: the received token IS the live one, so nothing new was issued and the live set is unchanged.
  expect(after.mcp.issuedTokens, 'the fake issued nothing new: the received token is the live one').toEqual(connected.mcp.issuedTokens)
  expect([...after.mcp.liveTokens].sort()).toEqual([...live].sort())
  for (const t of live) {
    expect(after.mcp.revoked.filter(r => r === t).length, 'the live token is not revoked by the refused reconnect').toBe(revokedBefore.filter(r => r === t).length)
  }
  await fakeSet(request, { mcp: { sameToken: false } })
})

test('a refresh racing a disconnect: the end state is disconnected, no token, no refresh request after the disconnect', async ({ request }) => {
  await fakeSet(request, { mcp: { rotation: true } })
  const before = await fakeState(request)
  const c = await freshConnect(request)
  expect(c.location).toBe('/tools/slack?connected=1')
  const connected = await fakeState(request)
  const mine = connected.mcp.issuedTokens.filter(t => !before.mcp.issuedTokens.includes(t))
  expect(mine.length, 'this connect issued a token').toBeGreaterThan(0)
  // Positive control: the alarm of a connected, due account does refresh. Without it "no refresh after the disconnect" could be
  // true only because the alarm never refreshes anything in this build.
  const sendsBefore = connected.mcp.refreshSends.length
  const live = await hook(request, { op: 'alarm', accountId: SLACK_ACCOUNT })
  expect(live.status, live.text).toBe(200)
  expect((await fakeState(request)).mcp.refreshSends.length, 'an alarm on a connected account sends a refresh').toBeGreaterThan(sendsBefore)

  const gone = await call(request, inhouse, 'POST', `/api/tools/${encodeURIComponent(SLACK_ACCOUNT)}/disconnect`, { json: {} })
  expect(gone.status, gone.text).toBe(200)
  const mark = (await fakeState(request)).mcp.refreshSends.length
  // The alarm the account would have fired for its refresh, now (the hook runs the hub's alarm once).
  const alarm = await hook(request, { op: 'alarm', accountId: SLACK_ACCOUNT })
  expect(alarm.status, alarm.text).toBe(200)
  const after = await fakeState(request)
  expect(after.mcp.refreshSends.length, 'no refresh request after the disconnect').toBe(mark)
  // This account's tokens (every access token issued since this test began) are not live: a refresh in flight would have made one.
  const everyoneMine = after.mcp.issuedTokens.filter(t => !before.mcp.issuedTokens.includes(t))
  for (const t of everyoneMine) expect(after.mcp.liveTokens, 'no token of this account is live').not.toContain(t)
  const t = await readTools(request)
  expect(t.connected).not.toContain('slack')
  expect(t.details.slack?.canDisconnect).toBe(false)
  await fakeSet(request, { mcp: { rotation: false } })
})

test('every route answer has no field beyond the contract and carries no token', async ({ request }) => {
  const c = await freshConnect(request)
  const issued = (await fakeState(request)).mcp.issuedTokens
  const read = await call(request, inhouse, 'GET', '/api/tools')
  expect(read.status, read.text).toBe(200)
  // Route C: the top level and each detail hold only the contract's keys (the schemas aren't strict, so the keys are compared).
  const top = Object.keys(ToolsDataSchema.shape)
  for (const k of Object.keys(read.json)) expect(top, `ToolsData has no "${k}" in the contract`).toContain(k)
  const detailKeys = Object.keys(ToolDetailSchema.shape)
  for (const [key, d] of Object.entries<Record<string, unknown>>(read.json.details)) {
    for (const k of Object.keys(d)) expect(detailKeys, `details.${key} has no "${k}" in the contract`).toContain(k)
  }
  const paused = await call(request, inhouse, 'PUT', `/api/tools/${encodeURIComponent(SLACK_ACCOUNT)}/paused`, { json: { paused: false } })
  expect(paused.json).toEqual({ paused: false })
  const answers = [c.start.text, read.text, paused.text]
  for (const token of issued) expect(anyContains(answers, token)).toBe(false)
  expect(Object.keys(c.start.json).sort()).toEqual(['authorizeUrl', 'expiresAt'])
  const gone = await call(request, inhouse, 'POST', `/api/tools/${encodeURIComponent(SLACK_ACCOUNT)}/disconnect`, { json: {} })
  expect(Object.keys(gone.json)).toEqual(['revoked'])
  for (const token of issued) expect(gone.text).not.toContain(token)

  // The raw ConnectGateway answers the product Worker received (the hook records them): each is a HubResult with no field beyond
  // the contract, and none holds a canary.
  const bodies = (await fakeState(request)).connect.bodies
  expect(bodies.length, 'the hook recorded the hub answers').toBeGreaterThan(0)
  for (const [n, text] of bodies.entries()) {
    expect(strictHubResult(JSON.parse(text)), `ConnectGateway body #${n}`).toBeNull()
    for (const [i, token] of issued.entries()) expect(text.includes(token), `ConnectGateway body #${n} holds canary slack#${i}`).toBe(false)
  }
})

/** The keys of the hub's `AccountStatus` and `AccountSummary` (app/hub/index/contract.ts), written out: a new field fails here until a person adds it. */
const STATUS_KEYS = ['accountId', 'state', 'kid', 'expiresAt', 'scopes', 'lastError', 'paused', 'kind', 'connectedBy', 'connectedAt', 'revokeFailedAt', 'needsReconnect']
const SUMMARY_KEYS = ['accountId', 'connector', 'configured', 'status']
const VALUE_SHAPES: string[][] = [['authorizeUrl', 'expiresAt'], ['accountId'], ['revoked'], ['paused']]
const sameKeys = (o: unknown, keys: readonly string[]): boolean => typeof o === 'object' && o !== null && JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort())
const onlyKeys = (o: unknown, keys: readonly string[]): boolean => typeof o === 'object' && o !== null && Object.keys(o).every(k => keys.includes(k))

/** Null when `body` is a HubResult with exactly the contract's fields; else what is wrong, with no value in it. */
function strictHubResult(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return 'not an object'
  const b = body as { ok?: unknown; value?: unknown; error?: unknown }
  if (b.ok === true) {
    if (!sameKeys(body, ['ok', 'value'])) return 'an ok answer with fields beyond ok and value'
    const v = b.value
    if (Array.isArray(v)) {
      for (const row of v) {
        if (!sameKeys(row, SUMMARY_KEYS)) return 'an account summary with fields beyond the contract'
        if (!onlyKeys((row as { status: unknown }).status, STATUS_KEYS)) return 'an account status with fields beyond the contract'
      }
      return null
    }
    return VALUE_SHAPES.some(keys => sameKeys(v, keys)) ? null : 'a value with fields beyond the contract'
  }
  if (b.ok === false) {
    if (!sameKeys(body, ['ok', 'error'])) return 'an error answer with fields beyond ok and error'
    const e = b.error as object
    return onlyKeys(e, ['code', 'message', 'retryAfterMs']) && typeof (e as { code?: unknown }).code === 'string' ? null : 'an error with fields beyond code, message and retryAfterMs'
  }
  return 'neither ok nor an error'
}

/** The first connect's callback, again: its minted code and state are the ones the hub has already used. */
async function replayOf(request: Parameters<typeof callbackOf>[0], first: Awaited<ReturnType<typeof connectSlack>>) {
  const minted = await mintTestCode(first.authorizeUrl)
  // Same authorize URL, so the same state: the hub consumed it on the first callback.
  expect(minted.state).toBe(first.state)
  return callbackOf(request, minted.callbackUrl)
}
