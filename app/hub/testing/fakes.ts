// The test-fakes hook, hub side (W5's API specs, through the product's test-build route `POST /api/ops/test-fakes` and
// ConnectGateway.testFakes). Reads and flips the fake upstreams the singleton `__test-fakes__` SignIn Durable Object
// serves (./index.ts): the fake OAuth MCP servers (FakeMcpServer, `slack` and `notes`), the fake Slack Web API
// (FakeSlackWeb) and the recorded Shopify store.
//
// Rules: as ./index.ts. Reached only by a dynamic import inside `if (__INHOUSE_HUB_TEST__ && env.INHOUSE_TEST_BUILD
// === '1')` (oauth/entry.ts and signin/signin.ts), so the deployable bundle drops it; scripts/check-hub-build.mjs fails
// a deployable bundle carrying HUB_FAKES_CANARY or this module, and fails unless the test bundle carries the canary.
//
// Every op validates its whole input before it changes anything (an unknown switch, a wrong type or an unknown channel
// id is `invalid_args`, nothing applied). All upstream requests, fake switches/seeds, ConnectGateway answer bodies, hub
// logs and var overrides live in the one singleton `__test-fakes__` DO (with var overrides in its SQLite KV), so on a
// real Cloudflare deployment every stateless Worker isolate and every account SignIn DO isolate shares the same fakes.
// The DO is strictly a leaf: `alarm` and `state`'s `connectedAccounts` run in `runHubFakesOp` (ConnectGateway), never
// from inside the singleton DO, so no DO-to-DO cycle is possible.
import { z } from 'zod'
import type { HubResult } from '../index/contract'
import { err } from '../index/errors'
import { AccountIdSchema } from '../index/schemas'
import { settledAnswer } from '../../shared/rpc-answer'
import { flushTestLogs, loadRegistry, signInFor, TEST_FAKES_DO_NAME, TEST_FAKES_VARS_KEY } from '../signin/signin'
import { FakeMcpServer, SLACK_CHANNELS, SLACK_MESSAGES } from '../../test/upstreams/mcp/server'
import { FakeSlackWeb, WEB_CHANNELS } from '../../test/upstreams/slack/server'
import { dataset as shopifyFixtureValue } from '../../test/upstreams/shopify/recordings/fixture/dataset'
import type { Dataset } from '../../test/upstreams/shopify/dataset'
import { attachFakeStorage, mcpFixtures, notesMcp, shopifyIssuedTokens, shopifyRequests, shopifyWrite, slackMcp, slackWeb } from './index'
import { FIXTURE_KEYS, type FixtureKeyName } from '../../test/upstreams/mcp/index'
import type { FakeStorage } from './write-store'

/** Found in the hub's test bundle, never in the deployable one (scripts/check-hub-build.mjs reads it from here). */
export const HUB_FAKES_CANARY = 'INHOUSE_HUB_FAKES_CANARY_3a6f'

/** The FakeMcpServer switches the hook may set (the fake's own field names). `deliver` and `now` are functions: not settable. */
export const MCP_SWITCHES = [
  'cumulative', 'sameToken', 'rotation', 'refreshModes', 'missingScope', 'revokeFails', 'sse', 'prmResource', 'noS256',
  'headerMetadata', 'retryAfterS', 'asIssuer', 'exportAfterLists', 'expiresInS',
] as const
/** The FakeSlackWeb switches the hook may set (the fake's own field names). */
export const WEB_SWITCHES = ['rateLimitNextPost', 'failNextPost', 'throwNextPost', 'pageSize', 'padBytes'] as const

const McpSwitchesSchema = z.strictObject({
  /** Which fake MCP server; both when absent. */
  profile: z.enum(['slack', 'notes']).optional(),
  cumulative: z.boolean().optional(),
  sameToken: z.boolean().optional(),
  rotation: z.boolean().optional(),
  refreshModes: z.array(z.enum(['ok', 'unreachable', 'ratelimited', 'lost', 'invalid'])).max(50).optional(),
  missingScope: z.enum(['hide', 'fail']).optional(),
  revokeFails: z.boolean().optional(),
  sse: z.boolean().optional(),
  prmResource: z.string().min(1).max(500).nullable().optional(),
  noS256: z.boolean().optional(),
  headerMetadata: z.boolean().optional(),
  retryAfterS: z.number().int().min(0).max(3600).optional(),
  asIssuer: z.string().min(1).max(500).nullable().optional(),
  exportAfterLists: z.number().int().min(0).max(1000).optional(),
  /** A rotation token's lifetime in seconds (the hub refreshes proactively at half of it). */
  expiresInS: z.number().int().min(1).max(86_400).optional(),
  /** Not a switch: calls the fake's `staleSessions()` once (every current session's next request gets a 401). */
  staleSessions: z.literal(true).optional(),
})

const ChannelPatchSchema = z.strictObject({
  name: z.string().min(1).max(80).optional(),
  is_channel: z.boolean().optional(),
  is_private: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  is_member: z.boolean().optional(),
  is_shared: z.boolean().optional(),
  is_ext_shared: z.boolean().optional(),
  is_org_shared: z.boolean().optional(),
  is_pending_ext_shared: z.boolean().optional(),
})

const WebSwitchesSchema = z.strictObject({
  rateLimitNextPost: z.boolean().optional(),
  failNextPost: z.string().min(1).max(100).nullable().optional(),
  throwNextPost: z.boolean().optional(),
  pageSize: z.number().int().min(1).max(1000).optional(),
  padBytes: z.number().int().min(0).max(65_536).optional(),
  channels: z.array(z.strictObject({ id: z.string().min(1).max(40), patch: ChannelPatchSchema })).max(50).optional(),
})

const ShopifyWriteSwitchesSchema = z.strictObject({
  faults: z.strictObject({
    'shopify.order.tag_add': z.enum(['succeed', 'refuse', 'timeout', 'broken_body']).optional(),
  }).optional(),
})

/**
 * Stage 1 M4-F: M4's fixtures. `revokeKey` revokes one fixture key (the modern server's two, the helpdesk's or Path C's
 * REST API's). `toolsVersion` switches one connection's plant (`/changing/mcp`, `/list-fails/mcp`, by its address with
 * any query) to its second state or back: a test, not a list count, decides when a tool changes (#624). `revokeLogins`
 * ends every login at the fixture login server. `clockMs` moves the fixtures' clock (codes, tokens, requestState).
 */
const FixturesSwitchesSchema = z.strictObject({
  revokeKey: z.enum(Object.keys(FIXTURE_KEYS) as [FixtureKeyName, ...FixtureKeyName[]]).optional(),
  toolsVersion: z.strictObject({ address: z.string().url().max(500), version: z.union([z.literal(1), z.literal(2)]) }).optional(),
  revokeLogins: z.literal(true).optional(),
  clockMs: z.number().int().min(0).max(8_640_000_000_000_000).optional(),
})

/** The hub ops (the product's hook forwards these as they are). */
export const HubFakesOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('state') }),
  z.strictObject({ op: z.literal('reset') }),
  z.strictObject({
    op: z.literal('set'),
    mcp: McpSwitchesSchema.optional(),
    web: WebSwitchesSchema.optional(),
    shopifyWrite: ShopifyWriteSwitchesSchema.optional(),
    fixtures: FixturesSwitchesSchema.optional(),
  }),
  z.strictObject({ op: z.literal('alarm'), accountId: AccountIdSchema }),
  z.strictObject({ op: z.literal('var'), name: z.literal('SLACK_PRIVATE_SEARCH'), value: z.enum(['on', 'off']) }),
  z.strictObject({ op: z.literal('logs'), since: z.number().int().min(0).optional() }),
  z.strictObject({
    op: z.literal('seed'),
    slack: z.strictObject({ messages: z.array(z.strictObject({ channel: z.string().min(1).max(40), text: z.string().min(1).max(4000) })).min(1).max(50) }).optional(),
    shopify: z.strictObject({ refundNotes: z.array(z.strictObject({ order: z.string().min(1).max(200), note: z.string().min(1).max(4000) })).min(1).max(50) }).optional(),
  }),
])
export type HubFakesOp = z.infer<typeof HubFakesOpSchema>

const CONNECT_BODIES_CAP = 500
const HUB_LOGS_CAP = 5000
/** Bounded ConnectGateway answer log held in the singleton `__test-fakes__` DO isolate. */
const connectBodies: string[] = []
/** Bounded hub log buffer held in the singleton `__test-fakes__` DO isolate. */
const hubLogBuf: { lines: string[]; dropped: number } = { lines: [], dropped: 0 }

/** Appends one ConnectGateway answer JSON text (called by ConnectGateway via the singleton DO). */
export function recordConnectBody(body: string): void {
  connectBodies.push(body)
  if (connectBodies.length > CONNECT_BODIES_CAP) connectBodies.shift()
}

/** Appends flushed hub log lines from any Worker or SignIn DO isolate (called via the singleton DO). */
export function appendHubLogs(lines: string[]): void {
  for (const line of lines) {
    hubLogBuf.lines.push(line)
    if (hubLogBuf.lines.length > HUB_LOGS_CAP) {
      hubLogBuf.lines.shift()
      hubLogBuf.dropped++
    }
  }
}

/** A JSON copy, so the answer can't alias the fake's live arrays. */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** A fake MCP server's logs, plus every access token it issued (`issuedTokens`) and those not revoked (`liveTokens`). */
const mcpLogs = (f: FakeMcpServer) =>
  copy({
    requests: f.requests,
    revoked: f.revoked,
    refreshSends: f.refreshSends,
    toolCalls: f.toolCalls,
    issuedTokens: [...f.tokens.keys()],
    liveTokens: [...f.tokens].filter(([, t]) => !t.revoked).map(([k]) => k),
  })

/** Every account the registry names that is connected (`active`), with the scopes its stored grant holds. */
async function connectedAccounts(env: Env): Promise<{ accountId: string; scopes: string[] }[]> {
  const ids = [...new Set((await loadRegistry(env)).modules.map(m => m.accountId))].sort()
  const out: { accountId: string; scopes: string[] }[] = []
  for (const accountId of ids) {
    const r = await settledAnswer(signInFor(env, accountId).status(accountId))
    if (r.ok && r.value.state === 'active') out.push({ accountId, scopes: [...r.value.scopes] })
  }
  return out
}

/**
 * The singleton DO's own portion of `state`: `mcp` is the Slack MCP fake, `notes` the generic one, `web` the Slack Web
 * API fake, `shopify` the recorded store's request log and issued tokens, `connect.bodies` each ConnectGateway answer.
 */
function fakesStateLocal() {
  return {
    mcp: mcpLogs(slackMcp),
    notes: mcpLogs(notesMcp),
    web: copy({ requests: slackWeb.requests, posts: slackWeb.posts, violations: slackWeb.violations }),
    shopify: copy({ requests: shopifyRequests, issuedTokens: shopifyIssuedTokens }),
    shopifyWrite: copy({
      requests: shopifyWrite.requests,
      writes: shopifyWrite.writes,
      orders: [...shopifyWrite.orders.values()],
      faults: shopifyWrite.faults,
    }),
    connect: { bodies: [...connectBodies] },
    // Stage 1 M4-F: M4's fixtures (their request log, calls, writes, the login server's logs), a JSON copy.
    fixtures: mcpFixtures.state(),
  }
}

// ---------- seeds ----------

/** The fixture's own Slack messages: a reset cuts SLACK_MESSAGES back to these. */
const SLACK_MESSAGES_BASE = SLACK_MESSAGES.length
let seedTs = 0
/** Each refund note a seed replaced, by order then refund index: a reset puts them back. */
const notesBefore = new Map<string, string | null>()

/** The very object the seam's recorded store serves from (createShopifyUpstream checks it and reads it as it is). */
const shopifyFixture = shopifyFixtureValue as Dataset
const orderFor = (ref: string) => shopifyFixture.orders.find(o => o.id === ref || o.name === ref)

/**
 * Plants text where the reads return it. Slack: a message in a fixture channel (search and channel history read it).
 * Shopify: a recorded order's first refund `note` (the hub denies the order's own note by path, so the refund note is
 * the note text a read returns, through refunds_search); an order with no refund, or no such order, is refused.
 */
function applySeed(op: Extract<HubFakesOp, { op: 'seed' }>): HubResult<{ seeded: { slack: number; shopify: number } }> {
  for (const m of op.slack?.messages ?? []) if (!SLACK_CHANNELS.some(c => c.id === m.channel)) return err('invalid_args', 'slack.messages.channel')
  for (const n of op.shopify?.refundNotes ?? []) if (!orderFor(n.order)?.refunds[0]) return err('invalid_args', 'shopify.refundNotes.order')
  for (const m of op.slack?.messages ?? []) {
    SLACK_MESSAGES.push({ channel: m.channel, ts: `1763900000.${String(++seedTs).padStart(6, '0')}`, user: 'U0TEST0002', text: m.text })
  }
  for (const n of op.shopify?.refundNotes ?? []) {
    const order = orderFor(n.order)!
    const key = `${order.id}#0`
    if (!notesBefore.has(key)) notesBefore.set(key, order.refunds[0]!.note)
    order.refunds[0]!.note = n.note
  }
  return { ok: true, value: { seeded: { slack: op.slack?.messages.length ?? 0, shopify: op.shopify?.refundNotes.length ?? 0 } } }
}

function clearSeeds(): void {
  SLACK_MESSAGES.length = SLACK_MESSAGES_BASE
  for (const [key, note] of notesBefore) {
    const order = orderFor(key.slice(0, key.lastIndexOf('#')))
    if (order?.refunds[0]) order.refunds[0].note = note
  }
  notesBefore.clear()
}

/**
 * Clears the fakes' logs (and the ConnectGateway answers kept), restores every switch to a fresh fake's value and the
 * channels to the fixture's, drops the var overrides and the seeds. Issued tokens stay (a live connection keeps working).
 */
export function resetFakes(kv?: Pick<SyncKvStorage, 'delete'>): void {
  for (const f of [slackMcp, notesMcp]) {
    const fresh = new FakeMcpServer(f.profile) as unknown as Record<string, unknown>
    const live = f as unknown as Record<string, unknown>
    for (const k of MCP_SWITCHES) live[k] = copy(fresh[k])
    f.requests = []
    f.revoked = []
    f.refreshSends = []
    f.toolCalls = []
    f.restartLists()
    // A `staleSessions` set earlier must not 401 the next test's first request.
    for (const session of f.sessions.values()) session.stale = false
  }
  const freshWeb = new FakeSlackWeb() as unknown as Record<string, unknown>
  const liveWeb = slackWeb as unknown as Record<string, unknown>
  for (const k of WEB_SWITCHES) liveWeb[k] = freshWeb[k]
  slackWeb.channels = new Map(WEB_CHANNELS.map(c => [c.id, { ...c }]))
  slackWeb.requests = []
  slackWeb.posts = []
  slackWeb.violations = []
  shopifyRequests.length = 0
  shopifyWrite.reset()
  connectBodies.length = 0
  mcpFixtures.reset()
  kv?.delete(TEST_FAKES_VARS_KEY)
  clearSeeds()
}

function applySet(op: Extract<HubFakesOp, { op: 'set' }>): HubResult<{ set: true }> {
  // Check every channel id, and the plant address, before changing anything.
  for (const c of op.web?.channels ?? []) if (!slackWeb.channels.has(c.id)) return err('invalid_args', 'web.channels.id')
  const tv = op.fixtures?.toolsVersion
  if (tv && !mcpFixtures.hasToolsVersion(tv.address)) return err('invalid_args', 'fixtures.toolsVersion.address')
  if (op.mcp) {
    const { profile, staleSessions, ...switches } = op.mcp
    const targets = profile === 'slack' ? [slackMcp] : profile === 'notes' ? [notesMcp] : [slackMcp, notesMcp]
    for (const f of targets) {
      Object.assign(f, switches)
      if (staleSessions) f.staleSessions()
    }
  }
  if (op.web) {
    const { channels, ...switches } = op.web
    Object.assign(slackWeb, switches)
    for (const c of channels ?? []) slackWeb.channels.set(c.id, { ...slackWeb.channels.get(c.id)!, ...c.patch })
  }
  if (op.shopifyWrite?.faults) {
    Object.assign(shopifyWrite.faults, op.shopifyWrite.faults)
  }
  if (op.fixtures?.revokeKey) mcpFixtures.revokeKey(op.fixtures.revokeKey)
  if (tv) mcpFixtures.setToolsVersion(tv.address, tv.version)
  if (op.fixtures?.revokeLogins) mcpFixtures.revokeLogins()
  if (op.fixtures?.clockMs !== undefined) mcpFixtures.setClock(op.fixtures.clockMs)
  return { ok: true, value: { set: true } }
}

/** The hub's captured log lines from sequence number `since` on, and the number to pass next time. */
export function hubLogs(since = 0): { lines: string[]; next: number } {
  const from = Math.max(0, since - hubLogBuf.dropped)
  return { lines: hubLogBuf.lines.slice(from), next: hubLogBuf.dropped + hubLogBuf.lines.length }
}

/**
 * Leaf ops executed inside the singleton `__test-fakes__` SignIn Durable Object (zero outbound DO calls). The write
 * store is bound to the DO's storage first (#619: `state` after a restart reads it back), and kept after `set` and `reset`.
 */
export function runHubFakesInDo(storage: FakeStorage, input: unknown): HubResult<unknown> {
  const { kv } = storage
  const parsed = HubFakesOpSchema.safeParse(input)
  if (!parsed.success) return err('invalid_args', parsed.error.issues[0]?.path.join('.') || 'op')
  const op = parsed.data
  const writeStore = attachFakeStorage(storage)
  switch (op.op) {
    case 'state':
      return { ok: true, value: fakesStateLocal() }
    case 'reset':
      resetFakes(kv)
      writeStore.save()
      return { ok: true, value: { reset: true } }
    case 'set': {
      const r = applySet(op)
      writeStore.save()
      return r
    }
    case 'var': {
      const cur = kv.get<Record<string, string>>(TEST_FAKES_VARS_KEY) ?? {}
      kv.put(TEST_FAKES_VARS_KEY, { ...cur, [op.name]: op.value })
      return { ok: true, value: { name: op.name, value: op.value } }
    }
    case 'logs':
      return { ok: true, value: hubLogs(op.since) }
    case 'seed':
      return applySeed(op)
    case 'alarm':
      return err('invalid_args', 'op')
  }
}

/**
 * One hub op (called from ConnectGateway.testFakes). Dispatches leaf ops to the singleton `__test-fakes__` DO and
 * keeps account-DO fan-out (`alarm`, `state.accounts`) in this gateway so DO calls form a strict DAG with no cycles.
 * Every answer read from a Durable Object is copied and released (`settledAnswer`, shared/rpc-answer.ts), never passed on
 * as is or left open, as the hub's gateways do (#443): the objects' answers are theirs, and the call stays tied to them (#530).
 */
export async function runHubFakesOp(env: Env, input: unknown): Promise<HubResult<unknown>> {
  const parsed = HubFakesOpSchema.safeParse(input)
  if (!parsed.success) return err('invalid_args', parsed.error.issues[0]?.path.join('.') || 'op')
  const op = parsed.data
  const fakes = env.SIGNIN.get(env.SIGNIN.idFromName(TEST_FAKES_DO_NAME))
  switch (op.op) {
    case 'alarm':
      return (await settledAnswer(env.SIGNIN.get(env.SIGNIN.idFromName(op.accountId)).testFireAlarm())) as HubResult<unknown>
    case 'state': {
      const local = (await settledAnswer(fakes.testFakesOp(op))) as HubResult<Record<string, unknown>>
      if (!local.ok) return local
      return { ok: true, value: { ...local.value, accounts: await connectedAccounts(env) } }
    }
    case 'logs':
      await flushTestLogs(env)
      return (await settledAnswer(fakes.testFakesOp(op))) as HubResult<unknown>
    case 'reset':
    case 'set':
    case 'var':
    case 'seed':
      return (await settledAnswer(fakes.testFakesOp(op))) as HubResult<unknown>
  }
}
