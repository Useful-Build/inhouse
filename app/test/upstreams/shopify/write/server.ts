// The fake Shopify write upstream (Stage 1 M2-C, N13): a separate invented store (`example-write.myshopify.com`) for
// the write-scoped Shopify app, so the recorded read fixture (`example-fixture.myshopify.com`) is never written to.
//
// Bundled into the hub's TEST build through app/hub/testing/index.ts ONLY, so:
// - NO npm packages (relative imports and runtime globals only).
// - Deterministic: no clock, no randomness.
// - Per-operation fault switch (one key per operation, M3-S1): 'succeed' | 'refuse' | 'timeout' (hangs until the caller's
//   deadline aborts) | 'broken_body' | 'throttle' (Shopify's THROTTLED with its cost extension; nothing runs).
// - Split as the hub is (M3-S1): this file holds the store, the sign-in and the routing; each operation's mutation is its
//   own file under ops/ (one line per operation in ops/index.ts).
// - Strict about the document (M3-S2, #489): an operation is picked by its kind and name, then answered only when the
//   request's text is exactly that operation's document and its variables exactly the declared ones (./gql.ts).
//   Anything else is a GraphQL error (`GRAPHQL_PARSE_FAILED`, `GRAPHQL_VALIDATION_FAILED`) and is kept in
//   `documentErrors`, so a test can say no request was malformed.
// - Idempotent mutations (M3-S2: stock and refunds): the same `idempotencyKey` with the same variables answers the first
//   answer again and changes nothing; with other variables it's an error and changes nothing.
// - scripts/check-hub-build.mjs proves SHOPIFY_WRITE_UPSTREAM_CANARY and this module are absent from the deployable bundle.

import { GqlError, mismatch, parseDocument } from './gql.js'
import { FAKE_WRITE_OPS, type FakeWriteOperationKey } from './ops/index.js'
import { levelKey } from './ops/inventory.js'

/** Found in the hub's test bundle only (scripts/check-hub-build.mjs reads this exact value). */
export const SHOPIFY_WRITE_UPSTREAM_CANARY = 'INHOUSE_SHOPIFY_WRITE_UPSTREAM_CANARY_9f4e'

export const SHOPIFY_WRITE_SHOP = 'example-write'
export const SHOPIFY_WRITE_HOST = `${SHOPIFY_WRITE_SHOP}.myshopify.com`
export const SHOPIFY_WRITE_TEST_CLIENT_ID = 'test-write-client'
export const SHOPIFY_WRITE_TEST_CLIENT_SECRET = 'test-only-write-client-secret-8d4a2f1c9b0e'
export const SHOPIFY_WRITE_API_VERSION = '2026-10'
export const SHOPIFY_WRITE_SCOPES = ['write_orders', 'write_draft_orders', 'write_inventory'] as const
export const SHOPIFY_WRITE_TOKEN_LIFETIME_S = 86399

export type WriteFault = 'succeed' | 'refuse' | 'timeout' | 'broken_body' | 'throttle'

export type FakeWriteOrder = {
  id: string
  name: string
  tags: string[]
}

/** A draft order the fake made: its lines and optional note and tags, exactly as received. */
export type FakeDraftOrder = { id: string; lines: { variantId: string; quantity: number }[]; note?: string; tags?: string[] }

/** The product variants a draft order may name (invented). */
export const WRITE_VARIANTS: readonly string[] = ['gid://shopify/ProductVariant/7001', 'gid://shopify/ProductVariant/7002', 'gid://shopify/ProductVariant/7003']

export const INITIAL_WRITE_ORDERS: readonly FakeWriteOrder[] = [
  { id: 'gid://shopify/Order/9001', name: '#9001', tags: ['existing'] },
  { id: 'gid://shopify/Order/9002', name: '#9002', tags: [] },
  { id: 'gid://shopify/Order/9003', name: '#9003', tags: ['vip'] },
]

/** Stage 1 M3-S2: the stock levels the fake starts with (`available` per item and location; invented). */
export const INITIAL_STOCK: readonly { item: string; location: string; available: number }[] = [
  { item: 'gid://shopify/InventoryItem/8001', location: 'gid://shopify/Location/601', available: 10 },
  { item: 'gid://shopify/InventoryItem/8002', location: 'gid://shopify/Location/601', available: 0 },
  { item: 'gid://shopify/InventoryItem/8001', location: 'gid://shopify/Location/602', available: 5 },
]

/**
 * Stage 1 M3-S2: an order the fake can refund, its money in cents. `unfulfilled` units are restocked as a cancel, fulfilled
 * ones as a return. `presentmentCurrency` other than the shop's is a multi-currency order.
 */
export type FakeRefundOrder = {
  id: string
  presentmentCurrency: string
  lines: { id: string; priceMinor: number; quantity: number; refunded: number; unfulfilled: number }[]
  shippingMinor: number
  shippingRefunded: number
  transactions: { id: string; gateway: string; amountMinor: number }[]
}
export type FakeRefund = { id: string; orderId: string; amountMinor: number; notify: boolean }

/** The shop's currency (`shop.currencyCode`). */
export const FAKE_SHOP_CURRENCY = 'USD'

/**
 * Order 9001: two fulfilled at $12.45 and three unfulfilled at $5.00, $5.00 shipping, one $44.90 sale. Order 9003: placed
 * in CAD (a multi-currency order the hub refuses to refund).
 */
export const INITIAL_REFUND_ORDERS: readonly FakeRefundOrder[] = [
  {
    id: 'gid://shopify/Order/9001',
    presentmentCurrency: 'USD',
    lines: [
      { id: 'gid://shopify/LineItem/90011', priceMinor: 1245, quantity: 2, refunded: 0, unfulfilled: 0 },
      { id: 'gid://shopify/LineItem/90012', priceMinor: 500, quantity: 3, refunded: 0, unfulfilled: 3 },
    ],
    shippingMinor: 500,
    shippingRefunded: 0,
    transactions: [{ id: 'gid://shopify/OrderTransaction/70001', gateway: 'bogus', amountMinor: 4490 }],
  },
  {
    id: 'gid://shopify/Order/9003',
    presentmentCurrency: 'CAD',
    lines: [{ id: 'gid://shopify/LineItem/90031', priceMinor: 1000, quantity: 1, refunded: 0, unfulfilled: 0 }],
    shippingMinor: 0,
    shippingRefunded: 0,
    transactions: [{ id: 'gid://shopify/OrderTransaction/70003', gateway: 'bogus', amountMinor: 1000 }],
  },
]

const copyRefundOrders = () => new Map(INITIAL_REFUND_ORDERS.map(o => [o.id, {
  ...o, lines: o.lines.map(l => ({ ...l })), transactions: o.transactions.map(t => ({ ...t })),
}]))
const copyStock = () => new Map(INITIAL_STOCK.map(l => [levelKey(l.item, l.location), l.available]))

export type ShopifyWriteRequestLog = { path: string; method: string; operation?: string }
/** A mutation the fake received. `replayed`: an idempotency key it had seen with the same variables (nothing ran again). */
export type ShopifyWriteCallLog = { operation: FakeWriteOperationKey; variables: Record<string, unknown>; outcome: WriteFault; replayed?: true }

/** The operations' faults, keyed by operation key; a key not set here is 'succeed'. */
export type WriteFaults = Partial<Record<FakeWriteOperationKey, WriteFault>>

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const gqlError = (message: string, code: string, version: string) =>
  json({ errors: [{ message, extensions: { code } }] }, 200, { 'X-Shopify-API-Version': version })

/** Shopify's throttle bucket as the fake reports it when its `throttle` fault is set: empty, refilling at 100 a second. */
export const FAKE_THROTTLE = { maximumAvailable: 2000, currentlyAvailable: 0, restoreRate: 100 } as const

export class FakeShopifyWriteUpstream {
  orders = new Map<string, FakeWriteOrder>(INITIAL_WRITE_ORDERS.map(o => [o.id, { ...o, tags: [...o.tags] }]))
  drafts: FakeDraftOrder[] = []
  variants = new Set<string>(WRITE_VARIANTS)
  stock = copyStock()
  adjustments = 0
  refundOrders = copyRefundOrders()
  refunds: FakeRefund[] = []
  currency = FAKE_SHOP_CURRENCY
  faults: WriteFaults = { 'shopify.order.tag_add': 'succeed' }
  requests: ShopifyWriteRequestLog[] = []
  writes: ShopifyWriteCallLog[] = []
  /** Queries answered (a refund's lookup, the shop's currency): they change nothing. */
  reads: { operation: FakeWriteOperationKey; variables: Record<string, unknown> }[] = []
  /** Documents refused for not being exactly an operation's document (#489). */
  documentErrors: string[] = []
  /** Idempotency keys seen: the variables sent with each and the first answer. */
  #idempotent = new Map<string, { variables: string; data: Record<string, unknown> }>()
  issuedTokens: string[] = []
  scope: string[] = [...SHOPIFY_WRITE_SCOPES]
  credentials = { clientId: SHOPIFY_WRITE_TEST_CLIENT_ID, clientSecret: SHOPIFY_WRITE_TEST_CLIENT_SECRET }
  apiVersion = SHOPIFY_WRITE_API_VERSION
  #tokens = new Set<string>()
  #issued = 0

  reset(): void {
    this.orders = new Map(INITIAL_WRITE_ORDERS.map(o => [o.id, { ...o, tags: [...o.tags] }]))
    this.drafts = []
    this.variants = new Set(WRITE_VARIANTS)
    this.stock = copyStock()
    this.adjustments = 0
    this.refundOrders = copyRefundOrders()
    this.refunds = []
    this.currency = FAKE_SHOP_CURRENCY
    this.faults = { 'shopify.order.tag_add': 'succeed' }
    this.requests = []
    this.writes = []
    this.reads = []
    this.documentErrors = []
    this.#idempotent = new Map()
    this.scope = [...SHOPIFY_WRITE_SCOPES]
  }

  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (req.method !== 'POST') {
      this.requests.push({ path: url.pathname, method: req.method })
      return new Response('method not allowed', { status: 405 })
    }

    if (url.pathname === '/admin/oauth/access_token') {
      this.requests.push({ path: url.pathname, method: req.method })
      const form = new URLSearchParams(await req.text())
      if (
        form.get('grant_type') !== 'client_credentials' ||
        form.get('client_id') !== this.credentials.clientId ||
        form.get('client_secret') !== this.credentials.clientSecret
      ) {
        return json({ error: 'invalid_client' }, 401)
      }
      const token = `shpat_write_test_${++this.#issued}`
      this.#tokens.add(token)
      this.issuedTokens.push(token)
      return json({ access_token: token, scope: this.scope.join(','), expires_in: SHOPIFY_WRITE_TOKEN_LIFETIME_S })
    }

    const m = /^\/admin\/api\/([^/]+)\/graphql\.json$/.exec(url.pathname)
    if (!m) {
      this.requests.push({ path: url.pathname, method: req.method })
      return new Response('not found', { status: 404 })
    }
    if (!this.#tokens.has(req.headers.get('X-Shopify-Access-Token') ?? '')) {
      this.requests.push({ path: url.pathname, method: req.method })
      return json({ errors: '[API] Invalid API key or access token' }, 401)
    }
    if (m[1] !== this.apiVersion) {
      this.requests.push({ path: url.pathname, method: req.method })
      return json({ data: null }, 200, { 'X-Shopify-API-Version': this.apiVersion })
    }

    let body: { query?: unknown; variables?: unknown }
    try {
      body = (await req.json()) as typeof body
    } catch {
      this.requests.push({ path: url.pathname, method: req.method })
      return gqlError('body is not JSON', 'BAD_REQUEST', this.apiVersion)
    }
    const text = typeof body.query === 'string' ? body.query : ''
    const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>
    let parsed: ReturnType<typeof parseDocument>
    try {
      parsed = parseDocument(text)
    } catch (e) {
      this.requests.push({ path: url.pathname, method: req.method })
      this.documentErrors.push(`parse: ${e instanceof GqlError ? e.message : 'unreadable'}`)
      return gqlError('the document does not parse', 'GRAPHQL_PARSE_FAILED', this.apiVersion)
    }
    const op = parsed.name
    this.requests.push({ path: url.pathname, method: req.method, operation: op || undefined })

    const handler = FAKE_WRITE_OPS.find(h => h.kind === parsed.kind && h.name === op)
    if (!handler) {
      return gqlError(`Access denied: write operation not supported (${SHOPIFY_WRITE_UPSTREAM_CANARY})`, 'ACCESS_DENIED', this.apiVersion)
    }
    let wrong: string | null
    try {
      wrong = mismatch(text, handler.document(variables), variables)
    } catch (e) {
      wrong = `expected document: ${e instanceof GqlError ? e.message : 'unreadable'}`
    }
    if (wrong) {
      this.documentErrors.push(`${op}: ${wrong}`)
      return gqlError(`${op}: ${wrong}`, 'GRAPHQL_VALIDATION_FAILED', this.apiVersion)
    }

    const fault = this.faults[handler.key] ?? 'succeed'
    const logged = JSON.parse(JSON.stringify(variables)) as Record<string, unknown>
    const seen = handler.idempotent && typeof variables.idempotencyKey === 'string' ? this.#idempotent.get(variables.idempotencyKey) : undefined
    if (handler.kind === 'query') this.reads.push({ operation: handler.key, variables: logged })
    else this.writes.push({ operation: handler.key, variables: logged, outcome: fault, ...(seen ? { replayed: true as const } : {}) })
    const headers = { 'X-Shopify-API-Version': this.apiVersion }
    if (seen) {
      // Shopify answers a repeated key with the first answer; another request under the same key is an error. Nothing runs.
      if (seen.variables !== JSON.stringify(variables)) return gqlError('idempotency key reused with other input', 'IDEMPOTENCY_KEY_MISMATCH', this.apiVersion)
      return json({ data: seen.data }, 200, headers)
    }

    if (fault === 'timeout') {
      // Hangs past the caller's deadline: answers only when the request's signal aborts, with the abort reason, as
      // fetch does. The write was received (logged above), so the caller can't know whether it ran.
      const signal = req.signal
      return new Promise<Response>((_, reject) => {
        if (signal.aborted) return reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    if (fault === 'broken_body') {
      return new Response(`{"data":{"${handler.root}":`, { status: 200, headers: { 'Content-Type': 'application/json', ...headers } })
    }
    if (fault === 'throttle') {
      // Shopify's THROTTLED: nothing runs; the cost extension says how far the bucket is short.
      return json({
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: { cost: { requestedQueryCost: handler.cost(variables), actualQueryCost: null, throttleStatus: { ...FAKE_THROTTLE } } },
      }, 200, headers)
    }
    const data = handler.run(this, variables, fault === 'refuse')
    if (handler.idempotent && typeof variables.idempotencyKey === 'string') {
      this.#idempotent.set(variables.idempotencyKey, { variables: JSON.stringify(variables), data: JSON.parse(JSON.stringify(data)) as Record<string, unknown> })
    }
    return json({ data }, 200, headers)
  }
}

export function createShopifyWriteUpstream(): FakeShopifyWriteUpstream {
  return new FakeShopifyWriteUpstream()
}
