// The Shopify provider: the client credentials grant and the Admin GraphQL read call. The only URLs the hub builds
// are these two, from the validated shop handle. Every function returns a mapped outcome; nothing here throws on an
// upstream answer, and nothing from an upstream body, header or the secret reaches a result.
// Docs read 2026-11-20:
// - https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
// - https://shopify.dev/docs/api/admin-graphql and https://shopify.dev/docs/api/usage/response-codes
// - https://shopify.dev/docs/api/usage/versioning (X-Shopify-API-Version on fall-forward)
import type { HubErrorCode, HubResult } from '../../index/contract'
import { err, ok } from '../../index/errors'

export type Upstream = (req: Request) => Promise<Response>

export type ShopifyConfig = { shop: string; clientId: string; clientSecret: string }

const SHOP = /^[a-z0-9][a-z0-9-]{0,59}$/
export const API_VERSION = /^\d{4}-(01|04|07|10)$/
export const GRANT_TIMEOUT_MS = 10_000
export const QUERY_TIMEOUT_MS = 15_000
export const MAX_BODY_BYTES = 4 * 1024 * 1024

/** OC 10: `SHOPIFY_SHOP` and `SHOPIFY_CLIENT_ID` are vars, `SHOPIFY_CLIENT_SECRET` a secret. Null: not configured. */
export function parseShopifyConfig(env: {
  SHOPIFY_SHOP?: string
  SHOPIFY_CLIENT_ID?: string
  SHOPIFY_CLIENT_SECRET?: string
}): ShopifyConfig | null {
  const shop = env.SHOPIFY_SHOP
  const clientId = env.SHOPIFY_CLIENT_ID
  const clientSecret = env.SHOPIFY_CLIENT_SECRET
  if (typeof shop !== 'string' || !SHOP.test(shop)) return null
  if (typeof clientId !== 'string' || clientId.length === 0) return null
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) return null
  return { shop, clientId, clientSecret }
}

export type GrantOk = { ok: true; accessToken: string; scope: string | undefined; expiresAtMs: number; startMs: number }
export type GrantFail = { ok: false; code: Extract<HubErrorCode, 'upstream_unavailable' | 'credentials_rejected'> }

type Capped = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'failed' }

/**
 * Reads at most `limit` bytes of a body as UTF-8. `too_large` when it's larger (the rest is cancelled); `failed` when
 * the stream errors (the deadline included) or the bytes aren't valid UTF-8.
 */
async function readCapped(res: Response, limit: number): Promise<Capped> {
  if (!res.body) return { ok: true, text: '' }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        return { ok: false, reason: 'too_large' }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, reason: 'failed' }
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all) }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

/**
 * Runs `fn` under a deadline whose timer is cleared once `fn` settles (body read included). Not
 * AbortSignal.timeout(): its timer outlives the call, and a Durable Object with a pending timer isn't idle, so
 * eviction waits for it to fire (10 s after a grant, 15 s after a read, measured under workerd).
 */
async function withDeadline<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('upstream deadline', 'TimeoutError')), ms)
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** POST https://<shop>.myshopify.com/admin/oauth/access_token, form encoded, no `scope`. */
export function requestGrant(upstream: Upstream, config: ShopifyConfig, nowMs: () => number): Promise<GrantOk | GrantFail> {
  return withDeadline(GRANT_TIMEOUT_MS, signal => grant(upstream, config, nowMs, signal))
}

async function grant(upstream: Upstream, config: ShopifyConfig, nowMs: () => number, signal: AbortSignal): Promise<GrantOk | GrantFail> {
  const startMs = nowMs()
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })
  let res: Response
  try {
    res = await upstream(
      new Request(`https://${config.shop}.myshopify.com/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        redirect: 'manual',
        signal,
      }),
    )
  } catch {
    return { ok: false, code: 'upstream_unavailable' }
  }
  const capped = await readCapped(res, 64 * 1024)
  const text = capped.ok ? capped.text : null
  if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false, code: 'credentials_rejected' }
  if (text !== null && text.includes('shop_not_permitted')) return { ok: false, code: 'credentials_rejected' }
  if (res.status < 200 || res.status > 299 || text === null) return { ok: false, code: 'upstream_unavailable' }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, code: 'upstream_unavailable' }
  }
  if (typeof json !== 'object' || json === null) return { ok: false, code: 'upstream_unavailable' }
  const { access_token, scope, expires_in } = json as Record<string, unknown>
  if (typeof access_token !== 'string' || access_token.length === 0) return { ok: false, code: 'upstream_unavailable' }
  if (typeof expires_in !== 'number' || !Number.isSafeInteger(expires_in) || expires_in <= 0) {
    return { ok: false, code: 'upstream_unavailable' }
  }
  // A missing or non-string scope goes on to the scope check, which fails it closed (scope_mismatch).
  return {
    ok: true,
    accessToken: access_token,
    scope: typeof scope === 'string' ? scope : undefined,
    expiresAtMs: startMs + expires_in * 1000,
    startMs,
  }
}

export type ReadOutcome = { kind: 'unauthorized' } | { kind: 'result'; result: HubResult<{ data: unknown }> }

type GraphQLError = { extensions?: { code?: unknown } }
type Throttle = { requestedQueryCost?: unknown; currentlyAvailable?: unknown; restoreRate?: unknown }

/** POST https://<shop>.myshopify.com/admin/api/<version>/graphql.json with the access token. */
export function sendRead(
  upstream: Upstream,
  config: ShopifyConfig,
  token: string,
  apiVersion: string,
  document: string,
  variables: Record<string, unknown> | undefined,
): Promise<ReadOutcome> {
  return withDeadline(QUERY_TIMEOUT_MS, signal => read(upstream, config, token, apiVersion, document, variables, signal))
}

async function read(
  upstream: Upstream,
  config: ShopifyConfig,
  token: string,
  apiVersion: string,
  document: string,
  variables: Record<string, unknown> | undefined,
  signal: AbortSignal,
): Promise<ReadOutcome> {
  let res: Response
  try {
    res = await upstream(
      new Request(`https://${config.shop}.myshopify.com/admin/api/${apiVersion}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify(variables === undefined ? { query: document } : { query: document, variables }),
        redirect: 'manual',
        signal,
      }),
    )
  } catch {
    return { kind: 'result', result: err('upstream_unavailable') }
  }
  if (res.status === 401) {
    await res.body?.cancel().catch(() => {})
    return { kind: 'unauthorized' }
  }
  if (res.status >= 500 || res.status < 200 || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {})
    return { kind: 'result', result: err('upstream_unavailable') }
  }
  if (res.status >= 400) {
    await res.body?.cancel().catch(() => {})
    return { kind: 'result', result: err('upstream_rejected') }
  }
  const served = res.headers.get('X-Shopify-API-Version')
  if (served !== null && served !== apiVersion) {
    await res.body?.cancel().catch(() => {})
    return { kind: 'result', result: err('upstream_version_mismatch') }
  }
  // Stream errors and oversize both stop here; an oversize body is result_too_large, a broken one unavailable.
  const contentLength = Number(res.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => {})
    return { kind: 'result', result: err('result_too_large') }
  }
  const capped = await readCapped(res, MAX_BODY_BYTES)
  if (!capped.ok) return { kind: 'result', result: err(capped.reason === 'too_large' ? 'result_too_large' : 'upstream_unavailable') }
  const text = capped.text
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { kind: 'result', result: err('upstream_unavailable') }
  }
  if (typeof json !== 'object' || json === null) return { kind: 'result', result: err('upstream_unavailable') }
  const body = json as { data?: unknown; errors?: unknown; extensions?: { cost?: { throttleStatus?: Throttle; requestedQueryCost?: unknown } } }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const codes = (body.errors as GraphQLError[])
      .map(e => (typeof e?.extensions?.code === 'string' ? e.extensions.code : null))
      .filter((c): c is string => c !== null && /^[A-Z_]{1,64}$/.test(c))
    if (codes.includes('THROTTLED')) {
      const t = body.extensions?.cost?.throttleStatus ?? {}
      const requested = Number(body.extensions?.cost?.requestedQueryCost ?? t.requestedQueryCost)
      const available = Number(t.currentlyAvailable)
      const rate = Number(t.restoreRate)
      let seconds = 1
      if (Number.isFinite(requested) && Number.isFinite(available) && Number.isFinite(rate) && rate > 0) {
        seconds = Math.max(1, (requested - available) / rate)
      }
      return { kind: 'result', result: err('rate_limited', undefined, Math.ceil(seconds * 1000)) }
    }
    const unique = [...new Set(codes)].slice(0, 10)
    return { kind: 'result', result: err('upstream_rejected', unique.length ? unique.join(',') : undefined) }
  }
  if (!('data' in body)) return { kind: 'result', result: err('upstream_unavailable') }
  return { kind: 'result', result: ok({ data: body.data }) }
}
