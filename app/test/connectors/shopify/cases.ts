// The fixed live case list (P4 W1): used by the recorder's differential run, the nightly and the orchestrator's live
// check. Every filter of every tool at least once, max `first` on each list tool (so the recorded requestedQueryCost is
// the worst case), second pages through `after`, an injection-shaped SKU and an unknown one.
//
// Fixture facts are from the P0 seeding record (S4, 2026-11-19): the store is seeded once and never changes, so they
// state counts and values, never a date relative to now. A fact returns null when it holds, else a short reason with
// no store data in it (the live script prints it).

export type LiveCase = {
  name: string
  tool: string
  input: Record<string, unknown>
  /** Pages to follow through nextCursor (default 1). The run stops early when nextCursor is null. */
  pages?: number
  /** Checks the case's page results (one per page sent). */
  fact?: (pages: unknown[]) => string | null
}

type Item = Record<string, any>
const items = (pages: unknown[]): Item[] => pages.flatMap(p => (p as { items: Item[] }).items)
const lastCursor = (pages: unknown[]) => (pages.at(-1) as { nextCursor: string | null }).nextCursor
const expectCount = (what: string, got: number, want: number) => (got === want ? null : `${what}: ${got}, expected ${want}`)

export const INJECTION_SKU = 'X" OR status:"any'
export const UNKNOWN_SKU = 'INHOUSE-NO-SUCH-SKU-0000'

export const CASES: readonly LiveCase[] = [
  // orders_search
  { name: 'orders max first, two pages', tool: 'orders_search', input: { first: 20 }, pages: 2 },
  { name: 'orders paid and unfulfilled', tool: 'orders_search', input: { financialStatus: 'paid', fulfillmentStatus: 'unfulfilled', first: 20 } },
  { name: 'orders by return status', tool: 'orders_search', input: { returnStatus: 'return_requested', first: 20 } },
  {
    name: 'orders on the run-out SKU',
    tool: 'orders_search',
    input: { sku: 'P4-0013', first: 20 },
    pages: 4,
    fact: pages => {
      if (lastCursor(pages) !== null) return 'more pages than expected'
      const units = items(pages)
        .flatMap(o => o.lines as Item[])
        .filter(l => l.sku === 'P4-0013')
        .reduce((s, l) => s + (l.quantity as number), 0)
      return expectCount('units on P4-0013', units, 97)
    },
  },
  { name: 'orders injection-shaped sku', tool: 'orders_search', input: { sku: INJECTION_SKU }, fact: p => expectCount('orders', items(p).length, 0) },
  { name: 'orders unknown sku', tool: 'orders_search', input: { sku: UNKNOWN_SKU }, fact: p => expectCount('orders', items(p).length, 0) },

  // order_get
  {
    name: 'order #1001',
    tool: 'order_get',
    input: { name: '#1001' },
    fact: ([p]) => {
      const o = (p as { order: Item | null }).order
      if (!o) return 'order #1001 not found'
      if (o.financialStatus !== 'PAID') return 'order #1001 is not paid'
      if (o.fulfillmentStatus !== 'UNFULFILLED') return 'order #1001 is not unfulfilled'
      return null
    },
  },
  { name: 'order unknown name', tool: 'order_get', input: { name: '#999999' }, fact: ([p]) => ((p as { order: unknown }).order === null ? null : 'expected no order') },

  // refunds_search
  {
    name: 'refunds on the stove SKU',
    tool: 'refunds_search',
    input: { createdFrom: '2026-11-19T00:00:00Z', sku: 'P4-0062', first: 10 },
    pages: 4,
    fact: pages => {
      if (lastCursor(pages) !== null) return 'more pages than expected'
      const r = items(pages).filter(i => (i.lines as Item[]).some(l => l.sku === 'P4-0062'))
      if (r.some(i => i.note !== 'Igniter failed')) return 'a refund note differs'
      if (r.some(i => (i.lines as Item[]).some(l => l.sku === 'P4-0062' && l.restockType !== 'NO_RESTOCK'))) return 'a restock type differs'
      return expectCount('refunds with a P4-0062 line', r.length, 21)
    },
  },

  // returns_search
  {
    name: 'returns on the shell SKU',
    tool: 'returns_search',
    input: { sku: 'P4-0089', first: 5 },
    pages: 4,
    fact: pages => {
      if (lastCursor(pages) !== null) return 'more pages than expected'
      const open = items(pages).filter(i => (i.lines as Item[]).some(l => l.sku === 'P4-0089' && (l.unprocessedQuantity as number) > 0))
      return expectCount('returns on P4-0089 not processed', open.length, 11)
    },
  },
  { name: 'returns by status', tool: 'returns_search', input: { returnStatus: 'return_requested', first: 5 } },
  { name: 'returns any, two pages', tool: 'returns_search', input: { first: 5 }, pages: 2 },

  // products_search
  { name: 'products by text', tool: 'products_search', input: { text: 'P4-0062', first: 20 } },
  { name: 'products active, two pages', tool: 'products_search', input: { status: 'active', first: 20 }, pages: 2 },
  {
    name: 'products out of stock',
    tool: 'products_search',
    input: { stockBelow: 1, first: 20 },
    fact: p => (items(p).some(i => (i.variants as Item[]).some(v => v.sku === 'P4-0038')) ? null : 'P4-0038 is not below 1'),
  },

  // inventory_levels_get
  {
    name: 'stock of the run-out SKU',
    tool: 'inventory_levels_get',
    input: { sku: 'P4-0013' },
    fact: ([p]) => {
      const m = (p as { matches: Item[] }).matches
      return expectCount('available on P4-0013', m.flatMap(x => x.levels as Item[]).reduce((s, l) => s + (l.available as number), 0), 29)
    },
  },
  {
    name: 'stock of the oversold SKU',
    tool: 'inventory_levels_get',
    input: { sku: 'P4-0038' },
    fact: ([p]) => {
      const m = (p as { matches: Item[] }).matches
      return expectCount('available on P4-0038', m.flatMap(x => x.levels as Item[]).reduce((s, l) => s + (l.available as number), 0), -4)
    },
  },
  { name: 'stock unknown sku', tool: 'inventory_levels_get', input: { sku: UNKNOWN_SKU }, fact: ([p]) => expectCount('matches', (p as { matches: unknown[] }).matches.length, 0) },
  { name: 'stock injection-shaped sku', tool: 'inventory_levels_get', input: { sku: INJECTION_SKU }, fact: ([p]) => expectCount('matches', (p as { matches: unknown[] }).matches.length, 0) },
  // A prefix of the fixture's P4-0010 to P4-0019: search may match loosely, the tool keeps exact matches only.
  { name: 'stock of a SKU prefix', tool: 'inventory_levels_get', input: { sku: 'P4-001' }, fact: ([p]) => expectCount('matches', (p as { matches: unknown[] }).matches.length, 0) },
]

/** The dates the window cases are cut from: every order's processedAt and every refund's createdAt in the recording. */
export type WindowSource = { processedAt: string[]; refundCreatedAt: string[] }

export function windowSource(d: { orders: { processedAt: string; refunds: { createdAt: string | null }[] }[] }): WindowSource {
  return {
    processedAt: d.orders.map(o => o.processedAt),
    refundCreatedAt: d.orders.flatMap(o => o.refunds.map(r => r.createdAt).filter((c): c is string => c !== null)),
  }
}

/**
 * [the earliest date, the median date): one boundary inside the data, so the upper bound excludes something. Null when
 * the dates can't make such a window (fewer than two distinct values).
 */
export function windowOf(dates: readonly string[]): { from: string; to: string } | null {
  const ms = [...new Set(dates.map(d => Date.parse(d)).filter(Number.isFinite))].sort((a, b) => a - b)
  if (ms.length < 2) return null
  const at = (x: number) => new Date(x).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return { from: at(Math.floor(ms[0]! / 1000) * 1000), to: at(Math.floor(ms[Math.floor(ms.length / 2)]! / 1000) * 1000) }
}

/** The window cases, derived from the recorded dates (the recorder from its passes, the live check from the recording). */
export function windowCases(src: WindowSource): LiveCase[] {
  const out: LiveCase[] = []
  const orders = windowOf(src.processedAt)
  if (orders) out.push({ name: 'orders in a processed window', tool: 'orders_search', input: { processedFrom: orders.from, processedTo: orders.to, first: 20 }, pages: 2 })
  const refunds = windowOf(src.refundCreatedAt)
  if (refunds) out.push({ name: 'refunds in a closed window', tool: 'refunds_search', input: { createdFrom: refunds.from, createdTo: refunds.to, first: 10 }, pages: 2 })
  return out
}

export const casesFor = (src: WindowSource, base: readonly LiveCase[] = CASES): LiveCase[] => [...base, ...windowCases(src)]
