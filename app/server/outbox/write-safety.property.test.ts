// Stage 1 M2-S, the write-safety gate (N2, N9 to N15, N19; P6 acceptance 1 to 6, 8, 9): proof across modules that no
// outside write happens without a live grant or an approval of that exact action. Real D1, the real outbox (request,
// answer, Undo, withdraw, resolve), the real claim, dispatcher, sweep and gate sync, the real stores for members,
// connector accounts, permissions and the ceiling, and behind the dispatcher a stand-in for the `HUB_WRITE` binding
// (vitest.config.ts binds a 503 there) that runs the hub's own write entry (`runWriteAction`, its strict request schema),
// the hub's own Shopify mutation sender and Slack outbox poster, against the hub's fake Shopify write upstream
// (test/upstreams/shopify/write/) and a recording Slack SignIn. The app's server project can't load the hub's
// ShopifyWriteCore (its SignIn imports `graphql`, which only app/hub/ installs), so the stand-in repeats its account checks
// (paused, `connectedAtMs`, the approved store), its token grant and its lookup-then-mutation order around the hub's real
// operations (`SHOPIFY_WRITE_OPS`: each one's strict arguments, documents and reading).
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
// Stage 1 M2-N (Q3 = A) adds two steps on the same path: the agent's `notification_send` to the listed channel (the real
// tool handler and its Slack leg, with a stand-in for N14's admission: a fresh call, a replay of the last one, or a call
// admission refuses), from any asker and origin, a team routine and a system routine included; and an admin or a member
// moving the alerts mark on or off the channel (the real store: the brand's grant follows the mark). The oracle is the
// same: a notice's post is an effect like any other and must meet W1 to W7.
// Stage 1 M3-W extends the same gate across every M3 path (N22 to N26, N31 as the oracle). Worlds with the M3 write set
// turn on every operation (tags added and removed, draft orders, restock, reduce, refunds, Slack posts) under N24's
// limits made small enough to reach (a bulk threshold of 3, batches of 6). Steps add: a request of any operation and
// size (one order, a few, more than the bulk threshold, past a grant's largest call or the ceiling's, an argument the
// store refuses); parallel appends to one chat's collecting batch; a batch answered as its card shows it, for every item
// or for fewer than the tip (`upTo` below it, the backend's own answer), with stale totals among them; the admins card
// (a refund a member asks for), answered by anyone; the ceiling of any operation raised or lowered in every limit
// (`lowered_rev`); a revoke, a lowered ceiling, an admin demoted or a fast Pause landing inside an item's call; a crash
// at any of a batch pass's D1 calls; the store throttling (the item tried again, nothing having run), refusing, timing
// out or answering a broken body, per operation; a restore's hold and its confirm; and a person resolving one item.
//
// The oracle reads the upstream's log (every write request the fake Shopify store received, with the store's own
// answer, and every post the Slack SignIn sent on). Each upstream write belongs to the hub call it happened inside (the
// stand-in sees each call start and end); a write outside any call is W1's. A call's "send key" is its single action, or
// for a batch the item its claim took (`item_id`, kept across moves). The store's answer says what happened: `ran`
// (changed something), `refused` (a user error or a GraphQL error: nothing changed), `throttled` (Shopify ran nothing),
// `replayed` (an idempotency key it had seen: nothing ran again) or `unclear` (a timeout or a broken body). It holds,
// written before the code:
//  W1. every upstream write happened inside a hub call; per send key at most one write that ran or is unclear, and every
//      call but its last was throttled with nothing run (a throttled item may be tried again, nothing else is);
//  W2. the call behind a write came from a winning claim at which, read from D1 right after the claim's batch and
//      checked here in the test's own words (not claim-guard.ts's SQL): the gate was open, at the epoch the approval was
//      given in and at the object's pause generation; the action was approved at this revision, past its hold and under
//      10 minutes old, in the current Pause/Resume era; the operation enabled in the ceiling and the call (or the item)
//      within its largest single call; the account on the action's generation; the asker an active person whose role
//      may ask for it; and either (a) a live grant held by the asker (or the brand), on the same account, generation,
//      operation and scope, made under the current ceiling and policy, for an operation with no effect flag and no more
//      records than the bulk threshold, its largest call admitting the units, with this revision's use unreleased and the
//      grant's day (less the items given back) inside MIN(per_day, per_day_max), or (b) the approver approved this
//      revision (the test recorded the answer, from the revision the test sent, never from the row the outbox returned)
//      and is still an active person whose role may give it (an admins card: an active admin); and an answer wins only
//      at the revision it named. For a batch item (M3-W): the batch is sending, and the item is one the approval covered:
//      at a position at or under the `upTo` the test answered (or the call it ran under a grant split into), the same
//      item and arguments the card showed there when the person answered;
//  W3. the call started inside the permit: the clock before `claimed_at + 40 s`, and no Pause or Resume since the claim;
//  W4. no effect for a routine without an approval (a routine never runs under a grant);
//  W5. no effect with an empty ceiling: with no ceiling row (the product's state) every request is refused and nothing
//      reaches an upstream;
//  W6. (M3-W, #439 P9) units that went out stay counted: a grant-backed send key whose write ran (or is unclear) keeps
//      its units (the action's use unreleased and, for an item, no release of it) unless a person resolved it as not
//      sent; a `failed` row is never trusted to mean nothing went out, so a released use ties to the store's own refusal
//      (or no write at all) or a person's resolve. The units still held per grant and day stay inside the daily limit
//      their claims saw;
//  W7. every answer the write binding gave was released (Workers RPC: an undisposed answer keeps the call's context
//      open, and the BrandAgent object never goes idle);
//  W8. (M3-W, N25, N31) no money card a member could answer: an answer that wins on an admins card is an active
//      admin's, and any winning approval of an operation a member may not approve is an admin's;
//  W9. (M3-W, N31 card honesty) what was sent is what was asked and shown: every call's operation and arguments are the
//      ones the test itself requested for that send key (a one-call batch's items are the test's own split of the call).
// Planted bugs (each seen red, then restored; the PRs list them) prove the oracle has teeth.
import { fc } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AccountStatus, HubError, HubErrorCode, HubResult, SlackChannel, WriteGateway, WriteRequest, WriteResult } from '../../hub/index/contract.ts'
import {
  FakeShopifyWriteUpstream, SHOPIFY_WRITE_SHOP, SHOPIFY_WRITE_TEST_CLIENT_ID, SHOPIFY_WRITE_TEST_CLIENT_SECRET,
} from '../../test/upstreams/shopify/write/server.ts'
import type { ShopifyWriteCallLog, WriteFault } from '../../test/upstreams/shopify/write/server.ts'
import type { MemberRole } from '../../shared/contract/members.ts'
import { auditInsert } from '../db/audit.ts'
import { connectorAccountStore } from '../db/connector-accounts.ts'
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import { notifyDeps } from '../mcp/tools/notifications/deps.ts'
import type { NotifyAdmitted } from '../mcp/tools/notifications/deps.ts'
import { NotificationSendInput, notificationSend } from '../mcp/tools/notifications/send.ts'
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
import { OPERATIONS } from './operations/index.ts'
import { holdOutbox, releaseHoldStmts } from './restore-hold.ts'
import { openOutbox } from './store.ts'
import { sweepOutbox } from './sweep.ts'
import { fresh, notices, resetOutbox } from './test-support.ts'
import { timing } from './timing.ts'
import type { OutboxActionRow, OutboxGateRow, OutboxInvocation, OutboxItemRow, OutboxRequestCtx, OutboxRequestResult } from './types.ts'

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
interface WriteInput { accountId: string; expect: { connectedAtMs: number; shop?: string }; args: unknown; idempotencyKey?: string }
/** hub/connectors/shopify/write/provider.ts `MutationDoc`, `MutationAnswer`. */
interface MutationDoc { query: string; variables: Record<string, unknown> }
type MutationAnswer = { ok: true; data: Record<string, unknown> } | { ok: false; result: WriteResult }
/** hub/connectors/shopify/write/ops/types.ts `PreparedShopifyWriteOp`. */
/** Stage 1 M3-S2: a call's steps, an optional lookup query and the mutation built from its answer (`PreparedCall`). */
type MutationStep = { ok: true; doc: MutationDoc; read(data: Record<string, unknown>): WriteResult } | { ok: false; result: WriteResult }
interface ShopOp {
  prepare(args: unknown, idempotencyKey: string | undefined):
    | { ok: true; call: { lookup: MutationDoc | null; mutation(lookupData: Record<string, unknown> | null): MutationStep } }
    | { ok: false; path: string }
}
/** hub/outbox-entry/gateway.ts `WriteGatewayDeps`. */
interface WriteDeps { shopifyWrite(input: WriteInput & { operation: string }): Promise<WriteResult>; slackChannelPost(input: WriteInput): Promise<WriteResult> }
/** hub/connectors/slack/outbox.ts `SlackOutboxStub`. */
interface SlackStub {
  status(accountId: string): Promise<HubResult<AccountStatus>>
  slackChannelInfo(accountId: string, channelId: string): Promise<HubResult<SlackChannel>>
  slackPost(accountId: string, req: { channelId: string; title: string; text: string }, expect?: { connectedAtMs: number }): Promise<HubResult<{ ts: string }>>
}
interface HubCode {
  /** The write entry's logic (hub/outbox-entry/gateway.ts): the strict request schema, then the operation. */
  runWriteAction(deps: WriteDeps, req: WriteRequest): Promise<WriteResult>
  /** hub/connectors/shopify/write/provider.ts: the one mutation document, its deadline and its sure or unsure answer. */
  postMutation(upstream: Upstream, config: ShopConfig, token: string, doc: MutationDoc, timeoutMs: number): Promise<MutationAnswer>
  /** hub/connectors/shopify/write/ops/index.ts: each Shopify operation's strict arguments, document and reading. */
  SHOPIFY_WRITE_OPS: Readonly<Record<string, ShopOp>>
  SHOPIFY_WRITE_ACCOUNT: string
  writeErr(code: HubErrorCode, sent: 'no' | 'unknown', detail?: string): WriteResult
  /** hub/connectors/slack/outbox.ts: the Slack post's argument check, account checks and channel re-check. */
  postSlackOutboxAction(stub: SlackStub, req: WriteInput): Promise<WriteResult>
  /** hub/signin/providers/shopify.ts: the client-credentials grant. */
  requestGrant(upstream: Upstream, config: ShopConfig, nowMs: () => number): Promise<{ ok: true; accessToken: string } | { ok: false; code: HubErrorCode }>
  hubError(code: HubErrorCode, detail?: string): HubError
}
const HUB_FILES = [
  '../../hub/outbox-entry/gateway.ts', '../../hub/connectors/shopify/write/provider.ts', '../../hub/connectors/shopify/write/ops/index.ts', '../../hub/connectors/slack/outbox.ts',
  '../../hub/signin/providers/shopify.ts', '../../hub/index/errors.ts',
]
const HUB_NAMES: readonly (keyof HubCode)[] = [
  'runWriteAction', 'postMutation', 'SHOPIFY_WRITE_OPS', 'SHOPIFY_WRITE_ACCOUNT', 'writeErr', 'postSlackOutboxAction', 'requestGrant', 'hubError',
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
/** The notices' run (the audit line of an unlisted channel names it, so it has a real run id's shape). */
const NOTICE_RUN = 'r_wsNoticeRun00000000000'

const PEOPLE = ['m_ws_a', 'm_ws_b', 'm_ws_d', 'm_ws_e'] as const
const INHOUSE = 'm_ws_ih'
type Person = (typeof PEOPLE)[number]
const START_ROLE: Record<Person, MemberRole> = { m_ws_a: 'member', m_ws_b: 'member', m_ws_d: 'admin', m_ws_e: 'admin' }
const emailOf = (id: string) => `${id.replaceAll('_', '-')}@example.test`
const subjectOf = (id: string) => `sub-${id}`

// ---------- the stand-in for the HUB_WRITE binding ----------

type SlackFault = 'succeed' | 'refuse' | 'throw'
type BindingFault = 'ok' | 'throw' | 'hang'
interface HubAccount { paused: boolean; connectedAtMs: number | null }

/** What one upstream write did, by the store's own answer (or the Slack SignIn's). */
type Verdict = 'ran' | 'refused' | 'throttled' | 'replayed' | 'unclear'
/** The binding's answer to one call, as the dispatcher would read it. */
type CallAnswer = 'ok' | 'no' | 'throttled' | 'unknown' | 'threw' | null

/** One call that reached the binding, what the oracle saw at that moment, and every upstream write made inside it. */
interface Call {
  actionId: string
  /** The batch item's position (null for a single action). */
  n: number | null
  attempt: number
  permit: string[]
  operation: string
  args: unknown
  writes: Verdict[]
  /** What each upstream write carried, as the store (or Slack) received it, in the order of `writes`. */
  sent: Sent[]
  answer: CallAnswer
}

/** One upstream write as it arrived: a Shopify mutation's variables, or a Slack post. */
type Sent = { kind: 'shop'; operation: string; variables: Record<string, unknown> } | { kind: 'slack'; channelId: string; text: string }

/** `Symbol.dispose`, as the runtime has it (this project's TypeScript lib doesn't name it yet). */
const DISPOSE = (Symbol as unknown as { dispose: symbol }).dispose

const SHOP_CONFIG = { shop: SHOPIFY_WRITE_SHOP, clientId: SHOPIFY_WRITE_TEST_CLIENT_ID, clientSecret: SHOPIFY_WRITE_TEST_CLIENT_SECRET }

/** The store's own answer to one mutation, read as what happened. */
async function shopVerdict(log: ShopifyWriteCallLog, res: Response | null): Promise<Verdict> {
  if (log.outcome === 'throttle') return 'throttled'
  if (log.replayed) return 'replayed'
  if (log.outcome === 'timeout' || log.outcome === 'broken_body' || res === null) return 'unclear'
  let body: unknown
  try {
    body = await res.clone().json()
  } catch {
    return 'unclear'
  }
  const data = (body as { data?: unknown }).data
  // A GraphQL error (a document the store didn't take): nothing ran.
  if (typeof data !== 'object' || data === null) return 'refused'
  const roots = Object.values(data as Record<string, unknown>)
  const refused = roots.map(r => {
    const errors = typeof r === 'object' && r !== null ? (r as { userErrors?: unknown }).userErrors : undefined
    return Array.isArray(errors) && errors.length > 0
  })
  // Every root refused: nothing changed. Any root that went through (a partly-sent tags call): it ran.
  return roots.length > 0 && refused.every(Boolean) ? 'refused' : 'ran'
}

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
  /** Answers the binding gave and how many of them the dispatcher released (Workers RPC: each has a disposer). */
  given = 0
  released = 0
  /** Upstream writes some call saw happen inside it (W1 compares it with the store's log). */
  attributed = 0
  /** Runs first in every call, synchronously: the oracle's look at the permit (and a planted Pause inside the call). */
  onCall: (req: WriteRequest) => Call = req => ({ actionId: req.actionId, n: req.item?.n ?? null, attempt: req.attempt, permit: [], operation: req.operation, args: req.args, writes: [], sent: [], answer: null })
  /**
   * Runs once, inside the `beforeAt`-th call from now (the next by default), after the oracle's look and before the hub's
   * work: a rule that changes mid-call.
   */
  before: ((req: WriteRequest) => Promise<void>) | null = null
  beforeAt = 1
  #token: string | null = null
  /** The fake store takes one request at a time here, so each write it logs is known to belong to one call. */
  #lock: Promise<void> = Promise.resolve()

  #wrote(call: Call, v: Verdict, sent: Sent): void {
    call.writes.push(v)
    call.sent.push(sent)
    this.attributed++
  }

  /**
   * The fake store's fetch for one call, with each mutation's answer read as what it did. Per call (never a shared "current
   * call"): a call the dispatcher gave up on may still be running when the next one starts.
   */
  #shopFetch(call: Call): Upstream {
    return async req => {
      const prev = this.#lock
      let release!: () => void
      this.#lock = new Promise<void>(r => { release = r })
      await prev
      const before = this.shop.writes.length
      let res: Response | null = null
      let added: ShopifyWriteCallLog[] = []
      try {
        res = await this.shop.fetch(req)
        return res
      } finally {
        added = this.shop.writes.slice(before)
        release()
        for (const log of added) this.#wrote(call, await shopVerdict(log, res), { kind: 'shop', operation: log.operation, variables: log.variables })
      }
    }
  }

  #refusal(accountId: string, expected: number): WriteResult | null {
    const a = this.accounts.get(accountId)
    if (!a || a.connectedAtMs === null) return this.#code.writeErr('not_configured', 'no', 'disconnected')
    if (a.paused) return this.#code.writeErr('paused', 'no')
    if (a.connectedAtMs !== expected) return this.#code.writeErr('connect_stale', 'no', 'connectedAtMs')
    return null
  }

  #slack(call: Call): SlackStub {
    return {
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
        this.#wrote(call, this.slackFault === 'succeed' ? 'ran' : this.slackFault === 'refuse' ? 'refused' : 'unclear', { kind: 'slack', channelId: req.channelId, text: req.text })
        if (this.slackFault === 'throw') throw new Error('the Slack call broke')
        if (this.slackFault === 'refuse') return { ok: false, error: this.#code.hubError('upstream_rejected') }
        return { ok: true, value: { ts: `1800000000.${String(this.slackPosts.length).padStart(6, '0')}` } }
      },
    }
  }

  #deps(call: Call): WriteDeps {
    return {
      // ShopifyWriteCore.run (hub/connectors/shopify/write/core.ts) as it orders its checks, around the hub's own operation.
      shopifyWrite: async input => {
        const op = this.#code.SHOPIFY_WRITE_OPS[input.operation]
        if (!op) return this.#code.writeErr('unknown_tool', 'no')
        if (input.accountId !== this.#code.SHOPIFY_WRITE_ACCOUNT) return this.#code.writeErr('invalid_args', 'no', 'accountId')
        if (input.expect.shop === undefined) return this.#code.writeErr('invalid_args', 'no', 'expect.shop')
        const parsed = op.prepare(input.args, input.idempotencyKey)
        if (!parsed.ok) return this.#code.writeErr('invalid_args', 'no', parsed.path)
        // The write app points at the one store the fake is: any other approved store is refused.
        if (input.expect.shop !== SHOPIFY_WRITE_SHOP) return this.#code.writeErr('connect_stale', 'no', 'shop')
        const before = this.#refusal(input.accountId, input.expect.connectedAtMs)
        if (before) return before
        if (this.#token === null) {
          const g = await this.#code.requestGrant(this.shop.fetch, SHOP_CONFIG, () => Date.now())
          if (!g.ok) return this.#code.writeErr(g.code, 'no')
          this.#token = g.accessToken
        }
        let lookupData: Record<string, unknown> | null = null
        if (parsed.call.lookup) {
          const beforeLookup = this.#refusal(input.accountId, input.expect.connectedAtMs)
          if (beforeLookup) return beforeLookup
          const looked = await this.#code.postMutation(this.#shopFetch(call), SHOP_CONFIG, this.#token, parsed.call.lookup, HUB_DEADLINE_MS)
          // A query changes nothing: whatever its answer, the write didn't happen.
          if (!looked.ok) return looked.result.ok ? this.#code.writeErr('internal', 'no') : { ...looked.result, sent: 'no' }
          lookupData = looked.data
        }
        const step = parsed.call.mutation(lookupData)
        if (!step.ok) return step.result
        const rightBefore = this.#refusal(input.accountId, input.expect.connectedAtMs)
        if (rightBefore) return rightBefore
        const answer = await this.#code.postMutation(this.#shopFetch(call), SHOP_CONFIG, this.#token, step.doc, HUB_DEADLINE_MS)
        return answer.ok ? step.read(answer.data) : answer.result
      },
      slackChannelPost: input => this.#code.postSlackOutboxAction(this.#slack(call), input),
    }
  }

  readonly gateway: WriteGateway = {
    runAction: async req => {
      const call = this.onCall(req)
      const disturb = this.before
      if (disturb && --this.beforeAt <= 0) {
        this.before = null
        await disturb(req)
      }
      // The binding broke before the hub: nothing went out.
      if (this.binding === 'throw') {
        call.answer = 'threw'
        throw new Error('the binding broke')
      }
      let answer: WriteResult
      try {
        answer = await this.#code.runWriteAction(this.#deps(call), req)
      } catch {
        // hub/outbox-entry/entry.ts: an unexpected throw is `internal`, `sent: 'unknown'`.
        answer = { ok: false, error: this.#code.hubError('internal'), sent: 'unknown' }
      }
      call.answer = answer.ok ? 'ok' : answer.sent !== 'no' ? 'unknown' : answer.error.code === 'rate_limited' ? 'throttled' : 'no'
      // As Workers RPC hands it over: with a disposer the caller must run, or the call's context stays open.
      this.given++
      let disposed = false
      const handed = Object.assign({}, answer, { [DISPOSE]: () => { if (!disposed) { disposed = true; this.released++ } } }) as WriteResult
      // The hub did its work; its answer is lost until the test lets it through.
      if (this.binding === 'hang') return new Promise<WriteResult>(resolve => { this.hung.push(() => resolve(handed)) })
      return handed
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
/** The operations: `shop` is M2's `tag_add` (its name kept so M2's steps read as they did); the rest are M3's. */
type Op = 'shop' | 'slack' | 'untag' | 'draft' | 'restock' | 'reduce' | 'refund'
/** The operations that collect (N22: `coalesces: true`). */
type CollectOp = 'shop' | 'untag' | 'draft' | 'restock'
/** An account the `account` step moves. */
type AccountOp = 'shop' | 'slack'
/**
 * A request's size: one record (`one`), a few (at or under the bulk threshold: `few`), more than the threshold (`many`),
 * past a grant's or the ceiling's largest call (`large`, `huge`), or with an argument the store refuses (`bad`).
 */
type Size = 'one' | 'few' | 'many' | 'large' | 'huge' | 'bad' | 'dozen' | 'four'
/** A rule that changes inside a call (M3-W): a revoke, a lowered ceiling, an admin demoted, a fast Pause and Resume. */
type Disturb = 'none' | 'revoke' | 'lower' | 'demote' | 'flip' | 'restore'
/** How one send goes: a crash, a fast Pause and Resume, a permit reached late, a binding that throws or hangs. */
interface SendOpts { crash: { at: number; when: 'before' | 'after' } | null; flipAt: number; latePermit: boolean; binding: BindingFault; inCall?: Disturb; inCallAt?: number; crashOnResult?: boolean }
interface CeilingStep { k: 'ceiling'; op: Op; enabled: boolean; perDayMax: number; unitsMax?: number; bulkThreshold?: number; batchMax?: number }
type Step =
  | { k: 'request'; who: Who | 'system'; origin: 'chat' | 'job' | 'routine'; op: Op; mode: 'tool' | 'ask_only'; replay: 'none' | 'same' | 'other'; size?: Size }
  | { k: 'burst'; who: Who; op: CollectOp; n: number }
  | { k: 'answer'; i: number; by: Target; choice: 'fit_once' | 'fit_always' | 'once' | 'always' | 'approve' | 'deny'; stale: boolean; twice: boolean; cut?: number; newest?: true }
  | { k: 'drive'; i: number; cut: number; alarms: number }
  | { k: 'undo'; i: number; by: Target }
  | { k: 'withdraw'; i: number; by: Target | 'agent' }
  | { k: 'revoke'; i: number; by: 'holder' | Who }
  | { k: 'role'; who: Who; to: MemberRole }
  | { k: 'remove'; who: Who }
  | { k: 'reinvite'; who: Who }
  | CeilingStep
  | { k: 'account'; op: AccountOp; change: 'reconnect' | 'disconnect' | 'hub_drift' | 'hub_pause' | 'hub_resume' }
  | { k: 'channel'; listed: boolean }
  | { k: 'flip'; hookFails: boolean; pulse: boolean }
  | { k: 'tick'; ms: number; alarm: SendOpts | false }
  | ({ k: 'dispatch'; i: number } & SendOpts)
  | { k: 'scheduler' }
  | { k: 'sweep'; passes: 1 | 2 }
  | { k: 'fault'; shop: WriteFault; slack: SlackFault; target?: Op }
  | { k: 'late' }
  | { k: 'resolve'; i: number; by: Target; outcome: 'sent' | 'failed' }
  | { k: 'notice'; who: Who | 'system'; origin: 'chat' | 'job' | 'routine'; replay: 'none' | 'same' | 'refused' }
  | { k: 'alerts'; marked: boolean; by: Who | 'inhouse' }
  | { k: 'restore'; gap: boolean }
  | { k: 'confirm' }

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
  W(3, fc.record({ k: fc.constant('channel' as const), listed: fc.boolean() })),
  W(1, fc.record({ k: fc.constant('account' as const), op: fc.constantFrom<AccountOp>('shop', 'shop', 'slack'), change: fc.constantFrom('reconnect' as const, 'disconnect' as const, 'hub_drift' as const, 'hub_pause' as const, 'hub_resume' as const) })),
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
  // M2-N: notification_send to the listed channel (`refused`: admission finds no matching call), and the alerts mark.
  W(5, fc.record({
    k: fc.constant('notice' as const), who: fc.oneof(W(4, fc.constant<Who>(0)), W(2, fc.constant<Who>(2)), W(1, fc.constant<Who>(1)), W(1, fc.constant('system' as const))),
    origin: fc.constantFrom('chat' as const, 'chat' as const, 'job' as const, 'routine' as const),
    replay: fc.constantFrom('none' as const, 'none' as const, 'none' as const, 'same' as const, 'refused' as const),
  })),
  W(3, fc.record({ k: fc.constant('alerts' as const), marked: fc.constantFrom(true, true, false), by: fc.constantFrom<Who | 'inhouse'>(2, 2, 3, 0, 'inhouse') })),
)

// ---------- M3-W's steps ----------

const m3Op = fc.constantFrom<Op>('shop', 'shop', 'shop', 'untag', 'draft', 'restock', 'restock', 'reduce', 'refund', 'refund', 'slack')
const m3Size = fc.constantFrom<Size>('one', 'one', 'one', 'few', 'few', 'many', 'many', 'many', 'large', 'huge', 'bad')
// A send in an M3 world: a crash at any of a batch pass's D1 calls, a fast Pause and Resume there, and a rule that
// changes inside the first call.
const m3SendOpts: fc.Arbitrary<SendOpts> = fc.record({
  crash: fc.oneof(W(4, fc.constant(null)), W(1, fc.record({ at: fc.oneof(W(2, fc.integer({ min: 1, max: 8 })), W(2, fc.integer({ min: 9, max: 40 }))), when: fc.constantFrom('before' as const, 'after' as const) }))),
  flipAt: fc.oneof(W(10, fc.constant(0)), W(1, fc.integer({ min: 1, max: 30 }))),
  latePermit: fc.constantFrom(false, false, false, false, false, false, false, false, true),
  binding: fc.constantFrom<BindingFault>('ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'throw', 'hang'),
  inCall: fc.constantFrom<Disturb>('none', 'none', 'none', 'none', 'none', 'none', 'revoke', 'lower', 'demote', 'flip', 'restore'),
  crashOnResult: fc.constantFrom(false, false, false, false, false, false, false, true),
})
/** A call's result being stored (dispatch.ts `storeResult`, batch/send.ts `storeItem`). */
const RESULT_SQL = /^UPDATE outbox_(actions SET state = '(sent|failed|needs_check)'|items SET (state = '(sent|failed|needs_check)'|throttles))/
const m3Ceiling: fc.Arbitrary<Step> = fc.record({
  k: fc.constant('ceiling' as const), op: m3Op, enabled: fc.constantFrom(true, true, true, true, false), perDayMax: fc.constantFrom(1, 2, 5, 50, 200),
  unitsMax: fc.constantFrom(1, 3, 60, 500, 50_000), bulkThreshold: fc.constantFrom(1, 3, 3, 5), batchMax: fc.constantFrom(2, 6, 6, 500),
})
const asker = fc.oneof(W(5, fc.constant<Who>(0)), W(2, fc.constant<Who>(2)), W(2, fc.constant<Who>(1)), W(1, fc.constant('system' as const)))

const m3StepArb: fc.Arbitrary<Step> = fc.oneof(
  W(12, fc.record({
    k: fc.constant('request' as const), who: asker, origin: fc.constantFrom('chat' as const, 'chat' as const, 'chat' as const, 'job' as const, 'routine' as const), op: m3Op,
    mode: fc.constantFrom('tool' as const, 'tool' as const, 'tool' as const, 'ask_only' as const), replay: fc.constantFrom('none' as const, 'none' as const, 'none' as const, 'none' as const, 'same' as const, 'other' as const),
    size: m3Size,
  })),
  W(3, fc.record({ k: fc.constant('burst' as const), who: fc.constantFrom<Who>(0, 0, 1, 2), op: fc.constantFrom<CollectOp>('shop', 'shop', 'untag', 'draft', 'restock'), n: fc.integer({ min: 2, max: 6 }) })),
  W(12, fc.record({
    k: fc.constant('answer' as const), i: idx, by: fc.oneof(W(4, fc.constant('own' as const)), W(2, who)),
    choice: fc.constantFrom('fit_once' as const, 'fit_once' as const, 'fit_always' as const, 'fit_always' as const, 'once' as const, 'always' as const, 'approve' as const, 'deny' as const),
    stale: fc.constantFrom(false, false, false, false, true), twice: fc.constantFrom(false, false, false, true), cut: fc.oneof(W(3, fc.constant(0)), W(1, fc.integer({ min: 1, max: 4 }))),
  })),
  W(9, fc.record({ k: fc.constant('drive' as const), i: idx, cut: fc.oneof(W(3, fc.constant(0)), W(1, fc.integer({ min: 1, max: 3 }))), alarms: fc.integer({ min: 1, max: 4 }) })),
  W(2, fc.record({ k: fc.constant('undo' as const), i: idx, by: target })),
  W(1, fc.record({ k: fc.constant('withdraw' as const), i: idx, by: fc.oneof(target, fc.constant('agent' as const)) })),
  W(3, fc.record({ k: fc.constant('revoke' as const), i: idx, by: fc.oneof(fc.constant('holder' as const), who) })),
  W(2, fc.record({ k: fc.constant('role' as const), who, to: fc.constantFrom<MemberRole>('member', 'admin') })),
  W(1, fc.record({ k: fc.constant('remove' as const), who })),
  W(1, fc.record({ k: fc.constant('reinvite' as const), who })),
  W(4, m3Ceiling),
  W(2, fc.record({ k: fc.constant('channel' as const), listed: fc.boolean() })),
  W(1, fc.record({ k: fc.constant('account' as const), op: fc.constantFrom<AccountOp>('shop', 'shop', 'slack'), change: fc.constantFrom('reconnect' as const, 'disconnect' as const, 'hub_drift' as const, 'hub_pause' as const, 'hub_resume' as const) })),
  W(2, fc.record({ k: fc.constant('flip' as const), hookFails: fc.boolean(), pulse: fc.constantFrom(true, true, false) })),
  W(9, fc.record({
    k: fc.constant('tick' as const), alarm: fc.oneof(W(1, fc.constant(false as const)), W(4, m3SendOpts)),
    ms: fc.oneof(W(6, fc.integer({ min: 0, max: 5_000 })), W(8, fc.integer({ min: 10_000, max: 12_000 })), W(2, fc.constant(PERMIT_MS + 1)), W(3, fc.constant(61_000)),
      W(1, fc.constant(timing().approvalMaxAgeMs + 30_000)), W(1, fc.constant(timing().expiresMs + 60_000))),
  })),
  W(4, fc.tuple(fc.record({ k: fc.constant('dispatch' as const), i: idx }), m3SendOpts).map(([a, b]) => ({ ...a, ...b }))),
  W(2, fc.constant({ k: 'scheduler' as const })),
  W(3, fc.record({ k: fc.constant('sweep' as const), passes: fc.constantFrom<1 | 2>(1, 2) })),
  W(3, fc.record({
    k: fc.constant('fault' as const), target: fc.constantFrom<Op>('shop', 'untag', 'draft', 'restock', 'reduce', 'refund'),
    shop: fc.constantFrom<WriteFault>('succeed', 'succeed', 'succeed', 'succeed', 'refuse', 'timeout', 'broken_body', 'throttle', 'throttle'),
    slack: fc.constantFrom<SlackFault>('succeed', 'succeed', 'succeed', 'refuse', 'throw'),
  })),
  W(1, fc.constant({ k: 'late' as const })),
  W(3, fc.record({ k: fc.constant('resolve' as const), i: idx, by: target, outcome: fc.constantFrom('sent' as const, 'failed' as const) })),
  W(2, fc.record({
    k: fc.constant('notice' as const), who: fc.oneof(W(4, fc.constant<Who>(0)), W(2, fc.constant<Who>(2)), W(1, fc.constant('system' as const))),
    origin: fc.constantFrom('chat' as const, 'chat' as const, 'routine' as const), replay: fc.constantFrom('none' as const, 'none' as const, 'same' as const, 'refused' as const),
  })),
  W(2, fc.record({ k: fc.constant('alerts' as const), marked: fc.constantFrom(true, true, false), by: fc.constantFrom<Who | 'inhouse'>(2, 2, 3, 0, 'inhouse') })),
  W(1, fc.record({ k: fc.constant('restore' as const), gap: fc.boolean() })),
  W(1, fc.constant({ k: 'confirm' as const })),
)

// ---------- the world ----------

interface MemberRow { id: string; role: MemberRole; status: string; kind: string; rev: number }
interface GrantRow {
  id: string; rev: number; holder: string; holder_member: string | null; account_id: string; account_gen: number; operation: string; scope_key: string
  per_day: number; units_max: number; policy_rev: number; granted_role: MemberRole; ceiling_rev: number; revoked_at_ms: number | null
}
interface UseRow { id: string; action_id: string; action_rev: number; grant_id: string; day: string; units: number; released_at_ms: number | null }
interface CeilingRow { enabled: number; per_day_max: number; units_max: number; bulk_threshold: number; batch_max: number; lowered_rev: number }

/** The ceiling limits an M3 world starts with (N24's, made small enough to reach: a bulk threshold of 3, batches of 6). */
const M3_CEILING: Record<WriteOperationKey, { perDayMax: number; unitsMax: number; bulkThreshold: number; batchMax: number }> = {
  'shopify.order.tag_add': { perDayMax: 50, unitsMax: 100, bulkThreshold: 3, batchMax: 6 },
  'shopify.order.tag_remove': { perDayMax: 50, unitsMax: 100, bulkThreshold: 3, batchMax: 6 },
  'shopify.draft_order.create': { perDayMax: 50, unitsMax: 1, bulkThreshold: 5, batchMax: 6 },
  'shopify.inventory.restock': { perDayMax: 1_000, unitsMax: 500, bulkThreshold: 5, batchMax: 6 },
  'shopify.inventory.reduce': { perDayMax: 1_000, unitsMax: 500, bulkThreshold: 5, batchMax: 6 },
  'shopify.refund.create': { perDayMax: 50_000, unitsMax: 50_000, bulkThreshold: 5, batchMax: 500 },
  'slack.channel.post': { perDayMax: 50, unitsMax: 1, bulkThreshold: 5, batchMax: 500 },
}

async function setup(o: World): Promise<void> {
  await resetOutbox(db)
  await db.batch(PEOPLE.map(id => db.prepare(
    `INSERT INTO members (id, kind, role, status, name, email_norm, subject, created_at_ms) VALUES (?, 'person', ?, 'active', 'Test person', ?, ?, 1)
     ON CONFLICT (id) DO UPDATE SET role = excluded.role, status = 'active', removed_at_ms = NULL, email_norm = excluded.email_norm, subject = excluded.subject, rev = rev + 1`,
  ).bind(id, START_ROLE[id], emailOf(id), subjectOf(id))))
  await db.batch([
    // The Shopify write store's handle and currency are D1's, copied from the hub (M2-D's and M3-S2's sync); written here
    // as that sync would.
    db.prepare("INSERT INTO connector_accounts (account_id, connector, last_state, last_state_at_ms, connected_at_ms, shop, currency) VALUES (?, 'shopify', 'connected', 1, ?, ?, 'USD')").bind(SHOP, T0 - 2_000, SHOPIFY_WRITE_SHOP),
    db.prepare("INSERT INTO connector_accounts (account_id, connector, last_state, last_state_at_ms, connected_at_ms) VALUES (?, 'slack', 'connected', 1, ?)").bind(SLACK, T0 - 1_000),
  ])
  // An Inhouse team member: they may save the channel list (decision 19), but their alerts mark gives no grant (D4).
  await db.prepare(
    `INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'inhouse', NULL, 'active', 'Inhouse person', 1)
     ON CONFLICT (id) DO UPDATE SET status = 'active', removed_at_ms = NULL`,
  ).bind(INHOUSE).run()
  await channel(db, CHANNEL_ID, 'ops', 'm_ws_d')
  if (o.ceiling && o.m3) {
    await runBatch(db, (Object.keys(M3_CEILING) as WriteOperationKey[]).map(operation => setCeilingStmt({
      operation, enabled: true, ...M3_CEILING[operation], ...(operation === 'shopify.order.tag_add' && o.perDayMax !== undefined ? { perDayMax: o.perDayMax } : {}),
      actorId: 'm_system', nowMs: T0,
    })))
  } else if (o.ceiling) {
    await runBatch(db, (['shopify.order.tag_add', 'slack.channel.post'] as const).map(operation =>
      setCeilingStmt({ operation, enabled: true, perDayMax: operation === 'shopify.order.tag_add' ? o.perDayMax ?? 50 : 50, actorId: 'm_system', nowMs: T0 })))
  }
}

/**
 * The brand at the start: its ceiling on or absent (the product's state), and the Shopify tags' daily maximum. `m3`: every
 * operation of the M3 write set on, under `M3_CEILING`.
 */
interface World { ceiling: boolean; perDayMax?: number; m3?: boolean }

const OPERATION: Record<Op, WriteOperationKey> = {
  shop: 'shopify.order.tag_add', slack: 'slack.channel.post', untag: 'shopify.order.tag_remove', draft: 'shopify.draft_order.create',
  restock: 'shopify.inventory.restock', reduce: 'shopify.inventory.reduce', refund: 'shopify.refund.create',
}
const ACCOUNT: Record<AccountOp, string> = { shop: SHOP, slack: SLACK }
const CONNECTOR: Record<AccountOp, string> = { shop: 'shopify', slack: 'slack' }

const ORDER = (k: number) => `gid://shopify/Order/${9001 + (k % 3)}`

/**
 * A request's arguments, in the test's own words. Tags and draft orders carry the request's own tag; tag calls name the
 * fake store's three orders (and past them orders it doesn't have: "Order not found", a refusal).
 */
function argsFor(o: Op, n: number, size: Size): Record<string, unknown> {
  const t = `ws${n}`
  switch (o) {
    case 'shop':
    case 'untag': {
      const count = size === 'few' ? 2 + (n % 2) : size === 'many' || size === 'large' ? 4 + (n % 3) : size === 'dozen' ? 12 : size === 'four' ? 4 : 1
      const orders = size === 'bad' ? ['gid://shopify/Order/9009'] : Array.from({ length: count }, (_, k) => (k < 3 ? ORDER(n + k) : `gid://shopify/Order/${9010 + k}`))
      return { orderIds: orders, tags: [t] }
    }
    case 'draft':
      return { lines: [{ variantId: size === 'bad' ? 'gid://shopify/ProductVariant/7009' : `gid://shopify/ProductVariant/${7001 + (n % 3)}`, quantity: 1 + (n % 3) }], tags: [t] }
    case 'restock':
    case 'reduce':
      return {
        inventoryItemId: 'gid://shopify/InventoryItem/8001', locationId: size === 'bad' ? 'gid://shopify/Location/699' : 'gid://shopify/Location/601',
        quantity: size === 'huge' ? 600 + (n % 10) : size === 'large' || size === 'many' ? 60 + (n % 40) : 1 + (n % 20), reason: o === 'restock' ? 'restock' : 'damaged',
      }
    case 'refund': {
      // Order 9001's unshipped line at $5.00 (three to refund), order 9004's at $10.00; a wrong amount Shopify won't
      // suggest; an amount past the ceiling's largest refund.
      const [order, line, minor] = size === 'few' ? ['9004', '90041', 1_000] : ['9001', '90012', size === 'bad' ? 600 : size === 'huge' ? 60_000 : 500]
      return { orderId: `gid://shopify/Order/${order}`, lines: [{ lineItemId: `gid://shopify/LineItem/${line}`, quantity: 1 }], amount: { minor, currency: 'USD' }, restock: false, notifyCustomer: false }
    }
    case 'slack':
      return { channel: n % 2 === 0 ? '#ops' : CHANNEL_ID, text: `${t} restock is in` }
  }
}

/** A call's items as the test splits it itself (N21: tags, one item per order; anything else one item, the call). */
function splitOf(operation: WriteOperationKey, args: Record<string, unknown>): Record<string, unknown>[] {
  if (operation === 'shopify.order.tag_add' || operation === 'shopify.order.tag_remove') {
    return (args.orderIds as string[]).map(id => ({ orderIds: [id], tags: args.tags }))
  }
  return [args]
}

/** JSON with object keys sorted, so two values compare as data. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x !== null && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  : x))

/** "5.00" (a Shopify decimal string) in minor units; NaN when it isn't one. */
const cents = (v: unknown): number => {
  const m = typeof v === 'string' ? /^(\d+)(?:\.(\d{1,2}))?$/.exec(v) : null
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : Number.NaN
}

/**
 * #596: what the store received, against what the test asked for that send key, in the test's own words (main's tie
 * from each logged write to its action, by its tag or text and now its idempotency key, kept and widened to every
 * operation). Returns what differs, or null.
 */
function storeDiffers(sent: Sent, want: { operation: WriteOperationKey; args: Record<string, unknown> }, key: string): string | null {
  const a = want.args
  if (sent.kind === 'slack') return want.operation !== 'slack.channel.post' ? 'a post for a Shopify request' : sent.channelId !== CHANNEL_ID ? 'the channel' : sent.text !== a.text ? 'the text' : null
  if (sent.operation !== want.operation) return `the operation (${sent.operation})`
  const v = sent.variables
  const input = (typeof v.input === 'object' && v.input !== null ? v.input : {}) as Record<string, unknown>
  switch (want.operation) {
    case 'shopify.order.tag_add':
    case 'shopify.order.tag_remove': {
      const ids: unknown[] = []
      for (let i = 0; `id${i}` in v; i++) ids.push(v[`id${i}`])
      return canon(v.tags) !== canon(a.tags) ? 'the tags' : canon(ids) !== canon(a.orderIds) ? 'the orders' : null
    }
    case 'shopify.draft_order.create':
      return canon(input.lineItems) !== canon(a.lines) ? 'the lines' : canon(input.tags) !== canon(a.tags) || input.note !== a.note ? 'the note or tags' : null
    case 'shopify.inventory.restock':
    case 'shopify.inventory.reduce': {
      const c = (Array.isArray(input.changes) ? input.changes[0] : null) as Record<string, unknown> | null
      const sign = want.operation === 'shopify.inventory.restock' ? 1 : -1
      if (!c || c.inventoryItemId !== a.inventoryItemId || c.locationId !== a.locationId || c.delta !== sign * (a.quantity as number)) return 'the change'
      return input.reason !== a.reason ? 'the reason' : v.idempotencyKey !== key ? 'the idempotency key' : null
    }
    case 'shopify.refund.create': {
      const amount = a.amount as { minor: number; currency: string }
      const lines = (Array.isArray(input.refundLineItems) ? input.refundLineItems : []) as Record<string, unknown>[]
      const paid = (Array.isArray(input.transactions) ? input.transactions : []) as Record<string, unknown>[]
      if (input.orderId !== a.orderId || input.currency !== amount.currency || input.notify !== a.notifyCustomer) return 'the order, currency or notice'
      if (canon(lines.map(l => ({ lineItemId: l.lineItemId, quantity: l.quantity }))) !== canon(a.lines)) return 'the lines'
      if (paid.reduce((n, t) => n + cents(t.amount), 0) !== amount.minor) return `the amount (${paid.map(t => String(t.amount)).join(' + ')} for ${amount.minor})`
      return v.idempotencyKey !== key ? 'the idempotency key' : null
    }
    case 'slack.channel.post':
      return 'a Shopify write for a post'
  }
}

const rowOf = (id: string) => db.prepare('SELECT * FROM outbox_actions WHERE id = ?').bind(id).first<OutboxActionRow>()
const memberOf = (id: string) => db.prepare('SELECT id, role, status, kind, rev FROM members WHERE id = ?').bind(id).first<MemberRow>()
const itemsOf = async (actionId: string) => (await db.prepare('SELECT * FROM outbox_items WHERE action_id = ? ORDER BY n').bind(actionId).all<OutboxItemRow>()).results
const isEffectful = (operation: string) => {
  const e = OPERATIONS[operation as WriteOperationKey]
  return e !== undefined && Object.values(e.effects).some(Boolean)
}
const memberMay = (operation: string) => OPERATIONS[operation as WriteOperationKey]?.memberMay ?? false
/** Restore ids have the backup's shape (`YYYYMMDDTHHMMSSmmmZ-<8 hex>`). */
let restores = 0
const restoreId = () => `20271115T010203004Z-${(++restores).toString(16).padStart(8, '0')}`

/** What one sequence did, for the oracle. */
interface Outcome {
  /** Write requests that reached an upstream (whatever the store did with them). */
  effects: number
  /** Requests the outbox answered with something other than a refusal. */
  admitted: number
  /** M3-W: upstream writes for a batch item, and for an operation of the M3 write set. */
  itemEffects: number
  /** #597: the rare paths this run reached. */
  paths: { grantItemCalls: number; restoreInItemCall: number; crashBeforeItemResult: number }
  m3Effects: number
  problems: string[]
}

/** One winning claim (a single action's, or a batch item's), with the oracle's faults at that moment. */
interface Claim {
  faults: string[]
  limit: number | null
  era: number
  gen: number
  claimedAtMs: number
  grantId: string | null
  /** The use the units sit in (`<actionId>#<rev>`) and, for an item, its release's id. */
  useId: string
  releaseId: string | null
  /** The single action's id, or the item's id. */
  sendKey: string
  units: number
  day: string | null
}

/** An approval the test saw given: by a person (their id), or by a grant at the request; for a batch, what it covered. */
interface Approval {
  rev: number; by: string; era: number; upTo?: number; shown?: Map<number, { itemId: string; args: string }>
  /** A batch run under a grant at its request: the one call it holds, in the test's own counts (N22 way 1). */
  call?: { records: number; units: number }
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
        { accountId: SHOP, paused: hub.accounts.get(SHOP)?.paused ?? true, label: 'Shopify' },
        { accountId: SLACK, paused: hub.accounts.get(SLACK)?.paused ?? true, label: 'Slack' },
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
  const approvals = new Map<string, Approval>()
  /** Each winning claim: a single action's (`id#attempt`), a batch item's (`id:n#attempt`). */
  const claims = new Map<string, Claim>()
  const calls: Call[] = []
  /** M3-W (W9): the operation and arguments the test itself asked for, by send key (a single action, or an item). */
  const asked = new Map<string, { operation: WriteOperationKey; args: Record<string, unknown> }>()
  /** M3-W (W6): send keys a person resolved as not sent ("it didn't go out"). */
  const resolvedFailed = new Set<string>()
  /** M3-W: when each batch's send task asked to run again (`again`), as BrandAgent's alarm would. */
  const againAt = new Map<string, number>()
  let token = 0
  type LastRequest = { invocation: OutboxInvocation; args: Record<string, unknown>; op: Op; ctx: Omit<OutboxRequestCtx, 'invocation' | 'nowMs'> }
  const last: { request: LastRequest | null } = { request: null }
  type LastNotice = { toolUseId: string; jobId: string | null; args: Record<string, unknown>; memberId: string; chatId: string; routineAsker: string | null }
  const lastNotice: { notice: LastNotice | null } = { notice: null }
  /**
   * When the brand's grant to post to the channel may exist, in the test's own words (M2-N), not D1's: an active brand
   * admin's save moved the alerts mark onto the listed channel while the operation was on and Slack connected. Unmarking,
   * unlisting, a disconnect or reconnect, the operation off or any of its limits lowered, a restore, and removing the
   * grant all end it. W2 refuses a claim under a brand grant this record doesn't hold.
   */
  const brand = { marked: false, listed: true, ceilingOn: o.ceiling, slackConnected: true, allowed: false, grantId: null as string | null }
  const brandEnds = () => { brand.allowed = false; brand.grantId = null }
  /** The Slack post's ceiling as the test last set it (lowering any of it raises `lowered_rev`, N23). */
  const slackCeiling = o.m3 ? { enabled: true, ...M3_CEILING['slack.channel.post'] } : { enabled: true, perDayMax: 50, unitsMax: 1, bulkThreshold: 5, batchMax: 500 }
  /** Actions a routine's notice made, in the test's own words (W4 doesn't trust the row's `origin` for these). */
  const routineActions = new Set<string>()
  const restoresMade: string[] = []
  /** #597: how often a run reached the rare paths (reported by the suites, so a generator that stops reaching them shows). */
  const paths = { grantItemCalls: 0, restoreInItemCall: 0, crashBeforeItemResult: 0 }
  let permitClock = () => now
  let flipInCall = false
  const late: Promise<void>[] = []
  let admitted = 0
  const problems: string[] = []

  hub.onCall = req => {
    const key = req.item ? `${req.actionId}:${req.item.n}#${req.attempt}` : `${req.actionId}#${req.attempt}`
    const claim = claims.get(key)
    const permit: string[] = []
    if (!claim) permit.push('no winning claim for this attempt')
    else {
      if (permitClock() >= claim.claimedAtMs + PERMIT_MS) permit.push('the permit was reached after its deadline')
      if (object.pauseGen !== claim.gen || object.paused) permit.push('a Pause or Resume came between the claim and the call')
    }
    const call: Call = { actionId: req.actionId, n: req.item?.n ?? null, attempt: req.attempt, permit, operation: req.operation, args: req.args, writes: [], sent: [], answer: null }
    calls.push(call)
    if (flipInCall) { flip(); flip() }
    return call
  }

  /** The day's units a grant has in use, in the test's own words: unreleased uses, less the items released from them. */
  async function dayInUse(grantId: string, day: string): Promise<number> {
    const uses = (await db.prepare('SELECT * FROM permission_uses WHERE grant_id = ? AND day = ? AND released_at_ms IS NULL').bind(grantId, day).all<UseRow>()).results
    let n = 0
    for (const u of uses) {
      n += u.units
      const back = (await db.prepare('SELECT units FROM permission_item_releases WHERE action_id = ? AND action_rev = ?').bind(u.action_id, u.action_rev).all<{ units: number }>()).results
      for (const b of back) n -= b.units
    }
    return n
  }

  /**
   * The rules shared by a single action's claim and a batch item's: the gate, the ceiling, the account, the asker, and
   * the grant or the person's approval. `units` and `records` are the call's (an item's own).
   */
  async function ruleFaults(pre: OutboxActionRow, units: number, records: number, useId: string): Promise<{ faults: string[]; limit: number | null; day: string | null }> {
    const f: string[] = []
    let limit: number | null = null
    let day: string | null = null
    const gate = await db.prepare('SELECT * FROM outbox_gate WHERE id = 1').first<OutboxGateRow>()
    if (!gate || gate.paused !== 0 || gate.restore_hold !== 0) f.push('the gate was closed')
    else {
      if (gate.epoch !== pre.approved_epoch) f.push('an approval from another gate epoch')
      if (gate.do_gen !== object.pauseGen) f.push('the gate was behind the object')
    }
    if (pre.policy_rev !== POLICY_REV) f.push('made under another policy')
    const ceiling = await db.prepare('SELECT * FROM permission_ceiling WHERE operation = ?').bind(pre.operation).first<CeilingRow>()
    if (!ceiling || ceiling.enabled !== 1) f.push('an empty ceiling')
    else if (units > ceiling.units_max) f.push(`a call past the ceiling's largest (${units} > ${ceiling.units_max})`)
    const acct = await db.prepare('SELECT connected_at_ms, disconnected_at_ms FROM connector_accounts WHERE account_id = ?').bind(pre.account_id)
      .first<{ connected_at_ms: number | null; disconnected_at_ms: number | null }>()
    if (!acct || acct.connected_at_ms !== pre.account_gen || (acct.disconnected_at_ms !== null && acct.disconnected_at_ms >= acct.connected_at_ms)) f.push('the account changed generation')
    const asker = await memberOf(pre.asked_by)
    if (!asker || asker.kind !== 'person' || asker.status !== 'active') f.push('the asker is not an active person')
    else if (asker.role !== 'admin' && !memberMay(pre.operation) && pre.approver_kind !== 'admins') f.push('a member asked for what only an admin may approve, on their own card')
    if (pre.operation === 'slack.channel.post') {
      const listed = await db.prepare('SELECT 1 AS one FROM notify_channels WHERE channel_id = ? AND removed_at_ms IS NULL')
        .bind((JSON.parse(pre.scope_json) as { channelId?: string }).channelId ?? '').first()
      if (!listed) f.push('the channel is not listed')
    }
    const ap = approvals.get(pre.id)
    if (pre.grant_id !== null) {
      if (pre.origin === 'routine') f.push('a routine under a grant')
      if (isEffectful(pre.operation)) f.push('a guardrailed operation under a grant')
      if (pre.approver_kind !== 'person') f.push('an admins card under a grant')
      if (ceiling && records > ceiling.bulk_threshold) f.push('a grant-backed call over the bulk threshold')
      const g = await db.prepare('SELECT * FROM permission_grants WHERE id = ?').bind(pre.grant_id).first<GrantRow>()
      if (!g || g.revoked_at_ms !== null) f.push('the grant was revoked')
      else {
        if (g.account_id !== pre.account_id || g.account_gen !== pre.account_gen || g.operation !== pre.operation || g.scope_key !== pre.scope_key) f.push('the grant does not cover it')
        const held = g.holder === `member:${pre.asked_by}` ? asker?.role === 'admin' || g.granted_role === 'member' : g.holder === 'brand' && g.granted_role === 'admin'
        if (!held) f.push('the grant is not the asker\'s')
        if (g.holder === 'brand' && (!brand.allowed || brand.grantId !== g.id)) f.push('a brand grant the test never saw an admin give, or saw taken back')
        if (!ceiling || g.ceiling_rev !== ceiling.lowered_rev) f.push('the grant predates a lowered ceiling')
        if (g.policy_rev !== POLICY_REV) f.push('the grant was made under another policy')
        if (units > g.units_max) f.push(`a call past the grant's largest (${units} > ${g.units_max})`)
      }
      const use = await db.prepare('SELECT * FROM permission_uses WHERE id = ?').bind(useId).first<UseRow>()
      if (!use || use.released_at_ms !== null || use.grant_id !== pre.grant_id) f.push('no unreleased use for this revision')
      else {
        day = use.day
        limit = g && ceiling ? Math.min(g.per_day, ceiling.per_day_max) : null
        if (limit === null || (await dayInUse(use.grant_id, use.day)) > limit) f.push('the grant\'s day is over its limit')
      }
    } else {
      // The person who approved: the asker, or for an admins card the admin who answered first.
      const admins = pre.approver_kind === 'admins'
      if (admins ? pre.approver !== 'role:admin' : pre.approved_by !== pre.approver || pre.approver !== pre.asked_by) f.push('not approved by its approver')
      if (!ap || ap.by !== pre.approved_by) f.push('the test saw no answer by the one who approved it')
      const approver = pre.approved_by === null ? null : await memberOf(pre.approved_by)
      if (!approver || approver.kind !== 'person' || approver.status !== 'active') f.push('the approver is not an active person')
      else if ((admins || !memberMay(pre.operation)) && approver.role !== 'admin') f.push('approved by someone who is not an admin now')
    }
    return { faults: f, limit, day }
  }

  /** The oracle's look at a single action's claim, right after its batch: W2, in the test's own words. */
  async function claimFaults(pre: OutboxActionRow, post: OutboxActionRow): Promise<{ faults: string[]; limit: number | null; day: string | null }> {
    const claimedAt = post.claimed_at_ms ?? -1
    const r = await ruleFaults(pre, pre.units, pre.records, `${pre.id}#${pre.rev}`)
    const f = r.faults
    const ap = approvals.get(pre.id)
    if (!ap || ap.rev !== pre.approved_rev) f.push('no approval of this revision')
    else if (ap.era !== era) f.push('an approval from before the last Pause or Resume')
    if (pre.state !== 'approved' || pre.approved_rev !== pre.rev) f.push('not an approved revision')
    if (pre.send_at_ms === null || pre.send_at_ms > claimedAt) f.push('claimed inside the hold')
    if (pre.approved_at_ms === null || pre.approved_at_ms <= claimedAt - timing().approvalMaxAgeMs) f.push('an approval over 10 minutes old')
    return r
  }

  /** M3-W: the oracle's look at a batch item's claim, right after it. W2 for items, in the test's own words. */
  async function itemClaimFaults(b: OutboxActionRow, it: OutboxItemRow, claimedAtMs: number): Promise<{ faults: string[]; limit: number | null; day: string | null }> {
    const rev = b.approved_rev ?? -1
    const r = await ruleFaults({ ...b, rev }, it.units, it.records, `${b.id}#${rev}`)
    const f = r.faults
    if (b.kind !== 'batch' || b.state !== 'sending') f.push(`an item of a batch that is ${b.state}`)
    const ap = approvals.get(b.id)
    if (!ap || ap.rev !== b.approved_rev) f.push('no approval of this revision')
    else {
      if (ap.era !== era) f.push('an approval from before the last Pause or Resume')
      if (ap.upTo === undefined || it.n > ap.upTo) f.push(`an item past what the approval covered (${it.n} of ${ap.upTo ?? 'none'})`)
      const shown = ap.shown?.get(it.n)
      if (!shown || shown.itemId !== it.item_id || shown.args !== it.args_json) f.push('an item the card did not show at that position')
    }
    // The batch's own claim (once, N22): past its hold, under 10 minutes after its approval.
    if (b.approved_at_ms === null || b.send_at_ms === null || b.claimed_at_ms === null) f.push('an item of a batch with no approval, hold or claim')
    else {
      if (b.send_at_ms > b.claimed_at_ms) f.push('a batch claimed inside the hold')
      if (b.approved_at_ms <= b.claimed_at_ms - timing().approvalMaxAgeMs) f.push('a batch claimed on an approval over 10 minutes old')
    }
    // A batch under a grant is one call (N22 way 1): the call, not one item, is what the bulk threshold and the largest
    // calls bound (N23).
    if (b.grant_id !== null) {
      const call = ap?.call
      const ceiling = await db.prepare('SELECT * FROM permission_ceiling WHERE operation = ?').bind(b.operation).first<CeilingRow>()
      const g = await db.prepare('SELECT * FROM permission_grants WHERE id = ?').bind(b.grant_id).first<GrantRow>()
      if (!call) f.push('a grant-backed batch the test never saw a grant take at its request')
      else {
        if (ceiling && call.records > ceiling.bulk_threshold) f.push(`a grant-backed call over the bulk threshold (${call.records} > ${ceiling.bulk_threshold})`)
        if (ceiling && call.units > ceiling.units_max) f.push(`a grant-backed call past the ceiling's largest (${call.units} > ${ceiling.units_max})`)
        if (g && call.units > g.units_max) f.push(`a grant-backed call past the grant's largest (${call.units} > ${g.units_max})`)
      }
    }
    if (it.not_before_ms !== null && it.not_before_ms > claimedAtMs) f.push('a throttled item claimed before its wait')
    return r
  }

  /** The dispatcher, as BrandAgent's task runs it, on a D1 the oracle watches (and that may crash or flip under it). */
  async function dispatch(id: string, o2: Partial<SendOpts> = {}) {
    let pre: OutboxActionRow | null = null
    let preItems: Map<string, { item: OutboxItemRow; batch: OutboxActionRow }> | null = null
    let reads = 0
    const watched = tapped(db, {
      before: async (n, sqls) => {
        if (o2.crash?.when === 'before' && o2.crash.at === n) throw new Crash('crash')
        // M3-W: the process dies right after a call, before its result is stored (the call went out; its answer is lost).
        if (o2.crashOnResult && RESULT_SQL.test(sqls[0] ?? '')) {
          if (sqls[0]?.startsWith('UPDATE outbox_items')) paths.crashBeforeItemResult++
          throw new Crash('crash')
        }
        if (sqls[0]?.startsWith("UPDATE outbox_actions SET state = 'sending'")) pre = await rowOf(id)
        if (sqls[0]?.startsWith("UPDATE outbox_items SET state = 'sending'")) {
          // Every pending item of a sending batch, with its batch: the one whose attempt moves won the claim.
          const rows = (await db.prepare(`SELECT i.* FROM outbox_items i JOIN outbox_actions a ON a.id = i.action_id WHERE i.state = 'pending'`).all<OutboxItemRow>()).results
          preItems = new Map()
          for (const it of rows) {
            const b = await rowOf(it.action_id)
            if (b) preItems.set(it.item_id, { item: it, batch: b })
          }
        }
      },
      after: async (n, sqls) => {
        if (pre && sqls[0]?.startsWith("UPDATE outbox_actions SET state = 'sending'")) {
          const post = await rowOf(id)
          if (post && post.kind === 'single' && post.state === 'sending' && post.attempt === pre.attempt + 1 && pre.state === 'approved') {
            const r = await claimFaults(pre, post)
            claims.set(`${id}#${post.attempt}`, {
              ...r, era, gen: object.pauseGen, claimedAtMs: post.claimed_at_ms ?? -1, grantId: pre.grant_id, useId: `${pre.id}#${pre.rev}`, releaseId: null,
              sendKey: pre.id, units: pre.units,
            })
          }
          pre = null
        }
        if (preItems && sqls[0]?.startsWith("UPDATE outbox_items SET state = 'sending'")) {
          for (const { item, batch } of preItems.values()) {
            const post = await db.prepare('SELECT * FROM outbox_items WHERE item_id = ?').bind(item.item_id).first<OutboxItemRow>()
            if (!post || post.state !== 'sending' || post.attempt !== item.attempt + 1) continue
            const r = await itemClaimFaults(batch, item, post.claimed_at_ms ?? -1)
            const rev = batch.approved_rev ?? -1
            claims.set(`${post.action_id}:${post.n}#${post.attempt}`, {
              ...r, era, gen: object.pauseGen, claimedAtMs: post.claimed_at_ms ?? -1, grantId: batch.grant_id, useId: `${batch.id}#${rev}`,
              releaseId: `${batch.id}#${rev}#${item.n}`, sendKey: item.item_id, units: item.units,
            })
          }
          preItems = null
        }
        if (o2.flipAt !== undefined && o2.flipAt > 5 && o2.flipAt - 5 === n) { flip(); flip() }
        if (o2.crash?.when === 'after' && o2.crash.at === n) throw new Crash('crash')
      },
    })
    hub.binding = o2.binding ?? 'ok'
    hub.before = o2.inCall && o2.inCall !== 'none' ? disturbance(o2.inCall) : null
    hub.beforeAt = o2.inCallAt ?? 1
    permitClock = () => now + (o2.latePermit ? PERMIT_MS : 0)
    flipInCall = o2.flipAt === 5
    const read = () => {
      if (++reads === o2.flipAt) { flip(); flip() }
    }
    try {
      await sendAction(id, {
        db: watched, nowMs: now, hub: hub.gateway, notify: note.notify, requestId: fresh('send'), again: atMs => { againAt.set(id, atMs) }, timeoutMs: DISPATCH_TIMEOUT_MS,
        clock: () => permitClock(), onLate: p => late.push(p),
        gate: { get paused() { read(); return object.paused }, get pauseGen() { read(); return object.pauseGen } },
      })
    } catch (err) {
      if (!isCrash(err)) throw err
    } finally {
      hub.binding = 'ok'
      hub.before = null
      flipInCall = false
      permitClock = () => now
    }
  }

  /** M3-W: a rule that changes inside a call (after the oracle's look at it): the call can't be recalled, later ones stop. */
  function disturbance(d: Exclude<Disturb, 'none'>): (req: WriteRequest) => Promise<void> {
    return async req => {
      if (d === 'flip') {
        flip()
        flip()
      } else if (d === 'revoke') {
        const g = await db.prepare('SELECT * FROM permission_grants WHERE revoked_at_ms IS NULL ORDER BY granted_at_ms, id LIMIT 1').first<GrantRow>()
        if (!g) return
        const viewer = await actor(g.holder_member ?? 'm_ws_d')
        await permissions.remove({ id: g.id, ifRev: g.rev }, viewer, { ...at(), actorId: viewer.memberId })
        if (g.id === brand.grantId) brandEnds()
      } else if (d === 'lower') {
        // The call's operation, its largest single call down to 1 (raising `lowered_rev`).
        const c = await db.prepare('SELECT * FROM permission_ceiling WHERE operation = ?').bind(req.operation).first<CeilingRow>()
        if (!c) return
        await setCeiling({ k: 'ceiling', op: opOf(req.operation), enabled: c.enabled === 1, perDayMax: c.per_day_max, unitsMax: 1, bulkThreshold: c.bulk_threshold, batchMax: c.batch_max })
      } else if (d === 'restore') {
        // A restore's hold while this call is out: the call can't be recalled; the rest is held for a check.
        if (req.item) paths.restoreInItemCall++
        await restoreHold(false)
      } else {
        const m = await memberOf('m_ws_d')
        if (m?.role === 'admin') await members.changeRole({ id: m.id, role: 'member', ifRev: m.rev }, at())
      }
    }
  }

  /** A restore's hold (M2-R, M3-B): the gate held, approved and sending rows (and their items) held for a check, every live grant revoked. */
  async function restoreHold(gap: boolean): Promise<void> {
    const afterId = (await db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM audit_log').first<number>('n')) ?? 0
    const rid = restoreId()
    await holdOutbox(db, { restoreId: rid, afterId, gap, at: { nowMs: now, actorId: 'm_ws_d', requestId: fresh('restore') } })
    restoresMade.push(rid)
    brandEnds()
  }
  const opOf = (operation: string): Op => (Object.keys(OPERATION) as Op[]).find(k => OPERATION[k] === operation) ?? 'shop'

  /** A ceiling change through its one writer, and the brand's Slack grant ended by any lowering of the post's ceiling. */
  async function setCeiling(s: CeilingStep): Promise<void> {
    const operation = OPERATION[s.op]
    await runBatch(db, [setCeilingStmt({
      operation, enabled: s.enabled, perDayMax: s.perDayMax, actorId: 'm_system', nowMs: now,
      ...(s.unitsMax !== undefined ? { unitsMax: s.unitsMax } : {}), ...(s.bulkThreshold !== undefined ? { bulkThreshold: s.bulkThreshold } : {}),
      ...(s.batchMax !== undefined ? { batchMax: s.batchMax } : {}),
    })])
    if (s.op === 'slack') {
      // Turning the operation off or lowering any of its limits raises `lowered_rev`: every grant made before covers nothing.
      const next = { enabled: s.enabled, perDayMax: s.perDayMax, unitsMax: s.unitsMax ?? 1, bulkThreshold: s.bulkThreshold ?? 5, batchMax: s.batchMax ?? 500 }
      const lowered = (slackCeiling.enabled && !next.enabled) || next.perDayMax < slackCeiling.perDayMax || next.unitsMax < slackCeiling.unitsMax
        || next.bulkThreshold < slackCeiling.bulkThreshold || next.batchMax < slackCeiling.batchMax
      if (lowered) brandEnds()
      Object.assign(slackCeiling, next)
      brand.ceilingOn = s.enabled
    }
  }

  /** BrandAgent's alarm: the send task of every approved action whose hold is over, and of every batch whose task asked to run again. */
  async function alarm(opts: Partial<SendOpts> = {}) {
    const due = (await db.prepare("SELECT id FROM outbox_actions WHERE state = 'approved' AND send_at_ms <= ? ORDER BY send_at_ms, id").bind(now).all<{ id: string }>()).results.map(r => r.id)
    for (const [id, atMs] of [...againAt]) {
      if (atMs > now) continue
      againAt.delete(id)
      if (!due.includes(id)) due.push(id)
    }
    for (const id of due) await dispatch(id, opts)
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
  /** Who acts on a row: `own` is its approver (an admins card's: the first admin), or its asker. */
  const by = async (t: Target, row: OutboxActionRow, own: 'approver' | 'asker' = 'approver') => {
    if (t !== 'own') return actor(PEOPLE[t])
    if (own === 'asker') return actor(row.asked_by)
    return actor(row.approver_kind === 'admins' ? 'm_ws_d' : row.approver)
  }

  /** What the test asked for, by the send keys the outbox made of it (W9's record), and the approval a grant gave. */
  async function noteRequest(r: OutboxRequestResult, opNow: Op, args: Record<string, unknown>, replay: boolean): Promise<void> {
    if (r.outcome === 'refused') return
    admitted++
    const operation = OPERATION[opNow]
    if (!ids.includes(r.action.id)) ids.push(r.action.id)
    if (r.outcome === 'collected') {
      // One item holding the whole call.
      if (!asked.has(r.item.item_id)) {
        if (canon(JSON.parse(r.item.args_json)) !== canon(args)) problems.push(`W9: a collected item whose arguments are not the call's (${r.item.item_id})`)
        asked.set(r.item.item_id, { operation, args })
      }
      return
    }
    if (r.action.kind === 'batch') {
      // A call that is its own batch: its items are the test's own split of the call, in order.
      const items = await itemsOf(r.action.id)
      const parts = splitOf(operation, args)
      const fresh1 = items.filter(i => !asked.has(i.item_id))
      if (fresh1.length > 0) {
        if (items.length !== parts.length || items.some((i, k) => canon(JSON.parse(i.args_json)) !== canon(parts[k]))) {
          problems.push(`W9: a batch whose items are not the call split in order (${r.action.id})`)
        }
        items.forEach((i, k) => { if (parts[k]) asked.set(i.item_id, { operation, args: parts[k] }) })
      }
      if (r.outcome === 'approved' && !approvals.has(r.action.id)) {
        const entry = OPERATIONS[operation]
        approvals.set(r.action.id, {
          rev: r.action.approved_rev ?? -1, by: 'grant', era, upTo: parts.length,
          shown: new Map(items.map(i => [i.n, { itemId: i.item_id, args: i.args_json }])),
          call: { records: entry.records(entry.args.parse(args) as never), units: entry.units(entry.args.parse(args) as never) },
        })
      }
      return
    }
    if (!asked.has(r.action.id) && !(replay && r.outcome === 'existing')) asked.set(r.action.id, { operation, args })
    if (r.outcome === 'approved') approvals.set(r.action.id, { rev: r.action.approved_rev ?? -1, by: 'grant', era })
  }

  /** One person's answer to a row, as its card offers it (a batch's: Approve or No for items 1 to `upTo`). */
  async function answerRow(id: string, s: { by: Target; choice: Extract<Step, { k: 'answer' }>['choice']; stale: boolean; twice: boolean; cut?: number }): Promise<boolean> {
    const row = (await rowOf(id))!
    const who1 = await by(s.by, row)
    // A stale answer names a revision the card isn't at (one behind, or one ahead of a first revision). A batch's stale
    // answer names totals the card didn't show.
    const batch = row.kind === 'batch'
    const ifRev = s.stale && !batch ? (row.rev > 1 ? row.rev - 1 : row.rev + 1) : row.rev
    // `fit_*`: the choice the card offers (Approve on an exact or a routine's card, card.ts `kindOf`); the others may not fit.
    const exact = batch || row.verdict === 'exact' || row.origin === 'routine'
    const choice = s.choice === 'fit_once' || s.choice === 'fit_always' ? (exact ? 'approve' : s.choice === 'fit_once' ? 'once' : 'always') : s.choice
    let upTo: number | undefined
    let shown: OutboxItemRow[] = []
    let totals: { records: number; units: number } | undefined
    if (batch) {
      if (row.items_n < 1) return false
      upTo = Math.max(1, row.items_n - (s.cut ?? 0))
      shown = (await itemsOf(id)).filter(i => i.n <= upTo!)
      totals = { records: shown.reduce((a, i) => a + i.records, 0), units: shown.reduce((a, i) => a + i.units, 0) + (s.stale ? 1 : 0) }
    }
    const before = await memberOf(who1.memberId)
    const answer = () => port.answer(who1, id, batch ? { choice: choice === 'deny' ? 'deny' : 'approve', ifRev, upTo, totals } : { choice, ifRev })
    const results = s.twice ? await Promise.all([answer(), answer()]) : [await answer()]
    let won = false
    for (const r of results) {
      if (!('action' in r)) continue
      won = true
      // An answer is to the revision the person saw: it may win only at that revision, and what it approves is the
      // next one. Recorded from the test's own `ifRev`, never from the row the outbox returns.
      if (ifRev !== row.rev) problems.push(`W2: an answer to revision ${ifRev} won on a card at revision ${row.rev} (${id})`)
      if (batch && s.stale) problems.push(`W2: a batch answer with totals the card didn't show won (${id})`)
      // W8: no money card a member could answer.
      if (row.approver_kind === 'admins' && (before?.role !== 'admin' || before.status !== 'active')) problems.push(`W8: a member answered an admins card (${id})`)
      if (r.action.state === 'approved' && !memberMay(row.operation) && before?.role !== 'admin') problems.push(`W8: a member's approval of ${row.operation} won (${id})`)
      if (r.action.state === 'approved') {
        approvals.set(id, {
          rev: ifRev + 1, by: who1.memberId, era,
          ...(batch ? { upTo, shown: new Map(shown.map(i => [i.n, { itemId: i.item_id, args: i.args_json }])) } : {}),
        })
      }
    }
    return won
  }

  for (const s of steps) {
    switch (s.k) {
      case 'request': {
        const replay = s.replay !== 'none' ? last.request : null
        const n = ++token
        const opNow: Op = replay ? replay.op : s.op
        const args: Record<string, unknown> = replay && s.replay === 'same' ? replay.args : argsFor(opNow, n, s.size ?? 'one')
        const asker1 = s.who === 'system' ? null : await actor(PEOPLE[s.who])
        const ctx: LastRequest['ctx'] = replay ? replay.ctx : {
          asker: asker1, origin: s.who === 'system' ? 'routine' as const : s.origin, chatId: `c_ws_${s.who}`, jobId: s.origin === 'job' ? 'j_ws' : null,
        }
        const invocation: OutboxInvocation = replay ? replay.invocation : { runId: 'r_ws', turnId: 't_ws', toolUseId: fresh('tu') }
        const r = await port.request({ ...ctx, nowMs: now, invocation }, { operation: OPERATION[opNow], args }, { mode: s.mode })
        if (r.outcome === 'existing' && replay && s.replay === 'other' && canon(JSON.parse(r.action.args_json)) !== canon(args)) problems.push('a replay with other arguments was answered with the first row')
        await noteRequest(r, opNow, args, replay !== null)
        // A replay keeps the first call's arguments as the invocation's own (its row holds those).
        if (!replay) last.request = { invocation, args, op: opNow, ctx }
        break
      }
      case 'burst': {
        // Parallel appends: calls of one kind from one chat at once (each its own invocation).
        const asker1 = await actor(PEOPLE[s.who])
        const made = Array.from({ length: s.n }, () => ({ args: argsFor(s.op, ++token, 'one'), toolUseId: fresh('tu') }))
        const results = await Promise.all(made.map(m => port.request(
          { asker: asker1, origin: 'chat', chatId: `c_ws_${s.who}`, jobId: null, nowMs: now, invocation: { runId: 'r_ws', turnId: 't_ws', toolUseId: m.toolUseId } },
          { operation: OPERATION[s.op], args: m.args }, { mode: 'tool' },
        )))
        for (const [k, r] of results.entries()) await noteRequest(r, s.op, made[k]!.args, false)
        break
      }
      case 'answer': {
        // `newest`: the card the last request made (a fixed prefix names it exactly).
        const id = s.newest ? await db.prepare("SELECT id FROM outbox_actions WHERE state = 'waiting' ORDER BY created_at_ms DESC, id DESC LIMIT 1").first<string>('id') : await aim(s.i, 'waiting')
        if (id) await answerRow(id, s)
        break
      }
      case 'drive': {
        // A person approves a waiting card as it shows (a batch: items 1 to `upTo`), and its task runs at the hold's end and
        // after. A waiting batch first, when there is one.
        const id = (await db.prepare("SELECT id FROM outbox_actions WHERE state = 'waiting' AND kind = 'batch' ORDER BY created_at_ms, id LIMIT 1 OFFSET ?").bind(s.i % 2).first<string>('id'))
          ?? await aim(s.i, 'waiting')
        if (!id) break
        const row = (await rowOf(id))!
        if (row.state !== 'waiting') break
        const won = await answerRow(id, { by: 'own', choice: 'fit_once', stale: false, twice: false, cut: s.cut })
        if (!won) break
        now += timing().holdMs + 1
        for (let k = 0; k < s.alarms; k++) {
          await alarm()
          now += 1_500
        }
        break
      }
      case 'undo': {
        const id = await aim(s.i, 'approved')
        if (!id) break
        const row = (await rowOf(id))!
        const who1 = s.by === 'own' && row.approver_kind === 'admins' ? await actor(row.approved_by ?? 'm_ws_d') : await by(s.by, row)
        await port.undo(who1, id, { ifRev: row.rev })
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
        const g = live[s.i % live.length]!
        const viewer = await actor(s.by === 'holder' ? g.holder_member ?? 'm_ws_d' : PEOPLE[s.by])
        await permissions.remove({ id: g.id, ifRev: g.rev }, viewer, { ...at(), actorId: viewer.memberId })
        if (g.id === brand.grantId && (await db.prepare('SELECT revoked_at_ms FROM permission_grants WHERE id = ?').bind(g.id).first<number | null>('revoked_at_ms')) !== null) brandEnds()
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
        // The save clears the mark either way, and unlisting ends every grant on the channel.
        brand.marked = false
        brand.listed = s.listed
        brandEnds()
        break
      }
      case 'ceiling':
        await setCeiling(s)
        break
      case 'account': {
        const id = ACCOUNT[s.op]
        const h = hub.accounts.get(id)!
        if (s.change === 'reconnect') {
          // A new generation, the same on both sides (the product's row and the hub's SignIn).
          now += 1
          await accounts.connectEnded(id, CONNECTOR[s.op], 'ok', 'connected', at())
          h.connectedAtMs = now
          if (s.op === 'slack') {
            brand.slackConnected = true
            brandEnds()
          }
        } else if (s.change === 'disconnect') {
          now += 1
          await accounts.recordDisconnect(id, CONNECTOR[s.op], { action: 'tools.disconnect', accountId: id, revoked: true }, at())
          h.connectedAtMs = null
          if (s.op === 'slack') {
            brand.slackConnected = false
            brandEnds()
          }
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
        // An approved action's task, or (M3-W) a sending batch's next pass.
        const id = await aim(s.i, 'approved') ?? await aim(s.i, 'sending')
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
      case 'fault': {
        const key = OPERATION[s.target ?? 'shop']
        if (key !== 'slack.channel.post') hub.shop.faults[key] = s.shop
        hub.slackFault = s.slack
        break
      }
      case 'late':
        for (const release of hub.hung.splice(0)) release()
        await Promise.all(late.splice(0))
        break
      case 'resolve': {
        const id = await aim(s.i, 'needs_check')
        if (!id) break
        const row = (await rowOf(id))!
        const person = await by(s.by, row)
        // #586: who may say what happened, in the test's own words: an active person who is the card's approver, or an
        // active admin. A resolve by anyone else is a problem, and never what a released unit may rest on (W6).
        const m = await memberOf(person.memberId)
        const mayResolve = m !== null && m.kind === 'person' && m.status === 'active' && (m.role === 'admin' || m.id === row.approver)
        let won = false
        if (row.kind === 'batch') {
          // One unclear item at a time.
          const item = await db.prepare("SELECT * FROM outbox_items WHERE action_id = ? AND state = 'needs_check' ORDER BY n LIMIT 1").bind(id).first<OutboxItemRow>()
          if (!item) break
          const r = await port.resolve(person, id, { outcome: s.outcome, ifRev: row.rev, item: item.n })
          const after = await db.prepare('SELECT * FROM outbox_items WHERE item_id = ?').bind(item.item_id).first<OutboxItemRow>()
          won = 'action' in r && after?.state === s.outcome && after.resolved_by === person.memberId
          if (won && mayResolve && s.outcome === 'failed') resolvedFailed.add(item.item_id)
        } else {
          const r = await port.resolve(person, id, { outcome: s.outcome, ifRev: row.rev })
          won = 'action' in r && r.action.state === s.outcome
          if (won && mayResolve && s.outcome === 'failed') resolvedFailed.add(id)
        }
        if (won && !mayResolve) problems.push(`W6: a check resolved by someone who may not resolve it (${person.memberId} on ${id})`)
        break
      }
      case 'notice': {
        // The agent's notification_send to the listed channel, through the real tool handler and its Slack leg.
        const replay = s.replay === 'same' ? lastNotice.notice : null
        const n = ++token
        const t = `ws${n}`
        const system = s.who === 'system' || s.origin === 'routine'
        const fresh1: LastNotice = {
          toolUseId: fresh('tu'), jobId: s.origin === 'job' ? 'j_ws' : null, args: { to: { channels: ['#ops'] }, title: 'Restock', text: `${t} restock is in`, format: 'message' },
          memberId: system ? SYSTEM_MEMBER_ID : PEOPLE[s.who as Who], chatId: `c_ws_${s.who}`, routineAsker: s.who === 'system' ? null : system ? PEOPLE[s.who as Who] : null,
        }
        const call = replay ?? fresh1
        const admission: NotifyAdmitted | null = s.replay === 'refused' ? null : { toolUseId: call.toolUseId, jobId: call.jobId, replay: replay !== null }
        const deps = notifyDeps({
          hubAccounts: async () => [
            { accountId: SHOP, paused: hub.accounts.get(SHOP)?.paused ?? true, label: 'Shopify' },
            { accountId: SLACK, paused: hub.accounts.get(SLACK)?.paused ?? true, label: 'Slack' },
          ],
          admit: async () => admission,
          routineAsker: async () => (call.routineAsker ? actor(call.routineAsker) : null),
          noted: async () => {},
          schedule: async () => {},
        })
        const r = await notificationSend.call(NotificationSendInput.parse(call.args), { memberId: call.memberId, chatId: call.chatId, runId: NOTICE_RUN, turnId: 't_ws', nowMs: now, requestId: fresh('mcp') }, { db, notify: deps })
        const recipients = (r.structuredContent as { recipients: { approval_id?: string; status?: string; created?: boolean }[] }).recipients
        for (const x of recipients) {
          if (x.approval_id === undefined) continue
          if (admission === null) problems.push('a notice that admission refused still made an action')
          admitted++
          if (!ids.includes(x.approval_id)) ids.push(x.approval_id)
          if (call.memberId === SYSTEM_MEMBER_ID) routineActions.add(x.approval_id)
          if (!asked.has(x.approval_id)) asked.set(x.approval_id, { operation: 'slack.channel.post', args: { text: call.args.text } })
          if (x.created && x.status === 'approved') {
            const row = (await rowOf(x.approval_id))!
            approvals.set(x.approval_id, { rev: row.approved_rev ?? -1, by: 'grant', era })
          }
          if (replay && x.created) problems.push('a replayed notice made a new action')
        }
        if (!replay) lastNotice.notice = fresh1
        break
      }
      case 'alerts': {
        // An admin (or a member, whose save makes no grant) moves the alerts mark on or off the channel, if it's listed.
        const current = await channels.list()
        if (!current.channels.some(c => c.channelId === CHANNEL_ID)) break
        const actorId = s.by === 'inhouse' ? INHOUSE : PEOPLE[s.by]
        const who1 = await memberOf(actorId)
        const movesOn = s.marked && !brand.marked
        const mayGrant = movesOn && who1?.kind === 'person' && who1.status === 'active' && who1.role === 'admin' && brand.listed && brand.ceilingOn && brand.slackConnected
        await channels.save({ channels: current.channels.map(c => ({ channelId: c.channelId, name: c.name })), alertsChannelId: s.marked ? CHANNEL_ID : null, ifRev: current.rev }, { ...at(), actorId })
        if (!s.marked && brand.marked) brandEnds()
        brand.marked = s.marked
        if (mayGrant) {
          // The id is D1's (the store mints it); whether a grant may exist at all is the record's.
          const g = await db.prepare("SELECT id FROM permission_grants WHERE holder = 'brand' AND revoked_at_ms IS NULL").first<string>('id')
          brand.allowed = g !== null
          brand.grantId = g
        }
        break
      }
      case 'restore':
        await restoreHold(s.gap)
        break
      case 'confirm': {
        // The admin's confirm of the last restore releases its hold (the gate's next sync seats it at the object's generation).
        const rid = restoresMade.at(-1)
        if (!rid) break
        await runBatch(db, [
          auditInsert({ atMs: now, actorId: 'm_ws_d', args: { action: 'restore.confirmed', restoreId: rid, backupId: rid, approvedBy: 'm_ws_d' }, target: null, requestId: fresh('confirm') }, null),
          ...releaseHoldStmts({ restoreId: rid, nowMs: now }),
        ])
        break
      }
    }
  }
  for (const release of hub.hung.splice(0)) release()
  await Promise.all(late.splice(0))
  // A late answer whose dispatcher crashed after the timeout has no `late` promise to wait on: its release runs on the
  // promise chain the dispatcher attached at the call. One macrotask turn lets every such chain finish.
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })

  // ---------- the oracle, from the upstreams' logs ----------
  // W7: every answer the binding gave was released (a late one once it arrived).
  if (hub.released !== hub.given) problems.push(`W7: ${hub.given - hub.released} of the binding's ${hub.given} answers were never released`)
  // W1: every upstream write happened inside a hub call.
  const logged = hub.shop.writes.length + hub.slackPosts.length
  if (logged !== hub.attributed) problems.push(`W1: ${logged - hub.attributed} upstream writes outside any hub call`)
  const claimOf = (c: Call) => claims.get(c.n === null ? `${c.actionId}#${c.attempt}` : `${c.actionId}:${c.n}#${c.attempt}`)
  const keyOf = (c: Call) => claimOf(c)?.sendKey ?? (c.n === null ? c.actionId : `${c.actionId}:${c.n}`)
  const wentOut = (c: Call) => c.writes.some(v => v === 'ran' || v === 'unclear')
  const perKey = new Map<string, Call[]>()
  for (const c of calls) perKey.set(keyOf(c), [...(perKey.get(keyOf(c)) ?? []), c])
  for (const [key, cs] of perKey) {
    const out = cs.flatMap(c => c.writes).filter(v => v === 'ran' || v === 'unclear').length
    if (out > 1) problems.push(`W1: ${out} writes that went out for one send (${key})`)
    // Every call but the last was throttled with nothing run: only a throttled item is tried again.
    for (const c of cs.slice(0, -1)) {
      if (c.answer !== 'throttled' || c.writes.some(v => v !== 'throttled')) problems.push(`W1: ${cs.length} hub calls for one send, an earlier one not throttled (${key})`)
    }
  }
  // W2, W3 and W9 for every call (an effect needs one; a call that the hub refused must still have come from a sound claim).
  for (const c of calls) {
    const claim = claimOf(c)
    const where = `${c.actionId}${c.n === null ? '' : `:${c.n}`}${wentOut(c) ? ', with an effect' : ''}`
    for (const f of claim?.faults ?? ['no winning claim']) problems.push(`W2: a call whose claim had ${f} (${where})`)
    for (const f of c.permit) problems.push(`W3: a call where ${f} (${where})`)
    const want = asked.get(keyOf(c))
    if (!want) problems.push(`W9: a call for something the test never asked for (${where})`)
    else if (c.operation !== want.operation) problems.push(`W9: a call of ${c.operation} for a request of ${want.operation} (${where})`)
    else if (c.operation === 'slack.channel.post') {
      const a = c.args as { channelId?: unknown; text?: unknown }
      if (a.channelId !== CHANNEL_ID || a.text !== want.args.text) problems.push(`W9: a post other than the one asked for (${where})`)
    } else if (canon(c.args) !== canon(want.args)) problems.push(`W9: a call whose arguments are not the ones asked for (${where})`)
    if (want) {
      for (const sentOne of c.sent) {
        const differs = storeDiffers(sentOne, want, `${c.actionId}:${c.n ?? 1}`)
        if (differs !== null) problems.push(`W9: the store received other than what was asked: ${differs} (${where})`)
      }
    }
  }
  for (const [key, cs] of perKey) {
    if (!cs.some(wentOut)) continue
    const id = cs[0]!.actionId
    const row = await rowOf(id)
    if ((row?.origin === 'routine' || routineActions.has(id)) && approvals.get(id)?.by === 'grant') problems.push(`W4: a routine's effect with no person's approval (${key})`)
  }
  // W6 (#439 P9): a grant-backed send whose write went out keeps its units unless a person said it didn't go out; the
  // units still held, per grant and day, stay inside the largest daily limit any of their claims saw.
  const perGrantDay = new Map<string, { units: number; limit: number }>()
  for (const [key, cs] of perKey) {
    if (!cs.some(wentOut)) continue
    const claim = cs.map(claimOf).find(x => x !== undefined)
    if (!claim || claim.grantId === null) continue
    const use = await db.prepare('SELECT * FROM permission_uses WHERE id = ?').bind(claim.useId).first<UseRow>()
    if (!use) {
      problems.push(`W6: a grant-backed effect with no use (${key})`)
      continue
    }
    const itemBack = claim.releaseId === null ? null : await db.prepare('SELECT id FROM permission_item_releases WHERE id = ?').bind(claim.releaseId).first()
    if (use.released_at_ms !== null || itemBack) {
      if (!resolvedFailed.has(key)) {
        const row = await rowOf(cs[0]!.actionId)
        problems.push(`W6: units given back for a write that went out, with no person saying it didn't (${key}, the action ${row?.state ?? 'gone'})`)
      }
      continue
    }
    const k = `${use.grant_id}|${use.day}`
    const was = perGrantDay.get(k) ?? { units: 0, limit: 0 }
    const next = { units: was.units + claim.units, limit: Math.max(was.limit, claim.limit ?? 0) }
    perGrantDay.set(k, next)
    if (next.units > next.limit) problems.push(`W6: a grant's effects passed its day (${k}: ${next.units} over ${next.limit})`)
  }
  const effects = hub.shop.writes.length + hub.slackPosts.length
  if (!o.ceiling) {
    if (effects > 0) problems.push('W5: an effect with no ceiling row')
    if (admitted > 0) problems.push('W5: a request admitted with no ceiling row')
  }
  const itemEffects = calls.filter(c => c.n !== null).reduce((a, c) => a + c.writes.length, 0)
  const m3Effects = calls.filter(c => c.operation !== 'shopify.order.tag_add' && c.operation !== 'slack.channel.post').reduce((a, c) => a + c.writes.length, 0)
  paths.grantItemCalls = calls.filter(c => c.n !== null && (claimOf(c)?.grantId ?? null) !== null).length
  return { effects, admitted, itemEffects, m3Effects, paths, problems }
}

/** The world's daily maximum for Shopify tags: tight in a third of the runs each, so a grant's day fills. */
const PER_DAY_MAX = fc.constantFrom(1, 2, 50)
// Floors on what the suites send, about half the lowest count seen over repeated runs: a run that sends little proves
// little, and a floor near the usual count would flake. Seen on 2026-11-26: the main suite sent 139 to 164
// effects over 400 runs (5 runs of it; a reviewer's run saw 138), the send path 322 to 431 over 300 runs (11 runs of it).
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

  it("M2-N: a notice to the alerts channel goes out once under the brand's grant; without the mark it waits for its card", async () => {
    const granted = await runSequence([
      { k: 'alerts', marked: true, by: 2 },
      { k: 'notice', who: 0, origin: 'chat', replay: 'none' },
      { k: 'notice', who: 0, origin: 'chat', replay: 'same' },
      { k: 'tick', ms: 11_000, alarm: { crash: null, flipAt: 0, latePermit: false, binding: 'ok' } },
    ], { ceiling: true })
    expect(granted.problems).toEqual([])
    expect([granted.admitted, granted.effects]).toEqual([2, 1])
    const carded = await runSequence([
      { k: 'notice', who: 0, origin: 'chat', replay: 'none' },
      { k: 'tick', ms: 11_000, alarm: { crash: null, flipAt: 0, latePermit: false, binding: 'ok' } },
    ], { ceiling: true })
    expect([carded.problems, carded.effects]).toEqual([[], 0])
    const answered = await runSequence([
      { k: 'notice', who: 0, origin: 'chat', replay: 'none' },
      { k: 'answer', i: 0, by: 'own', choice: 'once', stale: false, twice: false },
      { k: 'tick', ms: 11_000, alarm: { crash: null, flipAt: 0, latePermit: false, binding: 'ok' } },
    ], { ceiling: true })
    expect([answered.problems, answered.effects]).toEqual([[], 1])
    // A member's mark gives no grant, and a routine never runs under the brand's: neither goes out without a card. (The
    // admin unmarks first: a save that doesn't move the mark gives no grant.)
    const noGrant = await runSequence([
      { k: 'alerts', marked: true, by: 0 },
      { k: 'notice', who: 0, origin: 'chat', replay: 'none' },
      { k: 'alerts', marked: false, by: 2 },
      { k: 'alerts', marked: true, by: 2 },
      { k: 'notice', who: 1, origin: 'routine', replay: 'none' },
      { k: 'tick', ms: 11_000, alarm: { crash: null, flipAt: 0, latePermit: false, binding: 'ok' } },
    ], { ceiling: true })
    expect([noGrant.problems, noGrant.admitted, noGrant.effects]).toEqual([[], 2, 0])
    // The mark taken back takes the grant with it; the Inhouse team's mark gives none. Neither notice goes out on its own.
    const takenBack = await runSequence([
      { k: 'alerts', marked: true, by: 2 },
      { k: 'alerts', marked: false, by: 2 },
      { k: 'notice', who: 0, origin: 'chat', replay: 'none' },
      { k: 'alerts', marked: true, by: 'inhouse' },
      { k: 'notice', who: 2, origin: 'chat', replay: 'none' },
      { k: 'tick', ms: 11_000, alarm: { crash: null, flipAt: 0, latePermit: false, binding: 'ok' } },
    ], { ceiling: true })
    expect([takenBack.problems, takenBack.admitted, takenBack.effects]).toEqual([[], 2, 0])
  })

  it('holds W1 to W7 over random sequences of every kind of step', async () => {
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

  it('holds W1 to W7 on the send path: a crash at each boundary, the sweep, every fault, late results and checks', async () => {
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
    const sendPath = stepArb.filter(s => ['tick', 'dispatch', 'sweep', 'flip', 'late', 'resolve', 'fault', 'undo', 'revoke', 'account', 'ceiling', 'channel', 'alerts'].includes(s.k))
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

// ---------- Stage 1 M3-W: the same gate across every M3 path ----------

const SEND: SendOpts = { crash: null, flipAt: 0, latePermit: false, binding: 'ok' }
const askFor = (who1: Who, o: Op, size: Size = 'one'): Step => ({ k: 'request', who: who1, origin: 'chat', op: o, mode: 'tool', replay: 'none', size })
const answer = (by1: Target, choice: Extract<Step, { k: 'answer' }>['choice'], cut = 0): Step => ({ k: 'answer', i: 0, by: by1, choice, stale: false, twice: false, cut })
/** "Always allow" on a first card of the operation, so later calls run under the member's grant. */
const allow = (who1: Who, o: Op): Step[] => [askFor(who1, o), answer('own', 'fit_always')]
// Floors on what the M3 suites send, about half the lowest count seen over repeated runs (see the M2 floors above). Seen
// on 2026-11-27 over 3 runs each: the main M3 suite sent 861 to 941 writes over 300 runs, 329 to 340 of them batch items
// and 373 to 423 of the M3 write set's operations; the M3 send path 1471 to 1565 writes, 1067 to 1126 of them items.
const M3_FLOOR = { effects: 400, items: 150, m3: 180 }

/** #597: the rare paths a suite reached, summed over its runs, and logged so a review can read the counts. */
type Paths = Outcome['paths']
const addPaths = (to: Paths, from: Paths) => { for (const k of Object.keys(to) as (keyof Paths)[]) to[k] += from[k] }
const noPaths = (): Paths => ({ grantItemCalls: 0, restoreInItemCall: 0, crashBeforeItemResult: 0 })
const M3_SEND_FLOOR = { effects: 700, items: 500 }
/** #597: the rare-path suite's floors (about half the lowest seen; see its log line). */
const RARE_FLOOR = { grantItemCalls: 1, restoreInItemCall: 1, crashBeforeItemResult: 1 }

describe('the write-safety gate (M3-W): every operation, batches, admin cards, limits, item crashes, throttles and restores', () => {
  beforeAll(async () => {
    hubCode = await loadHub()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterAll(() => vi.restoreAllMocks())

  it('a member\'s refund is an admins card: a member\'s answer loses, an admin\'s goes out once, after its hold', async () => {
    const out = await runSequence([
      askFor(0, 'refund'),
      answer(1, 'approve'),
      answer(0, 'approve'),
      answer('own', 'approve'),
      { k: 'tick', ms: 11_000, alarm: SEND },
    ], { ceiling: true, m3: true })
    expect(out.problems).toEqual([])
    expect([out.admitted, out.effects]).toEqual([1, 1])
  })

  it('one call over the bulk threshold is one exact card; approved below its tip, only the items it covered go out', async () => {
    // Five or six orders (`many`): the card is approved for one less than it holds; the last moves to a new card.
    const out = await runSequence([
      askFor(0, 'shop', 'many'),
      answer('own', 'approve', 1),
      { k: 'tick', ms: 11_000, alarm: SEND },
      { k: 'tick', ms: 2_000, alarm: SEND },
    ], { ceiling: true, m3: true })
    expect(out.problems).toEqual([])
    const [batch] = (await db.prepare("SELECT * FROM outbox_actions WHERE kind = 'batch' ORDER BY created_at_ms LIMIT 1").all<OutboxActionRow>()).results
    expect(batch?.approved_upto).toBe((batch?.items_n ?? 0))
    expect(out.itemEffects).toBe(batch?.approved_upto)
    const remainder = await db.prepare("SELECT items_n, state FROM outbox_actions WHERE kind = 'batch' AND state = 'waiting'").first<{ items_n: number }>()
    expect(remainder?.items_n).toBe(1)
  })

  it('N32: a grant-backed batch revoked during its hold sends nothing', async () => {
    const out = await runSequence([
      ...allow(0, 'shop'),
      { k: 'tick', ms: 11_000, alarm: SEND },
      askFor(0, 'shop', 'few'),
      { k: 'revoke', i: 0, by: 'holder' },
      { k: 'tick', ms: 11_000, alarm: SEND },
    ], { ceiling: true, m3: true })
    expect(out.problems).toEqual([])
    expect(out.itemEffects).toBe(0)
  })

  it('N32: an exact batch paused between items 10 and 11: items 1 to 10 are called once, the other two move to a new card for a new OK', async () => {
    const out = await runSequence([
      { k: 'ceiling', op: 'shop', enabled: true, perDayMax: 50, unitsMax: 100, bulkThreshold: 3, batchMax: 500 },
      askFor(0, 'shop', 'dozen'),
      answer('own', 'approve'),
      // A fast Pause and Resume inside item 10's call: that call can't be recalled; item 11's claim is refused.
      { k: 'tick', ms: 11_000, alarm: { ...SEND, inCall: 'flip', inCallAt: 10 } },
      { k: 'tick', ms: 2_000, alarm: SEND },
    ], { ceiling: true, m3: true })
    expect(out.problems).toEqual([])
    expect(out.itemEffects).toBe(10)
    const rows = (await db.prepare("SELECT * FROM outbox_actions WHERE kind = 'batch' ORDER BY created_at_ms, id").all<OutboxActionRow>()).results
    expect(rows.map(r => [r.state, r.items_n])).toEqual([['sent', 10], ['waiting', 2]])
    // Orders past the fake store's three are refused by it (nothing changed): 3 of the 10 calls went out.
    expect(JSON.parse(rows[0]!.result_json ?? '{}')).toEqual({ ref: '3 of 12 went out; the other 2 moved to a new card for a new OK' })
    expect((await itemsOf(rows[1]!.id)).map(i => [i.n, i.moved_from, JSON.parse(i.args_json)])).toEqual([
      [1, rows[0]!.id, { orderIds: ['gid://shopify/Order/9020'], tags: [expect.any(String)] }],
      [2, rows[0]!.id, { orderIds: ['gid://shopify/Order/9021'], tags: [expect.any(String)] }],
    ])
  })

  it('pinned (the gate\'s own first counterexamples): a replay of a refused call with other arguments makes its own card, and a replay of that is that card', async () => {
    // A refund past the ceiling's largest is refused; the same invocation again with an amount within it is a new call
    // (nothing was made the first time); again with those arguments, it is that card.
    const out = await runSequence([
      askFor(2, 'refund', 'huge'),
      { k: 'request', who: 2, origin: 'chat', op: 'refund', mode: 'tool', replay: 'other', size: 'one' },
      { k: 'request', who: 2, origin: 'chat', op: 'refund', mode: 'tool', replay: 'other', size: 'one' },
    ], { ceiling: true, m3: true })
    expect(out.problems).toEqual([])
    expect(out.admitted).toBe(2)
  })

  it('a crash after an item\'s call, before its result is stored: the sweep makes it a check, and nothing sends it again', async () => {
    const out = await runSequence([
      askFor(0, 'shop', 'many'),
      answer('own', 'approve'),
      { k: 'tick', ms: 11_000, alarm: { ...SEND, crashOnResult: true } },
      { k: 'tick', ms: 61_000, alarm: false },
      { k: 'sweep', passes: 2 },
      { k: 'tick', ms: 2_000, alarm: SEND },
      { k: 'tick', ms: 2_000, alarm: SEND },
    ], { ceiling: true, m3: true })
    expect(out.problems).toEqual([])
    const [batch] = (await db.prepare("SELECT * FROM outbox_actions WHERE kind = 'batch'").all<OutboxActionRow>()).results
    const items = await itemsOf(batch!.id)
    expect(items[0]?.state).toBe('needs_check')
    expect(items.slice(1).every(i => i.state === 'sent' || i.state === 'failed')).toBe(true)
    expect(out.itemEffects).toBe(items.length)
  })

  it('past a grant\'s day, calls collect into one card; a person approves it and each item goes out once', async () => {
    const out = await runSequence([
      ...allow(0, 'restock'),
      { k: 'tick', ms: 11_000, alarm: SEND },
      askFor(0, 'restock', 'large'),
      askFor(0, 'restock', 'large'),
      { k: 'burst', who: 0, op: 'restock', n: 1 },
      { k: 'drive', i: 0, cut: 0, alarms: 2 },
    ], { ceiling: true, m3: true })
    expect(out.problems).toEqual([])
    expect(out.itemEffects).toBeGreaterThan(0)
  })

  it('holds W1 to W9 over random sequences of every M3 step', async () => {
    const totals = { effects: 0, items: 0, m3: 0 }
    const reached = noPaths()
    const runs = 300
    // Most runs start with "Always allow" for the first member's tags and stock, so runs under a grant, a grant's largest
    // call and its day are common; a third of the worlds cap the tags at 1 or 2 a day.
    const seeds: Step[][] = [[], [...allow(0, 'shop')], [...allow(0, 'shop'), ...allow(0, 'restock')], [...allow(0, 'restock'), ...allow(2, 'draft'), askFor(0, 'shop', 'many')]]
    await fc.assert(fc.asyncProperty(fc.constantFrom(0, 1, 2, 2, 3), PER_DAY_MAX, fc.array(m3StepArb, { minLength: 30, maxLength: 80 }), async (seed, perDayMax, steps) => {
      const out = await runSequence([...seeds[seed]!, ...steps], { ceiling: true, perDayMax, m3: true })
      totals.effects += out.effects
      totals.items += out.itemEffects
      totals.m3 += out.m3Effects
      addPaths(reached, out.paths)
      expect(out.problems).toEqual([])
    }), { numRuns: runs })
    console.info(`M3-W main: ${JSON.stringify({ ...totals, ...reached })} over ${runs} runs`)
    expect(totals.effects, `writes over ${runs} runs: ${JSON.stringify(totals)}`).toBeGreaterThan(M3_FLOOR.effects)
    expect(totals.items, `item writes over ${runs} runs: ${JSON.stringify(totals)}`).toBeGreaterThan(M3_FLOOR.items)
    expect(totals.m3, `M3 operations' writes over ${runs} runs: ${JSON.stringify(totals)}`).toBeGreaterThan(M3_FLOOR.m3)
  }, 600_000)

  it('holds W1 to W9 on the batch send path: item crashes, throttles, restores, rules changing mid-batch, every fault', async () => {
    // A prefix that leaves batches behind: a grant-backed batch approved at its request, an exact bulk card approved below
    // its tip (its last item on a new card), five waiting restock cards and a sixth collected, approved in full, and a
    // member's refund approved by an admin.
    const prefix: Step[] = [
      ...allow(0, 'shop'),
      askFor(0, 'shop', 'few'),
      askFor(0, 'shop', 'many'),
      { k: 'answer', i: 0, by: 'own', choice: 'approve', stale: false, twice: false, cut: 1 },
      ...Array.from({ length: 6 }, (): Step => askFor(1, 'restock')),
      { k: 'drive', i: 0, cut: 0, alarms: 0 },
      // The member's refund, approved by an admin: the card the request just made (High 3 of the first review: `aim` found
      // another member's card here, so the admin's answer lost and the refund was rarely approved).
      askFor(0, 'refund'),
      { ...answer(2, 'approve'), newest: true } as Step,
    ]
    const sendPath = m3StepArb.filter(s => ['tick', 'dispatch', 'sweep', 'flip', 'late', 'resolve', 'fault', 'undo', 'revoke', 'role', 'account', 'ceiling', 'restore', 'confirm', 'drive', 'answer'].includes(s.k))
    const totals = { effects: 0, items: 0 }
    const reached = noPaths()
    await fc.assert(fc.asyncProperty(PER_DAY_MAX, fc.array(sendPath, { minLength: 5, maxLength: 30 }), async (perDayMax, tail) => {
      const out = await runSequence([...prefix, ...tail], { ceiling: true, perDayMax, m3: true })
      totals.effects += out.effects
      totals.items += out.itemEffects
      addPaths(reached, out.paths)
      expect(out.problems).toEqual([])
    }), { numRuns: 300 })
    console.info(`M3-W send path: ${JSON.stringify({ ...totals, ...reached })} over 300 runs`)
    expect(totals.effects, `writes over 300 runs: ${JSON.stringify(totals)}`).toBeGreaterThan(M3_SEND_FLOOR.effects)
    expect(totals.items, `item writes over 300 runs: ${JSON.stringify(totals)}`).toBeGreaterThan(M3_SEND_FLOOR.items)
  }, 600_000)

  it('#597: the rare paths: items sent under a grant, a restore while an item is out, a crash before an item\'s result is stored', async () => {
    // A grant-backed batch approved at its request and an exact bulk card approved in full, both due; then only the steps
    // around their sends, with a crash before a stored result and a restore inside a call drawn often.
    const prefix: Step[] = [
      ...allow(0, 'shop'),
      { k: 'tick', ms: 11_000, alarm: SEND },
      askFor(0, 'shop', 'few'),
      askFor(0, 'shop', 'many'),
      { ...answer('own', 'approve'), newest: true } as Step,
      { k: 'tick', ms: 11_000, alarm: false },
    ]
    const rareSend: fc.Arbitrary<SendOpts> = fc.record({
      crash: fc.constant(null), flipAt: fc.constant(0), latePermit: fc.constant(false), binding: fc.constantFrom<BindingFault>('ok', 'ok', 'ok', 'hang'),
      inCall: fc.constantFrom<Disturb>('none', 'restore', 'restore', 'revoke', 'flip'), inCallAt: fc.integer({ min: 1, max: 4 }), crashOnResult: fc.constantFrom(false, true, true),
    })
    const rare: fc.Arbitrary<Step> = fc.oneof(
      W(5, fc.record({ k: fc.constant('tick' as const), ms: fc.constantFrom(0, 1_500, 61_000), alarm: rareSend })),
      W(3, fc.tuple(fc.record({ k: fc.constant('dispatch' as const), i: idx }), rareSend).map(([a, b]) => ({ ...a, ...b }))),
      W(2, fc.record({ k: fc.constant('sweep' as const), passes: fc.constantFrom<1 | 2>(1, 2) })),
      W(2, fc.record({ k: fc.constant('resolve' as const), i: idx, by: target, outcome: fc.constantFrom('sent' as const, 'failed' as const) })),
      W(1, fc.constant({ k: 'confirm' as const })),
      W(1, fc.record({ k: fc.constant('flip' as const), hookFails: fc.boolean(), pulse: fc.constantFrom(true, false) })),
      W(1, fc.constant({ k: 'late' as const })),
      W(1, fc.record({ k: fc.constant('fault' as const), target: fc.constant<Op>('shop'), shop: fc.constantFrom<WriteFault>('succeed', 'succeed', 'refuse', 'timeout', 'throttle'), slack: fc.constant<SlackFault>('succeed') })),
    )
    const reached = noPaths()
    let effects = 0
    await fc.assert(fc.asyncProperty(fc.array(rare, { minLength: 3, maxLength: 15 }), async tail => {
      const out = await runSequence([...prefix, ...tail], { ceiling: true, m3: true })
      effects += out.effects
      addPaths(reached, out.paths)
      expect(out.problems).toEqual([])
    }), { numRuns: 150 })
    console.info(`M3-W rare paths: ${JSON.stringify({ effects, ...reached })} over 150 runs`)
    expect(reached.grantItemCalls, JSON.stringify(reached)).toBeGreaterThan(RARE_FLOOR.grantItemCalls)
    expect(reached.restoreInItemCall, JSON.stringify(reached)).toBeGreaterThan(RARE_FLOOR.restoreInItemCall)
    expect(reached.crashBeforeItemResult, JSON.stringify(reached)).toBeGreaterThan(RARE_FLOOR.crashBeforeItemResult)
  }, 600_000)

  it('"Always allow" never covers a call over the bulk threshold: four orders are one exact card, nothing goes out under the grant', async () => {
    const out = await runSequence([
      ...allow(0, 'shop'),
      { k: 'tick', ms: 11_000, alarm: SEND },
      askFor(0, 'shop', 'four'),
      { k: 'tick', ms: 11_000, alarm: SEND },
      { k: 'tick', ms: 2_000, alarm: SEND },
    ], { ceiling: true, m3: true })
    expect(out.problems).toEqual([])
    expect(out.itemEffects).toBe(0)
    const card = await db.prepare("SELECT state, verdict, guardrail, grant_id FROM outbox_actions WHERE kind = 'batch'").first()
    expect(card).toEqual({ state: 'waiting', verdict: 'exact', guardrail: 'bulk', grant_id: null })
  })

  it('a batch is never claimed inside its hold, nor on an approval over 10 minutes old', async () => {
    const out = await runSequence([
      ...allow(0, 'shop'),
      { k: 'tick', ms: 11_000, alarm: SEND },
      askFor(0, 'shop', 'few'),
      // Its task run at once, inside the hold; then again once its approval is past 10 minutes old.
      { k: 'dispatch', i: 0, ...SEND },
      { k: 'tick', ms: timing().approvalMaxAgeMs + 30_000, alarm: false },
      { k: 'dispatch', i: 0, ...SEND },
    ], { ceiling: true, m3: true })
    expect(out.problems).toEqual([])
    expect(out.itemEffects).toBe(0)
  })

  it('#586: only the card\'s approver or an admin may say a check didn\'t go out', async () => {
    // A member's refund approved by an admin, made unclear by the store's timeout; the member who asked can't resolve it.
    const out = await runSequence([
      askFor(0, 'refund'),
      { ...answer(2, 'approve'), newest: true } as Step,
      { k: 'fault', target: 'refund', shop: 'timeout', slack: 'succeed' },
      { k: 'tick', ms: 11_000, alarm: SEND },
      { k: 'resolve', i: 0, by: 0, outcome: 'failed' },
    ], { ceiling: true, m3: true })
    expect(out.problems).toEqual([])
    const card = await db.prepare("SELECT state FROM outbox_actions WHERE operation = 'shopify.refund.create'").first<string>('state')
    expect(card).toBe('needs_check')
  })

  it('#596: a refund whose amount Shopify would now suggest differently is never sent (the store receives only what was approved)', async () => {
    // Order 9001's line at $5.00, asked as $6.00: the hub's lookup finds the suggestion isn't the approved amount.
    const out = await runSequence([
      askFor(2, 'refund', 'bad'),
      { ...answer('own', 'approve'), newest: true } as Step,
      { k: 'tick', ms: 11_000, alarm: SEND },
    ], { ceiling: true, m3: true })
    expect(out.problems).toEqual([])
    expect(out.effects).toBe(0)
    const card = await db.prepare("SELECT state, error_code FROM outbox_actions WHERE operation = 'shopify.refund.create'").first<{ state: string; error_code: string }>()
    expect(card).toEqual({ state: 'failed', error_code: 'upstream_rejected' })
  })

  it('High 3: an admin who approved a member\'s refund, demoted during its hold: the refund doesn\'t go, and it waits for an admin again', async () => {
    const out = await runSequence([
      askFor(0, 'refund'),
      { ...answer(2, 'approve'), newest: true } as Step,
      { k: 'role', who: 2, to: 'member' },
      { k: 'tick', ms: 11_000, alarm: SEND },
      { k: 'tick', ms: 2_000, alarm: SEND },
    ], { ceiling: true, m3: true })
    expect(out.problems).toEqual([])
    expect(out.effects).toBe(0)
    const card = await db.prepare("SELECT state, approver_kind FROM outbox_actions WHERE operation = 'shopify.refund.create'").first<{ state: string; approver_kind: string }>()
    expect(card).toEqual({ state: 'waiting', approver_kind: 'admins' })
  })

  it('the product\'s state (no ceiling row): no M3 request is admitted and nothing reaches an upstream', async () => {
    const noCeiling = m3StepArb.filter(s => s.k !== 'ceiling')
    await fc.assert(fc.asyncProperty(fc.array(noCeiling, { minLength: 10, maxLength: 40 }), async steps => {
      const out = await runSequence(steps, { ceiling: false, m3: true })
      expect(out.problems).toEqual([])
      expect([out.effects, out.admitted]).toEqual([0, 0])
    }), { numRuns: 20 })
  }, 120_000)
})
