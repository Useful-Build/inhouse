// `shopify.refund.create` (Stage 1 M3-S2, N21, section 0 Q1 and Q2): refunds line items (and shipping) on one order in
// the brand's connected Shopify store, for an exact amount in the shop's currency. Money and the customer: an exact
// approval every time, never covered by a grant, never collected (the 6th waiting card in a chat is refused
// `too_many_waiting`), and admins only: a member's refund is an admins card any active admin answers (M3-X, N25).
// `units` = the amount in minor units, so the ceiling's largest call (N24: $500 as 50,000 cents) bounds one refund.
// `resolve` refuses a currency other than the shop's (`ConnectedAccountFacts.currency`, copied from the hub), and every
// refund while the shop's currency isn't known. At the send the hub asks Shopify's suggested refund for these lines and
// sends only when it equals the amount ("the refund amount changed" otherwise), the amount explicit in its transactions
// (hub/connectors/shopify/write/ops/refund-create.ts). `notifyCustomer` sends only Shopify's own refund email; the card
// says whether it will.
import { z } from 'zod'
import { shopScope } from './shopify-order-tags.ts'
import type { MoneyAmount, OperationEntry } from './types.ts'

const ORDER_ID = /^gid:\/\/shopify\/Order\/[1-9][0-9]{0,19}$/
const LINE_ITEM_ID = /^gid:\/\/shopify\/LineItem\/[1-9][0-9]{0,19}$/
/** The most minor units in one refund (shared/contract/ceiling.ts `LIMIT_MAX`; the hub's bound too). */
export const REFUND_MINOR_MAX = 1_000_000_000

export const RefundArgsSchema = z.strictObject({
  orderId: z.string().regex(ORDER_ID),
  lines: z.array(z.strictObject({ lineItemId: z.string().regex(LINE_ITEM_ID), quantity: z.int().min(1).max(1000) })).max(50)
    .refine(ls => new Set(ls.map(l => l.lineItemId)).size === ls.length, 'Each line once'),
  /** Shipping to refund, in the shop's minor units; absent, none. */
  shippingMinor: z.int().min(0).max(REFUND_MINOR_MAX).optional(),
  /** The whole refund, in the shop's minor units and currency: what the person approves and Shopify must suggest. */
  amount: z.strictObject({ minor: z.int().min(1).max(REFUND_MINOR_MAX), currency: z.string().regex(/^[A-Z]{3}$/) }),
  /** Put the refunded units back in stock. */
  restock: z.boolean(),
  /** Let Shopify send the customer its own refund email (never words the agent writes). */
  notifyCustomer: z.boolean(),
})
  .refine(a => a.lines.length > 0 || (a.shippingMinor ?? 0) > 0, { path: ['lines'], message: 'Refund at least one line or the shipping' })
  .refine(a => !a.restock || a.lines.length > 0, { path: ['restock'], message: 'Nothing to restock' })
export type RefundArgs = z.infer<typeof RefundArgsSchema>

const num = (id: string) => id.slice(id.lastIndexOf('/') + 1)

/** "$24.90", "¥2,490", "CA$24.90": minor units in the currency's own digits (shown only; never computed with). */
export function moneyWords(m: MoneyAmount): string {
  const f = new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency })
  const digits = f.resolvedOptions().maximumFractionDigits ?? 2
  return f.format(m.minor / 10 ** digits)
}

const itemCount = (a: RefundArgs) => a.lines.reduce((n, l) => n + l.quantity, 0)
const itemsWords = (a: RefundArgs) => (itemCount(a) === 1 ? '1 item' : `${itemCount(a)} items`)
const shippingWords = (a: RefundArgs) => moneyWords({ minor: a.shippingMinor ?? 0, currency: a.amount.currency })
const emailWords = (a: RefundArgs) => `The customer gets Shopify’s refund email: ${a.notifyCustomer ? 'yes' : 'no'}.`

export const shopifyRefundCreate: OperationEntry<RefundArgs> & { key: 'shopify.refund.create' } = {
  key: 'shopify.refund.create',
  tool: 'shopify_refund_create',
  description: 'Refund line items and shipping on one order in the connected Shopify store, for an exact amount in the shop\'s currency (minor units, such as cents). An admin approves every refund exactly. Shopify refuses it if its own suggested refund for those lines differs from the amount.',
  args: RefundArgsSchema,
  connector: 'shopify',
  scope: (a, f) => {
    const currency = f.accounts.shopify?.currency ?? null
    // The shop's currency isn't known yet (the hub hasn't read it): no refund until it is.
    if (currency === null) return { refuse: 'account_unavailable' }
    if (a.amount.currency !== currency) return { refuse: 'invalid_args' }
    return shopScope('shopify.refund.create', f)
  },
  records: () => 1,
  units: a => a.amount.minor,
  unitsLabel: 'minor currency units',
  // Every line, the shipping, the amount, the restock and the email: nothing a person approves is cut.
  itemLine: (a, f) => {
    const shop = f.accounts.shopify?.shop
    return [
      `Refund ${moneyWords(a.amount)} (${a.amount.currency}) on order ${num(a.orderId)}${shop ? ` (${shop})` : ''}`,
      ...(a.lines.length > 0 ? [`${a.lines.map(l => `${l.quantity} × line ${num(l.lineItemId)}`).join(', ')}`] : []),
      `shipping ${shippingWords(a)}`,
      `restock: ${a.restock ? 'yes' : 'no'}`,
      `refund email: ${a.notifyCustomer ? 'yes' : 'no'}`,
    ].join('; ')
  },
  effects: { money: true, customer: true, destructive: false, access: false },
  memberMay: false,
  reversible: false,
  idempotent: false,
  coalesces: false,
  amount: a => ({ ...a.amount }),
  // N24: no grant; $500 in the shop's minor units at most in one refund. No daily figure applies (no grant covers it).
  defaults: { grant: null, ceiling: { perDayMax: 50_000, unitsMax: 50_000 } },
  card: a => ({
    title: `Refund ${moneyWords(a.amount)} (${a.amount.currency}) on order ${num(a.orderId)}`,
    lines: [
      `${itemsWords(a)}, shipping ${shippingWords(a)}.`,
      ...a.lines.map(l => `${l.quantity} × line ${num(l.lineItemId)}`),
      `Restock the items: ${a.restock ? 'yes' : 'no'}.`,
      emailWords(a),
    ],
  }),
}
