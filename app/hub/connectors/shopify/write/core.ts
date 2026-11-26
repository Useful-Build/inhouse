// The Shopify write SignIn state machine (Stage 1 M2-C, N13, P6 W5): holds the write-scoped Shopify app's access token
// in its own SignIn Durable Object, sealed under the hub's KeyRing with AAD `shopify:store:write` (distinct from the
// read app's `shopify:store`). Never reads or falls back to the read app's credentials or token.
//
// Pure over injected store, clock, upstream, keyring, and config so the Node test project tests every branch and race.
import type { AccountStatus, HubErrorCode, HubResult, WriteResult } from '../../../index/contract'
import { open, sameEnvelope, seal, type Envelope } from '../../../crypto/envelope'
import type { KeyRing, KeyRingResult } from '../../../crypto/keyring'
import { log } from '../../../index/log'
import { checkGrantedScopes, describeScopeMismatch } from '../../../scope/scopes'
import { EXPIRY_MARGIN_MS, type SyncStore } from '../../../signin/core'
import { requestGrant, type ShopifyConfig, type Upstream } from '../../../signin/providers/shopify'
import {
  sendOrderTagsAdd,
  SHOPIFY_WRITE_ACCOUNT,
  SHOPIFY_WRITE_SCOPES,
  SHOPIFY_WRITE_SIGNIN_ACCOUNT,
  ShopifyOrderTagAddArgsSchema,
  writeErr,
} from './provider'

export type WriteTokenRecord = {
  v: 1
  token: Envelope | null
  obtainedAtMs: number | null
  expiresAtMs: number | null
  scopes: string[]
}

export type ShopifyWriteDeps = {
  store: SyncStore
  now: () => number
  upstream: () => Promise<Upstream>
  keyring: () => Promise<KeyRingResult>
  config: () => ShopifyConfig | null
  /** Reads the brand's Shopify account status (paused, disconnected, connectedAtMs) from the account SignIn DO. */
  accountStatus: (accountId: string) => Promise<HubResult<AccountStatus>>
  /** The write's deadline; tests shorten it. Defaults to `WRITE_TIMEOUT_MS`. */
  writeTimeoutMs?: number
}

const WRITE_RECORD_KEY = 'write_record'

/** Validates the brand's Shopify account state against `expect.connectedAtMs`. Returns a refusal WriteResult or null. */
export function checkShopifyAccountState(status: HubResult<AccountStatus>, expectedConnectedAtMs: number): WriteResult | null {
  if (!status.ok) return { ok: false, error: status.error, sent: 'no' }
  const s = status.value
  if (s.paused) return writeErr('paused', 'no')
  if (s.state === 'disconnected') return writeErr('not_configured', 'no', 'disconnected')
  if (s.state === 'failed') return writeErr('credentials_rejected', 'no')
  if (s.connectedAt === null || s.connectedAt.ms !== expectedConnectedAtMs) {
    return writeErr('connect_stale', 'no', 'connectedAtMs')
  }
  return null
}

export class ShopifyWriteCore {
  readonly #d: ShopifyWriteDeps
  #inflight: Promise<{ ok: true } | { ok: false; code: HubErrorCode; detail?: string }> | null = null

  constructor(deps: ShopifyWriteDeps) {
    this.#d = deps
  }

  #read(): WriteTokenRecord | undefined {
    return this.#d.store.get<WriteTokenRecord>(WRITE_RECORD_KEY)
  }

  #write(r: WriteTokenRecord): void {
    this.#d.store.put(WRITE_RECORD_KEY, r)
  }

  #grant(ring: KeyRing, config: ShopifyConfig, upstream: Upstream): Promise<{ ok: true } | { ok: false; code: HubErrorCode; detail?: string }> {
    if (this.#inflight) return this.#inflight
    const p = this.#doGrant(ring, config, upstream).finally(() => {
      if (this.#inflight === p) this.#inflight = null
    })
    this.#inflight = p
    return p
  }

  async #doGrant(ring: KeyRing, config: ShopifyConfig, upstream: Upstream): Promise<{ ok: true } | { ok: false; code: HubErrorCode; detail?: string }> {
    const grant = await requestGrant(upstream, config, this.#d.now)
    if (!grant.ok) return { ok: false, code: grant.code }
    const check = checkGrantedScopes(grant.scope, { read: SHOPIFY_WRITE_SCOPES, required: SHOPIFY_WRITE_SCOPES })
    if (!check.ok) return { ok: false, code: 'scope_mismatch', detail: describeScopeMismatch(check) }
    const token = await seal(ring, SHOPIFY_WRITE_SIGNIN_ACCOUNT, 'token', grant.accessToken)
    this.#write({
      v: 1,
      token,
      obtainedAtMs: grant.startMs,
      expiresAtMs: grant.expiresAtMs,
      scopes: check.scopes,
    })
    log('signin_grant', { accountId: SHOPIFY_WRITE_SIGNIN_ACCOUNT, code: 'ok', kid: token.kid, state: 'active' })
    return { ok: true }
  }

  async #acquire(
    ring: KeyRing,
    config: ShopifyConfig,
    upstream: Upstream,
  ): Promise<{ ok: true; token: string; envelope: Envelope; scopes: string[] } | { ok: false; code: HubErrorCode; detail?: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = this.#read()
      if (r?.token && r.expiresAtMs !== null && this.#d.now() < r.expiresAtMs - EXPIRY_MARGIN_MS) {
        const opened = await open(ring, SHOPIFY_WRITE_SIGNIN_ACCOUNT, 'token', r.token)
        if (opened.ok && this.#d.now() < r.expiresAtMs - EXPIRY_MARGIN_MS) {
          return { ok: true, token: opened.plaintext, envelope: r.token, scopes: [...r.scopes] }
        }
      }
      const g = await this.#grant(ring, config, upstream)
      if (!g.ok) return g
    }
    return { ok: false, code: 'upstream_unavailable' }
  }

  /**
   * Executes `shopify.order.tag_add`. Checks config, account status (paused, connectedAtMs), acquires the write-scoped
   * token, re-checks config, scopes, and account status again after every awaited step right before sending, and sends
   * once with no retry.
   */
  async orderTagAdd(req: {
    accountId: string
    expect: { connectedAtMs: number }
    args: unknown
  }): Promise<WriteResult> {
    if (req.accountId !== SHOPIFY_WRITE_ACCOUNT) return writeErr('invalid_args', 'no', 'accountId')
    const parsed = ShopifyOrderTagAddArgsSchema.safeParse(req.args)
    if (!parsed.success) return writeErr('invalid_args', 'no', parsed.error.issues[0]?.path.join('.') || 'args')

    const config = this.#d.config()
    if (!config) return writeErr('not_configured', 'no', 'shopify_write')

    // Pre-check account state before spending a token grant.
    const before = checkShopifyAccountState(await this.#d.accountStatus(req.accountId), req.expect.connectedAtMs)
    if (before) return before

    const ring = await this.#d.keyring()
    if (!ring.ok) return writeErr('key_unavailable', 'no')
    const upstream = await this.#d.upstream()

    const acquired = await this.#acquire(ring.ring, config, upstream)
    if (!acquired.ok) return writeErr(acquired.code, 'no', acquired.detail)

    // Re-check config, scopes, and account state right before the upstream write request (after every awaited step).
    const configNow = this.#d.config()
    if (!configNow) return writeErr('not_configured', 'no', 'shopify_write')
    if (!SHOPIFY_WRITE_SCOPES.every(s => acquired.scopes.includes(s))) {
      return writeErr('scope_mismatch', 'no', 'missing write_orders')
    }
    const rightBeforeSend = checkShopifyAccountState(await this.#d.accountStatus(req.accountId), req.expect.connectedAtMs)
    if (rightBeforeSend) return rightBeforeSend

    const sent = await sendOrderTagsAdd(upstream, configNow, acquired.token, parsed.data, this.#d.writeTimeoutMs)
    if (!sent.ok && sent.error.code === 'credentials_rejected') this.#dropRejected(acquired.envelope)
    return sent
  }

  /**
   * A 401 on the write: the token was revoked (or the app uninstalled), so it is deleted and the next write grants a new
   * one instead of reusing it until it expires. Only when the stored token is still the one that was rejected, so a
   * newer grant that landed during the send is kept. Synchronous: read and delete with no await in between.
   */
  #dropRejected(rejected: Envelope): void {
    const r = this.#read()
    if (!r?.token || !sameEnvelope(r.token, rejected)) return
    this.#d.store.delete(WRITE_RECORD_KEY)
    log('signin_grant', { accountId: SHOPIFY_WRITE_SIGNIN_ACCOUNT, code: 'credentials_rejected', state: 'failed' })
  }
}
