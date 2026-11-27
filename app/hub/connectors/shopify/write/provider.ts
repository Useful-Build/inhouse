// Shopify write provider (Stage 1 M2-C, N13; split per operation in M3-S1): the write-scoped Shopify app's config
// parser and the one Admin GraphQL transport every write operation shares (`ops/`). Never reads SHOPIFY_SHOP /
// SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET (the read app's credentials). Never retries a write. Returns `sent: 'no'`
// only when sure nothing executed; everything else is `sent: 'unknown'`. Never returns an upstream body, header, token,
// or secret.
// Docs read 2026-11-27 (Admin GraphQL 2026-10):
// - https://shopify.dev/docs/api/admin-graphql/latest/mutations/tagsAdd (id: ID!, tags: [String!]!; write_orders for an order)
// - https://shopify.dev/docs/api/admin-graphql/latest/mutations/tagsRemove (the same shape)
// - https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderCreate (input: DraftOrderInput!; write_draft_orders)
// - https://shopify.dev/docs/api/admin-graphql#rate-limits (`THROTTLED`; `extensions.cost.throttleStatus`)
// Stage 1 M3-S2, read 2026-11-27 (2026-10):
// - https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryAdjustQuantities (write_inventory; the
//   `@idempotent(key:)` directive is required since 2026-04)
// - https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryChangeInput (`changeFromQuantity` must be
//   passed; null skips the compare-and-swap)
// - https://shopify.dev/docs/apps/fulfillment/inventory-management-apps/quantities-states (the `reason` list)
// - https://shopify.dev/docs/api/admin-graphql/latest/mutations/refundCreate (the `orders` scope, i.e. write_orders for a
//   write; `@idempotent` required since 2026-04) and .../input-objects/RefundInput, RefundLineItemInput,
//   OrderTransactionInput, ShippingRefundInput, .../enums/RefundLineItemRestockType
// - https://shopify.dev/docs/api/admin-graphql/latest/objects/Order (`suggestedRefund`, `currencyCode`,
//   `presentmentCurrencyCode`), .../objects/SuggestedRefund, .../objects/SuggestedOrderTransaction
// - https://shopify.dev/docs/api/admin-graphql/latest/objects/Shop (`currencyCode`)
import type { HubErrorCode, WriteResult } from '../../../index/contract'
import { hubError } from '../../../index/errors'
import type { ShopifyConfig, Upstream } from '../../../signin/providers/shopify'

export const SHOPIFY_WRITE_API_VERSION = '2026-10'
export const SHOPIFY_WRITE_ACCOUNT = 'shopify:store' as const
export const SHOPIFY_WRITE_SIGNIN_ACCOUNT = 'shopify:store:write' as const
/** Every scope the write app's grant must hold; each operation names the one it needs (`ops/`). */
export const SHOPIFY_WRITE_SCOPES = ['write_orders', 'write_draft_orders', 'write_inventory'] as const
export type ShopifyWriteScope = (typeof SHOPIFY_WRITE_SCOPES)[number]
export const WRITE_TIMEOUT_MS = 15_000
export const WRITE_MAX_BODY_BYTES = 64 * 1024
/** The longest wait a throttled answer may name (the contract's bound: a day). */
const RETRY_AFTER_MAX_MS = 86_400_000

const SHOP = /^[a-z0-9][a-z0-9-]{0,59}$/

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

/**
 * Runs `fn` under a deadline: at `ms` the signal aborts and the answer is `onDeadline()`, even when the upstream ignores
 * the signal (a race, not only an abort), so a hung write never holds the caller past the deadline.
 */
async function withDeadline<T>(ms: number, onDeadline: () => T, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>(resolve => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('upstream deadline', 'TimeoutError'))
      resolve(onDeadline())
    }, ms)
  })
  try {
    return await Promise.race([fn(controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Definite pre-execution GraphQL error codes where Shopify rejected the request before mutating. */
const DEFINITE_GQL_REFUSALS = new Set(['ACCESS_DENIED', 'BAD_REQUEST', 'INVALID', 'GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED'])

/** One mutation document: its text and its variables (built by an operation in `ops/`, never from upstream text). */
export type MutationDoc = { query: string; variables: Record<string, unknown> }

/** The transport's answer: the response's `data` object (the operation reads it), or a finished WriteResult. */
export type MutationAnswer = { ok: true; data: Record<string, unknown> } | { ok: false; result: WriteResult }

/**
 * A throttled answer's wait, from Shopify's cost extension: the points the request asked for beyond what's available now,
 * at the bucket's restore rate. Undefined when the extension is absent or doesn't add up (the batch then waits its
 * default, `THROTTLE_WAIT_MS`).
 */
export function throttleWaitMs(extensions: unknown): number | undefined {
  if (typeof extensions !== 'object' || extensions === null) return undefined
  const cost = (extensions as { cost?: unknown }).cost
  if (typeof cost !== 'object' || cost === null) return undefined
  const requested = (cost as { requestedQueryCost?: unknown }).requestedQueryCost
  const status = (cost as { throttleStatus?: unknown }).throttleStatus
  if (typeof status !== 'object' || status === null) return undefined
  const available = (status as { currentlyAvailable?: unknown }).currentlyAvailable
  const rate = (status as { restoreRate?: unknown }).restoreRate
  if (typeof requested !== 'number' || typeof available !== 'number' || typeof rate !== 'number') return undefined
  if (!Number.isFinite(requested) || !Number.isFinite(available) || !Number.isFinite(rate) || rate <= 0 || requested < 0) return undefined
  const ms = Math.ceil((Math.max(0, requested - available) / rate) * 1000)
  return Math.min(ms, RETRY_AFTER_MAX_MS)
}

/**
 * Sends one mutation document to the write shop's Admin GraphQL endpoint. Never retries. The transport's own failures
 * (status, version, size, JSON, top-level errors) are finished here; a 200 with a `data` object goes back for the
 * operation to read. A top-level error answer is `sent: 'no'` only when no root field of the document has a value
 * (Shopify ran none of it) and every error carries a known pre-execution code.
 */
export function postMutation(
  upstream: Upstream,
  config: ShopifyConfig,
  token: string,
  doc: MutationDoc,
  timeoutMs: number = WRITE_TIMEOUT_MS,
): Promise<MutationAnswer> {
  return withDeadline(
    timeoutMs,
    (): MutationAnswer => ({ ok: false, result: writeErr('upstream_unavailable', 'unknown', 'deadline') }),
    signal => post(upstream, config, token, doc, signal),
  )
}

const fail = (code: HubErrorCode, sent: 'no' | 'unknown', detail?: string, retryAfterMs?: number): MutationAnswer => ({
  ok: false,
  result: writeErr(code, sent, detail, retryAfterMs),
})

async function post(upstream: Upstream, config: ShopifyConfig, token: string, doc: MutationDoc, signal: AbortSignal): Promise<MutationAnswer> {
  let res: Response
  try {
    res = await upstream(
      new Request(`https://${config.shop}.myshopify.com/admin/api/${SHOPIFY_WRITE_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: doc.query, variables: doc.variables }),
        redirect: 'manual',
        signal,
      }),
    )
  } catch {
    return fail('upstream_unavailable', 'unknown')
  }

  if (res.status === 401) {
    await res.body?.cancel().catch(() => {})
    return fail('credentials_rejected', 'no')
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('Retry-After'))
    await res.body?.cancel().catch(() => {})
    return fail('rate_limited', 'no', undefined, Number.isFinite(ra) && ra > 0 ? Math.min(Math.ceil(ra * 1000), RETRY_AFTER_MAX_MS) : undefined)
  }
  if (res.status >= 500 || res.status < 200 || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {})
    return fail('upstream_unavailable', 'unknown')
  }
  if (res.status >= 400) {
    await res.body?.cancel().catch(() => {})
    return fail('upstream_rejected', 'no')
  }

  const served = res.headers.get('X-Shopify-API-Version')
  if (served !== null && served !== SHOPIFY_WRITE_API_VERSION) {
    await res.body?.cancel().catch(() => {})
    return fail('upstream_version_mismatch', 'unknown')
  }

  const contentLength = Number(res.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > WRITE_MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => {})
    return fail('result_too_large', 'unknown')
  }

  const capped = await readCapped(res, WRITE_MAX_BODY_BYTES)
  if (!capped.ok) return fail(capped.reason === 'too_large' ? 'result_too_large' : 'upstream_unavailable', 'unknown')

  let json: unknown
  try {
    json = JSON.parse(capped.text)
  } catch {
    return fail('upstream_unavailable', 'unknown')
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return fail('upstream_unavailable', 'unknown')

  const body = json as { data?: unknown; errors?: unknown; extensions?: unknown }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const codes = (body.errors as { extensions?: { code?: unknown } }[])
      .map(e => (typeof e?.extensions?.code === 'string' ? e.extensions.code : null))
      .filter((c): c is string => c !== null && /^[A-Z_]{1,64}$/.test(c))
    // A partial result (errors next to any root field's value) means part of the document may have run: never
    // `sent: 'no'` then.
    const noMutationResult = body.data === undefined || body.data === null
      || (typeof body.data === 'object' && !Array.isArray(body.data) && Object.values(body.data as Record<string, unknown>).every(v => v == null))
    // A definite `'no'` needs every error to carry a known code: an uncoded error beside one could be anything.
    const allCoded = codes.length === body.errors.length
    if (codes.includes('THROTTLED')) {
      const none = noMutationResult && allCoded && codes.every(c => c === 'THROTTLED')
      return fail('rate_limited', none ? 'no' : 'unknown', undefined, none ? throttleWaitMs(body.extensions) : undefined)
    }
    if (noMutationResult && allCoded && codes.every(c => DEFINITE_GQL_REFUSALS.has(c))) {
      const unique = [...new Set(codes)].slice(0, 10)
      return fail('upstream_rejected', 'no', unique.join(','))
    }
    return fail('upstream_unavailable', 'unknown')
  }

  if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) return fail('upstream_unavailable', 'unknown')
  return { ok: true, data: body.data as Record<string, unknown> }
}
