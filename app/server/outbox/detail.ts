// Card details (Stage 1 M3, #488; Wasim, 2026-11-27): who and how much beside a write's ids ("#3901 · Alex Moore ·
// $642.10"), and a draft-order line's product. The hub reads them from the write store when the agent asks
// (hub ConnectGateway.cardFacts, through BrandAgent `cardFacts`); this module reads its answer strictly, runs every string
// through the app's text rules for connector text, and builds each operation's detail rows (shared/contract/actions.ts
// `ActionDetail`).
//
// Where these strings go, and only there: `outbox_actions.detail_json` and `outbox_items.detail_json` (0791), then the
// card (`ActionCard.detail`, `batch.firstDetails`) and the item list (`ActionItem.detail`), which people read. Never
// `card_json` or an item's `line`, the words the agent reads back (the approvals tool's view, the resume turn), never a
// tool result, an audit line or a notice. They're Shopify's text, which a customer can choose (a name): a person reads
// them as data on a card; the agent never reads them at all.
import { z } from 'zod'
import type { CardFactsRequest } from '../../hub/index/contract.ts'
import { DETAIL_TEXT_MAX } from '../../shared/contract/actions.ts'
import type { ActionDetail, ActionDetailRow } from '../../shared/contract/actions.ts'
import { cleanChars, removeLinks } from '../../shared/notify/bound.ts'

/** What an operation asks the store for: its orders' and its draft lines' variants' ids. */
export interface FactsWanted { orderIds: string[]; variantIds: string[] }

/** One order's facts, cleaned. */
export interface OrderFacts { found: true; name: string | undefined; customer: string | undefined; amount: string | undefined; currency: string | undefined }
/** One variant's facts, cleaned. */
export interface VariantFacts { found: true; product: string | undefined; sku: string | undefined }
type NotFound = { found: false }

/**
 * The store's answer as the entries read it: each id asked, found or not. `undefined` for an id it didn't answer (that
 * list wasn't read: the write app lacks the scope, or none was asked), and the entry then builds no rows.
 */
export interface CardFactsView {
  order(id: string): OrderFacts | NotFound | undefined
  variant(id: string): VariantFacts | NotFound | undefined
}

/**
 * The store's answer, cleaned, as plain data (it crosses BrandAgent's RPC): each id asked with its facts. A list is null
 * when it wasn't read.
 */
export interface CleanCardFacts {
  orders: ({ id: string } & (OrderFacts | NotFound))[] | null
  variants: ({ id: string } & (VariantFacts | NotFound))[] | null
}

/** Reads the facts for one request; null when the store didn't answer. Never throws. */
export type CardFactsReader = (req: CardFactsRequest) => Promise<CardFactsView | null>

/** The view the entries read over cleaned facts. */
export function factsView(c: CleanCardFacts): CardFactsView {
  const orders = new Map((c.orders ?? []).map(({ id, ...f }) => [id, f as OrderFacts | NotFound]))
  const variants = new Map((c.variants ?? []).map(({ id, ...f }) => [id, f as VariantFacts | NotFound]))
  return { order: id => orders.get(id), variant: id => variants.get(id) }
}

/** Markup and quoting characters a card never shows from a store: `<`, `>` and the backtick. */
const MARKUP = /[<>`]/g

/**
 * The app's text rules for connector text (shared/notify/bound.ts, the notices' steps 1 and 2): NFC, control, bidi,
 * zero-width and tag characters stripped, one line, anything that could be a link replaced; then no markup characters,
 * runs of space as one, and cut to `max` code points (with an ellipsis). Undefined when nothing is left.
 */
export function cardText(raw: string, max: number): string | undefined {
  const text = removeLinks(cleanChars(raw, 'message')).text.replace(MARKUP, '').replace(/\s+/gu, ' ').trim()
  if (text === '') return undefined
  const points = [...text]
  return points.length <= max ? text : `${points.slice(0, max - 1).join('').trimEnd()}…`
}

/** "$642.10": a store's decimal amount in its currency, for display only (never computed with). */
export function amountWords(amount: string, currency: string): string | undefined {
  const n = Number(amount)
  if (!Number.isFinite(n)) return undefined
  // Any three upper-case letters format (a code the runtime doesn't know shows as itself: "XYZ 1.00").
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n)
}

// The hub's answer, read strictly (written out: no hub runtime import in the product; hub/index/schemas.ts is the hub's).
const ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]{0,19}$/
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]{0,19}$/
const CURRENCY = /^[A-Z]{3}$/
const Answer = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.object({
      orders: z.array(z.discriminatedUnion('found', [
        z.object({
          id: z.string().regex(ORDER_GID), found: z.literal(true), name: z.string().max(200), customer: z.string().max(1000).nullable(),
          total: z.object({ amount: z.string().regex(/^-?\d{1,15}(?:\.\d{1,6})?$/), currencyCode: z.string().regex(CURRENCY) }).nullable(),
        }),
        z.object({ id: z.string().regex(ORDER_GID), found: z.literal(false) }),
      ])).max(100).nullable(),
      variants: z.array(z.discriminatedUnion('found', [
        z.object({ id: z.string().regex(VARIANT_GID), found: z.literal(true), product: z.string().max(1000), variant: z.string().max(200), sku: z.string().max(200).nullable() }),
        z.object({ id: z.string().regex(VARIANT_GID), found: z.literal(false) }),
      ])).max(20).nullable(),
    }),
  }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
])

/** Shopify's name for a variant that is the product's only one: not worth showing. */
const DEFAULT_VARIANT = 'Default Title'

/**
 * The hub's answer for `req`, every string cleaned; null when it doesn't parse, is an error, or answers other ids than
 * the ones asked (an answer about anything else is never shown). `why` names the reason for the log (a closed word).
 */
export function readCardFacts(raw: unknown, req: Pick<CardFactsRequest, 'orderIds' | 'variantIds'>): { facts: CleanCardFacts } | { facts: null; why: string } {
  const parsed = Answer.safeParse(raw)
  if (!parsed.success) return { facts: null, why: 'malformed' }
  if (!parsed.data.ok) return { facts: null, why: parsed.data.error.code.replace(/[^a-z_]/g, '').slice(0, 40) || 'hub_error' }
  const { orders, variants } = parsed.data.value
  const same = (asked: readonly string[], got: readonly { id: string }[] | null) =>
    got === null || (got.length === asked.length && got.every((x, i) => x.id === asked[i]))
  if (!same(req.orderIds, orders) || !same(req.variantIds, variants)) return { facts: null, why: 'other_ids' }
  return {
    facts: {
      orders: orders === null ? null : orders.map(o => (!o.found ? { id: o.id, found: false as const } : {
        id: o.id,
        found: true as const,
        name: cardText(o.name, DETAIL_TEXT_MAX.order),
        customer: o.customer === null ? undefined : cardText(o.customer, DETAIL_TEXT_MAX.customer),
        amount: o.total ? amountWords(o.total.amount, o.total.currencyCode) : undefined,
        currency: o.total?.currencyCode,
      })),
      variants: variants === null ? null : variants.map(v => {
        if (!v.found) return { id: v.id, found: false as const }
        const title = v.variant.trim() === '' || v.variant === DEFAULT_VARIANT ? v.product : `${v.product}, ${v.variant}`
        return { id: v.id, found: true as const, product: cardText(title, DETAIL_TEXT_MAX.product), sku: v.sku === null ? undefined : cardText(v.sku, DETAIL_TEXT_MAX.sku) }
      }),
    },
  }
}

const gidNumber = (id: string): string => id.slice(id.lastIndexOf('/') + 1)

/** Drops the fields with no value, so a row holds only what the store answered. */
function row(r: ActionDetailRow): ActionDetailRow {
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as ActionDetailRow
}

/**
 * An order's row: its name, customer and an amount (the order's total, or `amount` when the operation names the money
 * that matters, a refund's). Undefined when the store didn't answer for it.
 */
export function orderRow(f: CardFactsView, orderId: string, amount?: { words: string; currency: string }): ActionDetailRow | undefined {
  const o = f.order(orderId)
  const ref = `Order ${gidNumber(orderId)}`
  if (o === undefined) return undefined
  if (!o.found) return { ref, notFound: true }
  return row({ ref, order: o.name, customer: o.customer, amount: amount?.words ?? o.amount, currency: amount?.currency ?? o.currency })
}

/** A draft line's row: its product and variant, SKU and quantity. Undefined when the store didn't answer for it. */
export function variantRow(f: CardFactsView, variantId: string, quantity: number): ActionDetailRow | undefined {
  const v = f.variant(variantId)
  const ref = `Variant ${gidNumber(variantId)}`
  if (v === undefined) return undefined
  if (!v.found) return { ref, quantity, notFound: true }
  return row({ ref, product: v.product, sku: v.sku, quantity })
}

/** Rows as a detail: only when every id has one (a part-read list is never shown as if whole). */
export function detailOf(rows: readonly (ActionDetailRow | undefined)[]): ActionDetail | null {
  if (rows.length === 0 || rows.some(r => r === undefined)) return null
  return { rows: rows as ActionDetailRow[] }
}

/** A detail as stored (`detail_json`), or null. */
export const detailJson = (d: ActionDetail | null): string | null => (d === null ? null : JSON.stringify(d))
