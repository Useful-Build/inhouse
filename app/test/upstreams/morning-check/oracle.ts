// The eight rules of B2's problem-kind list, applied to a dataset in plain code: what a perfect morning check would find.
// It is the test's independent oracle for the datasets (each case's literal expected items must equal it), and the way to
// check the time-shifted fixture by hand. Not the grader and never sent to a model. No npm imports.
import type { Dataset } from '../shopify/dataset'

const DAY = 86_400_000
export type Sev = 'amber' | 'red'
export interface Found { key: string; sev: Sev; /** The order names, or for stock kinds the variants (sku, title). */ sources: string[] }

const t = (iso: string) => Date.parse(iso)

export function expectedFindings(d: Dataset, now: number): Found[] {
  const out: Found[] = []
  const live = d.orders.filter(o => o.cancelledAt === null)
  const age = (iso: string) => (now - t(iso)) / DAY
  const names = (os: { name: string }[]) => os.map(o => o.name).sort()

  const late = live.filter(o => (o.displayFinancialStatus === 'PAID' || o.displayFinancialStatus === 'PARTIALLY_REFUNDED') && o.displayFulfillmentStatus === 'UNFULFILLED' && age(o.processedAt) > 3)
  if (late.length > 0) out.push({ key: 'late-orders', sev: late.some(o => age(o.processedAt) > 7) ? 'red' : 'amber', sources: names(late) })

  const unpaid = live.filter(o => ['PENDING', 'AUTHORIZED', 'PARTIALLY_PAID'].includes(o.displayFinancialStatus ?? '') && age(o.processedAt) > 2)
  if (unpaid.length > 0) out.push({ key: 'unpaid-orders', sev: 'amber', sources: names(unpaid) })

  const open = live.filter(o => o.returns.nodes.some(r => (r.status === 'REQUESTED' || r.status === 'OPEN') && Math.min(age(r.createdAt), age(o.updatedAt)) > 3))
  if (open.length > 0) out.push({ key: 'open-returns', sev: 'amber', sources: names(open) })

  const unstocked = live.filter(o => o.returns.nodes.some(r => r.status === 'CLOSED' && r.returnLineItems.nodes.some(l => l.unprocessedQuantity > 0) && age(o.updatedAt) > 2))
  if (unstocked.length > 0) out.push({ key: 'returns-not-restocked', sev: 'amber', sources: names(unstocked) })

  const refunds = d.orders.flatMap(o => o.refunds.map(r => ({ o, at: r.createdAt === null ? 0 : t(r.createdAt) })))
  const last24 = refunds.filter(r => now - r.at <= DAY && now - r.at >= 0)
  const before = refunds.filter(r => now - r.at > DAY && now - r.at <= 15 * DAY)
  if (last24.length >= 3 && last24.length >= 2 * (before.length / 14)) out.push({ key: 'refund-spike', sev: 'red', sources: names([...new Map(last24.map(r => [r.o.name, r.o])).values()]) })

  const sold = new Map<string, number>()
  for (const o of live) if (age(o.processedAt) <= 14) for (const l of o.lineItems.nodes) if (l.sku !== null) sold.set(l.sku, (sold.get(l.sku) ?? 0) + l.currentQuantity)
  const variants = d.products.flatMap(p => p.variants.nodes.map(v => ({
    sku: v.sku ?? '', title: p.title,
    available: v.inventoryItem.inventoryLevels.nodes.reduce((n, l) => n + (l.quantities.find(q => q.name === 'available')?.quantity ?? 0), 0),
  })))
  const stock = (key: string, sev: Sev, pick: (v: (typeof variants)[number]) => boolean) => {
    const hit = variants.filter(pick)
    if (hit.length > 0) out.push({ key, sev, sources: hit.map(v => v.sku).sort() })
  }
  stock('low-stock', 'amber', v => (sold.get(v.sku) ?? 0) > 0 && v.available > 0 && v.available <= 7 * ((sold.get(v.sku) ?? 0) / 14))
  stock('out-of-stock', 'red', v => (sold.get(v.sku) ?? 0) > 0 && v.available === 0)
  stock('oversold', 'red', v => v.available < 0)
  return out
}
