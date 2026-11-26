// The test-fakes hook, product side (W5's API specs; route 76, `POST /api/ops/test-fakes`, server/ops/fakes-hook.ts).
// Import it only as `@test-fakes`: `vite build --mode product-test` resolves that to this file, every other build (the
// deployable product and the eval build included) to test-fakes-off.ts, so this never enters a deployable Worker
// (scripts/check-product-build.mjs part 8 scans for the canary below and for this module). It runs in the Worker
// request (fakes-hook.ts), whose env has DB, FILES and the three hub bindings; it reaches the hub over those bindings only.
//
// CLOSE TO AUTH, on purpose and only here: `notify` runs `notification_send` as a named member (an impersonation of a
// run's person) and `hub` calls the hub's ReadGateway with a run-kind scope no run token stands behind. Both exist so a
// spec can drive those paths without a container. The route is release-token only and 404 outside the test build.
//
// Ops (body `{ op, ... }`):
// - `state`, `reset`, `set`, `alarm`, `var`, `seed`: forwarded as they are to the hub's ConnectGateway.testFakes (the
//   fakes, the alarm, the var override and the seeds live in the hub isolate: hub/testing/fakes.ts). `state` gets
//   `serverDay` added here: the UTC day key the notice day caps count by (notify-slack/store.ts `utcDay`).
// - `hub`: { method: 'listTools' | 'callTool', name?, args? }: the egress `/hub/` route's own handler (handleHub) with a
//   synthetic run grant, so the scope is built exactly as that route builds it. Answers the ReadGateway's HubResult as
//   it came over the binding (502 `binding_failed` when the binding threw).
// - `notify`: { as: { memberId, chatId?, runId?, turnId? }, args }: the inhouse MCP server's own handler (handleMcp)
//   calling `notification_send` as `as.memberId`, which must be an active person on the brand; an `as.chatId` must be
//   that member's chat, and an `as.runId` or `as.turnId` given with it one of that chat's (both: a pair of one row).
//   Answers `{ result }`:
//   the tool's CallToolResult (text, structuredContent.recipients, isError on a refusal).
// - `prompt`: the prompt turnSystemPrompt builds now, for a synthetic turn id. Answers `{ prompt, version }`.
// - `systemNotice`: { notice }: sendSystemNotice(env, notice) with the real env. Answers its SystemNoticeResult.
// - `logs`: { since?: { product?, hub? } }: the captured log lines of this isolate and the hub's. Answers
//   `{ lines: [{ worker: 'product' | 'hub', line }], next: { product, hub } }`: the product's lines, then the hub's.
//   "This isolate" is the Worker request's: the BrandAgent's lines are in it only locally (one isolate for the Worker
//   and the object). On the remote per-PR deploy the object may run in another isolate, so its lines may be missing.
// - `transcripts`: the R2 session store's objects (`sessions/`, the runner's transcripts) as texts. Answers `{ texts }`.
//   Empty in the local test build (no container writes a session); filled on the per-PR remote deploy.
// - `ceiling` (Stage 1 M2-B, N2, N19): { operation, enabled, perDayMax }: the one way an operation exists in the test build
//   (no route writes the ceiling in M1 or M2). Answers `{ ok: true }`.
// - `action` (Stage 1 M2-B, N19): { as: { memberId, chatId? }, operation, args, mode?, shop? }: the outbox's `request` as
//   an active person on the brand, with no tool call behind it (`invocation: null`). The account's pause comes from the
//   hub; `shop` is the Shopify scope's shop (the hub doesn't expose it to the server; M2-D replaces this op with the real
//   egress handler). An approved action's send is asked of BrandAgent as an answer's is. Answers `{ result }`: the
//   outbox's `OutboxRequestResult`.
import { z } from 'zod'
import type { CallerScope, ConnectGateway, HubResult } from '../../hub/index/contract.ts'
import type { RunGrant } from '../do/brand-agent/tokens.ts'
import { handleHub, hubRouteDeps, type ReadGatewayLike } from '../egress/hub.ts'
import { handleMcp } from '../mcp/server/index.ts'
import { notifyDeps } from '../mcp/tools/notifications/deps.ts'
import { sendSystemNotice, type SystemNoticeInput } from '../notify-slack/send.ts'
import { utcDay } from '../notify-slack/store.ts'
import { turnPromptDeps, turnSystemPrompt } from '../prompt/connected.ts'
import { R2_PREFIXES, type KeyedBucket } from '../db/r2-keys.ts'
import { WriteOperationArgSchema } from '../../shared/contract/audit.ts'
import type { AccountSummary } from '../../hub/index/contract.ts'
import { runBatch } from '../db/sql.ts'
import { setCeilingStmt } from '../permissions/ceiling.ts'
import { outboxFacts } from '../outbox/facts.ts'
import { openOutbox } from '../outbox/store.ts'
import { SEND_KIND, sendTaskId } from '../outbox/send-task.ts'
import type { BrandAgent } from '../do/brand-agent/index.ts'

declare const __INHOUSE_TEST_BUILD__: boolean

/** The bundle-scan canary: it must be in the test build's Worker and never in a deployable one. */
export const TEST_FAKES_CANARY = 'inhouse-test-fakes-canary-6b2f90d4'

export type TestFakesEnv = { DB: D1Database; FILES?: KeyedBucket; HUB?: unknown; HUB_CONNECT?: unknown; HUB_DELIVERY?: unknown; BRAND_AGENT?: unknown }
/** What the route answers: a status and a JSON body. */
export type TestFakesAnswer = { status: number; body: unknown }

/** The ops forwarded to the hub as they are (hub/testing/fakes.ts validates their fields). */
export const HUB_OPS = ['state', 'reset', 'set', 'alarm', 'var', 'seed'] as const

const id = z.string().min(1).max(200)
const ProductOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('hub'), method: z.enum(['listTools', 'callTool']), name: z.string().min(1).max(200).optional(), args: z.record(z.string(), z.unknown()).optional() }),
  z.strictObject({ op: z.literal('notify'), as: z.strictObject({ memberId: id, chatId: id.optional(), runId: id.optional(), turnId: id.optional() }), args: z.unknown() }),
  z.strictObject({ op: z.literal('prompt') }),
  z.strictObject({ op: z.literal('systemNotice'), notice: z.unknown() }),
  z.strictObject({ op: z.literal('logs'), since: z.strictObject({ product: z.number().int().min(0).optional(), hub: z.number().int().min(0).optional() }).optional() }),
  z.strictObject({ op: z.literal('transcripts') }),
  z.strictObject({ op: z.literal('ceiling'), operation: WriteOperationArgSchema, enabled: z.boolean(), perDayMax: z.number().int().min(1).max(10_000) }),
  z.strictObject({
    op: z.literal('action'), as: z.strictObject({ memberId: id, chatId: id.optional() }), operation: WriteOperationArgSchema, args: z.unknown(),
    mode: z.enum(['tool', 'ask_only']).optional(), shop: z.string().min(1).max(100).optional(),
  }),
])
type ProductOp = z.infer<typeof ProductOpSchema>

const ok = (body: unknown): TestFakesAnswer => ({ status: 200, body })
const refuse = (status: number, code: string, detail?: string): TestFakesAnswer => ({ status, body: { error: { code, ...(detail ? { detail } : {}) } } })

// ---------- the log capture ----------

const LOG_CAP = 5000
const captured: { lines: string[]; dropped: number } = { lines: [], dropped: 0 }
let installed = false

const lineOf = (args: unknown[]): string =>
  args.map(a => {
    if (typeof a === 'string') return a
    try {
      return JSON.stringify(a) ?? String(a)
    } catch {
      return String(a)
    }
  }).join(' ')

/** Wraps this isolate's console once: every line still goes out, and a copy goes to a bounded buffer for `logs`. */
export function installLogCapture(): void {
  if (installed) return
  installed = true
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      captured.lines.push(lineOf(args))
      if (captured.lines.length > LOG_CAP) {
        captured.lines.shift()
        captured.dropped++
      }
      original(...args)
    }
  }
}
// In the test build, from the isolate's start (this module loads with the Worker entry, which the BrandAgent's class is
// exported from, so locally, where the Worker and the object share one isolate, the object's lines land in the same
// buffer). Only locally: on the remote per-PR deploy the BrandAgent may run in another isolate, and `logs` (which runs in
// the Worker request) may then miss its lines. Tests install it themselves.
if (__INHOUSE_TEST_BUILD__) installLogCapture()

export function productLogs(since = 0): { lines: string[]; next: number } {
  return { lines: captured.lines.slice(Math.max(0, since - captured.dropped)), next: captured.dropped + captured.lines.length }
}

// ---------- the ops ----------

const serverScope = (): CallerScope => ({ kind: 'server', job: 'test-fakes', requestId: `test-fakes-${crypto.randomUUID()}` })
type FakesGateway = Required<Pick<ConnectGateway, 'testFakes'>>

/** One op on the hub's ConnectGateway.testFakes, its HubResult turned into an answer. */
async function viaHub(env: TestFakesEnv, op: unknown): Promise<TestFakesAnswer> {
  let r: HubResult<unknown>
  try {
    r = await (env.HUB_CONNECT as FakesGateway).testFakes(serverScope(), op)
  } catch {
    return refuse(502, 'hub_unreachable')
  }
  if (r.ok) return ok(r.value)
  if (r.error.code === 'invalid_args') return refuse(400, 'invalid', r.error.message)
  // The deployable hub answers not_configured: it has no fakes.
  if (r.error.code === 'not_configured') return refuse(502, 'hub_not_test_build')
  return refuse(502, 'hub_error', r.error.code)
}

const tail = () => crypto.randomUUID().replaceAll('-', '').slice(0, 22)

/** `hub`: the egress route's handler with a synthetic run grant; the binding's raw answer recorded on the way. */
async function hubOp(env: TestFakesEnv, op: Extract<ProductOp, { op: 'hub' }>): Promise<TestFakesAnswer> {
  if (op.method === 'callTool' && op.name === undefined) return refuse(400, 'invalid', 'callTool needs name')
  const hub = env.HUB as ReadGatewayLike
  let result: unknown = null
  const recorder: ReadGatewayLike = {
    listTools: async scope => (result = await hub.listTools(scope)) as never,
    callTool: async (scope, name, args) => (result = await hub.callTool(scope, name, args)) as never,
  }
  const grant: RunGrant = {
    turnId: `t_fakes_${tail()}`, runId: `r_${tail()}`, chatId: `c_fakes_${tail()}`, memberId: 'm_test_fakes', sessionId: `s_fakes_${tail()}`,
    model: 'test-fakes', sideModel: 'test-fakes', expiresAtMs: Date.now() + 60_000,
  }
  const message = op.method === 'listTools'
    ? { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    : { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: op.name, arguments: op.args ?? {} } }
  const res = await handleHub(
    new Request('https://egress.invalid/hub/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) }),
    grant,
    // This hook exercises the hub binding’s own tool rules (ReadGateway refuses every write itself), so the egress's Watch
    // gate is held open: 1 is the stage index the egress reads as Act. The production egress tests cover that gate, which
    // M2-D replaces; nothing outside server/egress/ and server/stage/ imports the stage code (M2-F).
    hubRouteDeps(recorder, entry => console.log(entry), async () => 1),
  )
  // The route's own answer is read so the call completes as the egress would; the spec gets the binding's HubResult.
  await res.text()
  if (result === null) return refuse(502, 'binding_failed')
  return ok(result)
}

/** `notify`: notification_send through the MCP server's handler, as an active person on the brand. */
async function notifyOp(env: TestFakesEnv, op: Extract<ProductOp, { op: 'notify' }>): Promise<TestFakesAnswer> {
  const member = await env.DB.prepare("SELECT id FROM members WHERE id = ? AND kind = 'person' AND status = 'active'").bind(op.as.memberId).first<{ id: string }>()
  if (!member) return refuse(400, 'unknown_member')
  // A chat named here must be the member's own, and a run or turn named with it must be one of that chat's (its rows
  // in chat_messages). Without a chat the ids are synthetic and unchecked on purpose: the run caps count by run id, and
  // a spec needs fresh runs without a turn (a real run lives in the BrandAgent, not in a table this hook could read).
  if (op.as.chatId !== undefined) {
    const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ? AND owner_id = ? AND deleted_at_ms IS NULL').bind(op.as.chatId, member.id).first<{ id: string }>()
    if (!chat) return refuse(400, 'chat_not_members')
    for (const [column, value] of [['run_id', op.as.runId], ['turn_id', op.as.turnId]] as const) {
      if (value === undefined) continue
      const row = await env.DB.prepare(`SELECT 1 AS one FROM chat_messages WHERE chat_id = ? AND ${column} = ? LIMIT 1`).bind(chat.id, value).first()
      if (!row) return refuse(400, column === 'run_id' ? 'run_not_chats' : 'turn_not_chats')
    }
    // Both given: the turn must be that run's, not just any turn of the chat.
    if (op.as.runId !== undefined && op.as.turnId !== undefined) {
      const pair = await env.DB.prepare('SELECT 1 AS one FROM chat_messages WHERE chat_id = ? AND run_id = ? AND turn_id = ? LIMIT 1').bind(chat.id, op.as.runId, op.as.turnId).first()
      if (!pair) return refuse(400, 'turn_not_runs')
    }
  }
  const scope = {
    memberId: member.id,
    chatId: op.as.chatId ?? `c_fakes_${tail()}`,
    runId: op.as.runId ?? `r_${tail()}`,
    turnId: op.as.turnId ?? `t_fakes_${tail()}`,
  }
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notification_send', arguments: op.args } }
  const res = await handleMcp(
    new Request('https://egress.invalid/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) }),
    scope,
    { db: env.DB, notify: notifyDeps(env) },
  )
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } }
  if (body.result === undefined) return refuse(400, 'invalid', body.error?.message ?? 'no result')
  return ok({ result: body.result })
}

async function logsOp(env: TestFakesEnv, op: Extract<ProductOp, { op: 'logs' }>): Promise<TestFakesAnswer> {
  const hub = await viaHub(env, { op: 'logs', ...(op.since?.hub !== undefined ? { since: op.since.hub } : {}) })
  if (hub.status !== 200) return hub
  const product = productLogs(op.since?.product)
  const hubLogs = hub.body as { lines: string[]; next: number }
  return ok({
    lines: [...product.lines.map(line => ({ worker: 'product', line })), ...hubLogs.lines.map(line => ({ worker: 'hub', line }))],
    next: { product: product.next, hub: hubLogs.next },
  })
}

/** The most the `transcripts` op reads: objects, and bytes in all. */
const TRANSCRIPT_MAX_OBJECTS = 500
const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024
/** The session store's prefix, as the registry lists it (r2-keys.ts). Read only here. */
const SESSIONS_PREFIX = R2_PREFIXES.find(p => p === 'sessions/')!

async function transcriptsOp(env: TestFakesEnv): Promise<TestFakesAnswer> {
  if (!env.FILES) return refuse(502, 'no_session_store')
  const texts: string[] = []
  let bytes = 0
  let cursor: string | undefined
  do {
    const page = await env.FILES.list({ prefix: SESSIONS_PREFIX, ...(cursor ? { cursor } : {}) })
    for (const o of page.objects) {
      if (texts.length >= TRANSCRIPT_MAX_OBJECTS || bytes + o.size > TRANSCRIPT_MAX_BYTES) return refuse(502, 'too_many_transcripts')
      const body = await env.FILES.get(o.key)
      if (!body) continue
      texts.push(await body.text())
      bytes += o.size
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return ok({ texts })
}

/** `ceiling`: turns an operation on or off for the brand (the test build only: no route writes the ceiling, N2). */
async function ceilingOp(env: TestFakesEnv, op: Extract<ProductOp, { op: 'ceiling' }>): Promise<TestFakesAnswer> {
  await runBatch(env.DB, [setCeilingStmt({ operation: op.operation, enabled: op.enabled, perDayMax: op.perDayMax, actorId: 'm_system', nowMs: Date.now() })])
  return ok({ ok: true })
}

/** `action`: the outbox's `request` as an active person, its account facts from the hub; an approval's send asked for. */
async function actionOp(env: TestFakesEnv, op: Extract<ProductOp, { op: 'action' }>): Promise<TestFakesAnswer> {
  const member = await env.DB.prepare("SELECT id, role FROM members WHERE id = ? AND kind = 'person' AND status = 'active'").bind(op.as.memberId).first<{ id: string; role: 'member' | 'admin' }>()
  if (!member) return refuse(400, 'unknown_member')
  if (op.as.chatId !== undefined) {
    const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ? AND owner_id = ? AND deleted_at_ms IS NULL').bind(op.as.chatId, member.id).first()
    if (!chat) return refuse(400, 'chat_not_members')
  }
  const hubAccounts = async () => {
    const r = await (env.HUB_CONNECT as Pick<ConnectGateway, 'listAccounts'>).listAccounts(serverScope())
    if (!r.ok) throw new Error(`test-fakes action: the hub's accounts are unreadable (${r.error.code})`)
    return r.value.map((a: AccountSummary) => ({ accountId: a.accountId, paused: a.status.paused, label: a.connector === 'shopify' ? 'Shopify' : 'Slack', shop: a.connector === 'shopify' ? op.shop ?? null : null }))
  }
  const agent = env.BRAND_AGENT as DurableObjectNamespace<BrandAgent> | undefined
  const port = openOutbox({
    db: env.DB, requestId: `test-fakes-${crypto.randomUUID()}`, now: () => Date.now(), facts: outboxFacts({ db: env.DB, hubAccounts }),
    schedule: async (actionId, atMs) => {
      if (!agent) throw new Error('test-fakes action: no BRAND_AGENT binding')
      await agent.getByName('brand').poke({ kind: SEND_KIND, id: sendTaskId(actionId), dueAtMs: atMs })
    },
  })
  const result = await port.request(
    { asker: { memberId: member.id, role: member.role }, origin: 'chat', chatId: op.as.chatId ?? `c_fakes_${tail()}`, nowMs: Date.now(), invocation: null, jobId: null },
    { operation: op.operation, args: op.args },
    { mode: op.mode ?? 'tool' },
  )
  return ok({ result })
}

/** One op of the hook. Validates the body first: a malformed body or an unknown op is 400 and does nothing. */
export async function runTestFakes(body: unknown, env: TestFakesEnv): Promise<TestFakesAnswer> {
  console.log({ event: 'test_fakes', op: typeof (body as { op?: unknown } | null)?.op === 'string' ? (body as { op: string }).op : 'none', canary: TEST_FAKES_CANARY })
  if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof (body as { op?: unknown }).op !== 'string') {
    return refuse(400, 'invalid', 'the body is { op, ... }')
  }
  const name = (body as { op: string }).op
  if (name === 'state') {
    const state = await viaHub(env, body)
    return state.status === 200 ? ok({ ...(state.body as object), serverDay: utcDay(Date.now()) }) : state
  }
  if ((HUB_OPS as readonly string[]).includes(name)) return viaHub(env, body)
  const parsed = ProductOpSchema.safeParse(body)
  if (!parsed.success) return refuse(400, 'invalid', parsed.error.issues[0]?.path.join('.') || 'op')
  const op = parsed.data
  switch (op.op) {
    case 'hub':
      return hubOp(env, op)
    case 'notify':
      return notifyOp(env, op)
    case 'prompt':
      const built = await turnSystemPrompt(turnPromptDeps(env), `t_fakes_${tail()}`)
      return ok({ prompt: built.text, version: built.version })
    case 'systemNotice':
      return ok(await sendSystemNotice(env, op.notice as SystemNoticeInput))
    case 'logs':
      return logsOp(env, op)
    case 'transcripts':
      return transcriptsOp(env)
    case 'ceiling':
      return ceilingOp(env, op)
    case 'action':
      return actionOp(env, op)
  }
}

/**
 * Route 76's entry (fakes-hook.ts): one op in the Worker request. A handler's env has no `DB` or `FILES` (api.ts
 * `handlerEnv`: D1 and R2 only through stores), and the ops need both raw, so they come from the Worker's own env here,
 * in this test-build-only module, never in the handler (which every build bundles). The rest is the handler's env.
 */
export async function runTestFakesInWorker(body: unknown, handlerEnv: Omit<TestFakesEnv, 'DB' | 'FILES'>): Promise<TestFakesAnswer> {
  // Imported here, not at the top: scripts/check-product-build.test.mjs loads this module in Node for its canary.
  const { env } = await import('cloudflare:workers')
  const { DB, FILES } = env as unknown as Pick<TestFakesEnv, 'DB' | 'FILES'>
  return runTestFakes(body, { ...handlerEnv, DB, FILES })
}
