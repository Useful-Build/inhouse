// Test kit for the SignIn core (tests only; never imported by hub code, so never bundled). An in-memory synchronous
// store, a fake clock and alarm, and a fake Shopify upstream that issues tokens and checks them on every read.
import type { KeyRingResult } from '../../crypto/keyring'
import { parseKeyRing } from '../../crypto/keyring'
import type { ShopifyConfig, Upstream } from '../providers/shopify'
import { SignInCore, type SignInRecord, type SyncStore } from '../core'

export class MemStore implements SyncStore {
  map = new Map<string, unknown>()
  get<T>(key: string): T | undefined {
    const v = this.map.get(key)
    return v === undefined ? undefined : (structuredClone(v) as T)
  }
  put<T>(key: string, value: T): void {
    this.map.set(key, structuredClone(value))
  }
  delete(key: string): boolean {
    return this.map.delete(key)
  }
  *list<T>(prefix: string): Iterable<[string, T]> {
    for (const [k, v] of [...this.map]) if (k.startsWith(prefix)) yield [k, structuredClone(v) as T]
  }
  transactionSync<T>(fn: () => T): T {
    const snapshot = new Map(this.map)
    try {
      return fn()
    } catch (e) {
      this.map = snapshot
      throw e
    }
  }
  record(): SignInRecord | undefined {
    return this.get<SignInRecord>('record')
  }
}

export class FakeAlarm {
  at: number | null = null
  history: (number | null)[] = []
  /** Makes set and delete reject, as a failed storage write would. */
  fail = false
  async set(atMs: number) {
    if (this.fail) throw new Error('alarm write failed')
    this.at = atMs
    this.history.push(atMs)
  }
  async delete() {
    if (this.fail) throw new Error('alarm write failed')
    this.at = null
    this.history.push(null)
  }
}

export const START_MS = Date.UTC(2026, 10, 20, 6, 0, 0)
export const LIFETIME_S = 86399

/** A ring JSON with fresh random keys. */
export function ringJson(kids: string[], current: string, keys: Map<string, string> = new Map()): string {
  const out: Record<string, string> = {}
  for (const kid of kids) {
    let k = keys.get(kid)
    if (!k) {
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      k = btoa(String.fromCharCode(...bytes))
      keys.set(kid, k)
    }
    out[kid] = k
  }
  return JSON.stringify({ current, keys: out })
}

export type GrantMode =
  | { kind: 'ok' }
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'body'; body: string }
  | { kind: 'throw' }

export type ReadMode = { kind: 'ok' } | { kind: 'response'; make: () => Response } | { kind: 'throw' }

/** A fake shop. Tokens are checked on every read: unknown, revoked or unusable tokens answer 401. */
export class FakeShop {
  now: () => number
  grants = 0
  grantsInFlight = 0
  maxGrantsInFlight = 0
  count401 = 0
  reads: { token: string; atMs: number; usableAtSend: boolean }[] = []
  tokens = new Map<string, { expiresAtMs: number; revoked: boolean }>()
  scope = 'read_orders,read_returns'
  expiresIn: number = LIFETIME_S
  grantMode: GrantMode = { kind: 'ok' }
  readMode: ReadMode = { kind: 'ok' }
  /** The next access token to issue; default `tok-<n>`. */
  nextToken: (() => string) | null = null
  /** Wraps each delivery (fast-check's scheduler, in interleaving tests). */
  deliver: <T>(p: Promise<T>, label: string) => Promise<T> = p => p
  hosts = new Set<string>()
  apiVersionHeader: string | null = null

  constructor(now: () => number) {
    this.now = now
  }

  revokeAll() {
    for (const t of this.tokens.values()) t.revoked = true
  }

  upstream: Upstream = async (req: Request) => {
    const url = new URL(req.url)
    this.hosts.add(url.host)
    if (url.pathname === '/admin/oauth/access_token') {
      this.grants++
      this.grantsInFlight++
      this.maxGrantsInFlight = Math.max(this.maxGrantsInFlight, this.grantsInFlight)
      const res = this.#grant(await req.text())
      return this.deliver(res, 'grant').finally(() => {
        this.grantsInFlight--
      })
    }
    const token = req.headers.get('X-Shopify-Access-Token') ?? ''
    const t = this.tokens.get(token)
    const atMs = this.now()
    const usableAtSend = !!t && atMs < t.expiresAtMs - 60_000
    this.reads.push({ token, atMs, usableAtSend })
    let res: Promise<Response>
    if (!t || t.revoked || atMs >= t.expiresAtMs) {
      this.count401++
      res = Promise.resolve(new Response('{"errors":"[API] Invalid API key or access token"}', { status: 401 }))
    } else if (this.readMode.kind === 'throw') {
      res = Promise.reject(new TypeError('network down'))
    } else if (this.readMode.kind === 'response') {
      res = Promise.resolve(this.readMode.make())
    } else {
      const version = this.apiVersionHeader ?? url.pathname.split('/')[3] ?? ''
      res = Promise.resolve(
        new Response(JSON.stringify({ data: { shop: { name: 'Example Fixture' } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Shopify-API-Version': version },
        }),
      )
    }
    return this.deliver(res, 'read')
  }

  #grant(body: string): Promise<Response> {
    const form = new URLSearchParams(body)
    if (form.has('scope') || form.get('grant_type') !== 'client_credentials') {
      return Promise.resolve(new Response('{"error":"invalid_request"}', { status: 400 }))
    }
    const m = this.grantMode
    if (m.kind === 'throw') return Promise.reject(new TypeError('network down'))
    if (m.kind === 'status') return Promise.resolve(new Response(m.body ?? '{"error":"x"}', { status: m.status }))
    if (m.kind === 'body') return Promise.resolve(new Response(m.body, { status: 200 }))
    const token = this.nextToken ? this.nextToken() : `tok-${this.grants}-${crypto.randomUUID()}`
    this.tokens.set(token, { expiresAtMs: this.now() + this.expiresIn * 1000, revoked: false })
    return Promise.resolve(
      new Response(JSON.stringify({ access_token: token, scope: this.scope, expires_in: this.expiresIn }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }
}

export const ACCOUNT = 'shopify:store'
export const SCOPES = { read: ['read_orders', 'read_products', 'read_returns'], required: ['read_returns'] } as const
export const API = '2026-10'

export type Harness = {
  core: SignInCore
  store: MemStore
  alarm: FakeAlarm
  shop: FakeShop
  clock: { ms: number }
  ring: { json: string | undefined }
  config: { value: ShopifyConfig | null }
}

export function harness(opts: { store?: MemStore; ring?: { json: string | undefined }; clock?: { ms: number }; secret?: string } = {}): Harness {
  const clock = opts.clock ?? { ms: START_MS }
  const store = opts.store ?? new MemStore()
  const alarm = new FakeAlarm()
  const shop = new FakeShop(() => clock.ms)
  const ring = opts.ring ?? { json: ringJson(['k1'], 'k1') }
  const config = { value: { shop: 'example-fixture', clientId: 'test-client', clientSecret: opts.secret ?? 'test-secret' } as ShopifyConfig | null }
  const core = new SignInCore({
    store,
    now: () => clock.ms,
    alarm,
    upstream: async () => shop.upstream,
    keyring: (): Promise<KeyRingResult> => parseKeyRing(ring.json),
    shopify: () => config.value,
    scopesFor: async id => (id === ACCOUNT ? SCOPES : null),
  })
  return { core, store, alarm, shop, clock, ring, config }
}

export const readQuery = (h: Harness, document = '{ shop { currencyCode } }') => h.core.query({ accountId: ACCOUNT, document, apiVersion: API })

