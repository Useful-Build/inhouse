// The four S4 answers computed straight from the recorded dataset with plain loops (A.5). Written apart from
// scripts.ts and sharing no code with it: the scripts read through Shopify's documents and paging, this reads the
// dataset file. Ties break the same documented way (stock, then title; units, then count, then key).
import type { Dataset } from '../../../test/upstreams/shopify/dataset'

const DAY_MS = 24 * 60 * 60 * 1000

export function lowestStock(d: Dataset) {
  const tracked: { title: string; stock: number }[] = []
  let overPrice = 0
  for (const p of d.products) {
    if (p.tracksInventory) tracked.push({ title: p.title, stock: p.totalInventory })
    let over = false
    for (const v of p.variants.nodes) if (parseFloat(v.price) > 150) over = true
    if (over) overPrice++
  }
  tracked.sort((a, b) => a.stock - b.stock || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
  return { lowest: tracked.slice(0, 5), overPrice, products: d.products.length }
}

export function unfulfilledOverThreeDays(d: Dataset, askedAt: string) {
  const cutoff = new Date(askedAt).getTime() - 3 * DAY_MS
  const late: { name: string; processedAt: string }[] = []
  for (const o of d.orders) {
    if (o.cancelledAt !== null) continue
    if (o.displayFinancialStatus !== 'PAID' || o.displayFulfillmentStatus !== 'UNFULFILLED') continue
    if (new Date(o.processedAt).getTime() >= cutoff) continue
    late.push({ name: o.name, processedAt: o.processedAt })
  }
  late.sort((a, b) => new Date(a.processedAt).getTime() - new Date(b.processedAt).getTime() || (a.name < b.name ? -1 : 1))
  return { count: late.length, oldest: late.slice(0, 5), scanned: d.orders.length }
}

export function refundsByProductAndReason(d: Dataset) {
  const groups: { sku: string | null; reason: string | null; refunds: number; units: number }[] = []
  for (const o of d.orders) {
    if (o.displayFinancialStatus !== 'REFUNDED' && o.displayFinancialStatus !== 'PARTIALLY_REFUNDED') continue
    for (const r of o.refunds) {
      for (const l of r.refundLineItems.nodes) {
        let g = groups.find(x => x.sku === l.lineItem.sku && x.reason === r.note)
        if (!g) {
          g = { sku: l.lineItem.sku, reason: r.note, refunds: 0, units: 0 }
          groups.push(g)
        }
        g.refunds++
        g.units += l.quantity
      }
    }
  }
  const key = (g: { sku: string | null; reason: string | null }) => `${g.sku ?? ''}${g.reason ?? ''}`
  const top = [...groups].sort((a, b) => b.units - a.units || b.refunds - a.refunds || (key(a) < key(b) ? -1 : 1))
  return { groups: groups.length, top: top.slice(0, 5) }
}

export function openReturnsNotRestocked(d: Dataset) {
  const bySku: { sku: string | null; units: number; reasons: (string | null)[] }[] = []
  let returns = 0
  for (const o of d.orders) {
    if (o.returnStatus === 'NO_RETURN') continue
    for (const r of o.returns.nodes) {
      if (r.status !== 'OPEN') continue
      let counted = false
      for (const l of r.returnLineItems.nodes) {
        if (l.unprocessedQuantity <= 0) continue
        if (!counted) {
          returns++
          counted = true
        }
        const sku = l.fulfillmentLineItem.lineItem.sku
        let g = bySku.find(x => x.sku === sku)
        if (!g) {
          g = { sku, units: 0, reasons: [] }
          bySku.push(g)
        }
        g.units += l.unprocessedQuantity
        const reason = l.returnReasonDefinition === null ? null : l.returnReasonDefinition.name
        if (!g.reasons.includes(reason)) g.reasons.push(reason)
      }
    }
  }
  bySku.sort((a, b) => b.units - a.units || ((a.sku ?? '') < (b.sku ?? '') ? -1 : 1))
  return { returns, skus: bySku.slice(0, 5) }
}
