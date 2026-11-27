// The Shopify write SignIn state machine (Stage 1 M2-C, N13, P6 W5; every operation in `ops/` since M3-S1): holds the write-scoped Shopify app's access token
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
import { isShopifyWriteKey, SHOPIFY_WRITE_OPS } from './ops/index'
import { CURRENCY_CODE } from './ops/money'
import { postMutation, SHOPIFY_WRITE_ACCOUNT, SHOPIFY_WRITE_SCOPES, SHOPIFY_WRITE_SIGNIN_ACCOUNT, writeErr, type ShopifyWriteScope } from './provider'

/** One Shopify write as the gateway hands it over (`WriteRequest`'s operation, account, expectation and arguments). */
export type ShopifyWriteInput = {
  operation: string
  accountId: string
  expect: { connectedAtMs: number; shop?: string }
  args: unknown
  /** Stage 1 M3-S2: `WriteRequest.idempotencyKey`, required by an operation whose mutation takes one (`ops/`). */
  idempotencyKey?: string
}

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
const CURRENCY_KEY = 'shop_currency'
/** How long a read currency is kept before it's read again (Stage 1 M3-S2). A shop rarely changes its currency. */
export const CURRENCY_MAX_AGE_MS = 24 * 3600_000

/** The write store's currency as last read (`shop.currencyCode`), for the store it was read from. */
type CurrencyRecord = { v: 1; shop: string; code: string; readAtMs: number }

const SHOP_CURRENCY_QUERY = `query ShopCurrency {
  shop {
    currencyCode
  }
}`

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

  /**
   * The write token, granted when there's none, it's near expiry, or (#490) the stored grant's scopes don't cover `need`:
   * a token granted before an operation's scope was added would otherwise refuse that operation (`scope_mismatch`) until
   * it expired. A new grant must hold every write scope (`#doGrant`), so a second miss is the grant's own refusal.
   */
  async #acquire(
    ring: KeyRing,
    config: ShopifyConfig,
    upstream: Upstream,
    need: ShopifyWriteScope | null,
  ): Promise<{ ok: true; token: string; envelope: Envelope; scopes: string[] } | { ok: false; code: HubErrorCode; detail?: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = this.#read()
      const covers = r !== undefined && (need === null || r.scopes.includes(need))
      if (r?.token && covers && r.expiresAtMs !== null && this.#d.now() < r.expiresAtMs - EXPIRY_MARGIN_MS) {
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
   * Re-checks config, the approved store, the operation's scope and the account status right before an upstream request,
   * after every awaited step. Null when the request may go.
   */
  async #recheck(req: ShopifyWriteInput, scope: ShopifyWriteScope, scopes: readonly string[]): Promise<WriteResult | null> {
    const configNow = this.#d.config()
    if (!configNow) return writeErr('not_configured', 'no', 'shopify_write')
    if (configNow.shop !== req.expect.shop) return writeErr('connect_stale', 'no', 'shop')
    if (!scopes.includes(scope)) return writeErr('scope_mismatch', 'no', `missing ${scope}`)
    return checkShopifyAccountState(await this.#d.accountStatus(req.accountId), req.expect.connectedAtMs)
  }

  /**
   * Runs one Shopify write operation (`ops/`). Checks the operation, its arguments and idempotency key, config, the
   * approved store and account status (paused, connectedAtMs), acquires a write token whose grant covers the operation's
   * scope, then re-checks config, the store, the scope and the account status after every awaited step right before each
   * upstream request. An operation with a lookup (a refund) sends that one query first: any way it fails is `sent: 'no'`
   * (a query changes nothing), and its answer may refuse the write. Then one mutation document, once, with no retry.
   */
  async run(req: ShopifyWriteInput): Promise<WriteResult> {
    if (!isShopifyWriteKey(req.operation)) return writeErr('unknown_tool', 'no')
    const op = SHOPIFY_WRITE_OPS[req.operation]
    if (req.accountId !== SHOPIFY_WRITE_ACCOUNT) return writeErr('invalid_args', 'no', 'accountId')
    // Stage 1 M2-G: the store the action was approved for. Required: a write never goes to a store nobody named.
    if (req.expect.shop === undefined) return writeErr('invalid_args', 'no', 'expect.shop')
    const prepared = op.prepare(req.args, req.idempotencyKey)
    if (!prepared.ok) return writeErr('invalid_args', 'no', prepared.path)

    const config = this.#d.config()
    if (!config) return writeErr('not_configured', 'no', 'shopify_write')
    // The write app points at another store than the one approved (a store change with no request since): refused.
    if (config.shop !== req.expect.shop) return writeErr('connect_stale', 'no', 'shop')

    // Pre-check account state before spending a token grant.
    const before = checkShopifyAccountState(await this.#d.accountStatus(req.accountId), req.expect.connectedAtMs)
    if (before) return before

    const ring = await this.#d.keyring()
    if (!ring.ok) return writeErr('key_unavailable', 'no')
    const upstream = await this.#d.upstream()

    const acquired = await this.#acquire(ring.ring, config, upstream, op.scope)
    if (!acquired.ok) return writeErr(acquired.code, 'no', acquired.detail)

    let lookupData: Record<string, unknown> | null = null
    if (prepared.call.lookup) {
      const beforeLookup = await this.#recheck(req, op.scope, acquired.scopes)
      if (beforeLookup) return beforeLookup
      const looked = await postMutation(upstream, this.#d.config() ?? config, acquired.token, prepared.call.lookup, this.#d.writeTimeoutMs)
      if (!looked.ok) {
        if (looked.result.ok === false && looked.result.error.code === 'credentials_rejected') this.#dropRejected(acquired.envelope)
        // A query changes nothing: whatever its answer, the write didn't happen.
        return looked.result.ok ? writeErr('internal', 'no') : { ...looked.result, sent: 'no' }
      }
      lookupData = looked.data
    }
    const step = prepared.call.mutation(lookupData)
    if (!step.ok) return step.result

    // Re-check config, scopes, and account state right before the upstream write request (after every awaited step).
    const rightBeforeSend = await this.#recheck(req, op.scope, acquired.scopes)
    if (rightBeforeSend) return rightBeforeSend
    const configNow = this.#d.config()
    if (!configNow) return writeErr('not_configured', 'no', 'shopify_write')

    const answer = await postMutation(upstream, configNow, acquired.token, step.doc, this.#d.writeTimeoutMs)
    if (!answer.ok) {
      if (answer.result.ok === false && answer.result.error.code === 'credentials_rejected') this.#dropRejected(acquired.envelope)
      return answer.result
    }
    return step.read(answer.data)
  }

  /**
   * Stage 1 M3-S2 (N21): the write store's currency (`shop.currencyCode`), for the connect/status answer the product copies
   * into `connector_accounts`. Read with the write token at most once a day per store and kept; null when there's no
   * config, no token or no readable answer (the product then refuses every refund). One query, no retry.
   */
  async currency(): Promise<string | null> {
    const config = this.#d.config()
    if (!config) return null
    const kept = this.#d.store.get<CurrencyRecord>(CURRENCY_KEY)
    if (kept?.shop === config.shop && this.#d.now() - kept.readAtMs < CURRENCY_MAX_AGE_MS) return kept.code
    const ring = await this.#d.keyring()
    if (!ring.ok) return null
    const upstream = await this.#d.upstream()
    const acquired = await this.#acquire(ring.ring, config, upstream, null)
    if (!acquired.ok) return null
    const answer = await postMutation(upstream, config, acquired.token, { query: SHOP_CURRENCY_QUERY, variables: {} }, this.#d.writeTimeoutMs)
    if (!answer.ok) {
      if (answer.result.ok === false && answer.result.error.code === 'credentials_rejected') this.#dropRejected(acquired.envelope)
      log('hub_internal', { code: 'shop_currency_unread' })
      return null
    }
    const shop = answer.data.shop
    const code = typeof shop === 'object' && shop !== null ? (shop as { currencyCode?: unknown }).currencyCode : undefined
    if (typeof code !== 'string' || !CURRENCY_CODE.test(code)) {
      log('hub_internal', { code: 'shop_currency_unread' })
      return null
    }
    // The store may have changed while the query was out: keep only an answer for the store configured now.
    if (this.#d.config()?.shop !== config.shop) return null
    this.#d.store.put(CURRENCY_KEY, { v: 1, shop: config.shop, code, readAtMs: this.#d.now() } satisfies CurrencyRecord)
    return code
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
