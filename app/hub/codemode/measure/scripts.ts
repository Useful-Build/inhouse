// A.5's four reference scripts, one per S4 question, as the model would write them: page the recorded documents,
// reduce in the sandbox, return a small answer. They use only allowlisted fields, arguments, `query` keys and sort keys
// (the recorded test upstream answers only the recorded documents, so the scripts send those texts verbatim).
// Their expected answers come from oracle.ts, written separately over the dataset (no shared code).
import { RECORD_ORDERS, RECORD_PRODUCTS, RECORD_REFUNDS, RECORD_RETURNS } from '../../connectors/shopify/documents'
import { buildQuery } from '../../connectors/shopify/search'

/** The "now" the questions are asked at: the evening of the recording day. */
export const ASKED_AT = '2026-11-20T18:00:00Z'
/** The S4 bound on what reaches the model per question (S4: 199 to 1,131 characters). */
export const MAX_ANSWER_BYTES = 2 * 1024

const REFUNDED = buildQuery([
  { kind: 'any', of: [{ kind: 'eq', field: 'financial_status', value: 'refunded' }, { kind: 'eq', field: 'financial_status', value: 'partially_refunded' }] },
])!
const HAS_RETURN = buildQuery([{ kind: 'eq', field: 'return_status', value: 'no_return', negate: true }])!

/** Pages a root to the end: `all(doc, root, vars)` (defined inside each script). */
const PAGER = `
async function all(doc, root, vars) {
  const out = []
  let after = null
  do {
    const r = await shop.graphql(doc, after ? { ...vars, after } : vars)
    const conn = r.data[root]
    out.push(...conn.nodes)
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null
  } while (after)
  return out
}`

export type MeasureCase = { id: string; question: string; code: string }

export const MEASURE_CASES: readonly MeasureCase[] = [
  {
    id: 'lowest-stock',
    question: 'Which products are lowest on stock, and how many products sell for over $150?',
    code: `${PAGER}
const products = await all(${JSON.stringify(RECORD_PRODUCTS)}, 'products', { first: 250 })
const tracked = products.filter(p => p.tracksInventory)
tracked.sort((a, b) => a.totalInventory - b.totalInventory || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
return {
  lowest: tracked.slice(0, 5).map(p => ({ title: p.title, stock: p.totalInventory })),
  overPrice: products.filter(p => p.variants.nodes.some(v => Number(v.price) > 150)).length,
  products: products.length,
}`,
  },
  {
    id: 'unfulfilled-3-days',
    question: 'Which paid orders have waited more than 3 days unfulfilled?',
    code: `${PAGER}
const cutoff = Date.parse(${JSON.stringify(ASKED_AT)}) - 3 * 86400000
const orders = await all(${JSON.stringify(RECORD_ORDERS)}, 'orders', { first: 250 })
const late = orders
  .filter(o => !o.cancelledAt && o.displayFinancialStatus === 'PAID' && o.displayFulfillmentStatus === 'UNFULFILLED' && Date.parse(o.processedAt) < cutoff)
  .sort((a, b) => Date.parse(a.processedAt) - Date.parse(b.processedAt) || (a.name < b.name ? -1 : 1))
return { count: late.length, oldest: late.slice(0, 5).map(o => ({ name: o.name, processedAt: o.processedAt })), scanned: orders.length }`,
  },
  {
    id: 'refunds-by-product-reason',
    question: 'Is there a refund spike? Group refunds by product and reason.',
    code: `${PAGER}
const orders = await all(${JSON.stringify(RECORD_REFUNDS)}, 'orders', { first: 250, query: ${JSON.stringify(REFUNDED)} })
const groups = new Map()
for (const o of orders) for (const r of o.refunds) for (const l of r.refundLineItems.nodes) {
  const key = (l.lineItem.sku ?? '') + '\\u0000' + (r.note ?? '')
  const g = groups.get(key) ?? { sku: l.lineItem.sku, reason: r.note, refunds: 0, units: 0 }
  g.refunds += 1
  g.units += l.quantity
  groups.set(key, g)
}
const top = [...groups.values()].sort((a, b) => b.units - a.units || b.refunds - a.refunds || ((a.sku ?? '') + (a.reason ?? '') < (b.sku ?? '') + (b.reason ?? '') ? -1 : 1))
return { groups: groups.size, top: top.slice(0, 5) }`,
  },
  {
    id: 'open-returns-not-restocked',
    question: 'Which open returns have not been restocked yet?',
    code: `${PAGER}
const orders = await all(${JSON.stringify(RECORD_RETURNS)}, 'orders', { first: 250, query: ${JSON.stringify(HAS_RETURN)} })
const bySku = new Map()
let returns = 0
for (const o of orders) for (const r of o.returns.nodes) {
  if (r.status !== 'OPEN') continue
  const lines = r.returnLineItems.nodes.filter(l => l.unprocessedQuantity > 0)
  if (lines.length === 0) continue
  returns += 1
  for (const l of lines) {
    const sku = l.fulfillmentLineItem.lineItem.sku
    const g = bySku.get(sku) ?? { sku, units: 0, reasons: [] }
    g.units += l.unprocessedQuantity
    const reason = l.returnReasonDefinition ? l.returnReasonDefinition.name : null
    if (!g.reasons.includes(reason)) g.reasons.push(reason)
    bySku.set(sku, g)
  }
}
const skus = [...bySku.values()].sort((a, b) => b.units - a.units || ((a.sku ?? '') < (b.sku ?? '') ? -1 : 1))
return { returns, skus: skus.slice(0, 5) }`,
  },
]
