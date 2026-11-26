// The fake Shopify write upstream (Stage 1 M2-C, N13): a separate invented store (`example-write.myshopify.com`) for
// the write-scoped Shopify app, so the recorded read fixture (`example-fixture.myshopify.com`) is never written to.
//
// Bundled into the hub's TEST build through app/hub/testing/index.ts ONLY, so:
// - NO npm packages (relative imports and runtime globals only).
// - Deterministic: no clock, no randomness.
// - Per-operation fault switch: 'succeed' | 'refuse' | 'timeout' | 'broken_body'.
// - scripts/check-hub-build.mjs proves SHOPIFY_WRITE_UPSTREAM_CANARY and this module are absent from the deployable bundle.

/** Found in the hub's test bundle only (scripts/check-hub-build.mjs reads this exact value). */
export const SHOPIFY_WRITE_UPSTREAM_CANARY = 'INHOUSE_SHOPIFY_WRITE_UPSTREAM_CANARY_9f4e'

export const SHOPIFY_WRITE_SHOP = 'example-write'
export const SHOPIFY_WRITE_HOST = `${SHOPIFY_WRITE_SHOP}.myshopify.com`
export const SHOPIFY_WRITE_TEST_CLIENT_ID = 'test-write-client'
export const SHOPIFY_WRITE_TEST_CLIENT_SECRET = 'test-only-write-client-secret-8d4a2f1c9b0e'
export const SHOPIFY_WRITE_API_VERSION = '2026-10'
export const SHOPIFY_WRITE_SCOPES = ['write_orders'] as const
export const SHOPIFY_WRITE_TOKEN_LIFETIME_S = 86399

export type WriteFault = 'succeed' | 'refuse' | 'timeout' | 'broken_body'

export type FakeWriteOrder = {
  id: string
  name: string
  tags: string[]
}

export const INITIAL_WRITE_ORDERS: readonly FakeWriteOrder[] = [
  { id: 'gid://shopify/Order/9001', name: '#9001', tags: ['existing'] },
  { id: 'gid://shopify/Order/9002', name: '#9002', tags: [] },
  { id: 'gid://shopify/Order/9003', name: '#9003', tags: ['vip'] },
]

export type ShopifyWriteRequestLog = { path: string; method: string; operation?: string }
export type ShopifyWriteCallLog = { operation: string; variables: Record<string, unknown>; outcome: WriteFault }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const gqlError = (message: string, code: string, version: string) =>
  json({ errors: [{ message, extensions: { code } }] }, 200, { 'X-Shopify-API-Version': version })

export class FakeShopifyWriteUpstream {
  orders = new Map<string, FakeWriteOrder>(INITIAL_WRITE_ORDERS.map(o => [o.id, { ...o, tags: [...o.tags] }]))
  faults: Record<string, WriteFault> = { 'shopify.order.tag_add': 'succeed' }
  requests: ShopifyWriteRequestLog[] = []
  writes: ShopifyWriteCallLog[] = []
  issuedTokens: string[] = []
  scope: string[] = [...SHOPIFY_WRITE_SCOPES]
  credentials = { clientId: SHOPIFY_WRITE_TEST_CLIENT_ID, clientSecret: SHOPIFY_WRITE_TEST_CLIENT_SECRET }
  apiVersion = SHOPIFY_WRITE_API_VERSION
  #tokens = new Set<string>()
  #issued = 0

  reset(): void {
    this.orders = new Map(INITIAL_WRITE_ORDERS.map(o => [o.id, { ...o, tags: [...o.tags] }]))
    this.faults = { 'shopify.order.tag_add': 'succeed' }
    this.requests = []
    this.writes = []
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
    const head = /^\s*(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/.exec(text)
    const kind = head?.[1]
    const op = head?.[2] ?? ''
    this.requests.push({ path: url.pathname, method: req.method, operation: op || undefined })

    if (kind !== 'mutation' || op !== 'OrderTagsAdd') {
      return gqlError(`Access denied: write operation not supported (${SHOPIFY_WRITE_UPSTREAM_CANARY})`, 'ACCESS_DENIED', this.apiVersion)
    }

    const fault = this.faults['shopify.order.tag_add'] ?? 'succeed'
    this.writes.push({ operation: 'shopify.order.tag_add', variables: JSON.parse(JSON.stringify(variables)) as Record<string, unknown>, outcome: fault })

    if (fault === 'timeout') {
      throw new TypeError('fake: shopify write timed out')
    }
    if (fault === 'broken_body') {
      return new Response('{"data":{"tagsAdd":', {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Shopify-API-Version': this.apiVersion },
      })
    }
    if (fault === 'refuse') {
      return json(
        { data: { tagsAdd: { node: null, userErrors: [{ field: ['tags'], message: 'Refused by fake write upstream' }] } } },
        200,
        { 'X-Shopify-API-Version': this.apiVersion },
      )
    }

    const id = typeof variables.id === 'string' ? variables.id : ''
    const tags = Array.isArray(variables.tags) ? variables.tags.filter((t): t is string => typeof t === 'string') : []
    const order = this.orders.get(id)
    if (!order) {
      return json(
        { data: { tagsAdd: { node: null, userErrors: [{ field: ['id'], message: 'Order not found' }] } } },
        200,
        { 'X-Shopify-API-Version': this.apiVersion },
      )
    }
    for (const tag of tags) {
      if (!order.tags.includes(tag)) order.tags.push(tag)
    }
    return json(
      { data: { tagsAdd: { node: { id: order.id }, userErrors: [] } } },
      200,
      { 'X-Shopify-API-Version': this.apiVersion },
    )
  }
}

export function createShopifyWriteUpstream(): FakeShopifyWriteUpstream {
  return new FakeShopifyWriteUpstream()
}
