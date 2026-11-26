// Stage 1 M2-S, the write-safety gate (N2, N9 to N15, N19; P6 acceptance 1 to 6, 8, 9): proof across modules that no
// outside write happens without a live grant or an approval of that exact action. Real D1, the real outbox (request,
// answer, Undo, withdraw, resolve), the real claim, dispatcher, sweep and gate sync, the real stores for members,
// connector accounts, permissions and the ceiling, and behind the dispatcher a stand-in for the `HUB_WRITE` binding
// (vitest.config.ts binds a 503 there) that runs the hub's own write entry (`runWriteAction`, its strict request schema),
// the hub's own Shopify mutation sender and Slack outbox poster, against the hub's fake Shopify write upstream
// (test/upstreams/shopify/write/) and a recording Slack SignIn. The app's server project can't load the hub's
// ShopifyWriteCore (its SignIn imports `graphql`, which only app/hub/ installs), so the stand-in repeats its account checks
// (paused, `connectedAtMs`) and token grant around the hub's real `sendOrderTagsAdd`.
//
// Random steps: a request (any asker, a system routine included, any origin, both modes, a replay of the same
// invocation with the same or other arguments), an answer by anyone (a stale revision and a double answer among them),
// Undo, withdraw (the asker, the agent, anyone else), removing a permission (its holder, an admin, anyone else), a role
// lowered or raised, a member removed and re-invited, the ceiling turned off, lowered or raised (worlds start with Shopify
// tags capped at 1, 2 or 50 a day), the Slack channel taken off the list or listed again, an account reconnected
// or disconnected, the hub's own view of an account drifting or paused, Pause and Resume (each hook run or failing), a
// clock jump (past the 10 s hold, the 40 s permit deadline, the 60 s stale mark, the 10-minute approval cap, the 7-day
// expiry), a dispatch (a crash before or after each of its D1 calls, a fast Pause and Resume at each of its reads, a
// permit reached late, the binding throwing or hanging), a scheduler pass, a sweep, every fault switch of the fake
// upstreams, late results, and a person resolving "Needs a check".
//
// The oracle reads the upstream's log (every write request the fake Shopify store received, every post the Slack SignIn
// sent on), maps each effect to its action by the unique tag or text its request carried, and holds, written before the
// code:
//  W1. every effect belongs to exactly one action, and at most one effect per action (and at most one hub call);
//  W2. the call behind an effect came from a winning claim at which, read from D1 right after the claim's batch and
//      checked here in the test's own words (not claim-guard.ts's SQL): the gate was open, at the epoch the approval was
//      given in and at the object's pause generation; the action was approved at this revision, past its hold and under
//      10 minutes old, in the current Pause/Resume era; the operation enabled in the ceiling; the account on the action's
//      generation; the asker an active person; and either (a) a live grant held by the asker (or the brand), on the same
//      account, generation, operation and scope, made under the current ceiling and policy, with this revision's use
//      unreleased and the grant's day inside MIN(per_day, per_day_max), or (b) the approver (the asker) approved this
//      revision (the test recorded the answer, from the revision the test sent, never from the row the outbox returned)
//      and is still an active person; and an answer wins only at the revision it named;
//  W3. the call started inside the permit: the clock before `claimed_at + 40 s`, and no Pause or Resume since the claim;
//  W4. no effect for a routine without an approval (a routine never runs under a grant);
//  W5. no effect with an empty ceiling: with no ceiling row (the product's state) every request is refused and nothing
//      reaches an upstream;
//  W6. a grant-backed effect keeps its use (unreleased) unless the action ended `failed` (which releases it), and the
//      effects still holding a use, per grant and day, stay inside the daily limit their claims saw.
// Planted bugs (each seen red, then restored; the PR lists them) prove the oracle has teeth.
import { fc } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AccountStatus, HubError, HubErrorCode, HubResult, SlackChannel, WriteGateway, WriteRequest, WriteResult } from '../../hub/index/contract.ts'
import {
  FakeShopifyWriteUpstream, SHOPIFY_WRITE_SHOP, SHOPIFY_WRITE_TEST_CLIENT_ID, SHOPIFY_WRITE_TEST_CLIENT_SECRET,
} from '../../test/upstreams/shopify/write/server.ts'
import type { WriteFault } from '../../test/upstreams/shopify/write/server.ts'
import type { MemberRole } from '../../shared/contract/members.ts'
import { connectorAccountStore } from '../db/connector-accounts.ts'
import { memberStore } from '../db/members.ts'
import { runBatch } from '../db/sql.ts'
import { setCeilingStmt } from '../permissions/ceiling.ts'
import { permissionStore } from '../permissions/grants.ts'
import { POLICY_REV } from '../permissions/policy.ts'
import { channel } from '../permissions/test-support.ts'
import { notifyChannelStore } from '../notify-slack/channels.ts'
import type { WriteOperationKey } from '../permissions/types.ts'
import { sendAction } from './dispatch.ts'
import { outboxFacts } from './facts.ts'
import { syncGate } from './gate.ts'
import { openOutbox } from './store.ts'
import { sweepOutbox } from './sweep.ts'
import { fresh, notices, resetOutbox } from './test-support.ts'
import { timing } from './timing.ts'
import type { OutboxActionRow, OutboxGateRow, OutboxInvocation, OutboxRequestCtx } from './types.ts'

// The hub's compile-time test switch (hub/globals.d.ts; wrangler's `define` in the hub's own builds): off here, as in
// the hub's deployable build, so its log lines go straight to the console.
declare global {
  var __INHOUSE_HUB_TEST__: boolean
}
globalThis.__INHOUSE_HUB_TEST__ = false

// ---------- the hub's own code ----------
// Loaded at run time: the app's TypeScript project resolves imports as Node does (`nodenext`) and the hub's own imports
// are extensionless (it builds with `bundler` resolution), so a static import would pull the hub's files into the app's
// typecheck. The shapes they're used at are written here against the hub's contract types.
type Upstream = (req: Request) => Promise<Response>
interface ShopConfig { shop: string; clientId: string; clientSecret: string }
interface TagArgs { orderId: string; tags: string[] }
interface WriteInput { accountId: string; expect: { connectedAtMs: number }; args: unknown }
/** hub/outbox-entry/gateway.ts `WriteGatewayDeps`. */
interface WriteDeps { shopifyOrderTagAdd(input: WriteInput): Promise<WriteResult>; slackChannelPost(input: WriteInput): Promise<WriteResult> }
/** hub/connectors/slack/outbox.ts `SlackOutboxStub`. */
interface SlackStub {
  status(accountId: string): Promise<HubResult<AccountStatus>>
  slackChannelInfo(accountId: string, channelId: string): Promise<HubResult<SlackChannel>>
  slackPost(accountId: string, req: { channelId: string; title: string; text: string }, expect?: { connectedAtMs: number }): Promise<HubResult<{ ts: string }>>
}
interface HubCode {
  /** The write entry's logic (hub/outbox-entry/gateway.ts): the strict request schema, then the operation. */
  runWriteAction(deps: WriteDeps, req: WriteRequest): Promise<WriteResult>
  /** hub/connectors/shopify/write/provider.ts: the one mutation, its deadline and its sure or unsure answer. */
  sendOrderTagsAdd(upstream: Upstream, config: ShopConfig, token: string, args: TagArgs, timeoutMs: number): Promise<WriteResult>
  ShopifyOrderTagAddArgsSchema: { safeParse(v: unknown): { success: true; data: TagArgs } | { success: false; error: { issues: { path: PropertyKey[] }[] } } }
  SHOPIFY_WRITE_ACCOUNT: string
  writeErr(code: HubErrorCode, sent: 'no' | 'unknown', detail?: string): WriteResult
  /** hub/connectors/slack/outbox.ts: the Slack post's argument check, account checks and channel re-check. */
  postSlackOutboxAction(stub: SlackStub, req: WriteInput): Promise<WriteResult>
  /** hub/signin/providers/shopify.ts: the client-credentials grant. */
  requestGrant(upstream: Upstream, config: ShopConfig, nowMs: () => number): Promise<{ ok: true; accessToken: string } | { ok: false; code: HubErrorCode }>
  hubError(code: HubErrorCode, detail?: string): HubError
}
const HUB_FILES = [
  '../../hub/outbox-entry/gateway.ts', '../../hub/connectors/shopify/write/provider.ts', '../../hub/connectors/slack/outbox.ts',
  '../../hub/signin/providers/shopify.ts', '../../hub/index/errors.ts',
]
const HUB_NAMES: readonly (keyof HubCode)[] = [
  'runWriteAction', 'sendOrderTagsAdd', 'ShopifyOrderTagAddArgsSchema', 'SHOPIFY_WRITE_ACCOUNT', 'writeErr', 'postSlackOutboxAction', 'requestGrant', 'hubError',
]
async function loadHub(): Promise<HubCode> {
  const mods = await Promise.all(HUB_FILES.map(f => import(/* @vite-ignore */ f) as Promise<Record<string, unknown>>))
  const code = Object.assign({}, ...mods) as Record<string, unknown>
  for (const name of HUB_NAMES) if (!(name in code)) throw new Error(`the hub no longer exports ${name}`)
  if (code.SHOPIFY_WRITE_ACCOUNT !== SHOP) throw new Error('the hub\'s Shopify write account is not shopify:store')
  return code as unknown as HubCode
}
let hubCode!: HubCode

const db = env.DB
const T0 = 1_800_000_000_000
const SHOP = 'shopify:store'
const SLACK = 'slack:workspace'
const CHANNEL_ID = 'C0WSOPS001'
/** The permit's deadline after the claim (dispatch.ts `permitBy`): 60 s stale mark, less the 15 s hub limit and 5 s margin. */
const PERMIT_MS = 40_000
/** The hub's own write deadline in the stand-in (the real one is 15 s); the dispatcher's own limit is longer. */
const HUB_DEADLINE_MS = 40
const DISPATCH_TIMEOUT_MS = 120

const PEOPLE = ['m_ws_a', 'm_ws_b', 'm_ws_d', 'm_ws_e'] as const
type Person = (typeof PEOPLE)[number]
const START_ROLE: Record<Person, MemberRole> = { m_ws_a: 'member', m_ws_b: 'member', m_ws_d: 'admin', m_ws_e: 'admin' }
const emailOf = (id: string) => `${id.replaceAll('_', '-')}@example.test`
const subjectOf = (id: string) => `sub-${id}`

// ---------- the stand-in for the HUB_WRITE binding ----------

type SlackFault = 'succeed' | 'refuse' | 'throw'
type BindingFault = 'ok' | 'throw' | 'hang'
interface HubAccount { paused: boolean; connectedAtMs: number | null }

/** One call that reached the binding, and what the oracle saw at that moment. */
interface Call { actionId: string; attempt: number; permit: string[] }

const SHOP_CONFIG = { shop: SHOPIFY_WRITE_SHOP, clientId: SHOPIFY_WRITE_TEST_CLIENT_ID, clientSecret: SHOPIFY_WRITE_TEST_CLIENT_SECRET }

class HubStandIn {
  readonly #code: HubCode
  constructor(code: HubCode) {
    this.#code = code
  }

  /** The fake Shopify write store: `writes` is its log of every write request it received. */
  readonly shop = new FakeShopifyWriteUpstream()
  /** Every post the Slack SignIn sent on to Slack (the upstream's log). */
  readonly slackPosts: { channelId: string; text: string }[] = []
  slackFault: SlackFault = 'succeed'
  binding: BindingFault = 'ok'
  readonly accounts = new Map<string, HubAccount>()
  readonly hung: (() => void)[] = []
  /** Runs first in every call, synchronously: the oracle's look at the permit (and a planted Pause inside the call). */
  onCall: (req: WriteRequest) => void = () => {}
  #token: string | null = null

  #refusal(accountId: string, expected: number): WriteResult | null {
    const a = this.accounts.get(accountId)
    if (!a || a.connectedAtMs === null) return this.#code.writeErr('not_configured', 'no', 'disconnected')
    if (a.paused) return this.#code.writeErr('paused', 'no')
    if (a.connectedAtMs !== expected) return this.#code.writeErr('connect_stale', 'no', 'connectedAtMs')
    return null
  }

  readonly #slack: SlackStub = {
    status: async accountId => {
      const a = this.accounts.get(accountId)
      const at = a?.connectedAtMs ?? null
      const status: AccountStatus = {
        accountId, state: at === null ? 'disconnected' : 'active', kid: null, expiresAt: null, scopes: ['chat:write'], lastError: null,
        paused: a?.paused ?? false, kind: 'oauth_mcp', connectedBy: null, connectedAt: at === null ? null : { iso: new Date(at).toISOString(), ms: at },
        revokeFailedAt: null, needsReconnect: false,
      }
      return { ok: true, value: status }
    },
    slackChannelInfo: async (_accountId, channelId) => (channelId === CHANNEL_ID
      ? { ok: true, value: { id: CHANNEL_ID, name: 'ops', isMember: true, shared: false, archived: false, private: false } }
      : { ok: false, error: this.#code.hubError('connect_refused', 'not_found') }),
    slackPost: async (accountId, req, expect): Promise<HubResult<{ ts: string }>> => {
      // The SignIn's own last check before chat.postMessage.
      const refused = this.#refusal(accountId, expect?.connectedAtMs ?? -1)
      if (refused && !refused.ok) return { ok: false, error: refused.error }
      this.slackPosts.push({ channelId: req.channelId, text: req.text })
      if (this.slackFault === 'throw') throw new Error('the Slack call broke')
      if (this.slackFault === 'refuse') return { ok: false, error: this.#code.hubError('upstream_rejected') }
      return { ok: true, value: { ts: `1800000000.${String(this.slackPosts.length).padStart(6, '0')}` } }
    },
  }

  readonly #deps: WriteDeps = {
    shopifyOrderTagAdd: async input => {
      if (input.accountId !== this.#code.SHOPIFY_WRITE_ACCOUNT) return this.#code.writeErr('invalid_args', 'no', 'accountId')
      const parsed = this.#code.ShopifyOrderTagAddArgsSchema.safeParse(input.args)
      if (!parsed.success) return this.#code.writeErr('invalid_args', 'no', parsed.error.issues[0]?.path.join('.') || 'args')
      const before = this.#refusal(input.accountId, input.expect.connectedAtMs)
      if (before) return before
      if (this.#token === null) {
        const g = await this.#code.requestGrant(this.shop.fetch, SHOP_CONFIG, () => Date.now())
        if (!g.ok) return this.#code.writeErr(g.code, 'no')
        this.#token = g.accessToken
      }
      const rightBefore = this.#refusal(input.accountId, input.expect.connectedAtMs)
      if (rightBefore) return rightBefore
      return this.#code.sendOrderTagsAdd(this.shop.fetch, SHOP_CONFIG, this.#token, parsed.data, HUB_DEADLINE_MS)
    },
    slackChannelPost: input => this.#code.postSlackOutboxAction(this.#slack, input),
  }

  readonly gateway: WriteGateway = {
    runAction: async req => {
      this.onCall(req)
      // The binding broke before the hub: nothing went out.
      if (this.binding === 'throw') throw new Error('the binding broke')
      let answer: WriteResult
      try {
        answer = await this.#code.runWriteAction(this.#deps, req)
      } catch {
        // hub/outbox-entry/entry.ts: an unexpected throw is `internal`, `sent: 'unknown'`.
        answer = { ok: false, error: this.#code.hubError('internal'), sent: 'unknown' }
      }
      // The hub did its work; its answer is lost until the test lets it through.
      if (this.binding === 'hang') return new Promise<WriteResult>(resolve => { this.hung.push(() => resolve(answer)) })
      return answer
    },
  }
}

// ---------- a D1 that the test can watch and crash ----------

class Crash extends Error {}
const isCrash = (err: unknown): boolean => err instanceof Crash || (err instanceof Error && err.cause instanceof Crash)

interface Tap {
  before?: (n: number, sqls: readonly string[]) => void | Promise<void>
  after?: (n: number, sqls: readonly string[]) => void | Promise<void>
}

/** `db`, numbering each call (a statement's run, first, all or raw, or a batch) and running the tap around it. */
function tapped(target: D1Database, t: Tap): D1Database {
  let n = 0
  const sqlOf = new WeakMap<object, string>()
  const real = new WeakMap<object, D1PreparedStatement>()
  const around = async <R>(sqls: readonly string[], call: () => Promise<R>): Promise<R> => {
    const k = ++n
    await t.before?.(k, sqls)
    const r = await call()
    await t.after?.(k, sqls)
    return r
  }
  const wrap = (st: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(st, {
      get(s, key) {
        if (key === 'bind') return (...v: unknown[]) => wrap(s.bind(...v), sql)
        if (key === 'first' || key === 'all' || key === 'run' || key === 'raw') {
          return (...a: unknown[]) => around([sql], () => (s[key] as (...x: unknown[]) => Promise<unknown>).apply(s, a))
        }
        const v = Reflect.get(s, key) as unknown
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(s) : v
      },
    })
    real.set(proxy, st)
    sqlOf.set(proxy, sql)
    return proxy
  }
  return new Proxy(target, {
    get(d, key) {
      if (key === 'prepare') return (sql: string) => wrap(d.prepare(sql), sql)
      if (key === 'batch') {
        return (stmts: D1PreparedStatement[]) => around(stmts.map(s => sqlOf.get(s) ?? ''), () => d.batch(stmts.map(s => real.get(s) ?? s)))
      }
      const v = Reflect.get(d, key) as unknown
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(d) : v
    },
  })
}

// ---------- the steps ----------

type Who = 0 | 1 | 2 | 3
type Target = 'own' | Who
type Op = 'shop' | 'slack'
/** How one send goes: a crash, a fast Pause and Resume, a permit reached late, a binding that throws or hangs. */
interface SendOpts { crash: { at: number; when: 'before' | 'after' } | null; flipAt: number; latePermit: boolean; binding: BindingFault }
type Step =
  | { k: 'request'; who: Who | 'system'; origin: 'chat' | 'job' | 'routine'; op: Op; mode: 'tool' | 'ask_only'; replay: 'none' | 'same' | 'other' }
  | { k: 'answer'; i: number; by: Target; choice: 'fit_once' | 'fit_always' | 'once' | 'always' | 'approve' | 'deny'; stale: boolean; twice: boolean }
  | { k: 'undo'; i: number; by: Target }
  | { k: 'withdraw'; i: number; by: Target | 'agent' }
  | { k: 'revoke'; i: number; by: 'holder' | Who }
  | { k: 'role'; who: Who; to: MemberRole }
  | { k: 'remove'; who: Who }
  | { k: 'reinvite'; who: Who }
  | { k: 'ceiling'; op: Op; enabled: boolean; perDayMax: number }
  | { k: 'account'; op: Op; change: 'reconnect' | 'disconnect' | 'hub_drift' | 'hub_pause' | 'hub_resume' }
  | { k: 'channel'; listed: boolean }
  | { k: 'flip'; hookFails: boolean; pulse: boolean }
  | { k: 'tick'; ms: number; alarm: SendOpts | false }
  | ({ k: 'dispatch'; i: number } & SendOpts)
  | { k: 'scheduler' }
  | { k: 'sweep'; passes: 1 | 2 }
  | { k: 'fault'; shop: WriteFault; slack: SlackFault }
  | { k: 'late' }
  | { k: 'resolve'; i: number; by: Target; outcome: 'sent' | 'failed' }

const who = fc.constantFrom<Who>(0, 1, 2, 3)
const target = fc.oneof({ weight: 3, arbitrary: fc.constant('own' as const) }, { weight: 1, arbitrary: who })
const idx = fc.nat({ max: 9 })
const op = fc.constantFrom<Op>('shop', 'shop', 'slack')
const W = <T>(weight: number, arbitrary: fc.Arbitrary<T>) => ({ weight, arbitrary })
// flipAt: a fast Pause then Resume (hooks not run) at the dispatcher's n-th read of the object's pause state (1 before
// the claim, 2 at the claim, 3 and 4 at the permit), 5 inside the hub call (after the permit), 6 and up as its
// (n - 5)-th D1 call settles; 0 never. crash: the process dies before or after its n-th D1 call.
const sendOpts: fc.Arbitrary<SendOpts> = fc.record({
  crash: fc.oneof(W(3, fc.constant(null)), W(1, fc.record({ at: fc.oneof(W(3, fc.integer({ min: 2, max: 4 })), W(1, fc.integer({ min: 1, max: 7 }))), when: fc.constantFrom('before' as const, 'after' as const) }))),
  flipAt: fc.oneof(W(8, fc.constant(0)), W(1, fc.integer({ min: 1, max: 12 }))),
  latePermit: fc.constantFrom(false, false, false, false, false, false, true),
  binding: fc.constantFrom<BindingFault>('ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'throw', 'hang'),
})

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  W(9, fc.record({
    k: fc.constant('request' as const), who: fc.oneof(W(4, fc.constant<Who>(0)), W(2, fc.constant<Who>(2)), W(1, fc.constant<Who>(1)), W(1, fc.constant('system' as const))),
    origin: fc.constantFrom('chat' as const, 'chat' as const, 'job' as const, 'routine' as const), op, mode: fc.constantFrom('tool' as const, 'tool' as const, 'ask_only' as const),
    replay: fc.constantFrom('none' as const, 'none' as const, 'none' as const, 'same' as const, 'other' as const),
  })),
  W(11, fc.record({
    k: fc.constant('answer' as const), i: idx, by: target, choice: fc.constantFrom('fit_once' as const, 'fit_once' as const, 'fit_always' as const, 'fit_always' as const, 'once' as const, 'always' as const, 'approve' as const, 'deny' as const),
    stale: fc.constantFrom(false, false, false, true), twice: fc.constantFrom(false, false, false, true),
  })),
  W(2, fc.record({ k: fc.constant('undo' as const), i: idx, by: target })),
  W(1, fc.record({ k: fc.constant('withdraw' as const), i: idx, by: fc.oneof(target, fc.constant('agent' as const)) })),
  W(3, fc.record({ k: fc.constant('revoke' as const), i: idx, by: fc.oneof(fc.constant('holder' as const), who) })),
  W(1, fc.record({ k: fc.constant('role' as const), who, to: fc.constantFrom<MemberRole>('member', 'admin') })),
  W(1, fc.record({ k: fc.constant('remove' as const), who })),
  W(1, fc.record({ k: fc.constant('reinvite' as const), who })),
  W(3, fc.record({ k: fc.constant('ceiling' as const), op, enabled: fc.constantFrom(true, true, true, false), perDayMax: fc.constantFrom(1, 2, 50) })),
  W(1, fc.record({ k: fc.constant('channel' as const), listed: fc.boolean() })),
  W(1, fc.record({ k: fc.constant('account' as const), op, change: fc.constantFrom('reconnect' as const, 'disconnect' as const, 'hub_drift' as const, 'hub_pause' as const, 'hub_resume' as const) })),
  W(2, fc.record({ k: fc.constant('flip' as const), hookFails: fc.boolean(), pulse: fc.constantFrom(true, true, false) })),
  // alarm: BrandAgent's alarm fires as the clock moves, for every approved action whose hold is over, each send as drawn.
  W(8, fc.record({
    k: fc.constant('tick' as const), alarm: fc.oneof(W(1, fc.constant(false as const)), W(3, sendOpts)),
    ms: fc.oneof(W(6, fc.integer({ min: 0, max: 5_000 })), W(8, fc.integer({ min: 10_000, max: 12_000 })), W(2, fc.constant(PERMIT_MS + 1)), W(3, fc.constant(61_000)),
      W(1, fc.constant(timing().approvalMaxAgeMs + 30_000)), W(1, fc.constant(timing().expiresMs + 60_000))),
  })),
  W(3, fc.tuple(fc.record({ k: fc.constant('dispatch' as const), i: idx }), sendOpts).map(([a, b]) => ({ ...a, ...b }))),
  W(2, fc.constant({ k: 'scheduler' as const })),
  // passes: the sweep runs every minute; a second pass reaches what the first one's later steps changed (its lost-task
  // step runs before its stale-send step).
  W(3, fc.record({ k: fc.constant('sweep' as const), passes: fc.constantFrom<1 | 2>(1, 2) })),
  W(2, fc.record({ k: fc.constant('fault' as const), shop: fc.constantFrom<WriteFault>('succeed', 'succeed', 'succeed', 'succeed', 'refuse', 'timeout', 'broken_body'), slack: fc.constantFrom<SlackFault>('succeed', 'succeed', 'succeed', 'refuse', 'throw') })),
  W(1, fc.constant({ k: 'late' as const })),
  W(2, fc.record({ k: fc.constant('resolve' as const), i: idx, by: target, outcome: fc.constantFrom('sent' as const, 'failed' as const) })),
)

// ---------- the world ----------

interface MemberRow { id: string; role: MemberRole; status: string; kind: string; rev: number }
interface GrantRow { id: string; rev: number; holder: string; holder_member: string | null; account_id: string; account_gen: number; operation: string; scope_key: string; per_day: number; policy_rev: number; granted_role: MemberRole; ceiling_rev: number; revoked_at_ms: number | null }
interface UseRow { id: string; grant_id: string; day: string; units: number; released_at_ms: number | null }

async function setup(o: World): Promise<void> {
  await resetOutbox(db)
  await db.batch(PEOPLE.map(id => db.prepare(
    `INSERT INTO members (id, kind, role, status, name, email_norm, subject, created_at_ms) VALUES (?, 'person', ?, 'active', 'Test person', ?, ?, 1)
     ON CONFLICT (id) DO UPDATE SET role = excluded.role, status = 'active', removed_at_ms = NULL, email_norm = excluded.email_norm, subject = excluded.subject, rev = rev + 1`,
  ).bind(id, START_ROLE[id], emailOf(id), subjectOf(id))))
  await db.batch([
    db.prepare("INSERT INTO connector_accounts (account_id, connector, last_state, last_state_at_ms, connected_at_ms) VALUES (?, 'shopify', 'connected', 1, ?)").bind(SHOP, T0 - 2_000),
    db.prepare("INSERT INTO connector_accounts (account_id, connector, last_state, last_state_at_ms, connected_at_ms) VALUES (?, 'slack', 'connected', 1, ?)").bind(SLACK, T0 - 1_000),
  ])
  await channel(db, CHANNEL_ID, 'ops', 'm_ws_d')
  if (o.ceiling) {
    await runBatch(db, (['shopify.order.tag_add', 'slack.channel.post'] as const).map(operation =>
      setCeilingStmt({ operation, enabled: true, perDayMax: operation === 'shopify.order.tag_add' ? o.perDayMax ?? 50 : 50, actorId: 'm_system', nowMs: T0 })))
  }
}

/** The brand at the start: its ceiling on or absent (the product's state), and the Shopify tags' daily maximum. */
interface World { ceiling: boolean; perDayMax?: number }

const OPERATION: Record<Op, WriteOperationKey> = { shop: 'shopify.order.tag_add', slack: 'slack.channel.post' }
const ACCOUNT: Record<Op, string> = { shop: SHOP, slack: SLACK }
const CONNECTOR: Record<Op, string> = { shop: 'shopify', slack: 'slack' }

const rowOf = (id: string) => db.prepare('SELECT * FROM outbox_actions WHERE id = ?').bind(id).first<OutboxActionRow>()
const memberOf = (id: string) => db.prepare('SELECT id, role, status, kind, rev FROM members WHERE id = ?').bind(id).first<MemberRow>()

/** What one sequence did, for the oracle. */
interface Outcome {
  effects: number
  /** Requests the outbox answered with something other than a refusal. */
  admitted: number
  problems: string[]
}

async function runSequence(steps: readonly Step[], o: World): Promise<Outcome> {
  await setup(o)
  let now = T0
  const hub = new HubStandIn(hubCode)
  hub.accounts.set(SHOP, { paused: false, connectedAtMs: T0 - 2_000 })
  hub.accounts.set(SLACK, { paused: false, connectedAtMs: T0 - 1_000 })
  const port = openOutbox({
    db, now: () => now, requestId: fresh('ws'),
    facts: outboxFacts({
      db,
      hubAccounts: async () => [
        { accountId: SHOP, paused: hub.accounts.get(SHOP)?.paused ?? true, label: 'Shopify', shop: SHOPIFY_WRITE_SHOP },
        { accountId: SLACK, paused: hub.accounts.get(SLACK)?.paused ?? true, label: 'Slack', shop: null },
      ],
    }),
    schedule: async () => {},
  })
  const members = memberStore({ db })
  const accounts = connectorAccountStore({ db })
  const permissions = permissionStore({ db })
  const channels = notifyChannelStore({ db })
  const note = notices()
  const at = () => ({ actorId: 'm_ws_d', requestId: fresh('at'), nowMs: now })

  // The model: the object's pause state, its era (raised by every Pause and Resume), and every approval the test saw given.
  const object = { paused: false, pauseGen: 0 }
  let era = 0
  const flip = () => {
    object.paused = !object.paused
    object.pauseGen++
    era++
  }
  const approvals = new Map<string, { rev: number; by: string; era: number }>()
  /** Each winning claim (`id#attempt`): the oracle's faults at the claim, and the era and generation it happened in. */
  const claims = new Map<string, { faults: string[]; limit: number | null; era: number; gen: number; claimedAtMs: number; grantId: string | null; useId: string }>()
  const calls: Call[] = []
  /** The unique tag or text token each request carried, to its action. */
  const tokens = new Map<string, string>()
  let token = 0
  type LastRequest = { invocation: OutboxInvocation; args: Record<string, unknown>; op: Op; ctx: Omit<OutboxRequestCtx, 'invocation' | 'nowMs'> }
  const last: { request: LastRequest | null } = { request: null }
  let permitClock = () => now
  let flipInCall = false
  const late: Promise<void>[] = []
  let admitted = 0
  const problems: string[] = []

  hub.onCall = req => {
    const claim = claims.get(`${req.actionId}#${req.attempt}`)
    const permit: string[] = []
    if (!claim) permit.push('no winning claim for this attempt')
    else {
      if (permitClock() >= claim.claimedAtMs + PERMIT_MS) permit.push('the permit was reached after its deadline')
      if (object.pauseGen !== claim.gen || object.paused) permit.push('a Pause or Resume came between the claim and the call')
    }
    calls.push({ actionId: req.actionId, attempt: req.attempt, permit })
    if (flipInCall) { flip(); flip() }
  }

  /** The oracle's look at a claim, right after its batch: W2, in the test's own words. */
  async function claimFaults(pre: OutboxActionRow, post: OutboxActionRow): Promise<{ faults: string[]; limit: number | null }> {
    const f: string[] = []
    let limit: number | null = null
    const claimedAt = post.claimed_at_ms ?? -1
    const gate = await db.prepare('SELECT * FROM outbox_gate WHERE id = 1').first<OutboxGateRow>()
    if (!gate || gate.paused !== 0 || gate.restore_hold !== 0) f.push('the gate was closed')
    else {
      if (gate.epoch !== pre.approved_epoch) f.push('an approval from another gate epoch')
      if (gate.do_gen !== object.pauseGen) f.push('the gate was behind the object')
    }
    const ap = approvals.get(pre.id)
    if (!ap || ap.rev !== pre.approved_rev) f.push('no approval of this revision')
    else if (ap.era !== era) f.push('an approval from before the last Pause or Resume')
    if (pre.state !== 'approved' || pre.approved_rev !== pre.rev) f.push('not an approved revision')
    if (pre.send_at_ms === null || pre.send_at_ms > claimedAt) f.push('claimed inside the hold')
    if (pre.approved_at_ms === null || pre.approved_at_ms <= claimedAt - timing().approvalMaxAgeMs) f.push('an approval over 10 minutes old')
    if (pre.policy_rev !== POLICY_REV) f.push('made under another policy')
    const ceiling = await db.prepare('SELECT enabled, per_day_max, lowered_rev FROM permission_ceiling WHERE operation = ?').bind(pre.operation)
      .first<{ enabled: number; per_day_max: number; lowered_rev: number }>()
    if (!ceiling || ceiling.enabled !== 1) f.push('an empty ceiling')
    const acct = await db.prepare('SELECT connected_at_ms, disconnected_at_ms FROM connector_accounts WHERE account_id = ?').bind(pre.account_id)
      .first<{ connected_at_ms: number | null; disconnected_at_ms: number | null }>()
    if (!acct || acct.connected_at_ms !== pre.account_gen || (acct.disconnected_at_ms !== null && acct.disconnected_at_ms >= acct.connected_at_ms)) f.push('the account changed generation')
    const asker = await memberOf(pre.asked_by)
    if (!asker || asker.kind !== 'person' || asker.status !== 'active') f.push('the asker is not an active person')
    if (pre.operation === 'slack.channel.post') {
      const listed = await db.prepare('SELECT 1 AS one FROM notify_channels WHERE channel_id = ? AND removed_at_ms IS NULL')
        .bind((JSON.parse(pre.scope_json) as { channelId?: string }).channelId ?? '').first()
      if (!listed) f.push('the channel is not listed')
    }
    if (pre.grant_id !== null) {
      if (pre.origin === 'routine') f.push('a routine under a grant')
      const g = await db.prepare('SELECT * FROM permission_grants WHERE id = ?').bind(pre.grant_id).first<GrantRow>()
      if (!g || g.revoked_at_ms !== null) f.push('the grant was revoked')
      else {
        if (g.account_id !== pre.account_id || g.account_gen !== pre.account_gen || g.operation !== pre.operation || g.scope_key !== pre.scope_key) f.push('the grant does not cover it')
        const held = g.holder === `member:${pre.asked_by}` ? asker?.role === 'admin' || g.granted_role === 'member' : g.holder === 'brand' && g.granted_role === 'admin'
        if (!held) f.push('the grant is not the asker\'s')
        if (!ceiling || g.ceiling_rev !== ceiling.lowered_rev) f.push('the grant predates a lowered ceiling')
        if (g.policy_rev !== POLICY_REV) f.push('the grant was made under another policy')
      }
      const use = await db.prepare('SELECT * FROM permission_uses WHERE id = ?').bind(`${pre.id}#${pre.rev}`).first<UseRow>()
      if (!use || use.released_at_ms !== null || use.grant_id !== pre.grant_id) f.push('no unreleased use for this revision')
      else {
        const day = await db.prepare('SELECT COALESCE(SUM(units), 0) AS n FROM permission_uses WHERE grant_id = ? AND day = ? AND released_at_ms IS NULL')
          .bind(use.grant_id, use.day).first<{ n: number }>()
        limit = g && ceiling ? Math.min(g.per_day, ceiling.per_day_max) : null
        if (limit === null || (day?.n ?? 0) > limit) f.push('the grant\'s day is over its limit')
      }
    } else {
      if (pre.approved_by !== pre.approver || pre.approver !== pre.asked_by) f.push('not approved by its approver')
      if (!ap || ap.by !== pre.approver) f.push('the test saw no answer by the approver')
      const approver = await memberOf(pre.approver)
      if (!approver || approver.kind !== 'person' || approver.status !== 'active') f.push('the approver is not an active person')
    }
    return { faults: f, limit }
  }

  /** The dispatcher, as BrandAgent's task runs it, on a D1 the oracle watches (and that may crash or flip under it). */
  async function dispatch(id: string, o2: Partial<SendOpts> = {}) {
    let pre: OutboxActionRow | null = null
    let reads = 0
    const watched = tapped(db, {
      before: async (n, sqls) => {
        if (o2.crash?.when === 'before' && o2.crash.at === n) throw new Crash('crash')
        if (sqls[0]?.startsWith("UPDATE outbox_actions SET state = 'sending'")) pre = await rowOf(id)
      },
      after: async (n, sqls) => {
        if (pre && sqls[0]?.startsWith("UPDATE outbox_actions SET state = 'sending'")) {
          const post = await rowOf(id)
          if (post && post.state === 'sending' && post.attempt === pre.attempt + 1 && pre.state === 'approved') {
            claims.set(`${id}#${post.attempt}`, {
              ...await claimFaults(pre, post), era, gen: object.pauseGen, claimedAtMs: post.claimed_at_ms ?? -1, grantId: pre.grant_id, useId: `${pre.id}#${pre.rev}`,
            })
          }
          pre = null
        }
        if (o2.flipAt !== undefined && o2.flipAt > 5 && o2.flipAt - 5 === n) { flip(); flip() }
        if (o2.crash?.when === 'after' && o2.crash.at === n) throw new Crash('crash')
      },
    })
    hub.binding = o2.binding ?? 'ok'
    permitClock = () => now + (o2.latePermit ? PERMIT_MS : 0)
    flipInCall = o2.flipAt === 5
    const read = () => {
      if (++reads === o2.flipAt) { flip(); flip() }
    }
    try {
      await sendAction(id, {
        db: watched, nowMs: now, hub: hub.gateway, notify: note.notify, requestId: fresh('send'), again: () => {}, timeoutMs: DISPATCH_TIMEOUT_MS,
        clock: () => permitClock(), onLate: p => late.push(p),
        gate: { get paused() { read(); return object.paused }, get pauseGen() { read(); return object.pauseGen } },
      })
    } catch (err) {
      if (!isCrash(err)) throw err
    } finally {
      hub.binding = 'ok'
      flipInCall = false
      permitClock = () => now
    }
  }

  /** BrandAgent's alarm: the send task of every approved action whose hold is over. */
  async function alarm(opts: Partial<SendOpts> = {}) {
    const due = (await db.prepare("SELECT id FROM outbox_actions WHERE state = 'approved' AND send_at_ms <= ? ORDER BY send_at_ms, id").bind(now).all<{ id: string }>()).results
    for (const r of due) await dispatch(r.id, opts)
  }

  const ids: string[] = []
  const pick = (i: number) => (ids.length === 0 ? null : ids[i % ids.length])
  /** Most steps aim at a row in the state they act on (a person answers a waiting card, the alarm fires for an approved one). */
  const aim = async (i: number, state: string) => {
    if (i % 5 === 4) return pick(i)
    const r = await db.prepare('SELECT id FROM outbox_actions WHERE state = ? ORDER BY created_at_ms, id LIMIT 1 OFFSET ?').bind(state, i % 2).first<{ id: string }>()
      ?? await db.prepare('SELECT id FROM outbox_actions WHERE state = ? ORDER BY created_at_ms, id LIMIT 1').bind(state).first<{ id: string }>()
    return r?.id ?? pick(i)
  }
  const actor = async (id: string) => ({ memberId: id, role: (await memberOf(id))?.role ?? 'member' })
  const by = async (t: Target, row: OutboxActionRow, own: 'approver' | 'asker' = 'approver') => actor(t === 'own' ? (own === 'approver' ? row.approver : row.asked_by) : PEOPLE[t])

  for (const s of steps) {
    switch (s.k) {
      case 'request': {
        const replay = s.replay !== 'none' ? last.request : null
        const n = ++token
        const t = `ws${n}`
        const opNow: Op = replay ? replay.op : s.op
        const args: Record<string, unknown> = replay && s.replay === 'same'
          ? replay.args
          : opNow === 'shop' ? { orderId: `gid://shopify/Order/${9001 + (n % 3)}`, tags: [t] } : { channel: n % 2 === 0 ? '#ops' : CHANNEL_ID, text: `${t} restock is in` }
        const asker = s.who === 'system' ? null : await actor(PEOPLE[s.who])
        const ctx: LastRequest['ctx'] = replay ? replay.ctx : {
          asker, origin: s.who === 'system' ? 'routine' as const : s.origin, chatId: `c_ws_${s.who}`, jobId: s.origin === 'job' ? 'j_ws' : null,
        }
        const invocation: OutboxInvocation = replay ? replay.invocation : { runId: 'r_ws', turnId: 't_ws', toolUseId: fresh('tu') }
        const r = await port.request({ ...ctx, nowMs: now, invocation }, { operation: OPERATION[opNow], args }, { mode: s.mode })
        if (r.outcome !== 'refused') {
          admitted++
          if (!ids.includes(r.action.id)) ids.push(r.action.id)
          const carried = 'tags' in args ? String((args.tags as unknown[])[0]) : String(args.text).split(' ')[0] ?? ''
          if (!tokens.has(carried)) tokens.set(carried, r.action.id)
          if (r.outcome === 'approved') approvals.set(r.action.id, { rev: r.action.approved_rev ?? -1, by: 'grant', era })
          if (r.outcome === 'existing' && replay && s.replay === 'other') problems.push('a replay with other arguments was answered with the first row')
        }
        last.request = { invocation, args, op: opNow, ctx }
        break
      }
      case 'answer': {
        const id = await aim(s.i, 'waiting')
        if (!id) break
        const row = (await rowOf(id))!
        const who = await by(s.by, row)
        // A stale answer names a revision the card isn't at (one behind, or one ahead of a first revision).
        const ifRev = s.stale ? (row.rev > 1 ? row.rev - 1 : row.rev + 1) : row.rev
        // `fit_*`: the choice the card offers (Approve on an exact or a routine's card, card.ts `kindOf`); the others may not fit.
        const exact = row.verdict === 'exact' || row.origin === 'routine'
        const choice = s.choice === 'fit_once' || s.choice === 'fit_always' ? (exact ? 'approve' : s.choice === 'fit_once' ? 'once' : 'always') : s.choice
        const answer = () => port.answer(who, id, { choice, ifRev })
        const results = s.twice ? await Promise.all([answer(), answer()]) : [await answer()]
        for (const r of results) {
          if (!('action' in r)) continue
          // An answer is to the revision the person saw: it may win only at that revision, and what it approves is the
          // next one. Recorded from the test's own `ifRev`, never from the row the outbox returns.
          if (ifRev !== row.rev) problems.push(`W2: an answer to revision ${ifRev} won on a card at revision ${row.rev} (${id})`)
          if (r.action.state === 'approved') approvals.set(id, { rev: ifRev + 1, by: who.memberId, era })
        }
        break
      }
      case 'undo': {
        const id = await aim(s.i, 'approved')
        if (!id) break
        const row = (await rowOf(id))!
        await port.undo(await by(s.by, row), id, { ifRev: row.rev })
        break
      }
      case 'withdraw': {
        const id = await aim(s.i, 'waiting')
        if (!id) break
        const row = (await rowOf(id))!
        if (s.by === 'agent') await port.withdraw({ kind: 'agent', chatId: row.chat_id, turnId: 't_ws' }, id, { ifRev: row.rev })
        else await port.withdraw({ kind: 'member', actor: await by(s.by, row, 'asker') }, id, { ifRev: row.rev })
        break
      }
      case 'revoke': {
        const live = (await db.prepare('SELECT * FROM permission_grants WHERE revoked_at_ms IS NULL ORDER BY granted_at_ms, id').all<GrantRow>()).results
        if (live.length === 0) break
        const g = live[s.i % live.length]
        const viewer = await actor(s.by === 'holder' ? g.holder_member ?? 'm_ws_d' : PEOPLE[s.by])
        await permissions.remove({ id: g.id, ifRev: g.rev }, viewer, { ...at(), actorId: viewer.memberId })
        break
      }
      case 'role': {
        const m = await memberOf(PEOPLE[s.who])
        if (m) await members.changeRole({ id: m.id, role: s.to, ifRev: m.rev }, at())
        break
      }
      case 'remove': {
        const m = await memberOf(PEOPLE[s.who])
        if (m) await members.remove({ id: m.id, ifRev: m.rev }, at())
        break
      }
      case 'reinvite': {
        const id = PEOPLE[s.who]
        const m = await memberOf(id)
        if (m?.status !== 'removed') break
        const invited = await members.invite({ name: 'Test person', email: emailOf(id), role: START_ROLE[id] }, at())
        if ('ok' in invited) await members.resolvePerson({ subject: subjectOf(id), email: emailOf(id), requestId: fresh('signin'), nowMs: now })
        break
      }
      case 'channel': {
        // The admin takes the Slack channel off the list, or lists it again (the real store: its grants end with it).
        const current = await channels.list()
        await channels.save({ channels: s.listed ? [{ channelId: CHANNEL_ID, name: 'ops' }] : [], alertsChannelId: null, ifRev: current.rev }, at())
        break
      }
      case 'ceiling':
        await runBatch(db, [setCeilingStmt({ operation: OPERATION[s.op], enabled: s.enabled, perDayMax: s.perDayMax, actorId: 'm_system', nowMs: now })])
        break
      case 'account': {
        const id = ACCOUNT[s.op]
        const h = hub.accounts.get(id)!
        if (s.change === 'reconnect') {
          // A new generation, the same on both sides (the product's row and the hub's SignIn).
          now += 1
          await accounts.connectEnded(id, CONNECTOR[s.op], 'ok', 'connected', at())
          h.connectedAtMs = now
        } else if (s.change === 'disconnect') {
          now += 1
          await accounts.recordDisconnect(id, CONNECTOR[s.op], { action: 'tools.disconnect', accountId: id, revoked: true }, at())
          h.connectedAtMs = null
        } else if (s.change === 'hub_drift') {
          // The hub's account moved on and the product hasn't heard yet: the hub's own check is the line that holds.
          if (h.connectedAtMs !== null) h.connectedAtMs += 7
        } else {
          h.paused = s.change === 'hub_pause'
        }
        break
      }
      case 'flip':
        flip()
        if (!s.hookFails) await syncGate({ db, state: () => ({ ...object }), nowMs: now, requestId: fresh('sync'), notify: note.notify })
        if (s.pulse) {
          flip()
          if (!s.hookFails) await syncGate({ db, state: () => ({ ...object }), nowMs: now, requestId: fresh('sync'), notify: note.notify })
        }
        break
      case 'tick':
        now += s.ms
        if (s.alarm) await alarm(s.alarm)
        break
      case 'dispatch': {
        const id = await aim(s.i, 'approved')
        if (id) await dispatch(id, s)
        break
      }
      case 'scheduler':
        await alarm()
        break
      case 'sweep': {
        // The sweep asks for the send task of an approved action whose task was lost; BrandAgent then runs it.
        for (let pass = 0; pass < s.passes; pass++) {
          const ensured: string[] = []
          await sweepOutbox({ db, nowMs: now, state: () => ({ ...object }), scheduler: { ensure: t => { ensured.push(t.id.slice(t.id.indexOf(':') + 1)) } }, notify: note.notify, requestId: fresh('sweep') })
          for (const id of ensured) await dispatch(id)
        }
        break
      }
      case 'fault':
        hub.shop.faults['shopify.order.tag_add'] = s.shop
        hub.slackFault = s.slack
        break
      case 'late':
        for (const release of hub.hung.splice(0)) release()
        await Promise.all(late.splice(0))
        break
      case 'resolve': {
        const id = await aim(s.i, 'needs_check')
        if (!id) break
        const row = (await rowOf(id))!
        await port.resolve(await by(s.by, row), id, { outcome: s.outcome, ifRev: row.rev })
        break
      }
    }
  }
  for (const release of hub.hung.splice(0)) release()
  await Promise.all(late.splice(0))

  // ---------- the oracle, from the upstreams' logs ----------
  const effects: string[] = []
  for (const w of hub.shop.writes) {
    const tags = Array.isArray(w.variables.tags) ? (w.variables.tags as unknown[]).map(String) : []
    const owner = tags.map(t => tokens.get(t)).find(x => x !== undefined)
    if (owner) effects.push(owner)
    else problems.push(`W1: a Shopify write for no action (${tags.join(', ')})`)
  }
  for (const p of hub.slackPosts) {
    const owner = tokens.get(p.text.split(' ')[0] ?? '')
    if (owner) effects.push(owner)
    else problems.push('W1: a Slack post for no action')
  }
  const perAction = new Map<string, number>()
  for (const id of effects) perAction.set(id, (perAction.get(id) ?? 0) + 1)
  for (const [id, count] of perAction) {
    if (count > 1) problems.push(`W1: ${count} effects for one action (${id})`)
    if (!calls.some(c => c.actionId === id)) problems.push(`W1: an effect with no hub call (${id})`)
    const row = await rowOf(id)
    if (row?.origin === 'routine' && approvals.get(id)?.by === 'grant') problems.push(`W4: a routine's effect with no person's approval (${id})`)
  }
  // W2 and W3 for every call (an effect needs one; a call that the hub refused must still have come from a sound claim).
  const callsPer = new Map<string, number>()
  for (const c of calls) {
    callsPer.set(c.actionId, (callsPer.get(c.actionId) ?? 0) + 1)
    const claim = claims.get(`${c.actionId}#${c.attempt}`)
    for (const f of claim?.faults ?? ['no winning claim']) problems.push(`W2: a call whose claim had ${f} (${c.actionId}${perAction.has(c.actionId) ? ', with an effect' : ''})`)
    for (const f of c.permit) problems.push(`W3: a call where ${f} (${c.actionId}${perAction.has(c.actionId) ? ', with an effect' : ''})`)
  }
  for (const [id, count] of callsPer) if (count > 1) problems.push(`W1: ${count} hub calls for one action (${id})`)
  // W6: a grant-backed effect keeps its use unless its action failed (a definite refusal, or a person said it didn't go
  // out: both release it, as the reservation counts); the effects still holding a use, per grant and day, stay inside
  // the largest daily limit any of their claims saw.
  const perGrantDay = new Map<string, { units: number; limit: number }>()
  for (const id of perAction.keys()) {
    for (const c of calls.filter(x => x.actionId === id)) {
      const claim = claims.get(`${c.actionId}#${c.attempt}`)
      if (!claim || claim.grantId === null) continue
      const use = await db.prepare('SELECT * FROM permission_uses WHERE id = ?').bind(claim.useId).first<UseRow>()
      const row = await rowOf(id)
      if (!use) {
        problems.push(`W6: a grant-backed effect with no use (${id})`)
        continue
      }
      if (use.released_at_ms !== null) {
        if (row?.state !== 'failed') problems.push(`W6: a grant-backed effect whose use was released while ${row?.state} (${id})`)
        continue
      }
      const key = `${use.grant_id}|${use.day}`
      const was = perGrantDay.get(key) ?? { units: 0, limit: 0 }
      const now2 = { units: was.units + use.units, limit: Math.max(was.limit, claim.limit ?? 0) }
      perGrantDay.set(key, now2)
      if (now2.units > now2.limit) problems.push(`W6: a grant's effects passed its day (${key}: ${now2.units} over ${now2.limit})`)
    }
  }
  if (!o.ceiling) {
    if (effects.length > 0) problems.push('W5: an effect with no ceiling row')
    if (admitted > 0) problems.push('W5: a request admitted with no ceiling row')
  }
  return { effects: effects.length, admitted, problems }
}

/** The world's daily maximum for Shopify tags: tight in a third of the runs each, so a grant's day fills. */
const PER_DAY_MAX = fc.constantFrom(1, 2, 50)
// Floors on what the suites send, about half the lowest count seen over repeated runs: a run that sends little proves
// little, and a floor near the usual count would flake. Seen on 2026-11-26: the main suite sent 139 to 164
// effects over 400 runs (5 runs of it), the send path 322 to 431 over 300 runs (11 runs of it).
const MAIN_FLOOR = 70
const SEND_PATH_FLOOR = 160

describe('the write-safety gate (M2-S): no outside write without a live grant or an approval of that exact action', () => {
  beforeAll(async () => {
    hubCode = await loadHub()
    // The hub's own log line per call (hub/index/log.ts) and the dispatcher's: thousands per run.
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterAll(() => vi.restoreAllMocks())

  it('a Slack post goes out through the hub\'s own check of its arguments (the listed channel by its id)', async () => {
    const out = await runSequence([
      { k: 'request', who: 0, origin: 'chat', op: 'slack', mode: 'tool', replay: 'none' },
      { k: 'answer', i: 0, by: 'own', choice: 'once', stale: false, twice: false },
      { k: 'tick', ms: 11_000, alarm: { crash: null, flipAt: 0, latePermit: false, binding: 'ok' } },
    ], { ceiling: true })
    expect(out.problems).toEqual([])
    expect(out.effects).toBe(1)
  })

  it('holds W1 to W6 over random sequences of every kind of step', async () => {
    let effects = 0
    const runs = 400
    // Three runs in four start with an "Always allow" for the first member's Shopify tags, so sends under a grant are common;
    // a third of the worlds cap the tags at 1 or 2 a day, so a grant's day fills.
    const seed: Step[] = [
      { k: 'request', who: 0, origin: 'chat', op: 'shop', mode: 'tool', replay: 'none' },
      { k: 'answer', i: 0, by: 'own', choice: 'fit_always', stale: false, twice: false },
    ]
    await fc.assert(fc.asyncProperty(fc.constantFrom(true, true, true, false), PER_DAY_MAX, fc.array(stepArb, { minLength: 30, maxLength: 90 }), async (seeded, perDayMax, steps) => {
      const out = await runSequence(seeded ? [...seed, ...steps] : steps, { ceiling: true, perDayMax })
      effects += out.effects
      expect(out.problems).toEqual([])
    }), { numRuns: runs })
    // The suite must actually send: a run where nothing reached an upstream proves nothing.
    expect(effects, `effects sent over ${runs} runs: ${effects}`).toBeGreaterThan(MAIN_FLOOR)
  }, 300_000)

  it('holds W1 to W6 on the send path: a crash at each boundary, the sweep, every fault, late results and checks', async () => {
    // A prefix that leaves approved actions behind (one allowed once, one under a fresh "Always allow", one run under it,
    // a Slack post allowed once), then only the steps around a send.
    const prefix: Step[] = [
      { k: 'request', who: 0, origin: 'chat', op: 'shop', mode: 'tool', replay: 'none' },
      { k: 'answer', i: 0, by: 'own', choice: 'fit_once', stale: false, twice: false },
      { k: 'request', who: 0, origin: 'chat', op: 'shop', mode: 'tool', replay: 'none' },
      { k: 'answer', i: 0, by: 'own', choice: 'fit_always', stale: false, twice: false },
      { k: 'request', who: 0, origin: 'chat', op: 'shop', mode: 'tool', replay: 'none' },
      { k: 'request', who: 0, origin: 'chat', op: 'shop', mode: 'tool', replay: 'none' },
      { k: 'request', who: 2, origin: 'chat', op: 'slack', mode: 'tool', replay: 'none' },
      { k: 'answer', i: 0, by: 'own', choice: 'fit_once', stale: false, twice: false },
      { k: 'tick', ms: 11_000, alarm: false },
    ]
    const sendPath = stepArb.filter(s => ['tick', 'dispatch', 'sweep', 'flip', 'late', 'resolve', 'fault', 'undo', 'revoke', 'account', 'ceiling', 'channel'].includes(s.k))
    let effects = 0
    await fc.assert(fc.asyncProperty(PER_DAY_MAX, fc.array(sendPath, { minLength: 5, maxLength: 30 }), async (perDayMax, tail) => {
      const out = await runSequence([...prefix, ...tail], { ceiling: true, perDayMax })
      effects += out.effects
      expect(out.problems).toEqual([])
    }), { numRuns: 300 })
    expect(effects, `effects sent over 300 runs: ${effects}`).toBeGreaterThan(SEND_PATH_FLOOR)
  }, 300_000)

  it('the product\'s state (no ceiling row): every request is refused and nothing reaches an upstream', async () => {
    const noCeiling = stepArb.filter(s => s.k !== 'ceiling')
    await fc.assert(fc.asyncProperty(fc.array(noCeiling, { minLength: 10, maxLength: 40 }), async steps => {
      const out = await runSequence(steps, { ceiling: false })
      expect(out.problems).toEqual([])
      expect(out.effects).toBe(0)
      expect(out.admitted).toBe(0)
    }), { numRuns: 30 })
  }, 120_000)
})
