// Result shaping shared by the Shopify tools: money in minor units, instants, capped strings, enums, the shared zod
// pieces of the parsers, and the run wrapper that turns any data the parser or a mapper rejects into
// `upstream_unavailable` (OC 5). Mappers throw MapError only; anything else is a bug and stays loud.
import { z } from 'zod'
import type { HubResult, Instant } from '../../index/contract'
import { err, ok } from '../../index/errors'
import type { ToolContext } from '../../registry/registry'

export class MapError extends Error {}

export function fail(why: string): never {
  throw new MapError(why)
}

/** Each tool's worst-case result JSON stays under this (OC 4), leaving room under the gateway's 32 KiB cap. */
export const RESULT_BUDGET_BYTES = 24 * 1024

export const GID = /^gid:\/\/shopify\/[A-Za-z]{1,32}\/[0-9]{1,20}$/
export const CURSOR = /^[A-Za-z0-9+/=_-]{1,512}$/
const ENUM = /^[A-Z_]{1,40}$/
const DECIMAL = /^(-?)(\d{1,20})(?:\.(\d{1,20}))?$/
const CURRENCY = /^[A-Z]{3}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

// Parser pieces. Keys are exactly the documents' selections (fields.test.ts checks that).
export const zId = z.string().regex(GID)
export const zInt = z.number().int().min(-2147483648).max(2147483647)
export const zCount = z.number().int().min(0).max(2147483647)
export const zMoneyBag = z.object({ shopMoney: z.object({ amount: z.string(), currencyCode: z.string() }) })
export const zHasNext = z.object({ hasNextPage: z.boolean() })
export const zPage = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })

export type Money = { minor: number; currency: string }

/** Decimal string to minor units by string arithmetic (never floats), with the currency's ISO 4217 exponent. */
export function money(amount: string, currency: string): Money {
  if (!CURRENCY.test(currency)) fail('currency')
  const m = DECIMAL.exec(amount)
  if (!m) fail('amount')
  const exponent = currencyExponent(currency)
  const frac = m[3] ?? ''
  if (frac.length > exponent) fail('amount precision')
  const digits = `${m[2]}${frac.padEnd(exponent, '0')}`
  const big = BigInt(digits) * (m[1] === '-' ? -1n : 1n)
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < -BigInt(Number.MAX_SAFE_INTEGER)) fail('amount range')
  const minor = Number(big)
  return { minor: minor === 0 ? 0 : minor, currency }
}

const exponents = new Map<string, number>()
export function currencyExponent(currency: string): number {
  let e = exponents.get(currency)
  if (e === undefined) {
    try {
      e = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
    } catch {
      fail('currency')
    }
    exponents.set(currency, e)
  }
  return e
}

/** C1's instant: `iso` normalised through `new Date(ms).toISOString()`. */
export function instant(iso: string): Instant {
  if (!ISO_INSTANT.test(iso)) fail('instant')
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) fail('instant')
  return { iso: new Date(ms).toISOString(), ms }
}

export const nullableInstant = (iso: string | null): Instant | null => (iso === null ? null : instant(iso))

export function enumValue(v: string): string {
  if (!ENUM.test(v)) fail('enum')
  return v
}

export const nullableEnum = (v: string | null): string | null => (v === null ? null : enumValue(v))

/** Bytes this code point takes inside a JSON string (UTF-8, escapes counted). */
function jsonBytes(cp: number): number {
  if (cp === 0x22 || cp === 0x5c) return 2
  if (cp < 0x20) return cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d ? 2 : 6
  if (cp < 0x80) return 1
  if (cp < 0x800) return 2
  if (cp >= 0xd800 && cp <= 0xdfff) return 6 // a lone surrogate, escaped by JSON.stringify
  if (cp < 0x10000) return 3
  return 4
}

/** Tracks whether any string in one result object was cut. */
export type Cut = { truncated: boolean }

/** At most `maxBytes` of JSON-encoded string content, cut at a code point boundary. */
export function cap(cut: Cut, s: string, maxBytes: number): string {
  let used = 0
  let end = 0
  for (const ch of s) {
    const b = jsonBytes(ch.codePointAt(0)!)
    if (used + b > maxBytes) {
      cut.truncated = true
      return s.slice(0, end)
    }
    used += b
    end += ch.length
  }
  return s
}

export const capNullable = (cut: Cut, s: string | null, maxBytes: number): string | null => (s === null ? null : cap(cut, s, maxBytes))

/** A list must not be longer than requested: an upstream that sends more is malformed. */
export function within<T>(list: readonly T[], max: number): readonly T[] {
  if (list.length > max) fail('list longer than requested')
  return list
}

export function nextCursor(page: { hasNextPage: boolean; endCursor: string | null }): string | null {
  if (!page.hasNextPage) return null
  if (page.endCursor === null || !CURSOR.test(page.endCursor)) fail('cursor')
  return page.endCursor
}

/** Sends one document and maps its data. Client errors pass through as is; rejected data is upstream_unavailable. */
export async function runQuery<T>(
  ctx: ToolContext,
  document: string,
  variables: Record<string, unknown>,
  parser: z.ZodType<T>,
  map: (data: T) => unknown,
): Promise<HubResult<unknown>> {
  const r = await ctx.shopify.graphql(document, variables)
  if (!r.ok) return r
  const parsed = parser.safeParse((r.value as { data?: unknown } | undefined)?.data)
  if (!parsed.success) return err('upstream_unavailable')
  try {
    return ok(map(parsed.data))
  } catch (e) {
    if (e instanceof MapError) return err('upstream_unavailable')
    throw e
  }
}

// Input pieces shared by the tools (all convertible by z.toJSONSchema).
export const SKU = /^[\x21-\x7E][\x20-\x7E]{0,63}$/
export const zSku = z.string().regex(SKU)
export const zCursor = z.string().regex(CURSOR)
export const zInstantInput = z.iso.datetime({ offset: true })
