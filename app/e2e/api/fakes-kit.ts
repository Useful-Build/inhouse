// What the P5 connector specs share (connect, tools, notify-slack, canary, notices-injection): the test build's fakes control
// hook (POST /api/ops/test-fakes, release token, 404 outside the test build) and the connect flow driven through the API
// alone. The fake Slack (FakeMcpServer, FakeSlackWeb) lives inside the hub Worker, so a spec reads its logs and flips its
// switches only through the hook; `mintTestCode` is stateless HMAC and runs here, so no hook turns an authorize URL into a
// callback. Every id, name and token here is invented. No fixed waits: nothing here sleeps.
import { readdirSync, readFileSync } from 'node:fs'
import { expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { mintTestCode, SLACK_TEST } from '../../test/upstreams/mcp/server.ts'
import { actor, call, putSetting } from './kit.ts'
import type { Actor, Reply } from './kit.ts'

export const SLACK_ACCOUNT = 'slack:workspace'
export const SHOPIFY_ACCOUNT = 'shopify:store'
/** The five scopes the Slack app asks for (P5 plan, "Decisions that bind this phase"). Literal, never read from the code under test. */
export const SLACK_SCOPES = ['channels:history', 'channels:read', 'chat:write', 'search:read.public', 'users:read'] as const

export const inhouse = actor('inhouse')
export const release = actor('release')

export interface McpLogEntry { host: string; path: string; method: string; rpc?: string; tool?: string; session?: string | null }
export interface WebLogEntry { path: string; method: string; params: Record<string, string>; authorized: boolean }
/** The fakes' logs as the hook returns them (JSON copies, in order). */
/** One generic-or-Slack MCP fake's logs. */
export interface McpFakeState {
  requests: McpLogEntry[]
  revoked: string[]
  refreshSends: string[]
  toolCalls: { name: string; args: Record<string, unknown> }[]
  /** Every access token the fake issued (the canaries), live or not. */
  issuedTokens: string[]
  liveTokens: string[]
}
export interface FakeState {
  /** The Slack fake. */
  mcp: McpFakeState
  /** The generic `notes` fake (account `notes:test`), same shape. */
  notes: McpFakeState
  web: { requests: WebLogEntry[]; posts: Record<string, string>[]; violations: string[][] }
  /** The recorded Shopify upstream's requests and the tokens it issued (the Shopify canaries). */
  shopify: { requests: { path: string; method: string }[]; issuedTokens: string[] }
  /** The raw ConnectGateway answers the product Worker received, in order, each as JSON text (a spec parses and strict-checks each). */
  connect: { bodies: string[] }
  /** The hub's accounts: id and granted scopes (the hub's AccountStatus). */
  accounts: { accountId: string; scopes: string[] }[]
  /** The server's current UTC day, `YYYY-MM-DD` (the notice caps count by it). */
  serverDay: string
}

/** What `{op:'seed'}` plants where a read returns it: a Slack message, a refund note on a recorded order. */
export interface FakeSeed {
  slack?: { messages: { channel: string; text: string }[] }
  shopify?: { refundNotes: { order: string; note: string }[] }
}

/** What `{op:'set'}` takes: the switches of FakeMcpServer and FakeSlackWeb the specs flip. */
export interface FakeSwitches {
  /** FakeMcpServer's own switch names; `profile` picks one fake (both when absent). */
  mcp?: { profile?: 'slack' | 'notes'; sameToken?: boolean; rotation?: boolean; exportAfterLists?: number; expiresInS?: number; missingScope?: 'hide' | 'fail'; revokeFails?: boolean; cumulative?: boolean; sse?: boolean; noS256?: boolean; staleSessions?: true }
  web?: { rateLimitNextPost?: boolean; failNextPost?: string | null; channels?: { id: string; patch: Record<string, unknown> }[] }
}

/** One call of the hook as the release token. The reply is returned as it came. */
export const hook = (request: APIRequestContext, body: Record<string, unknown>): Promise<Reply> => call(request, release, 'POST', '/api/ops/test-fakes', { json: body })

async function hookOk(request: APIRequestContext, body: Record<string, unknown>): Promise<any> {
  const r = await hook(request, body)
  expect(r.status, `hook ${String(body.op)}: ${r.text}`).toBe(200)
  return r.json
}

export const fakeState = async (request: APIRequestContext): Promise<FakeState> => hookOk(request, { op: 'state' })
export const fakeReset = async (request: APIRequestContext): Promise<void> => { await hookOk(request, { op: 'reset' }) }
export const fakeSet = async (request: APIRequestContext, s: FakeSwitches): Promise<void> => { await hookOk(request, { op: 'set', ...s }) }
export type WorkerLog = { worker: 'product' | 'hub'; line: string }
export type LogMark = { product: number; hub: number }
/** Worker log lines captured since `since` (the whole capture without it), each tagged with its Worker, and the mark after them. */
export const workerLogsSince = async (request: APIRequestContext, since?: LogMark): Promise<{ lines: WorkerLog[]; next: LogMark }> =>
  hookOk(request, { op: 'logs', ...(since ? { since } : {}) })
export const workerLogEntries = async (request: APIRequestContext, since?: LogMark): Promise<WorkerLog[]> => (await workerLogsSince(request, since)).lines
/** The mark after every line captured so far: pass it to the next read to see only what a test did. */
export const logMark = async (request: APIRequestContext): Promise<LogMark> => (await workerLogsSince(request)).next
export const workerLogs = async (request: APIRequestContext, since?: LogMark): Promise<string[]> => (await workerLogEntries(request, since)).map(e => e.line)
/** Plants text where a read returns it (cleared by `reset`). */
export const seedFake = async (request: APIRequestContext, seed: FakeSeed): Promise<void> => { await hookOk(request, { op: 'seed', ...seed }) }
/** The hub's ReadGateway answer, as a run-scoped call would get it. */
export const hubCall = async (request: APIRequestContext, method: 'listTools' | 'callTool', name?: string, args?: unknown): Promise<{ ok: boolean; value?: any; error?: { code: string; message: string } }> =>
  hookOk(request, { op: 'hub', method, ...(name === undefined ? {} : { name }), ...(args === undefined ? {} : { args }) })
/** The per-turn system prompt as a turn started now would carry it. */
export const turnPrompt = async (request: APIRequestContext): Promise<string> => (await hookOk(request, { op: 'prompt' })).prompt as string

/** The names of the hub's tools a run would see now. */
export async function hubToolNames(request: APIRequestContext): Promise<string[]> {
  const r = await hubCall(request, 'listTools')
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r.value as { name: string }[]).map(t => t.name)
}

export interface ConnectOptions {
  /** The scopes the "person" grants, in place of what was asked (a wider grant). */
  grant?: string[]
  /** The team id the fake answers (another workspace). */
  team?: string
  /** The member who starts (default: the seeded Inhouse member). */
  starter?: Actor
  /** The member who calls back (default: the starter). */
  finisher?: Actor
  /** The hub account to connect (default Slack; `notes:test` is the generic test connector). */
  account?: string
}

export interface Connected {
  start: Reply
  authorizeUrl: string
  state: string
  callback: Reply
  /** `/tools/slack?connected=1` or `/tools/slack?connect_error=<code>`: where route B sent the browser. */
  location: string
}

/** Route A, `mintTestCode` on its authorize URL, then route B: a full Slack connect with no browser. */
export async function connectSlack(request: APIRequestContext, o: ConnectOptions = {}): Promise<Connected> {
  const starter = o.starter ?? inhouse
  const start = await call(request, starter, 'POST', `/api/connect/${encodeURIComponent(o.account ?? SLACK_ACCOUNT)}/start`, { json: {} })
  expect(start.status, start.text).toBe(200)
  const authorizeUrl = start.json.authorizeUrl as string
  const minted = await mintTestCode(authorizeUrl, { ...(o.grant ? { scope: o.grant } : {}), ...(o.team ? { team: o.team } : {}) })
  const callback = await callbackOf(request, minted.callbackUrl, o.finisher ?? starter)
  return { start, authorizeUrl, state: minted.state, callback, location: callback.headers.location ?? '' }
}

/** Route B with a callback URL's path and query (its host is the configured redirect URI's, not the test build's). */
export function callbackOf(request: APIRequestContext, callbackUrl: string, who: Actor = inhouse): Promise<Reply> {
  const u = new URL(callbackUrl)
  return call(request, who, 'GET', `${u.pathname}${u.search}`)
}

export interface ToolRow { accountId?: string; paused?: boolean; canDisconnect?: boolean; revokeFailed?: boolean; connectedBy?: string }
export interface ToolsRead {
  connected: string[]
  beingConnected: string[]
  catalog: { k: string; accountId?: string }[]
  details: Record<string, ToolRow>
  connection: Record<string, { status: string }>
  channels: { key: string }[]
}

export async function readTools(request: APIRequestContext, who: Actor = inhouse): Promise<ToolsRead> {
  const r = await call(request, who, 'GET', '/api/tools')
  expect(r.status, r.text).toBe(200)
  return r.json as ToolsRead
}

/** Disconnects Slack if it is connected, so a spec starts from "not connected" (a disconnect of an empty account is a 409, which is fine here). */
export async function ensureDisconnected(request: APIRequestContext): Promise<void> {
  const t = await readTools(request)
  if (!t.connected.includes('slack')) return
  const r = await call(request, inhouse, 'POST', `/api/tools/${encodeURIComponent(SLACK_ACCOUNT)}/disconnect`, { json: {} })
  expect(r.status, r.text).toBe(200)
}

/** Disconnects first, then connects: a spec that needs a freshly connected Slack. */
export async function freshConnect(request: APIRequestContext, o: ConnectOptions = {}): Promise<Connected> {
  await ensureDisconnected(request)
  const c = await connectSlack(request, o)
  expect(c.callback.status, c.callback.text).toBe(303)
  expect(c.location, 'a connect that should work lands on the tool page').toBe('/tools/slack?connected=1')
  return c
}

/** The state value in a minted callback is the start's own: kept for the spec that reuses or swaps it. */
export const TEST_USER = SLACK_TEST.user
/** The workspace the fake answers by default, and another one (workspace_mismatch). */
export const TEAM = { home: SLACK_TEST.teamId, other: SLACK_TEST.otherTeamId } as const

/** Whether any string in `texts` contains `needle`. The canary checks use it on logs, bodies and the fake's own records. */
export const anyContains = (texts: readonly string[], needle: string): boolean => texts.some(t => t.includes(needle))

export const NOTES_ACCOUNT = 'notes:test'

/** Notice-send plumbing shared by the notify and injection specs. */
const randomPart = (n: number): string => crypto.randomUUID().replaceAll('-', '').toUpperCase().slice(0, n)
/** A run identity for the `notify` op: ids shaped like the server's (`r_` and `t_` plus 22 characters). */
export const newRun = (memberId: string): { memberId: string; runId: string; turnId: string } => ({ memberId, runId: `r_${randomPart(22)}`, turnId: `t_${randomPart(22)}` })
/** `notification_send` as the MCP route would run it for this run; the answer is the tool's text and structure as JSON. */
export const notifySend = async (request: APIRequestContext, as: { memberId: string; runId?: string; turnId?: string; chatId?: string }, args: Record<string, unknown>): Promise<any> => {
  const r = await hook(request, { op: 'notify', as, args })
  expect(r.status, r.text).toBe(200)
  return r.json
}

/** Stage 1 M2-B (N19): turns a write operation on or off for the brand (the test build's only way; no route writes it). */
export async function setCeiling(request: APIRequestContext, operation: 'shopify.order.tag_add' | 'slack.channel.post', enabled: boolean, perDayMax = 50): Promise<void> {
  await hookOk(request, { op: 'ceiling', operation, enabled, perDayMax })
}

/**
 * Stage 1 M2-B (N19): the outbox's `request` as an active person, with no tool call behind it. The answer is the outbox's
 * result: `refused` with its words, `waiting` (a card), `approved` (under a permission) or `existing`.
 */
export const requestAction = async (
  request: APIRequestContext,
  as: { memberId: string; chatId?: string },
  operation: 'shopify.order.tag_add' | 'slack.channel.post',
  args: Record<string, unknown>,
  o: { mode?: 'tool' | 'ask_only'; shop?: string } = {},
): Promise<any> => (await hookOk(request, { op: 'action', as, operation, args, ...o })).result

/** The brand's stage (a technical setting the Inhouse team writes). Slack posts start at Act; Watch reaches the bell only. */
export async function setStage(request: APIRequestContext, stage: 'Watch' | 'Act' | 'Run'): Promise<void> {
  const r = await putSetting(request, inhouse, 'technical', 'stage', stage)
  expect(r.status, r.text).toBe(200)
}

/** Lists exactly these channels for notices (Slack must be connected: each added one is checked at Slack). The first of `ids` is the alerts channel when `alerts` is true. */
export async function setListedChannels(request: APIRequestContext, ids: string[], alerts = false): Promise<void> {
  const cur = await call(request, inhouse, 'GET', '/api/notify/channels')
  expect(cur.status, cur.text).toBe(200)
  const r = await call(request, inhouse, 'PUT', '/api/notify/channels', { json: { channelIds: ids, ...(alerts && ids[0] ? { alertsChannelId: ids[0] } : {}), ifRev: cur.json.rev } })
  expect(r.status, r.text).toBe(200)
}

/** The channel ids of the fake workspace (invented), by the names the specs use. */
export const CHANNEL = {
  opsAlerts: 'C0TEST0001',
  general: 'C0TEST0002',
  partnerShared: 'C0TEST0003',
  oldLaunch: 'C0TEST0004',
  design: 'C0TEST0005',
  leadership: 'C0TEST0006',
  vendorConnect: 'C0TEST0008',
} as const

// ---------- static source checks (no server): the runner's reach ----------

const appRoot = new URL('../../', import.meta.url)
/** Every non-test `.ts` file under `dir` (relative to app/), as [path, text]. */
export function sourcesUnder(dir: string): [string, string][] {
  return (readdirSync(new URL(`${dir}/`, appRoot), { recursive: true }) as string[])
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map(f => [`${dir}/${f}`, readFileSync(new URL(`${dir}/${f}`, appRoot), 'utf8')] as [string, string])
}
export const sourceOf = (rel: string): string => readFileSync(new URL(rel, appRoot), 'utf8')

/** The runner's six literal egress routes (the hub's `/hub/` rides the `mcp` grant), read from the Worker's source. */
export const egressRoutes = (): string[] => {
  const m = /EGRESS_ROUTES: readonly EgressRoute\[\] = \[([^\]]*)\]/.exec(sourceOf('server/do/brand-agent/tokens.ts'))
  expect(m, 'EGRESS_ROUTES is in server/do/brand-agent/tokens.ts').not.toBeNull()
  return m![1]!.split(',').map(x => x.trim().replaceAll("'", '')).sort()
}

/**
 * STATIC: the runner has no path to the delivery or connect bindings. The six routes are literals, and no non-test file under
 * server/egress/ or runner/src/ names `HUB_DELIVERY`, `HUB_CONNECT`, `DeliveryGateway` or `ConnectGateway`. A live proof needs a run
 * token a spec can't mint, so this reads the source.
 */
export function expectNoRunnerPathToDelivery(): void {
  expect(egressRoutes()).toEqual(['audit', 'events', 'files', 'mcp', 'model', 'store'])
  for (const [file, text] of [...sourcesUnder('server/egress'), ...sourcesUnder('runner/src')]) {
    expect(text, `${file} names no delivery or connect binding`).not.toMatch(/HUB_DELIVERY|HUB_CONNECT|DeliveryGateway|ConnectGateway/)
  }
}
