// `shopify.refund.create` (Stage 1 M3-S2, N21, section 0 Q1): refunds line items (and shipping) on one order, in the
// shop's currency, for exactly the amount a person approved (`refundCreate`, write_orders; `suggestedRefund` reads under
// the same grant). Two upstream requests per hub call, never more:
// 1. Lookup (a query, so nothing changes): the order's currencies, Shopify's suggested refund for these lines and this
//    shipping, and each line's unfulfilled quantity. The call is refused, `sent: 'no'`, when
//    - the order isn't found (`order`), or it was placed in another currency than the approved one, or in a presentment
//      currency other than the shop's (`currency`: Stage 1 refunds only single-currency orders);
//    - the suggested amount isn't the approved amount (`amount_changed`: "the refund amount changed");
//    - the suggestion names no transaction to refund, or its transactions don't add up to the amount (`transactions`);
//    - a line to restock is part fulfilled, part not (`restock`): Shopify restocks a fulfilled unit as a return and an
//      unfulfilled one as a cancel, and one refund line can't be both.
// 2. The mutation, carrying the amount explicitly in its transactions (each suggested transaction's parent and gateway),
//    the currency, whether Shopify sends its own refund email (`notify`) and the idempotency key, so a later "try again"
//    can't refund twice.
// The answer is `ok` only when the refund came back with exactly the approved amount; a refund that came back with
// another is unclear (`sent: 'unknown'`), never `ok` and never `'no'`.
import { z } from 'zod'
import { hubError } from '../../../../index/errors'
import { writeErr } from '../provider'
import { CURRENCY_CODE, fromMinor, toMinor } from './money'
import { rootOutcome, type LookupVerdict, type ShopifyWriteOp } from './types'

const ORDER_GID = /^gid:\/\/shopify\/Order\/([1-9]\d{0,19})$/
const LINE_ITEM_GID = /^gid:\/\/shopify\/LineItem\/[1-9]\d{0,19}$/
const TRANSACTION_GID = /^gid:\/\/shopify\/OrderTransaction\/[1-9]\d{0,19}$/
const REFUND_GID = /^gid:\/\/shopify\/Refund\/([1-9]\d{0,19})$/
/** A gateway name as Shopify reports it ("shopify_payments", "manual"): printable ASCII only, so it's safe to send back. */
const GATEWAY = /^[\x20-\x7e]{1,100}$/
/** The most minor units in one refund or one call's units (shared/contract/ceiling.ts `LIMIT_MAX`). */
export const REFUND_MINOR_MAX = 1_000_000_000

export const RefundCreateArgsSchema = z.strictObject({
  orderId: z.string().regex(ORDER_GID),
  lines: z.array(z.strictObject({ lineItemId: z.string().regex(LINE_ITEM_GID), quantity: z.int().min(1).max(1000) })).max(50)
    .refine(ls => new Set(ls.map(l => l.lineItemId)).size === ls.length, 'Each line once'),
  shippingMinor: z.int().min(0).max(REFUND_MINOR_MAX).optional(),
  amount: z.strictObject({ minor: z.int().min(1).max(REFUND_MINOR_MAX), currency: z.string().regex(CURRENCY_CODE) }),
  restock: z.boolean(),
  notifyCustomer: z.boolean(),
})
  .refine(a => a.lines.length > 0 || (a.shippingMinor ?? 0) > 0, { path: ['lines'], message: 'Refund at least one line or the shipping' })
  .refine(a => !a.restock || a.lines.length > 0, { path: ['restock'], message: 'Nothing to restock' })
export type RefundCreateArgs = z.infer<typeof RefundCreateArgsSchema>

type RestockType = 'NO_RESTOCK' | 'RETURN' | 'CANCEL'
type Looked = { transactions: { parentId: string; gateway: string; amount: string }[]; restockTypes: RestockType[] }

export const REFUND_LOOKUP_QUERY = `query RefundSuggestion($orderId: ID!, $refundLineItems: [RefundLineItemInput!]!, $shippingAmount: Money, $lineItemIds: [ID!]!) {
  order(id: $orderId) {
    id
    currencyCode
    presentmentCurrencyCode
    suggestedRefund(refundLineItems: $refundLineItems, shippingAmount: $shippingAmount) {
      amountSet {
        shopMoney {
          amount
          currencyCode
        }
        presentmentMoney {
          amount
          currencyCode
        }
      }
      suggestedTransactions {
        amountSet {
          shopMoney {
            amount
            currencyCode
          }
          presentmentMoney {
            amount
            currencyCode
          }
        }
        gateway
        kind
        parentTransaction {
          id
        }
      }
    }
  }
  lineItems: nodes(ids: $lineItemIds) {
    ... on LineItem {
      id
      unfulfilledQuantity
    }
  }
}`

export const REFUND_CREATE_MUTATION = `mutation RefundCreate($input: RefundInput!, $idempotencyKey: String!) {
  refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
    refund {
      id
      totalRefundedSet {
        shopMoney {
          amount
          currencyCode
        }
      }
    }
    userErrors {
      field
      message
    }
  }
}`

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null)

/** A `MoneyV2` in this currency, in minor units; null when it's another currency or unreadable. */
function money(v: unknown, currency: string): number | null {
  const m = obj(v)
  if (!m || m.currencyCode !== currency) return null
  return toMinor(m.amount, currency)
}

const refuse = (code: 'upstream_rejected' | 'upstream_unavailable', detail: string): LookupVerdict<Looked> =>
  ({ ok: false, result: { ok: false, error: hubError(code, detail), sent: 'no' } })

/** Reads the lookup: the facts the mutation is built from, or why it isn't sent. */
export function decideRefund(data: Record<string, unknown>, a: RefundCreateArgs): LookupVerdict<Looked> {
  const currency = a.amount.currency
  const order = obj(data.order)
  if (data.order === null) return refuse('upstream_rejected', 'order')
  if (!order || order.id !== a.orderId) return refuse('upstream_unavailable', 'lookup')
  if (order.currencyCode !== currency || order.presentmentCurrencyCode !== currency) return refuse('upstream_rejected', 'currency')

  const suggested = obj(order.suggestedRefund)
  const amountSet = obj(suggested?.amountSet)
  const shop = money(amountSet?.shopMoney, currency)
  const presentment = money(amountSet?.presentmentMoney, currency)
  if (shop === null || presentment === null) return refuse('upstream_unavailable', 'lookup')
  if (shop !== a.amount.minor || presentment !== a.amount.minor) return refuse('upstream_rejected', 'amount_changed')

  const raw = suggested?.suggestedTransactions
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) return refuse('upstream_rejected', 'transactions')
  const transactions: Looked['transactions'] = []
  let total = 0
  for (const t of raw) {
    const tx = obj(t)
    const parentId = obj(tx?.parentTransaction)?.id
    const minor = money(obj(tx?.amountSet)?.presentmentMoney, currency)
    if (!tx || tx.kind !== 'SUGGESTED_REFUND' || typeof tx.gateway !== 'string' || !GATEWAY.test(tx.gateway)
      || typeof parentId !== 'string' || !TRANSACTION_GID.test(parentId) || minor === null || minor < 1) {
      return refuse('upstream_rejected', 'transactions')
    }
    total += minor
    transactions.push({ parentId, gateway: tx.gateway, amount: fromMinor(minor, currency) })
  }
  if (total !== a.amount.minor) return refuse('upstream_rejected', 'transactions')

  const restockTypes: RestockType[] = []
  if (!a.restock) restockTypes.push(...a.lines.map((): RestockType => 'NO_RESTOCK'))
  else {
    const nodes = Array.isArray(data.lineItems) ? data.lineItems.map(obj) : []
    for (const l of a.lines) {
      const unfulfilled = nodes.find(n => n?.id === l.lineItemId)?.unfulfilledQuantity
      if (typeof unfulfilled !== 'number' || !Number.isSafeInteger(unfulfilled) || unfulfilled < 0) return refuse('upstream_rejected', 'restock')
      if (unfulfilled === 0) restockTypes.push('RETURN')
      else if (l.quantity <= unfulfilled) restockTypes.push('CANCEL')
      else return refuse('upstream_rejected', 'restock')
    }
  }
  return { ok: true, value: { transactions, restockTypes } }
}

export const refundCreate: ShopifyWriteOp<RefundCreateArgs, Looked> = {
  key: 'shopify.refund.create',
  scope: 'write_orders',
  args: RefundCreateArgsSchema,
  idempotent: true,
  lookup: {
    document: a => ({
      query: REFUND_LOOKUP_QUERY,
      variables: {
        orderId: a.orderId,
        refundLineItems: a.lines.map(l => ({ lineItemId: l.lineItemId, quantity: l.quantity })),
        shippingAmount: a.shippingMinor === undefined ? null : fromMinor(a.shippingMinor, a.amount.currency),
        lineItemIds: a.lines.map(l => l.lineItemId),
      },
    }),
    decide: decideRefund,
  },
  document: (a, { idempotencyKey, looked }) => {
    if (idempotencyKey === undefined) throw new Error('refundCreate: no idempotency key')
    return {
      query: REFUND_CREATE_MUTATION,
      variables: {
        input: {
          orderId: a.orderId,
          currency: a.amount.currency,
          notify: a.notifyCustomer,
          refundLineItems: a.lines.map((l, i) => ({ lineItemId: l.lineItemId, quantity: l.quantity, restockType: looked.restockTypes[i] })),
          ...(a.shippingMinor !== undefined ? { shipping: { amount: fromMinor(a.shippingMinor, a.amount.currency) } } : {}),
          transactions: looked.transactions.map(t => ({ orderId: a.orderId, parentId: t.parentId, gateway: t.gateway, kind: 'REFUND', amount: t.amount })),
        },
        idempotencyKey,
      },
    }
  },
  read: (data, a) => {
    const refund = obj(obj(data.refundCreate)?.refund)
    const num = typeof refund?.id === 'string' ? REFUND_GID.exec(refund.id)?.[1] : undefined
    const refunded = money(obj(refund?.totalRefundedSet)?.shopMoney, a.amount.currency)
    const outcome = rootOutcome(data.refundCreate, 'refund', () => num !== undefined && refunded === a.amount.minor)
    if (outcome === 'done') {
      const order = ORDER_GID.exec(a.orderId)?.[1] ?? 'order'
      return { ok: true, value: { ref: `refund ${num} on order ${order}: ${fromMinor(a.amount.minor, a.amount.currency)} ${a.amount.currency}` } }
    }
    if (outcome === 'refused') return writeErr('upstream_rejected', 'no')
    // A refund that came back with another amount went out: a person checks it.
    return writeErr('upstream_unavailable', 'unknown', num !== undefined && refunded !== null ? 'refund amount differs' : undefined)
  },
}
