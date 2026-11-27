// The fake's refunds (Stage 1 M3-S2): the `RefundSuggestion` query (an order's currencies, Shopify's suggested refund for
// some lines and shipping, each line's unfulfilled quantity) and the `RefundCreate` mutation. Amounts are whole cents in
// the fake (its orders are in dollars), shown as Shopify's decimal strings. Strict where Shopify is and stricter where a
// wrong refund could pass unnoticed: the transactions must add up to the refund of exactly those lines and that shipping,
// each line's restock type must fit its fulfillment, and nothing outside the input fields the hub sends is accepted.
// The idempotency key is the server's (../server.ts): the same key twice refunds once.
import type { FakeRefundOrder, FakeShopifyWriteUpstream } from '../server.js'
import { obj, userError, type FakeWriteOp } from './types.js'

export const cents = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`
const parseCents = (v: unknown): number | null => {
  const m = typeof v === 'string' ? /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v) : null
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null
}
const money = (minor: number, currency: string) => ({ amount: cents(minor), currencyCode: currency })

type Ask = { lines: { lineItemId: string; quantity: number }[]; shippingMinor: number }

/** What refunding these lines and this shipping comes to; null when a line isn't the order's or is past what's left. */
function refundOf(order: FakeRefundOrder, ask: Ask): number | null {
  let total = 0
  for (const l of ask.lines) {
    const line = order.lines.find(x => x.id === l.lineItemId)
    if (!line || !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > line.quantity - line.refunded) return null
    total += line.priceMinor * l.quantity
  }
  if (ask.shippingMinor < 0 || ask.shippingMinor > order.shippingMinor - order.shippingRefunded) return null
  return total + ask.shippingMinor
}

const asLines = (v: unknown): Ask['lines'] => (Array.isArray(v) ? v.map(obj).map(l => ({ lineItemId: String(l.lineItemId), quantity: Number(l.quantity) })) : [])

export const fakeRefundSuggestion: FakeWriteOp<'shopify.refund.suggestion'> = {
  key: 'shopify.refund.suggestion',
  kind: 'query',
  name: 'RefundSuggestion',
  document: () => `query RefundSuggestion($orderId: ID!, $refundLineItems: [RefundLineItemInput!]!, $shippingAmount: Money, $lineItemIds: [ID!]!) {
    order(id: $orderId) {
      id currencyCode presentmentCurrencyCode
      suggestedRefund(refundLineItems: $refundLineItems, shippingAmount: $shippingAmount) {
        amountSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        suggestedTransactions {
          amountSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
          gateway kind parentTransaction { id }
        }
      }
    }
    lineItems: nodes(ids: $lineItemIds) { ... on LineItem { id refundableQuantity unfulfilledQuantity } }
  }`,
  root: 'order',
  cost: () => 5,
  run(fake: FakeShopifyWriteUpstream, variables) {
    const ids = Array.isArray(variables.lineItemIds) ? variables.lineItemIds : []
    const lineItems = ids.map(id => {
      for (const o of fake.refundOrders.values()) {
        const line = o.lines.find(l => l.id === id)
        if (line) return { id: line.id, refundableQuantity: line.quantity - line.refunded, unfulfilledQuantity: line.unfulfilled }
      }
      return null
    })
    const order = typeof variables.orderId === 'string' ? fake.refundOrders.get(variables.orderId) : undefined
    if (!order) return { order: null, lineItems }
    const shipping = variables.shippingAmount === null ? 0 : parseCents(variables.shippingAmount)
    // Shopify's suggestion of lines past what's left refunds what's left; the fake answers nothing to refund instead.
    const total = shipping === null ? null : refundOf(order, { lines: asLines(variables.refundLineItems), shippingMinor: shipping })
    const amount = total ?? 0
    const tx = order.transactions[0]
    const shopMoney = money(amount, fake.currency)
    const presentmentMoney = money(amount, order.presentmentCurrency)
    return {
      order: {
        id: order.id,
        currencyCode: fake.currency,
        presentmentCurrencyCode: order.presentmentCurrency,
        suggestedRefund: {
          amountSet: { shopMoney, presentmentMoney },
          suggestedTransactions: amount > 0 && tx
            ? [{ amountSet: { shopMoney, presentmentMoney }, gateway: tx.gateway, kind: 'SUGGESTED_REFUND', parentTransaction: { id: tx.id } }]
            : [],
        },
      },
      lineItems,
    }
  },
}

const INPUT_KEYS = new Set(['orderId', 'currency', 'notify', 'refundLineItems', 'shipping', 'transactions'])
const RESTOCK = new Set(['NO_RESTOCK', 'RETURN', 'CANCEL'])

export const fakeRefundCreate: FakeWriteOp<'shopify.refund.create'> = {
  key: 'shopify.refund.create',
  kind: 'mutation',
  name: 'RefundCreate',
  document: () => `mutation RefundCreate($input: RefundInput!, $idempotencyKey: String!) {
    refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
      refund { id totalRefundedSet { shopMoney { amount currencyCode } } }
      userErrors { field message }
    }
  }`,
  root: 'refundCreate',
  cost: () => 10,
  idempotent: true,
  run(fake: FakeShopifyWriteUpstream, variables, refuse) {
    const refused = (field: string[], message: string) => ({ refundCreate: { refund: null, userErrors: [userError(field, message)] } })
    if (refuse) return refused(['input'], 'Refused by fake write upstream (refundCreate)')
    const input = obj(variables.input)
    const extra = Object.keys(input).find(k => !INPUT_KEYS.has(k))
    if (extra) return refused(['input', extra], 'Not accepted by the fake')
    const order = typeof input.orderId === 'string' ? fake.refundOrders.get(input.orderId) : undefined
    if (!order) return refused(['input', 'orderId'], 'Order not found')
    if (input.currency !== order.presentmentCurrency) return refused(['input', 'currency'], 'Currency must be the order presentment currency')
    if (typeof input.notify !== 'boolean') return refused(['input', 'notify'], 'Say whether to notify')
    const rawLines = Array.isArray(input.refundLineItems) ? input.refundLineItems.map(obj) : []
    for (const l of rawLines) {
      const line = order.lines.find(x => x.id === l.lineItemId)
      if (!line || typeof l.restockType !== 'string' || !RESTOCK.has(l.restockType)) return refused(['input', 'refundLineItems'], 'Line or restock type not valid')
      // As Shopify does: a cancel takes unshipped units (and cancels them), a return takes shipped ones, each only up to
      // what the line has of that kind. Nothing here checks that the person meant those units: that's the hub's job.
      const shipped = line.quantity - line.refunded - line.unfulfilled
      if (l.restockType === 'CANCEL' && Number(l.quantity) > line.unfulfilled) return refused(['input', 'refundLineItems', 'restockType'], 'Cancel restocks unfulfilled units only')
      if (l.restockType === 'RETURN' && Number(l.quantity) > shipped) return refused(['input', 'refundLineItems', 'restockType'], 'Return restocks fulfilled units only')
    }
    const shippingIn = input.shipping === undefined ? 0 : parseCents(obj(input.shipping).amount)
    const total = shippingIn === null ? null : refundOf(order, { lines: asLines(rawLines), shippingMinor: shippingIn })
    if (total === null) return refused(['input'], 'More than is left to refund')
    const txs = Array.isArray(input.transactions) ? input.transactions.map(obj) : []
    let sum = 0
    for (const t of txs) {
      const parent = order.transactions.find(x => x.id === t.parentId)
      const amount = parseCents(t.amount)
      if (!parent || t.orderId !== order.id || t.kind !== 'REFUND' || t.gateway !== parent.gateway || amount === null) return refused(['input', 'transactions'], 'Transaction not valid')
      sum += amount
    }
    if (sum !== total) return refused(['input', 'transactions'], 'The transactions do not add up to the refund')
    for (const l of rawLines) {
      const line = order.lines.find(x => x.id === l.lineItemId)!
      line.refunded += Number(l.quantity)
      if (l.restockType === 'CANCEL') line.unfulfilled -= Number(l.quantity)
      // Refunded with no restock: shipped units go first; an unshipped unit is refunded only past them.
      else line.unfulfilled = Math.min(line.unfulfilled, line.quantity - line.refunded)
    }
    order.shippingRefunded += shippingIn ?? 0
    const id = `gid://shopify/Refund/${5001 + fake.refunds.length}`
    fake.refunds.push({ id, orderId: order.id, amountMinor: total, notify: input.notify })
    return { refundCreate: { refund: { id, totalRefundedSet: { shopMoney: money(total, fake.currency) } }, userErrors: [] } }
  },
}

export const fakeShopCurrency: FakeWriteOp<'shopify.shop.currency'> = {
  key: 'shopify.shop.currency',
  kind: 'query',
  name: 'ShopCurrency',
  document: () => 'query ShopCurrency { shop { currencyCode } }',
  root: 'shop',
  cost: () => 1,
  run: fake => ({ shop: { currencyCode: fake.currency } }),
}
