// The test-fakes hook, hub side (W5's API specs, through the product's test-build route `POST /api/ops/test-fakes` and
// ConnectGateway.testFakes). Reads and flips the fake upstreams this isolate's test seam serves (./index.ts): the fake
// OAuth MCP servers (FakeMcpServer, `slack` and `notes`) and the fake Slack Web API (FakeSlackWeb).
//
// Rules: as ./index.ts. Reached only by a dynamic import inside `if (__INHOUSE_HUB_TEST__ && env.INHOUSE_TEST_BUILD
// === '1')` (oauth/entry.ts), so the deployable bundle drops it; scripts/check-hub-build.mjs fails a deployable bundle
// carrying HUB_FAKES_CANARY or this module, and fails unless the test bundle carries the canary.
//
// Every op validates its whole input before it changes anything (an unknown switch, a wrong type or an unknown channel
// id is `invalid_args`, nothing applied). The fakes, the var overrides and the log buffer live in this isolate: in the
// local multi-config `wrangler dev` the hub's entrypoints and its Durable Objects share one isolate, so they all see
// the same fakes.
import { z } from 'zod'
import type { HubResult } from '../index/contract'
import { err } from '../index/errors'
import { AccountIdSchema } from '../index/schemas'
import { loadRegistry, signInFor } from '../signin/signin'
import { FakeMcpServer, SLACK_CHANNELS, SLACK_MESSAGES } from '../../test/upstreams/mcp/server'
import { FakeSlackWeb, WEB_CHANNELS } from '../../test/upstreams/slack/server'
import { dataset as shopifyFixtureValue } from '../../test/upstreams/shopify/recordings/fixture/dataset'
import type { Dataset } from '../../test/upstreams/shopify/dataset'
import { notesMcp, shopifyIssuedTokens, shopifyRequests, slackMcp, slackWeb } from './index'

/** Found in the hub's test bundle, never in the deployable one (scripts/check-hub-build.mjs reads it from here). */
export const HUB_FAKES_CANARY = 'INHOUSE_HUB_FAKES_CANARY_3a6f'

/** The FakeMcpServer switches the hook may set (the fake's own field names). `deliver` and `now` are functions: not settable. */
export const MCP_SWITCHES = [
  'cumulative', 'sameToken', 'rotation', 'refreshModes', 'missingScope', 'revokeFails', 'sse', 'prmResource', 'noS256',
  'headerMetadata', 'retryAfterS', 'asIssuer', 'exportAfterLists',
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

/** The hub ops (the product's hook forwards these as they are). */
export const HubFakesOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('state') }),
  z.strictObject({ op: z.literal('reset') }),
  z.strictObject({ op: z.literal('set'), mcp: McpSwitchesSchema.optional(), web: WebSwitchesSchema.optional() }),
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

type Globals = {
  __inhouseHubTestVars?: Record<string, string>
  __inhouseHubTestLogs?: { lines: string[]; dropped: number }
  __inhouseHubTestConnectBodies?: string[]
}
const g = globalThis as Globals

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
    const r = await signInFor(env, accountId).status(accountId)
    if (r.ok && r.value.state === 'active') out.push({ accountId, scopes: [...r.value.scopes] })
  }
  return out
}

/**
 * What `state` answers: `mcp` is the Slack MCP fake, `notes` the generic one, `web` the Slack Web API fake, `shopify`
 * the recorded store's request log (path and method) and the access tokens it issued, `connect.bodies` each
 * ConnectGateway answer as JSON text (oauth/entry.ts), `accounts` the connected accounts' granted scopes.
 */
export async function fakesState(env: Env) {
  return {
    mcp: mcpLogs(slackMcp),
    notes: mcpLogs(notesMcp),
    web: copy({ requests: slackWeb.requests, posts: slackWeb.posts, violations: slackWeb.violations }),
    shopify: copy({ requests: shopifyRequests, issuedTokens: shopifyIssuedTokens }),
    connect: { bodies: [...(g.__inhouseHubTestConnectBodies ?? [])] },
    accounts: await connectedAccounts(env),
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
export function resetFakes(): void {
  for (const f of [slackMcp, notesMcp]) {
    const fresh = new FakeMcpServer(f.profile) as unknown as Record<string, unknown>
    const live = f as unknown as Record<string, unknown>
    for (const k of MCP_SWITCHES) live[k] = copy(fresh[k])
    f.requests = []
    f.revoked = []
    f.refreshSends = []
    f.toolCalls = []
    f.restartLists()
  }
  const freshWeb = new FakeSlackWeb() as unknown as Record<string, unknown>
  const liveWeb = slackWeb as unknown as Record<string, unknown>
  for (const k of WEB_SWITCHES) liveWeb[k] = freshWeb[k]
  slackWeb.channels = new Map(WEB_CHANNELS.map(c => [c.id, { ...c }]))
  slackWeb.requests = []
  slackWeb.posts = []
  slackWeb.violations = []
  shopifyRequests.length = 0
  delete g.__inhouseHubTestConnectBodies
  delete g.__inhouseHubTestVars
  clearSeeds()
}

function applySet(op: Extract<HubFakesOp, { op: 'set' }>): HubResult<{ set: true }> {
  // Check every channel id before changing anything.
  for (const c of op.web?.channels ?? []) if (!slackWeb.channels.has(c.id)) return err('invalid_args', 'web.channels.id')
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
  return { ok: true, value: { set: true } }
}

/** The hub's captured log lines from sequence number `since` on, and the number to pass next time. */
export function hubLogs(since = 0): { lines: string[]; next: number } {
  const buf = g.__inhouseHubTestLogs ?? { lines: [], dropped: 0 }
  const from = Math.max(0, since - buf.dropped)
  return { lines: buf.lines.slice(from), next: buf.dropped + buf.lines.length }
}

/** One hub op. `env.SIGNIN` for `alarm`. */
export async function runHubFakesOp(env: Env, input: unknown): Promise<HubResult<unknown>> {
  const parsed = HubFakesOpSchema.safeParse(input)
  if (!parsed.success) return err('invalid_args', parsed.error.issues[0]?.path.join('.') || 'op')
  const op = parsed.data
  switch (op.op) {
    case 'state':
      return { ok: true, value: await fakesState(env) }
    case 'reset':
      resetFakes()
      return { ok: true, value: { reset: true } }
    case 'set':
      return applySet(op)
    case 'alarm':
      return env.SIGNIN.get(env.SIGNIN.idFromName(op.accountId)).testFireAlarm()
    case 'var':
      g.__inhouseHubTestVars = { ...(g.__inhouseHubTestVars ?? {}), [op.name]: op.value }
      return { ok: true, value: { name: op.name, value: op.value } }
    case 'logs':
      return { ok: true, value: hubLogs(op.since) }
    case 'seed':
      return applySeed(op)
  }
}
