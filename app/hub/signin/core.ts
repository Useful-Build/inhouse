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
import type { AccountStatus, HubErrorCode, HubResult, Instant, SignInState } from '../index/contract'
import { err, ok } from '../index/errors'
import { log } from '../index/log'
import { open, sameEnvelope, seal, type Envelope, type EnvelopeField } from '../crypto/envelope'
import type { KeyRing, KeyRingResult } from '../crypto/keyring'
import { checkGrantedScopes, describeScopeMismatch } from '../scope/scopes'
import { checkReadDocument } from '../scope/graphql'
import { API_VERSION, requestGrant, sendRead, type ShopifyConfig, type Upstream } from './providers/shopify'

export type SignInRecord = {
  v: 1
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
}

/** The synchronous subset of ctx.storage the core uses. */
export type SyncStore = {
  get<T>(key: string): T | undefined
  put<T>(key: string, value: T): void
  delete(key: string): boolean
  list<T>(prefix: string): Iterable<[string, T]>
  transactionSync<T>(fn: () => T): T
}

export type AlarmControl = { set(atMs: number): void; delete(): void }

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
}

export type QueryRequest = {
  accountId: string
  document: string
  variables?: Record<string, unknown>
  apiVersion: string
}

export type GrantOutcome = { ok: true; generation: number } | { ok: false; code: HubErrorCode; detail?: string }

const RECORD = 'record'
const PENDING = 'pending:'
export const EXPIRY_MARGIN_MS = 60_000
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const
export const MAX_PENDING_TTL_MS = 2 * 60 * 60_000

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

type Acquired = { ok: true; token: string; generation: number } | { ok: false; code: HubErrorCode; detail?: string }

export class SignInCore {
  readonly #d: SignInDeps
  #inflight: Promise<GrantOutcome> | null = null

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
    if (r0.state === 'disconnected') return { ok: false, code: 'not_configured', detail: 'disconnected' }
    const g0 = r0.generation
    const config = this.#d.shopify()
    if (!config) return { ok: false, code: 'not_configured' }
    const scopes = await this.#d.scopesFor(accountId)
    if (!scopes) return { ok: false, code: 'not_configured' }
    const ring = await this.#d.keyring()
    if (!ring.ok) return { ok: false, code: 'key_unavailable' }
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
    }
    this.#write(next)
    const due = refreshDueAt(next)
    if (due !== null) this.#d.alarm.set(due)
    log('signin_grant', { accountId, code: 'ok', generation: next.generation, kid: token.kid, state: 'active' })
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
      const g = await this.#grant(accountId)
      if (!g.ok) return g
    }
    return { ok: false, code: 'upstream_unavailable' }
  }

  async #lazyReseal(accountId: string, ring: KeyRing, r: SignInRecord, field: EnvelopeField, plaintext: string) {
    const before = r[field]
    const resealed = await seal(ring, accountId, field, plaintext)
    const now = this.#stillCurrent(accountId, r.generation)
    if (!now || !sameEnvelope(now[field], before)) {
      log('signin_grant_discarded', { accountId, generation: r.generation, kid: resealed.kid })
      return false
    }
    this.#write({ ...now, [field]: resealed })
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

    const r = this.#recordFor(accountId)
    if (!r) return err('internal')
    const config = this.#d.shopify()
    if (!config) return err('not_configured')
    const ring = await this.#d.keyring()
    if (!ring.ok) return err('key_unavailable')

    const first = await this.#acquire(accountId, ring.ring, true)
    if (!first.ok) return err(first.code, first.detail)
    const upstream = await this.#d.upstream()
    const sent = await sendRead(upstream, config, first.token, apiVersion, document as string, variables)
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
    const resent = await sendRead(upstream, config, second.token, apiVersion, document as string, variables)
    if (resent.kind === 'result') return resent.result
    // A second 401: rejected. The token is deleted under the generation check.
    this.#grantFailed(accountId, second.generation, 'credentials_rejected')
    return err('credentials_rejected')
  }

  status(accountId: string): HubResult<AccountStatus> {
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
    for (const field of ['token', 'refresh'] as const) {
      const current = this.#recordFor(accountId)
      if (!current) return err('internal')
      const envelope = current[field]
      if (!envelope || envelope.kid === ring.ring.current) continue
      const opened = await open(ring.ring, accountId, field, envelope)
      if (!opened.ok) {
        log(opened.reason === 'key_missing' ? 'signin_key_missing' : 'hub_internal', { accountId, kid: envelope.kid, code: 'key_unavailable' })
        return err('key_unavailable')
      }
      if (await this.#lazyReseal(accountId, ring.ring, current, field, opened.plaintext)) changed = true
    }
    const after = this.#recordFor(accountId)
    if (!after) return err('internal')
    return ok({ kid: after.token?.kid ?? ring.ring.current, changed })
  }

  /** P5's caller. Token and refresh deleted, generation + 1, alarm deleted; only P5's connect leaves this state. */
  disconnect(accountId: string): HubResult<{ generation: number }> {
    const r = this.#recordFor(accountId)
    if (!r) return err('internal')
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
    this.#d.alarm.delete()
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

  #sweepPending(): void {
    const nowMs = this.#d.now()
    const expired: string[] = []
    for (const [key, item] of this.#d.store.list<{ expiresAtMs: number }>(PENDING)) {
      if (nowMs >= item.expiresAtMs) expired.push(key)
    }
    for (const key of expired) this.#d.store.delete(key)
  }

  /** The alarm. Catches everything and sets its own next alarm, so the platform's retries never decide. */
  async alarm(): Promise<void> {
    try {
      this.#sweepPending()
      const r = this.#read()
      if (!r || r.state === 'disconnected') return
      const nowMs = this.#d.now()
      const due = refreshDueAt(r)
      if (usable(r, nowMs) && due !== null && nowMs < due) {
        // A repeated alarm that isn't due: no grant, no record change; the refresh alarm stays where it was.
        this.#d.alarm.set(due)
        return
      }
      const outcome = await this.#grant(r.accountId)
      if (!outcome.ok) this.#scheduleBackoff()
    } catch {
      log('hub_internal', { code: 'internal' })
      try {
        this.#scheduleBackoff()
      } catch {
        log('hub_internal', { code: 'internal' })
      }
    }
  }

  #scheduleBackoff(): void {
    const r = this.#read()
    if (!r || r.state === 'disconnected') return
    this.#d.alarm.set(this.#d.now() + backoffFor(r.failures))
  }
}
