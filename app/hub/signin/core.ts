// The SignIn state machine over an injected store, clock, alarm and upstream, so the Node project tests all of it.
// signin.ts is a thin wrapper over ctx.storage.kv, ctx.storage.setAlarm and Date.now().
//
// Rules this file keeps (brief section 5; Durable Objects rules, read 2026-11-20):
// - One record under one key, written whole by one put, so it's never half written.
// - Every write after an await re-reads the record and writes only if `generation` is unchanged and the state isn't
//   `disconnected`. Re-encryption also requires the envelope it opened to be the one still stored. A refresh racing a
//   disconnect can't bring a token back.
// - Single flight: every path that needs a grant awaits one in-memory promise. It carries no token, only the outcome.
// - No plaintext token, client secret or upstream body is stored, logged or returned. A token lives in locals only.
//
// P5 (p5-w1) adds the `oauth_mcp` path beside H0's, additively: the path is picked by the account's connector kind (the
// stored record's `kind`, else the registry's `kindFor`), never by whether a provider happens to be configured. H0's
// Shopify path, its records and `#stillCurrent` are unchanged. OAuth records are v2 (every field written); a v1 record
// reads with the v2 defaults (`normalize`). `connectEpoch` guards only the connect callback's write (`#connectCurrent`).
import type { AccountStatus, HubErrorCode, HubResult, Instant, SignInState } from '../index/contract'
import type { McpClientConfig, McpConnectorModule, McpToolResult } from '../registry/registry'
import { MCP_SCOPE, requestedScopes, sameScopeSet, type Readiness } from '../registry/registry'
import { callMcpTool, type McpSession } from '../connectors/mcp/client'
import { constantTimeEqual } from '../oauth/http'
import {
  authorizeUrl,
  challengeFor,
  defaultRandom,
  discover,
  exchangeCode,
  newState,
  newVerifier,
  pinnedEndpoints,
  refreshTokens,
  register,
  revokeToken,
  stateAccount,
  STATE_TTL_MS,
  type ClientCreds,
  type Endpoints,
  type Random,
  type TokenFail,
} from '../oauth/protocol'
import { err, ok } from '../index/errors'
import { log } from '../index/log'
import { open, sameEnvelope, seal, type Envelope, type EnvelopeField } from '../crypto/envelope'
import type { KeyRing, KeyRingResult } from '../crypto/keyring'
import { checkGrantedScopes, describeScopeMismatch } from '../scope/scopes'
import { checkReadDocument } from '../scope/graphql'
import { checkShopifyFields, FIELD_NOT_ALLOWED } from '../scope/fields'
import { checkVariables } from '../scope/variables'
import { API_VERSION, requestGrant, sendRead, type ShopifyConfig, type Upstream } from './providers/shopify'
// P5 (p5-w4)
import { callWeb, LIST_LIMIT, parseChannel, POSTABLE_CHANNEL, refusalFor, type WebOutcome } from '../connectors/slack/web'
import type { SlackChannel, SlackPostRequest } from '../connectors/slack/contract'
import { boundNotice, composeSlack, isAppOrigin } from '../../shared/notify/bound'
import { linkPath } from '../../shared/notify/links'

export type SignInRecord = {
  /** 1: H0's shape (client credentials). 2: P5's OAuth records, every field below written. */
  v: 1 | 2
  accountId: string
  state: SignInState
  generation: number
  token: Envelope | null
  refresh: Envelope | null // P5's rotating providers; null for client credentials
  obtainedAtMs: number | null
  expiresAtMs: number | null
  scopes: string[]
  failures: number
  lastError: { code: HubErrorCode; atMs: number } | null
  // ---- P5 (p5-w1). Optional: a v1 record reads with the defaults in `normalize`. ----
  kind?: 'client_credentials' | 'oauth_mcp'
  paused?: boolean
  /** Bumped only by disconnect and by a successful completeConnect. */
  connectEpoch?: number
  connectedBy?: string | null
  connectedAtMs?: number | null
  /** Slack's team id at connect. */
  workspace?: string | null
  /** A dynamic client's registration (ClientCreds as JSON), sealed under field `client`. */
  client?: Envelope | null
  /** A dynamic connector's discovered endpoints, validated against its allowed hosts. */
  endpoints?: Endpoints | null
  revokeFailedAtMs?: number | null
  /** A refresh answer was lost: the next try is the last one with this refresh token. */
  refreshUnclear?: boolean
  /** A refresh answered Retry-After: no refresh before this time (with H0's backoff, whichever is later). */
  retryAtMs?: number | null
}

/** A v1 or v2 record with every v2 field present (the v1 defaults filled in). */
export type SignInRecordV2 = Required<SignInRecord>

export function normalize(r: SignInRecord): SignInRecordV2 {
  return {
    kind: 'client_credentials',
    paused: false,
    connectEpoch: 0,
    connectedBy: null,
    connectedAtMs: null,
    workspace: null,
    client: null,
    endpoints: null,
    revokeFailedAtMs: null,
    refreshUnclear: false,
    retryAtMs: null,
    ...r,
  }
}

/** The synchronous subset of ctx.storage the core uses. */
export type SyncStore = {
  get<T>(key: string): T | undefined
  put<T>(key: string, value: T): void
  delete(key: string): boolean
  list<T>(prefix: string): Iterable<[string, T]>
  transactionSync<T>(fn: () => T): T
}

/** ctx.storage.setAlarm / deleteAlarm. The core awaits both, so a failure is seen, logged and recorded. */
export type AlarmControl = {
  set(atMs: number): Promise<void>
  delete(): Promise<void>
  /** ctx.storage.getAlarm (P5 W1's `#ensureAlarmBy`). Without it, `#ensureAlarmBy` sets the alarm unconditionally. */
  get?(): Promise<number | null>
}

/** An OAuth account's provider (P5 W1): its connector module and this deployment's client settings. */
export type McpProvider = { kind: 'oauth_mcp'; connector: McpConnectorModule; clientConfig: McpClientConfig }

export type ConnectorScopes = { read: readonly string[]; required: readonly string[] }

export type SignInDeps = {
  store: SyncStore
  now: () => number
  alarm: AlarmControl
  upstream: () => Promise<Upstream>
  keyring: () => Promise<KeyRingResult>
  shopify: () => ShopifyConfig | null
  /** The connector's scope lists for an account, from the registry. Null: no connector names this account. */
  scopesFor: (accountId: string) => Promise<ConnectorScopes | null>
  // ---- P5 (p5-w1), optional so H0's test kits compile unchanged ----
  /** The OAuth provider for an account; null when the account isn't oauth_mcp or isn't configured. */
  provider?: (accountId: string) => Promise<McpProvider | null>
  /** The connector kind behind an account, from the registry. Absent: every account is client credentials (H0). */
  kindFor?: (accountId: string) => Promise<'client_credentials' | 'oauth_mcp' | null>
  random?: Random
  // ---- P5 (p5-w4) ----
  /** The hub var `APP_ORIGIN` (the brand's product origin, from the ops repo); never from a request. */
  appOrigin?: () => unknown
}

/** A pending connect (the `state`'s item). The verifier is sealed under field `pkce`. */
export type ConnectItem = {
  v: 1
  accountId: string
  memberId: string
  pkce: Envelope
  scopes: string[]
  redirectUri: string
  resource: string
  epochAtStart: number
  startedAtMs: number
}

export type McpCallRequest = { accountId: string; upstream: string; args: Record<string, unknown> }

/** H0's status fields; the stub's `status` returns the full AccountStatus through `accountStatus`. */
export type CoreStatus = Omit<AccountStatus, 'paused' | 'kind' | 'connectedBy' | 'connectedAt' | 'revokeFailedAt' | 'needsReconnect'>

export type QueryRequest = {
  accountId: string
  document: string
  variables?: Record<string, unknown>
  apiVersion: string
}

export type GrantOutcome = { ok: true; generation: number } | { ok: false; code: HubErrorCode; detail?: string }

const RECORD = 'record'
const PENDING = 'pending:'
/** W2's code-mode counters; swept by the same alarm (W1 owns the alarm path). */
const COUNTER = 'cm:'
export const EXPIRY_MARGIN_MS = 60_000
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const
export const MAX_PENDING_TTL_MS = 2 * 60 * 60_000
/** W2's counters: the day cap lives until the next UTC midnight, at most a day. */
export const MAX_COUNTER_TTL_MS = 24 * 60 * 60_000
/**
 * After credentials_rejected, reads inside this window answer the stored error without a token call. One minute: the
 * first alarm backoff step, so a fixed secret is picked up within a minute, and a run hammering a dead account costs
 * the provider's token endpoint at most one call a minute instead of one per read.
 */
export const REJECTED_COOLDOWN_MS = 60_000

const instant = (ms: number): Instant => ({ iso: new Date(ms).toISOString(), ms })

export const usable = (r: SignInRecord | undefined, nowMs: number): boolean =>
  !!r && r.state === 'active' && r.token !== null && r.expiresAtMs !== null && nowMs < r.expiresAtMs - EXPIRY_MARGIN_MS

/** Half the token's lifetime after it was obtained (OC 12). */
export const refreshDueAt = (r: SignInRecord): number | null =>
  r.obtainedAtMs !== null && r.expiresAtMs !== null ? r.obtainedAtMs + (r.expiresAtMs - r.obtainedAtMs) / 2 : null

export const backoffFor = (failures: number): number => BACKOFF_MS[Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1]!

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** For an oauth_mcp record: active, a token, the exact-scope rule, and not expiring within the margin. */
export const usableMcp = (r: SignInRecord, nowMs: number, requested: readonly string[]): boolean =>
  r.state === 'active' &&
  r.token !== null &&
  sameScopeSet(r.scopes, requested) &&
  (r.expiresAtMs === null || nowMs < r.expiresAtMs - EXPIRY_MARGIN_MS)

const UPSTREAM_TOOL = /^[a-z][a-z0-9_]{0,63}$/

type Acquired = { ok: true; token: string; generation: number } | { ok: false; code: HubErrorCode; detail?: string }

export class SignInCore {
  readonly #d: SignInDeps
  #inflight: Promise<GrantOutcome> | null = null
  /** The MCP session, in object memory only, keyed by the generation it started under (P5 W1). */
  #session: McpSession | null = null

  constructor(deps: SignInDeps) {
    this.#d = deps
  }

  // ---------- the record ----------

  #read(): SignInRecord | undefined {
    return this.#d.store.get<SignInRecord>(RECORD)
  }

  #write(r: SignInRecord): void {
    this.#d.store.put(RECORD, r)
  }

  #fresh(accountId: string): SignInRecord {
    return {
      v: 1,
      accountId,
      state: 'empty',
      generation: 0,
      token: null,
      refresh: null,
      obtainedAtMs: null,
      expiresAtMs: null,
      scopes: [],
      failures: 0,
      lastError: null,
    }
  }

  /** The record for this account, or a fresh one. Null when the stored record belongs to another account. */
  #recordFor(accountId: string): SignInRecord | null {
    const r = this.#read()
    if (!r) return this.#fresh(accountId)
    if (r.accountId !== accountId) {
      log('hub_internal', { accountId, code: 'account_mismatch' })
      return null
    }
    return r
  }

  /** A fresh OAuth record: v2, every field written. */
  #freshMcp(accountId: string): SignInRecord {
    return { ...normalize(this.#fresh(accountId)), v: 2, kind: 'oauth_mcp' }
  }

  /** The OAuth record for this account, or a fresh one. Null on another account or a client-credentials record. */
  #mcpRecord(accountId: string): SignInRecord | null {
    const r = this.#read()
    if (!r) return this.#freshMcp(accountId)
    if (r.accountId !== accountId || r.kind !== 'oauth_mcp') {
      log('hub_internal', { accountId, code: 'account_mismatch' })
      return null
    }
    return r
  }

  /** The connector kind behind the account: the stored record's, else the registry's. Never the provider's presence. */
  async #kind(accountId: string): Promise<'client_credentials' | 'oauth_mcp'> {
    const stored = this.#read()?.kind
    if (stored) return stored
    if (!this.#d.kindFor) return 'client_credentials'
    return (await this.#d.kindFor(accountId)) ?? 'client_credentials'
  }

  /**
   * The connect callback's check (OC-W1-5): the record (or a fresh one) names this account and `connectEpoch` is the
   * one the connect started under. Any state allowed. A disconnect between start and callback bumps the epoch and wins.
   */
  #connectCurrent(accountId: string, epochAtStart: number): SignInRecord | null {
    const r = this.#read() ?? this.#freshMcp(accountId)
    if (r.accountId !== accountId || r.kind !== 'oauth_mcp' || (r.connectEpoch ?? 0) !== epochAtStart) return null
    return r
  }

  /** A post-await write is allowed only if nothing moved the record underneath. */
  #stillCurrent(accountId: string, generation: number): SignInRecord | null {
    const r = this.#read() ?? this.#fresh(accountId)
    if (r.accountId !== accountId || r.generation !== generation || r.state === 'disconnected') return null
    return r
  }

  // ---------- grants ----------

  /** Single flight: every caller that needs a grant awaits the same promise. */
  #grant(accountId: string): Promise<GrantOutcome> {
    if (this.#inflight) return this.#inflight
    const p = this.#doGrant(accountId).finally(() => {
      if (this.#inflight === p) this.#inflight = null
    })
    this.#inflight = p
    return p
  }

  async #doGrant(accountId: string): Promise<GrantOutcome> {
    const r0 = this.#recordFor(accountId)
    if (!r0) return { ok: false, code: 'internal' }
    // P5: an OAuth account refreshes; it can never reach the client-credentials grant.
    if (r0.kind === 'oauth_mcp') return this.#doRefresh(accountId)
    if (this.#d.kindFor && (await this.#d.kindFor(accountId)) === 'oauth_mcp') return { ok: false, code: 'not_configured' }
    if (r0.state === 'disconnected') return { ok: false, code: 'not_configured', detail: 'disconnected' }
    const g0 = r0.generation
    // A misconfiguration is a failed grant like any other: `failures` grows (so the alarm backs off) and status names it.
    const config = this.#d.shopify()
    if (!config) return this.#grantFailed(accountId, g0, 'not_configured')
    const scopes = await this.#d.scopesFor(accountId)
    if (!scopes) return this.#grantFailed(accountId, g0, 'not_configured')
    const ring = await this.#d.keyring()
    if (!ring.ok) return this.#grantFailed(accountId, g0, 'key_unavailable')
    const upstream = await this.#d.upstream()

    const grant = await requestGrant(upstream, config, this.#d.now)
    if (!grant.ok) return this.#grantFailed(accountId, g0, grant.code)

    const check = checkGrantedScopes(grant.scope, scopes)
    if (!check.ok) return this.#grantFailed(accountId, g0, 'scope_mismatch', describeScopeMismatch(check))

    const token = await seal(ring.ring, accountId, 'token', grant.accessToken)
    const r1 = this.#stillCurrent(accountId, g0)
    if (!r1) {
      log('signin_grant_discarded', { accountId, generation: g0 })
      return { ok: false, code: 'not_configured', detail: 'disconnected' }
    }
    const next: SignInRecord = {
      ...r1,
      state: 'active',
      generation: g0 + 1,
      token,
      refresh: null,
      obtainedAtMs: grant.startMs,
      expiresAtMs: grant.expiresAtMs,
      scopes: check.scopes,
      failures: 0,
      lastError: null,
      // A client-credentials account has no completeConnect: its first successful grant is when it was connected. Kept
      // through every refresh grant, so the Tools page's "since" never moves (disconnect leaves only via completeConnect).
      connectedAtMs: r1.connectedAtMs ?? grant.startMs,
    }
    this.#write(next)
    log('signin_grant', { accountId, code: 'ok', generation: next.generation, kid: token.kid, state: 'active' })
    const due = refreshDueAt(next)
    if (due !== null) {
      try {
        await this.#d.alarm.set(due)
      } catch {
        // The token is good, but no refresh is scheduled: visible in the log and in status() until the next grant.
        log('hub_internal', { accountId, code: 'alarm_op', generation: next.generation })
        const r2 = this.#stillCurrent(accountId, next.generation)
        if (r2) this.#write({ ...r2, lastError: { code: 'internal', atMs: this.#d.now() } })
      }
    }
    return { ok: true, generation: next.generation }
  }

  #grantFailed(accountId: string, g0: number, code: HubErrorCode, detail?: string): GrantOutcome {
    const r = this.#stillCurrent(accountId, g0)
    if (!r) {
      log('signin_grant_discarded', { accountId, generation: g0, code })
      return { ok: false, code, detail }
    }
    const nowMs = this.#d.now()
    const rejected = code === 'credentials_rejected' || code === 'scope_mismatch'
    const next: SignInRecord = rejected
      ? // Rejected or wrong scope: `failed`, and the old token is deleted.
        { ...r, state: 'failed', token: null, refresh: null, failures: r.failures + 1, lastError: { code, atMs: nowMs } }
      : // Network, timeout, 5xx or a malformed body: state unchanged; an active record keeps its token.
        { ...r, failures: r.failures + 1, lastError: { code, atMs: nowMs } }
    this.#write(next)
    log('signin_grant', { accountId, code, generation: next.generation, state: next.state, failures: next.failures })
    return { ok: false, code, detail }
  }

  // ---------- token access ----------

  /** Opens a usable token, granting when there's none. Lazy re-encryption when it opened under an old kid. */
  async #acquire(accountId: string, ring: KeyRing, allowGrant: boolean): Promise<Acquired> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = this.#recordFor(accountId)
      if (!r) return { ok: false, code: 'internal' }
      if (r.state === 'disconnected') return { ok: false, code: 'not_configured', detail: 'disconnected' }
      if (usable(r, this.#d.now()) && r.token) {
        const opened = await open(ring, accountId, 'token', r.token)
        if (opened.ok) {
          if (opened.kid !== ring.current) await this.#lazyReseal(accountId, ring, r, 'token', opened.plaintext)
          // An await passed: the token must still be usable at send time.
          if (this.#d.now() < r.expiresAtMs! - EXPIRY_MARGIN_MS) return { ok: true, token: opened.plaintext, generation: r.generation }
        } else {
          // Client credentials: a token we can't open is discarded and granted again.
          log(opened.reason === 'key_missing' ? 'signin_key_missing' : 'hub_internal', {
            accountId,
            kid: r.token.kid,
            code: 'key_unavailable',
          })
        }
      }
      if (!allowGrant) return { ok: false, code: 'credentials_rejected' }
      if (r.state === 'failed' && r.lastError?.code === 'credentials_rejected' && this.#d.now() < r.lastError.atMs + REJECTED_COOLDOWN_MS) {
        return { ok: false, code: 'credentials_rejected' }
      }
      const g = await this.#grant(accountId)
      if (!g.ok) return g
    }
    return { ok: false, code: 'upstream_unavailable' }
  }

  async #lazyReseal(accountId: string, ring: KeyRing, r: SignInRecord, field: Exclude<EnvelopeField, 'pkce'>, plaintext: string) {
    const before = r[field] ?? null
    const resealed = await seal(ring, accountId, field, plaintext)
    const now = this.#stillCurrent(accountId, r.generation)
    if (!now || !sameEnvelope(now[field] ?? null, before)) {
      log('signin_grant_discarded', { accountId, generation: r.generation, kid: resealed.kid })
      return false
    }
    this.#write({ ...now, [field]: resealed })
    log('signin_reencrypt', { accountId, kid: resealed.kid, generation: now.generation })
    return true
  }

  /** Re-seals a client registration if the stored envelope is still the one opened. No state or generation rule. */
  async #resealClient(accountId: string, ring: KeyRing, before: Envelope, plaintext: string): Promise<boolean> {
    const resealed = await seal(ring, accountId, 'client', plaintext)
    const now = this.#read()
    if (!now || now.accountId !== accountId || !sameEnvelope(now.client ?? null, before)) {
      log('signin_grant_discarded', { accountId, kid: resealed.kid })
      return false
    }
    this.#write({ ...now, client: resealed })
    log('signin_reencrypt', { accountId, kid: resealed.kid, generation: now.generation })
    return true
  }

  // ---------- the stub's methods ----------

  async query(req: QueryRequest): Promise<HubResult<{ data: unknown }>> {
    if (typeof req !== 'object' || req === null) return err('invalid_args')
    const { accountId, document, variables, apiVersion } = req
    if (typeof accountId !== 'string') return err('invalid_args')
    if (typeof apiVersion !== 'string' || !API_VERSION.test(apiVersion)) return err('invalid_args', 'apiVersion')
    if (variables !== undefined && (typeof variables !== 'object' || variables === null || Array.isArray(variables))) {
      return err('invalid_args', 'variables')
    }
    // The read-only check comes before any token is opened.
    const doc = checkReadDocument(document)
    if (!doc.ok) return err(doc.code)
    // P5 (p5-w2): variables are plain JSON within 16 KiB, and the level 1 allowlist of fields, arguments, `query` keys and
    // sort keys holds, for every document.
    // Only the plain copy is used from here on: the input itself is never serialised.
    const vars = checkVariables(variables)
    if (!vars.ok) return err('invalid_args', 'variables')
    if (!checkShopifyFields(document as string, vars.value).ok) return err('invalid_args', FIELD_NOT_ALLOWED)

    const r = this.#recordFor(accountId)
    if (!r) return err('internal')
    // P5: a Shopify read never runs on an OAuth account.
    if (r.kind === 'oauth_mcp' || (this.#d.kindFor && (await this.#d.kindFor(accountId)) === 'oauth_mcp')) return err('not_configured')
    const config = this.#d.shopify()
    if (!config) return err('not_configured')
    const ring = await this.#d.keyring()
    if (!ring.ok) return err('key_unavailable')

    const first = await this.#acquire(accountId, ring.ring, true)
    if (!first.ok) return err(first.code, first.detail)
    const upstream = await this.#d.upstream()
    const sent = await sendRead(upstream, config, first.token, apiVersion, document as string, vars.value)
    if (sent.kind === 'result') return sent.result

    // A 401: grant once if the token we used is still the current one, then re-send once. Only reads are re-sent.
    const now = this.#recordFor(accountId)
    if (!now) return err('internal')
    if (now.generation === first.generation) {
      const g = await this.#grant(accountId)
      if (!g.ok) return err(g.code, g.detail)
    }
    const second = await this.#acquire(accountId, ring.ring, false)
    if (!second.ok) return err(second.code, second.detail)
    const resent = await sendRead(upstream, config, second.token, apiVersion, document as string, vars.value)
    if (resent.kind === 'result') return resent.result
    // A second 401: rejected. The token is deleted under the generation check.
    this.#grantFailed(accountId, second.generation, 'credentials_rejected')
    return err('credentials_rejected')
  }

  /**
   * A client credentials account's token, granted now if it has none (P5 #337: a test shop's object before the turn's
   * prompt reads its status, so the prompt names what the turn's reads will use). The token endpoint only, no read.
   */
  async warm(accountId: string): Promise<HubResult<{ state: SignInState }>> {
    if ((await this.#kind(accountId)) !== 'client_credentials') return err('not_configured')
    if (!this.#recordFor(accountId)) return err('internal')
    if (!this.#d.shopify()) return err('not_configured')
    const ring = await this.#d.keyring()
    if (!ring.ok) return err('key_unavailable')
    const got = await this.#acquire(accountId, ring.ring, true)
    if (!got.ok) return err(got.code, got.detail)
    return ok({ state: this.#recordFor(accountId)!.state })
  }

  status(accountId: string): HubResult<CoreStatus> {
    const r = this.#recordFor(accountId)
    if (!r) return err('internal')
    return ok({
      accountId,
      state: r.state,
      kid: r.token?.kid ?? null,
      expiresAt: r.expiresAtMs !== null && r.token ? instant(r.expiresAtMs) : null,
      scopes: [...r.scopes],
      lastError: r.lastError ? { code: r.lastError.code, at: instant(r.lastError.atMs) } : null,
    })
  }

  async reencrypt(accountId: string): Promise<HubResult<{ kid: string; changed: boolean }>> {
    const r = this.#recordFor(accountId)
    if (!r) return err('internal')
    const ring = await this.#d.keyring()
    if (!ring.ok) return err('key_unavailable')
    let changed = false
    // P5: `client` (a dynamic client's registration) too. Pending `pkce` items live 10 minutes and aren't re-sealed.
    for (const field of ['token', 'refresh', 'client'] as const) {
      const current = this.#recordFor(accountId)
      if (!current) return err('internal')
      const envelope = current[field] ?? null
      if (!envelope || envelope.kid === ring.ring.current) continue
      const opened = await open(ring.ring, accountId, field, envelope)
      if (!opened.ok) {
        log(opened.reason === 'key_missing' ? 'signin_key_missing' : 'hub_internal', { accountId, kid: envelope.kid, code: 'key_unavailable' })
        return err('key_unavailable')
      }
      // P5: a client registration isn't a token, so a disconnected account's is re-sealed too (envelope check alone).
      const done = field === 'client' ? await this.#resealClient(accountId, ring.ring, envelope, opened.plaintext) : await this.#lazyReseal(accountId, ring.ring, current, field, opened.plaintext)
      if (done) changed = true
    }
    const after = this.#recordFor(accountId)
    if (!after) return err('internal')
    // The kid of any envelope still under an old key, so the rotation runbook's "new kid" check is honest.
    const stale = [after.token, after.refresh, after.client ?? null].find(e => e && e.kid !== ring.ring.current)
    return ok({ kid: stale?.kid ?? after.token?.kid ?? ring.ring.current, changed })
  }

  /** P5's caller. Token and refresh deleted, generation + 1, alarm deleted; only P5's connect leaves this state. */
  async disconnect(accountId: string): Promise<HubResult<{ generation: number; revoked?: boolean }>> {
    if ((await this.#kind(accountId)) === 'oauth_mcp') return this.#disconnectMcp(accountId)
    const r = this.#recordFor(accountId)
    if (!r) return err('internal')
    // connectedAtMs is kept here: only completeConnect leaves `disconnected`, and it sets a new one. A future reconnect
    // path for a client-credentials account (a grant out of `disconnected`) must clear connectedAtMs first, or the grant's
    // `r1.connectedAtMs ?? grant.startMs` would keep the old connect date.
    const next: SignInRecord = {
      ...r,
      state: 'disconnected',
      generation: r.generation + 1,
      token: null,
      refresh: null,
      obtainedAtMs: null,
      expiresAtMs: null,
      scopes: [],
    }
    this.#write(next)
    try {
      await this.#d.alarm.delete()
    } catch {
      // Harmless: an alarm that still fires finds the record disconnected and does nothing.
      log('hub_internal', { accountId, code: 'alarm_op', generation: next.generation })
    }
    return ok({ generation: next.generation })
  }

  /** One-time pending items (OC 14, for P5's OAuth state and PKCE verifier). */
  async putPending(key: string, data: unknown, ttlMs: number): Promise<HubResult<{ expiresAtMs: number }>> {
    if (typeof key !== 'string' || key.length === 0) return err('invalid_args')
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_PENDING_TTL_MS) {
      return err('invalid_args', 'ttlMs')
    }
    const id = PENDING + (await sha256Hex(key))
    const expiresAtMs = this.#d.now() + ttlMs
    this.#d.store.put(id, { data, expiresAtMs })
    return ok({ expiresAtMs })
  }

  async takePending(key: string): Promise<HubResult<unknown | null>> {
    if (typeof key !== 'string' || key.length === 0) return err('invalid_args')
    const id = PENDING + (await sha256Hex(key))
    const nowMs = this.#d.now()
    const item = this.#d.store.transactionSync(() => {
      const found = this.#d.store.get<{ data: unknown; expiresAtMs: number }>(id)
      if (found) this.#d.store.delete(id)
      return found
    })
    if (!item || nowMs >= item.expiresAtMs) return ok(null)
    return ok(item.data)
  }

  /**
   * P5 (p5-w2): code mode's caps. One synchronous read-increment-write: past `limit` nothing is written and `ok` is
   * false. A counter lives until `ttlMs` after its first bump (a later bump keeps that expiry); W1's alarm sweep clears it.
   */
  async bumpCounter(key: string, limit: number, ttlMs: number): Promise<HubResult<{ ok: boolean; count: number }>> {
    if (typeof key !== 'string' || key.length === 0 || key.length > 300) return err('invalid_args')
    if (!Number.isSafeInteger(limit) || limit < 1) return err('invalid_args', 'limit')
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_COUNTER_TTL_MS) return err('invalid_args', 'ttlMs')
    const id = COUNTER + key
    const nowMs = this.#d.now()
    const out = this.#d.store.transactionSync(() => {
      const found = this.#d.store.get<{ count: number; expiresAtMs: number }>(id)
      const live = found && nowMs < found.expiresAtMs ? found : { count: 0, expiresAtMs: nowMs + ttlMs }
      if (live.count >= limit) return { ok: false, count: live.count, expiresAtMs: live.expiresAtMs }
      const next = { count: live.count + 1, expiresAtMs: live.expiresAtMs }
      this.#d.store.put(id, next)
      return { ok: true, ...next }
    })
    try {
      await this.#ensureAlarmBy(out.expiresAtMs)
    } catch {
      log('hub_internal', { code: 'alarm_op' })
    }
    return ok({ ok: out.ok, count: out.count })
  }

  /** Expired one-time items under `pending:` and W2's `cm:`, for every record kind (P5's lock sweep). */
  #sweepPending(): void {
    const nowMs = this.#d.now()
    const expired: string[] = []
    for (const prefix of [PENDING, COUNTER]) {
      for (const [key, item] of this.#d.store.list<{ expiresAtMs: number }>(prefix)) {
        if (nowMs >= item.expiresAtMs) expired.push(key)
      }
    }
    for (const key of expired) this.#d.store.delete(key)
  }

  /** The earliest expiry of a live one-time item, or null. */
  #nextPendingExpiry(): number | null {
    let next: number | null = null
    for (const prefix of [PENDING, COUNTER]) {
      for (const [, item] of this.#d.store.list<{ expiresAtMs: number }>(prefix)) {
        if (next === null || item.expiresAtMs < next) next = item.expiresAtMs
      }
    }
    return next
  }

  /** The alarm. Catches everything and sets its own next alarm, so the platform's retries never decide. */
  async alarm(): Promise<void> {
    try {
      this.#sweepPending()
      const r = this.#read()
      if (r?.kind === 'oauth_mcp') return await this.#mcpAlarm(r)
      if (!r || r.state === 'disconnected') {
        // P5: nothing else sets an alarm here, so live one-time items (W2's counters) would never be swept.
        await this.#ensureSweepAlarm(r?.accountId ?? '')
        return
      }
      const nowMs = this.#d.now()
      const due = refreshDueAt(r)
      if (usable(r, nowMs) && due !== null && nowMs < due) {
        // A repeated alarm that isn't due: no grant, no record change; the refresh alarm stays where it was.
        await this.#d.alarm.set(due)
        return
      }
      const outcome = await this.#grant(r.accountId)
      if (!outcome.ok) await this.#scheduleBackoff()
    } catch {
      log('hub_internal', { code: 'internal' })
      try {
        await this.#scheduleBackoff()
      } catch {
        log('hub_internal', { code: 'internal' })
      }
    }
  }

  async #scheduleBackoff(): Promise<void> {
    const r = this.#read()
    if (!r || r.state === 'disconnected') return
    await this.#d.alarm.set(this.#d.now() + backoffFor(r.failures))
  }

  // ======================================================================================================
  // P5 (p5-w1): OAuth for connectors with an official MCP server. Brief sections 4 to 6.
  // ======================================================================================================

  #random(): Random {
    return this.#d.random ?? defaultRandom
  }

  async #provider(accountId: string): Promise<McpProvider | null> {
    return this.#d.provider ? this.#d.provider(accountId) : null
  }

  /** Sets the alarm to `ms` unless one is already set earlier (setAlarm overrides, so read it first). */
  async #ensureAlarmBy(ms: number): Promise<void> {
    const current = this.#d.alarm.get ? await this.#d.alarm.get() : null
    if (current !== null && current <= ms) return
    await this.#d.alarm.set(ms)
  }

  async #ensureSweepAlarm(accountId: string): Promise<void> {
    const next = this.#nextPendingExpiry()
    if (next === null) return
    try {
      await this.#ensureAlarmBy(next)
    } catch {
      log('hub_internal', { accountId, code: 'alarm_op' })
    }
  }

  /** The client the hub authenticates as: the deployment's pre-registered one, or the sealed dynamic registration. */
  async #clientCreds(accountId: string, ring: KeyRing, p: McpProvider, r: SignInRecord): Promise<ClientCreds | null> {
    if (p.connector.client === 'preregistered') {
      if (!p.clientConfig.clientId) return null
      return { clientId: p.clientConfig.clientId, clientSecret: p.clientConfig.clientSecret, authMethod: 'client_secret_post', expiresAtMs: null }
    }
    if (!r.client) return null
    const opened = await open(ring, accountId, 'client', r.client)
    if (!opened.ok) return null
    try {
      return JSON.parse(opened.plaintext) as ClientCreds
    } catch {
      return null
    }
  }

  #endpoints(p: McpProvider, r: SignInRecord): Endpoints | null {
    return p.connector.client === 'preregistered' ? pinnedEndpoints(p.connector) : (r.endpoints ?? null)
  }

  /** Whether `token` equals the token stored for the account now (the live-token rule). Both stay in locals. */
  async #isLive(accountId: string, ring: KeyRing, token: string): Promise<boolean> {
    const r = this.#read()
    if (!r || r.accountId !== accountId || !r.token) return false
    const opened = await open(ring, accountId, 'token', r.token)
    return opened.ok && constantTimeEqual(opened.plaintext, token)
  }

  /** Best effort, and never a value equal to the live stored token (OC-W1-15). */
  async #revokeUnlessLive(accountId: string, ring: KeyRing, p: McpProvider, r: SignInRecord, client: ClientCreds | null, token: string): Promise<void> {
    if (await this.#isLive(accountId, ring, token)) return
    const endpoints = this.#endpoints(p, r)
    if (!endpoints) return
    const ok = await revokeToken(await this.#d.upstream(), p.connector, endpoints, client, token)
    if (!ok) log('revoke_failed', { accountId })
  }

  // ---------- readiness and status ----------

  /** For the gateway (P5 W1 section 6): whether this account's tools are served now. Writes nothing. */
  async ready(accountId: string): Promise<HubResult<Readiness>> {
    if ((await this.#kind(accountId)) === 'client_credentials') {
      const r = this.#read()
      if (r && r.accountId !== accountId) return err('internal')
      return ok(r?.paused ? { ready: false, code: 'paused' } : { ready: true, policies: [] })
    }
    const p = await this.#provider(accountId)
    if (!p) return ok({ ready: false, code: 'not_configured' })
    const r = this.#read()
    if (!r || r.accountId !== accountId || r.kind !== 'oauth_mcp' || r.state !== 'active' || !r.token) return ok({ ready: false, code: 'not_configured' })
    if (!sameScopeSet(r.scopes, requestedScopes(p.connector, p.clientConfig))) return ok({ ready: false, code: 'scope_mismatch' })
    if (r.paused) return ok({ ready: false, code: 'paused' })
    // An expired rotating token is still ready: the call refreshes it first.
    if (r.expiresAtMs !== null && this.#d.now() >= r.expiresAtMs - EXPIRY_MARGIN_MS && !r.refresh) return ok({ ready: false, code: 'not_configured' })
    return ok({ ready: true, policies: [...p.clientConfig.policies] })
  }

  /** H0's status plus P5's fields. Async because `needsReconnect` compares with the current requested scopes. */
  async accountStatus(accountId: string): Promise<HubResult<AccountStatus>> {
    const base = this.status(accountId)
    if (!base.ok) return base
    // Kind first (it may await the registry), so the backfill below runs only for a client-credentials account.
    const kind = await this.#kind(accountId)
    const raw = this.#read()
    const r = normalize(raw ?? this.#fresh(accountId))
    // A client-credentials record granted before connectedAtMs was kept: its current token's grant time. That is the
    // latest grant, so the first connect was at or before it (an upper bound on the true connect time, never the clock).
    // Read and written with no await in between, so it can't overwrite a newer record; later reads and refresh grants
    // keep it. A record that never held a token (a failed first grant) gets no date.
    if (raw && kind === 'client_credentials' && r.connectedAtMs === null && r.obtainedAtMs !== null && (r.state === 'active' || r.state === 'failed')) {
      r.connectedAtMs = r.obtainedAtMs
      this.#write({ ...raw, connectedAtMs: r.obtainedAtMs })
    }
    let needsReconnect = false
    if (kind === 'oauth_mcp') {
      const p = await this.#provider(accountId)
      needsReconnect = r.state === 'failed' || (r.state === 'active' && !!p && !sameScopeSet(r.scopes, requestedScopes(p.connector, p.clientConfig)))
    }
    return ok({
      ...base.value,
      paused: r.paused,
      kind,
      connectedBy: r.connectedBy,
      connectedAt: r.connectedAtMs !== null ? instant(r.connectedAtMs) : null,
      revokeFailedAt: r.revokeFailedAtMs !== null ? instant(r.revokeFailedAtMs) : null,
      needsReconnect,
    })
  }

  /** Pause keyed by account, any kind (OC-W1-8). Doesn't touch the token or either counter. */
  async setPaused(accountId: string, paused: boolean): Promise<HubResult<{ paused: boolean }>> {
    if (typeof paused !== 'boolean') return err('invalid_args', 'paused')
    const kind = await this.#kind(accountId)
    const r = kind === 'oauth_mcp' ? this.#mcpRecord(accountId) : this.#recordFor(accountId)
    if (!r) return err('internal')
    this.#write({ ...r, paused })
    return ok({ paused })
  }

  // ---------- connect ----------

  /** Connect start (section 5). Writes a pending item, never the record, except a dynamic client's registration. */
  async beginConnect(req: { accountId: string; memberId: string }): Promise<HubResult<{ authorizeUrl: string; expiresAtMs: number }>> {
    if (typeof req !== 'object' || req === null || typeof req.accountId !== 'string' || typeof req.memberId !== 'string' || req.memberId.length === 0) {
      return err('invalid_args')
    }
    const { accountId, memberId } = req
    if ((await this.#kind(accountId)) !== 'oauth_mcp') return err('not_configured')
    const p = await this.#provider(accountId)
    if (!p) return err('not_configured')
    const r0 = this.#mcpRecord(accountId)
    if (!r0) return err('internal')
    const ring = await this.#d.keyring()
    if (!ring.ok) return err('key_unavailable')
    const c = p.connector

    let endpoints: Endpoints
    let clientId: string
    if (c.client === 'preregistered') {
      if (!p.clientConfig.clientId) return err('not_configured')
      endpoints = pinnedEndpoints(c)
      clientId = p.clientConfig.clientId
    } else {
      const upstream = await this.#d.upstream()
      const found = await discover(upstream, c)
      if (!found.ok) return err(found.code)
      endpoints = found.endpoints
      let client = await this.#clientCreds(accountId, ring.ring, p, r0)
      if (!client || (client.expiresAtMs !== null && this.#d.now() >= client.expiresAtMs - EXPIRY_MARGIN_MS)) {
        const reg = await register(upstream, c, endpoints, p.clientConfig.redirectUri)
        if (!reg.ok) return err(reg.code)
        client = reg.client
        const sealed = await seal(ring.ring, accountId, 'client', JSON.stringify(client))
        // Not a token: no generation check. The record is re-read and written whole in one put.
        const now = this.#mcpRecord(accountId)
        if (!now) return err('internal')
        this.#write({ ...now, client: sealed, endpoints })
      } else if (JSON.stringify(r0.endpoints) !== JSON.stringify(endpoints)) {
        const now = this.#mcpRecord(accountId)
        if (!now) return err('internal')
        this.#write({ ...now, endpoints })
      }
      clientId = client.clientId
    }

    const scopes = requestedScopes(c, p.clientConfig)
    const random = this.#random()
    const verifier = newVerifier(random)
    const challenge = await challengeFor(verifier)
    const state = newState(accountId, random)
    const pkce = await seal(ring.ring, accountId, 'pkce', verifier)
    const epochAtStart = (this.#read()?.connectEpoch ?? 0)
    const item: ConnectItem = {
      v: 1,
      accountId,
      memberId,
      pkce,
      scopes,
      redirectUri: p.clientConfig.redirectUri,
      resource: c.mcp.resource,
      epochAtStart,
      startedAtMs: this.#d.now(),
    }
    const put = await this.putPending(state, item, STATE_TTL_MS)
    if (!put.ok) return put
    // H0 sweeps pending items only in alarm(); a non-rotating account never sets one otherwise.
    await this.#ensureSweepAlarm(accountId)
    const url = authorizeUrl(c, endpoints, { clientId, redirectUri: p.clientConfig.redirectUri, scopes, state, challenge, teamId: p.clientConfig.teamId })
    log('connect_start', { accountId, memberId })
    return ok({ authorizeUrl: url, expiresAtMs: put.value.expiresAtMs })
  }

  /** Takes a connect's pending item: one use, the member who started it only. */
  async #takeConnect(state: string, memberId: string): Promise<ConnectItem | null> {
    if (typeof state !== 'string' || state.length === 0 || typeof memberId !== 'string') return null
    const taken = await this.takePending(state)
    const item = taken.ok ? (taken.value as ConnectItem | null) : null
    if (!item || typeof item !== 'object' || item.v !== 1 || typeof item.accountId !== 'string') return null
    if (stateAccount(state) !== item.accountId) return null
    // Consumed before this check, so another member's state is spent too.
    if (item.memberId !== memberId) return null
    return item
  }

  /** The callback (section 5, steps 2 to 10). */
  async completeConnect(req: { state: string; code: string; memberId: string }): Promise<HubResult<{ accountId: string }>> {
    if (typeof req !== 'object' || req === null || typeof req.code !== 'string' || req.code.length === 0) return err('invalid_args')
    const item = await this.#takeConnect(req.state, req.memberId)
    if (!item) {
      log('connect_complete', { code: 'state_invalid' })
      return err('state_invalid')
    }
    const result = await this.#complete(item, req.code)
    log('connect_complete', { accountId: item.accountId, memberId: item.memberId, code: result.ok ? 'ok' : result.error.code })
    return result
  }

  async #complete(item: ConnectItem, code: string): Promise<HubResult<{ accountId: string }>> {
    const accountId = item.accountId
    const p = await this.#provider(accountId)
    if (!p) return err('not_configured')
    const r0 = this.#mcpRecord(accountId)
    if (!r0) return err('internal')
    const ring = await this.#d.keyring()
    if (!ring.ok) return err('key_unavailable')
    const verifier = await open(ring.ring, accountId, 'pkce', item.pkce)
    if (!verifier.ok) return err('key_unavailable')
    const client = await this.#clientCreds(accountId, ring.ring, p, r0)
    const endpoints = this.#endpoints(p, r0)
    if (!client || !endpoints) return err('not_configured')

    const upstream = await this.#d.upstream()
    const exchanged = await exchangeCode(upstream, p.connector, endpoints, client, { code, verifier: verifier.plaintext, redirectUri: item.redirectUri })
    if (!exchanged.ok) {
      this.#noteError(accountId, exchanged.code)
      return err(exchanged.code, undefined, exchanged.retryAfterMs)
    }
    const t = exchanged.tokens

    // Workspace, then the exact scope rule (the same rule readiness applies later).
    let failed: { code: HubErrorCode; detail?: string } | null = null
    if (p.connector.profile === 'slack' && t.teamId !== p.clientConfig.teamId) failed = { code: 'workspace_mismatch' }
    else if (!t.scopes || !sameScopeSet(t.scopes, item.scopes)) failed = { code: 'scope_mismatch', detail: describeMcpScopes(t.scopes ?? [], item.scopes) }
    if (failed) {
      const g0 = this.#read()?.generation
      if (await this.#isLive(accountId, ring.ring, t.accessToken)) {
        // A cumulative grant handed back the very token we use: record what it now carries, revoke nothing. Written
        // only if the record didn't move during the comparison (a reconnect with another token wins).
        const now = this.#read()
        if (now && now.accountId === accountId && now.kind === 'oauth_mcp' && now.generation === g0) {
          const scopes = failed.code === 'scope_mismatch' && t.scopes ? t.scopes : now.scopes
          this.#write({ ...now, scopes, lastError: { code: failed.code, atMs: this.#d.now() } })
        } else {
          await this.#revokeUnlessLive(accountId, ring.ring, p, r0, client, t.accessToken)
        }
      } else {
        this.#noteError(accountId, failed.code)
        await this.#revokeUnlessLive(accountId, ring.ring, p, r0, client, t.accessToken)
      }
      return err(failed.code, failed.detail)
    }

    const token = await seal(ring.ring, accountId, 'token', t.accessToken)
    const refresh = t.refreshToken ? await seal(ring.ring, accountId, 'refresh', t.refreshToken) : null
    // The live-token comparison needs an await, so it's taken against a record and the write happens only if that same
    // generation is still stored when the connect-only check passes (a refresh in between re-runs it once).
    for (let attempt = 0; attempt < 2; attempt++) {
      const seen = this.#read()
      const same = await this.#isLive(accountId, ring.ring, t.accessToken)
      const cur = this.#connectCurrent(accountId, item.epochAtStart)
      if (!cur) {
        if (!same) await this.#revokeUnlessLive(accountId, ring.ring, p, r0, client, t.accessToken)
        return err('connect_stale')
      }
      if ((seen?.generation ?? 0) !== cur.generation) continue
      const nowMs = this.#d.now()
      const meta = {
        connectEpoch: (cur.connectEpoch ?? 0) + 1,
        connectedBy: item.memberId,
        connectedAtMs: nowMs,
        workspace: t.teamId,
        scopes: t.scopes!,
        failures: 0,
        lastError: null,
        revokeFailedAtMs: null,
      }
      if (same && cur.state === 'active') {
        // The provider returned the token we already hold: a metadata refresh. Token, refresh, generation unchanged.
        this.#write({ ...cur, ...meta })
        return ok({ accountId })
      }
      const replaced = cur.token
      const next: SignInRecord = {
        ...cur,
        ...meta,
        v: 2,
        kind: 'oauth_mcp',
        state: 'active',
        generation: cur.generation + 1,
        token,
        refresh,
        obtainedAtMs: nowMs,
        expiresAtMs: t.expiresInS !== null ? nowMs + t.expiresInS * 1000 : null,
        refreshUnclear: false,
      }
      this.#write(next)
      const due = refreshDueAt(next)
      if (due !== null && next.refresh) {
        try {
          await this.#d.alarm.set(due)
        } catch {
          log('hub_internal', { accountId, code: 'alarm_op', generation: next.generation })
        }
      }
      // A previous, different token was replaced: revoke it after the put.
      if (replaced && !same) {
        const old = await open(ring.ring, accountId, 'token', replaced)
        if (old.ok) await this.#revokeUnlessLive(accountId, ring.ring, p, next, client, old.plaintext)
      }
      return ok({ accountId })
    }
    // Two refreshes landed during this callback: treat as stale rather than loop.
    await this.#revokeUnlessLive(accountId, ring.ring, p, r0, client, t.accessToken)
    return err('connect_stale')
  }

  /** `lastError` only: metadata, no token change, so no generation check. */
  #noteError(accountId: string, code: HubErrorCode): void {
    const r = this.#read()
    if (!r || r.accountId !== accountId || r.kind !== 'oauth_mcp') return
    this.#write({ ...r, lastError: { code, atMs: this.#d.now() } })
  }

  /** The AS answered `?error=` (section 5): consume the state the same way and record `connect_refused`. */
  async failConnect(req: { state: string; memberId: string }): Promise<HubResult<{ accountId: string | null }>> {
    if (typeof req !== 'object' || req === null) return err('invalid_args')
    const item = await this.#takeConnect(req.state, req.memberId)
    if (!item) {
      log('connect_complete', { code: 'state_invalid' })
      return ok({ accountId: null })
    }
    this.#noteError(item.accountId, 'connect_refused')
    log('connect_complete', { accountId: item.accountId, memberId: item.memberId, code: 'connect_refused' })
    return ok({ accountId: item.accountId })
  }

  /**
   * Disconnect (section 4): in one synchronous step read the record, keep its token envelope, write the disconnected
   * record with `connectEpoch + 1`. Then open the captured envelope and revoke it. Only this path revokes the stored
   * token, after deleting it.
   */
  async #disconnectMcp(accountId: string): Promise<HubResult<{ generation: number; revoked: boolean }>> {
    const r = this.#mcpRecord(accountId)
    if (!r) return err('internal')
    const captured = r.token
    const next: SignInRecord = {
      ...r,
      state: 'disconnected',
      generation: r.generation + 1,
      connectEpoch: (r.connectEpoch ?? 0) + 1,
      token: null,
      refresh: null,
      obtainedAtMs: null,
      expiresAtMs: null,
      scopes: [],
      refreshUnclear: false,
    }
    this.#write(next)
    this.#session = null
    try {
      await this.#d.alarm.delete()
    } catch {
      log('hub_internal', { accountId, code: 'alarm_op', generation: next.generation })
    }
    if (!captured) return ok({ generation: next.generation, revoked: true })
    let revoked = false
    const p = await this.#provider(accountId)
    const ring = await this.#d.keyring()
    if (p && ring.ok) {
      const opened = await open(ring.ring, accountId, 'token', captured)
      const endpoints = this.#endpoints(p, r)
      if (opened.ok && endpoints) {
        const client = await this.#clientCreds(accountId, ring.ring, p, r)
        revoked = await revokeToken(await this.#d.upstream(), p.connector, endpoints, client, opened.plaintext)
      }
    }
    if (!revoked) log('revoke_failed', { accountId, generation: next.generation })
    // Metadata after an await: written only if nothing moved the record since our disconnect.
    const now = this.#read()
    if (now && now.accountId === accountId && now.generation === next.generation) {
      this.#write({ ...now, revokeFailedAtMs: revoked ? null : this.#d.now() })
    }
    return ok({ generation: next.generation, revoked })
  }

  // ---------- refresh ----------

  /** Inside H0's single flight (`#grant`): one refresh at a time per account. */
  async #doRefresh(accountId: string): Promise<GrantOutcome> {
    const r0 = this.#read()
    if (!r0 || r0.accountId !== accountId) return { ok: false, code: 'internal' }
    if (r0.state !== 'active' || !r0.refresh) return { ok: false, code: r0.state === 'disconnected' ? 'not_configured' : 'credentials_rejected' }
    const g0 = r0.generation
    const p = await this.#provider(accountId)
    if (!p) return { ok: false, code: 'not_configured' }
    const ring = await this.#d.keyring()
    if (!ring.ok) return this.#refreshFailed(accountId, g0, { ok: false, code: 'key_unavailable', cls: 'not_consumed' })
    const opened = await open(ring.ring, accountId, 'refresh', r0.refresh)
    const client = await this.#clientCreds(accountId, ring.ring, p, r0)
    const endpoints = this.#endpoints(p, r0)
    if (!opened.ok || !client || !endpoints) return this.#refreshFailed(accountId, g0, { ok: false, code: opened.ok ? 'not_configured' : 'key_unavailable', cls: 'not_consumed' })

    const upstream = await this.#d.upstream()
    const startMs = this.#d.now()
    const res = await refreshTokens(upstream, p.connector, endpoints, client, opened.plaintext)
    if (!res.ok) return this.#refreshFailed(accountId, g0, res)
    const t = res.tokens
    const token = await seal(ring.ring, accountId, 'token', t.accessToken)
    const refresh = t.refreshToken ? await seal(ring.ring, accountId, 'refresh', t.refreshToken) : r0.refresh
    const r1 = this.#stillCurrent(accountId, g0)
    if (!r1) {
      log('signin_grant_discarded', { accountId, generation: g0 })
      await this.#revokeUnlessLive(accountId, ring.ring, p, r0, client, t.accessToken)
      return { ok: false, code: 'not_configured', detail: 'disconnected' }
    }
    // The pair in one put: never half saved.
    const next: SignInRecord = {
      ...r1,
      generation: g0 + 1,
      token,
      refresh,
      obtainedAtMs: startMs,
      expiresAtMs: t.expiresInS !== null ? startMs + t.expiresInS * 1000 : null,
      scopes: t.scopes ?? r1.scopes,
      failures: 0,
      lastError: null,
      refreshUnclear: false,
      retryAtMs: null,
    }
    this.#write(next)
    log('signin_grant', { accountId, code: 'ok', generation: next.generation, kid: token.kid, state: 'active' })
    const due = refreshDueAt(next)
    if (due !== null) {
      try {
        await this.#d.alarm.set(due)
      } catch {
        log('hub_internal', { accountId, code: 'alarm_op', generation: next.generation })
      }
    }
    return { ok: true, generation: next.generation }
  }

  /** The earliest time the next refresh may go out: H0's backoff after the last failure, and any Retry-After. */
  #refreshNotBefore(r: SignInRecord): number | null {
    if (r.failures === 0 && !r.refreshUnclear) return null
    const backoff = r.lastError ? r.lastError.atMs + backoffFor(r.failures) : 0
    return Math.max(backoff, r.retryAtMs ?? 0)
  }

  /** The three refresh classes (section 4): not consumed keeps the record; unclear allows one more send; spent fails. */
  #refreshFailed(accountId: string, g0: number, res: TokenFail): GrantOutcome {
    const r = this.#stillCurrent(accountId, g0)
    if (!r) {
      log('signin_grant_discarded', { accountId, generation: g0, code: res.code })
      return { ok: false, code: res.code }
    }
    const nowMs = this.#d.now()
    const spent = res.cls === 'spent' || (res.cls === 'unclear' && r.refreshUnclear === true)
    const next: SignInRecord = spent
      ? {
          ...r,
          state: 'failed',
          generation: r.generation + 1,
          token: null,
          refresh: null,
          failures: r.failures + 1,
          lastError: { code: 'credentials_rejected', atMs: nowMs },
          refreshUnclear: false,
        }
      : {
          ...r,
          failures: r.failures + 1,
          lastError: { code: res.code, atMs: nowMs },
          refreshUnclear: res.cls === 'unclear' ? true : r.refreshUnclear === true,
          retryAtMs: res.retryAfterMs !== undefined ? nowMs + res.retryAfterMs : null,
        }
    this.#write(next)
    log('signin_grant', { accountId, code: spent ? 'credentials_rejected' : res.code, generation: next.generation, state: next.state, failures: next.failures })
    return spent ? { ok: false, code: 'credentials_rejected' } : { ok: false, code: res.code }
  }

  /** The alarm for an OAuth record: sweep (done), refresh a rotating token when due, else re-set at its due time. */
  async #mcpAlarm(r: SignInRecord): Promise<void> {
    const accountId = r.accountId
    const rotating = r.state === 'active' && r.refresh !== null && r.expiresAtMs !== null
    if (rotating) {
      const due = refreshDueAt(r)
      const notBefore = this.#refreshNotBefore(r)
      if (notBefore !== null && this.#d.now() < notBefore) {
        // Backing off after a failed refresh (H0's schedule, or the upstream's Retry-After): wait until then.
        await this.#d.alarm.set(notBefore)
      } else if (due !== null && this.#d.now() < due && notBefore === null) {
        // An early (sweep) alarm never costs the proactive refresh.
        await this.#d.alarm.set(due)
      } else {
        const outcome = await this.#grant(accountId)
        if (!outcome.ok) await this.#scheduleBackoff()
      }
    }
    await this.#ensureSweepAlarm(accountId)
  }

  // ---------- the MCP proxy ----------

  /** A usable token for an OAuth account, refreshing first when it expired and a refresh token is held. */
  async #mcpAcquire(accountId: string, ring: KeyRing, requested: readonly string[], allowRefresh: boolean): Promise<Acquired> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = this.#read()
      if (!r || r.accountId !== accountId || r.kind !== 'oauth_mcp') return { ok: false, code: 'not_configured' }
      if (r.state === 'failed') return { ok: false, code: 'credentials_rejected' }
      if (r.state !== 'active' || (!r.token && !r.refresh)) return { ok: false, code: 'not_configured' }
      if (!sameScopeSet(r.scopes, requested)) return { ok: false, code: 'scope_mismatch' }
      if (usableMcp(r, this.#d.now(), requested) && r.token) {
        const opened = await open(ring, accountId, 'token', r.token)
        if (!opened.ok) return { ok: false, code: 'key_unavailable' }
        if (opened.kid !== ring.current) await this.#lazyReseal(accountId, ring, r, 'token', opened.plaintext)
        return { ok: true, token: opened.plaintext, generation: r.generation }
      }
      if (!allowRefresh || !r.refresh) return { ok: false, code: 'credentials_rejected' }
      // Backing off after a failed refresh: answer the last error, send nothing (the alarm retries on schedule).
      const notBefore = this.#refreshNotBefore(r)
      if (notBefore !== null && this.#d.now() < notBefore) {
        const code = r.lastError?.code ?? 'upstream_unavailable'
        return { ok: false, code, detail: undefined }
      }
      const g = await this.#grant(accountId)
      if (!g.ok) return g
    }
    return { ok: false, code: 'upstream_unavailable' }
  }

  /** A second 401: rejected. The token and refresh are deleted under the generation check. */
  #mcpRejected(accountId: string, generation: number): void {
    const r = this.#stillCurrent(accountId, generation)
    if (!r) return
    this.#write({
      ...r,
      state: 'failed',
      generation: r.generation + 1,
      token: null,
      refresh: null,
      failures: r.failures + 1,
      lastError: { code: 'credentials_rejected', atMs: this.#d.now() },
    })
    this.#session = null
  }

  /**
   * One allowlisted upstream tool call (section 6). The name must be one of the connector's reviewed upstream names, so
   * a known write or an unlisted tool never reaches the upstream. One 401 doesn't kill a token: with a refresh token,
   * refresh once (if the token used is still current) and re-send once; without one, re-initialise and re-send once
   * with the same token. A second 401 is credentials_rejected.
   */
  async mcpCall(req: McpCallRequest): Promise<HubResult<McpToolResult>> {
    if (typeof req !== 'object' || req === null || typeof req.accountId !== 'string') return err('invalid_args')
    const { accountId, upstream: name, args } = req
    if (typeof name !== 'string' || !UPSTREAM_TOOL.test(name)) return err('invalid_args', 'upstream')
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return err('invalid_args', 'args')
    if ((await this.#kind(accountId)) !== 'oauth_mcp') return err('not_configured')
    const p = await this.#provider(accountId)
    if (!p) return err('not_configured')
    const c = p.connector
    const entry = c.tools.find(t => t.upstream === name)
    if (!entry) return err(c.knownWrites.includes(name) ? 'write_refused' : 'unknown_tool')
    // Defense in depth: the gateway already hides a tool whose policy is off.
    if (entry.policy !== undefined && !p.clientConfig.policies.includes(entry.policy)) return err('unknown_tool')
    const r = this.#read()
    if (!r || r.accountId !== accountId || r.kind !== 'oauth_mcp') return err('not_configured')
    const requested = requestedScopes(c, p.clientConfig)
    if (r.state === 'active' && !sameScopeSet(r.scopes, requested)) return err('scope_mismatch')
    if (r.paused) return err('paused')
    const ring = await this.#d.keyring()
    if (!ring.ok) return err('key_unavailable')
    const started = this.#d.now()
    const target = { endpoint: c.mcp.endpoint, allowedHosts: c.mcp.allowedHosts }

    const first = await this.#mcpAcquire(accountId, ring.ring, requested, true)
    if (!first.ok) return this.#mcpLogged(accountId, name, started, err(first.code, first.detail))
    const upstream = await this.#d.upstream()
    let out = await callMcpTool(upstream, target, first.token, first.generation, this.#session, name, args)
    if (out.kind === 'unauthorized') {
      this.#session = null
      const now = this.#read()
      if (now?.refresh && now.generation === first.generation) {
        // The same backoff gate as #mcpAcquire: while refreshes are backing off, a 401 sends no refresh either.
        const notBefore = this.#refreshNotBefore(now)
        if (notBefore !== null && this.#d.now() < notBefore) return this.#mcpLogged(accountId, name, started, err(now.lastError?.code ?? 'upstream_unavailable'))
        const g = await this.#grant(accountId)
        if (!g.ok) return this.#mcpLogged(accountId, name, started, err(g.code, g.detail))
      }
      const second = await this.#mcpAcquire(accountId, ring.ring, requested, false)
      if (!second.ok) return this.#mcpLogged(accountId, name, started, err(second.code, second.detail))
      out = await callMcpTool(upstream, target, second.token, second.generation, null, name, args)
      if (out.kind === 'unauthorized') {
        this.#mcpRejected(accountId, second.generation)
        return this.#mcpLogged(accountId, name, started, err('credentials_rejected'))
      }
    }
    if (out.kind === 'error') {
      // Whatever went wrong, a reused session isn't trusted for the next call.
      this.#session = null
      return this.#mcpLogged(accountId, name, started, err(out.code, undefined, out.retryAfterMs))
    }
    // Kept only while the record still carries the generation it started under.
    if (this.#read()?.generation === out.session.generation) this.#session = out.session
    return this.#mcpLogged(accountId, name, started, ok(out.result), out.dropped)
  }

  #mcpLogged<T>(accountId: string, name: string, started: number, result: HubResult<T>, parts?: number): HubResult<T> {
    log('mcp_call', { accountId, upstreamTool: name, code: result.ok ? 'ok' : result.error.code, ms: this.#d.now() - started, parts })
    return result
  }

  // ---------- P5 (p5-w4): Slack delivery, the choke point ----------
  // Three methods and no generic one (p5-w4.md section 6, OC-W4-4 and OC-W4-9). Each starts with the readiness read the
  // gateway's callReadTool uses (`ready`: active, not paused, the exact-scope rule), so a paused or needs-reconnect
  // account answers `paused` or `scope_mismatch` before any upstream request. One send, no retry.

  /** Readiness, then a usable token (refreshed first when it expired), for the Slack account only. */
  async #slackGate(accountId: string): Promise<HubResult<{ token: string; upstream: Upstream }>> {
    if ((await this.#kind(accountId)) !== 'oauth_mcp') return err('not_configured')
    const p = await this.#provider(accountId)
    if (!p || p.connector.id !== 'slack') return err('not_configured')
    const rd = await this.ready(accountId)
    if (!rd.ok) return rd
    if (!rd.value.ready) return err(rd.value.code)
    const ring = await this.#d.keyring()
    if (!ring.ok) return err('key_unavailable')
    const a = await this.#mcpAcquire(accountId, ring.ring, requestedScopes(p.connector, p.clientConfig), true)
    if (!a.ok) return err(a.code, a.detail)
    return ok({ token: a.token, upstream: await this.#d.upstream() })
  }

  #webError<T>(out: Exclude<WebOutcome, { kind: 'ok' }>): HubResult<T> {
    return out.kind === 'unauthorized' ? err('credentials_rejected') : err(out.code, out.detail, out.retryAfterMs)
  }

  async #channelInfo(token: string, upstream: Upstream, channelId: string): Promise<HubResult<SlackChannel>> {
    const out = await callWeb(upstream, token, 'conversations.info', { channel: channelId })
    if (out.kind !== 'ok') return this.#webError(out)
    const c = parseChannel(out.body.channel)
    if (!c || c.id !== channelId) return err('upstream_unavailable')
    return ok(c)
  }

  /** `conversations.info` for one channel id (C or G). */
  async slackChannelInfo(accountId: string, channelId: string): Promise<HubResult<SlackChannel>> {
    if (typeof channelId !== 'string' || !/^[CG][A-Z0-9]{2,20}$/.test(channelId)) return err('invalid_args', 'channelId')
    const g = await this.#slackGate(accountId)
    if (!g.ok) return g
    return this.#channelInfo(g.value.token, g.value.upstream, channelId)
  }

  /** `conversations.list`: public channels, archived ones excluded, 200 a page. */
  async slackChannelList(accountId: string, cursor?: string): Promise<HubResult<{ channels: SlackChannel[]; nextCursor: string | null }>> {
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^[A-Za-z0-9+/=_-]{1,500}$/.test(cursor))) return err('invalid_args', 'cursor')
    const g = await this.#slackGate(accountId)
    if (!g.ok) return g
    const params: Record<string, string> = { types: 'public_channel', exclude_archived: 'true', limit: String(LIST_LIMIT) }
    if (cursor !== undefined) params.cursor = cursor
    const out = await callWeb(g.value.upstream, g.value.token, 'conversations.list', params)
    if (out.kind !== 'ok') return this.#webError(out)
    if (!Array.isArray(out.body.channels)) return err('upstream_unavailable')
    const channels: SlackChannel[] = []
    for (const raw of out.body.channels as unknown[]) {
      const c = parseChannel(raw)
      if (!c) return err('upstream_unavailable')
      channels.push(c)
    }
    const meta = out.body.response_metadata as { next_cursor?: unknown } | undefined
    const next = typeof meta?.next_cursor === 'string' && /^[A-Za-z0-9+/=_-]{1,500}$/.test(meta.next_cursor) ? meta.next_cursor : null
    return ok({ channels, nextCursor: next })
  }

  /**
   * The only Slack post (section 6): the id's shape, readiness, the bounds with the one escape, the channel re-checked at
   * Slack, then `chat.postMessage` with a parameter object built here from exactly `channel`, `text`, `unfurl_links` and
   * `unfurl_media`, so no caller can add `link_names`, `parse`, `blocks`, `thread_ts` or anything else.
   */
  async slackPost(accountId: string, req: SlackPostRequest): Promise<HubResult<{ ts: string }>> {
    const started = this.#d.now()
    const channelId = typeof req === 'object' && req !== null && typeof req.channelId === 'string' ? req.channelId : ''
    const result = await this.#post(accountId, req)
    log('hub_delivery', {
      accountId,
      code: result.ok ? 'ok' : result.error.code,
      ms: this.#d.now() - started,
      channelHash: POSTABLE_CHANNEL.test(channelId) ? (await sha256Hex(channelId)).slice(0, 12) : undefined,
    })
    return result
  }

  async #post(accountId: string, req: SlackPostRequest): Promise<HubResult<{ ts: string }>> {
    if (typeof req !== 'object' || req === null) return err('invalid_args')
    if (typeof req.channelId !== 'string' || !POSTABLE_CHANNEL.test(req.channelId)) return err('invalid_args', 'channelId')
    if (typeof req.title !== 'string' || typeof req.text !== 'string') return err('invalid_args')
    // The pure steps first, so a doomed post costs no token read, refresh or Slack call. Steps 1 and 2 again
    // (idempotent on the server's output), then the escape, once. `report` keeps the line breaks the server left; a
    // `message` already arrives on one line.
    const b = boundNotice({ title: req.title, text: req.text, format: 'report' }, { escape: true })
    if (!b.ok) return err('invalid_args', b.reason)
    let appLink: { origin: string; path: string } | null = null
    if (req.link !== undefined) {
      const path = linkPath(req.link)
      if (path === null) {
        log('hub_delivery', { accountId, code: 'link_dropped' })
      } else {
        const origin = this.#d.appOrigin?.()
        if (!isAppOrigin(origin)) return err('not_configured', 'APP_ORIGIN')
        appLink = { origin, path }
      }
    }
    const g = await this.#slackGate(accountId)
    if (!g.ok) return g
    const info = await this.#channelInfo(g.value.token, g.value.upstream, req.channelId)
    if (!info.ok) return info
    const refused = refusalFor(info.value)
    if (refused) return err('connect_refused', refused)
    const params = { channel: req.channelId, text: composeSlack(b.title, b.text, appLink), unfurl_links: 'false', unfurl_media: 'false' }
    const out = await callWeb(g.value.upstream, g.value.token, 'chat.postMessage', params)
    if (out.kind !== 'ok') return this.#webError(out)
    const ts = out.body.ts
    return typeof ts === 'string' && /^\d{1,12}\.\d{1,8}$/.test(ts) ? ok({ ts }) : err('upstream_unavailable')
  }
}

/** Scope handles for a message: handle-shaped values only, so nothing odd from an upstream rides along. */
export function describeMcpScopes(granted: readonly string[], requested: readonly string[]): string {
  const safe = (list: string[]) => list.filter(s => s.length <= 64 && MCP_SCOPE.test(s)).slice(0, 20)
  const g = new Set(granted)
  const q = new Set(requested)
  const extra = safe([...g].filter(s => !q.has(s)))
  const missing = safe([...q].filter(s => !g.has(s)))
  const parts: string[] = []
  if (extra.length) parts.push(`extra ${extra.join(',')}`)
  if (missing.length) parts.push(`missing ${missing.join(',')}`)
  return parts.join('; ')
}
