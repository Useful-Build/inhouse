// Shopify write provider (Stage 1 M2-C, N13): the write-scoped Shopify app's config parser, strict argument schemas,
// and single-send Admin GraphQL mutations. Never reads SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET (the
// read app's credentials). Never retries a write. Returns `sent: 'no'` only when sure nothing executed; everything else
// is `sent: 'unknown'`. Never returns an upstream body, header, token, or secret.
// Docs read 2026-11-26 (Admin GraphQL 2026-10):
// - https://shopify.dev/docs/api/admin-graphql/latest/mutations/tagsAdd (id: ID!, tags: [String!]!; scope write_orders)
import { z } from 'zod'
import type { HubErrorCode, WriteResult } from '../../../index/contract'
import { hubError } from '../../../index/errors'
import type { ShopifyConfig, Upstream } from '../../../signin/providers/shopify'

export const SHOPIFY_WRITE_API_VERSION = '2026-10'
export const SHOPIFY_WRITE_ACCOUNT = 'shopify:store' as const
export const SHOPIFY_WRITE_SIGNIN_ACCOUNT = 'shopify:store:write' as const
export const SHOPIFY_WRITE_SCOPES = ['write_orders'] as const
export const WRITE_TIMEOUT_MS = 15_000
export const WRITE_MAX_BODY_BYTES = 64 * 1024

const SHOP = /^[a-z0-9][a-z0-9-]{0,59}$/
const ORDER_GID = /^gid:\/\/shopify\/Order\/([1-9]\d{0,19})$/
// Tags: 1..40 chars, no commas or control characters.
// eslint-disable-next-line no-control-regex -- rejecting control characters is intentional
const TAG_RE = /^[^\u0000-\u001F\u007F,]{1,40}$/

export const ShopifyOrderTagAddArgsSchema = z.strictObject({
  orderId: z.string().regex(ORDER_GID),
  tags: z.array(z.string().trim().regex(TAG_RE)).min(1).max(5),
})
export type ShopifyOrderTagAddArgs = z.infer<typeof ShopifyOrderTagAddArgsSchema>

export const ORDER_TAGS_ADD_MUTATION = `mutation OrderTagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    node {
      id
    }
    userErrors {
      field
      message
    }
  }
}`

/**
 * Write app credentials ONLY (`SHOPIFY_WRITE_SHOP`, `SHOPIFY_WRITE_CLIENT_ID`, `SHOPIFY_WRITE_CLIENT_SECRET`).
 * Never falls back to the read app's `SHOPIFY_*` variables.
 */
export function parseShopifyWriteConfig(env: {
  SHOPIFY_WRITE_SHOP?: string
  SHOPIFY_WRITE_CLIENT_ID?: string
  SHOPIFY_WRITE_CLIENT_SECRET?: string
}): ShopifyConfig | null {
  const shop = env.SHOPIFY_WRITE_SHOP
  const clientId = env.SHOPIFY_WRITE_CLIENT_ID
  const clientSecret = env.SHOPIFY_WRITE_CLIENT_SECRET
  if (typeof shop !== 'string' || !SHOP.test(shop)) return null
  if (typeof clientId !== 'string' || clientId.length === 0) return null
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) return null
  return { shop, clientId, clientSecret }
}

export const writeErr = (code: HubErrorCode, sent: 'no' | 'unknown', detail?: string, retryAfterMs?: number): WriteResult => ({
  ok: false,
  error: hubError(code, detail, retryAfterMs),
  sent,
})

type Capped = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'failed' }

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

async function withDeadline<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('upstream deadline', 'TimeoutError')), ms)
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** Definite pre-execution GraphQL error codes where Shopify rejected the request before mutating. */
const DEFINITE_GQL_REFUSALS = new Set(['ACCESS_DENIED', 'BAD_REQUEST', 'INVALID', 'GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED'])

/** Safe human-readable ref for a successful tag add (order id digits + tag names, bounded). */
export function formatOrderTagRef(orderId: string, tags: readonly string[]): string {
  const num = ORDER_GID.exec(orderId)?.[1] ?? 'order'
  return `order ${num}: ${tags.join(', ')}`.slice(0, 500)
}

/**
 * Sends one `tagsAdd` mutation to the write shop's Admin GraphQL endpoint. Never retries.
 * `sent: 'no'` only when Shopify definitively refused before executing; any ambiguous failure is `sent: 'unknown'`.
 */
export function sendOrderTagsAdd(
  upstream: Upstream,
  config: ShopifyConfig,
  token: string,
  args: ShopifyOrderTagAddArgs,
): Promise<WriteResult> {
  return withDeadline(WRITE_TIMEOUT_MS, signal => send(upstream, config, token, args, signal))
}

async function send(
  upstream: Upstream,
  config: ShopifyConfig,
  token: string,
  args: ShopifyOrderTagAddArgs,
  signal: AbortSignal,
): Promise<WriteResult> {
  let res: Response
  try {
    res = await upstream(
      new Request(`https://${config.shop}.myshopify.com/admin/api/${SHOPIFY_WRITE_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: ORDER_TAGS_ADD_MUTATION, variables: { id: args.orderId, tags: args.tags } }),
        redirect: 'manual',
        signal,
      }),
    )
  } catch {
    return writeErr('upstream_unavailable', 'unknown')
  }

  if (res.status === 401) {
    await res.body?.cancel().catch(() => {})
    return writeErr('credentials_rejected', 'no')
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('Retry-After'))
    await res.body?.cancel().catch(() => {})
    return writeErr('rate_limited', 'no', undefined, Number.isFinite(ra) && ra > 0 ? Math.ceil(ra * 1000) : undefined)
  }
  if (res.status >= 500 || res.status < 200 || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {})
    return writeErr('upstream_unavailable', 'unknown')
  }
  if (res.status >= 400) {
    await res.body?.cancel().catch(() => {})
    return writeErr('upstream_rejected', 'no')
  }

  const served = res.headers.get('X-Shopify-API-Version')
  if (served !== null && served !== SHOPIFY_WRITE_API_VERSION) {
    await res.body?.cancel().catch(() => {})
    return writeErr('upstream_version_mismatch', 'unknown')
  }

  const contentLength = Number(res.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > WRITE_MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => {})
    return writeErr('result_too_large', 'unknown')
  }

  const capped = await readCapped(res, WRITE_MAX_BODY_BYTES)
  if (!capped.ok) return writeErr(capped.reason === 'too_large' ? 'result_too_large' : 'upstream_unavailable', 'unknown')

  let json: unknown
  try {
    json = JSON.parse(capped.text)
  } catch {
    return writeErr('upstream_unavailable', 'unknown')
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return writeErr('upstream_unavailable', 'unknown')
  }

  const body = json as { data?: unknown; errors?: unknown }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const codes = (body.errors as { extensions?: { code?: unknown } }[])
      .map(e => (typeof e?.extensions?.code === 'string' ? e.extensions.code : null))
      .filter((c): c is string => c !== null && /^[A-Z_]{1,64}$/.test(c))
    if (codes.includes('THROTTLED')) return writeErr('rate_limited', 'no')
    if (codes.length > 0 && codes.every(c => DEFINITE_GQL_REFUSALS.has(c))) {
      const unique = [...new Set(codes)].slice(0, 10)
      return writeErr('upstream_rejected', 'no', unique.join(','))
    }
    return writeErr('upstream_unavailable', 'unknown')
  }

  if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
    return writeErr('upstream_unavailable', 'unknown')
  }
  const tagsAdd = (body.data as Record<string, unknown>).tagsAdd
  if (typeof tagsAdd !== 'object' || tagsAdd === null || Array.isArray(tagsAdd)) {
    return writeErr('upstream_unavailable', 'unknown')
  }
  const payload = tagsAdd as { node?: unknown; userErrors?: unknown }
  if (!Array.isArray(payload.userErrors)) {
    return writeErr('upstream_unavailable', 'unknown')
  }
  if (payload.userErrors.length > 0) {
    return writeErr('upstream_rejected', 'no')
  }
  if (typeof payload.node !== 'object' || payload.node === null || (payload.node as { id?: unknown }).id !== args.orderId) {
    return writeErr('upstream_unavailable', 'unknown')
  }
  return { ok: true, value: { ref: formatOrderTagRef(args.orderId, args.tags) } }
}
