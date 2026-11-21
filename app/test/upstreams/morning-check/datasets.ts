// The graded morning-check set's datasets (p4-w3.md section 6, B2's problem-kind list). Every dataset is a function of
// `now`: a planted age is relative ("5 days ago"), and the recorded fixture is time-shifted by (now - its recording), so
// the rules ("more than 3 days", "the last 24 h") read the same on any run day. Invented data only. No npm imports: the hub's
// test build bundles this folder through ./upstreams.ts (like test/upstreams/).
import type { Dataset, LevelNode, OrderNode, ProductNode, RefundNode, ReturnNode } from '../shopify/dataset'
import { currentDocumentHashes } from '../../../hub/connectors/shopify/documents'
import { dataset as fixtureDataset } from '../shopify/recordings/fixture/dataset'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR

const usd = (amount: string) => ({ shopMoney: { amount, currencyCode: 'USD' } })
const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')

export interface Sku { sku: string; title: string; available: number }
export interface Line { sku: string; qty: number; unfulfilled?: number }
export interface OrderSpec {
  /** The order number: the name is `#<n>`. */
  n: number
  ageMs: number
  /** When the order last changed (default: when it was placed). */
  updatedAgoMs?: number
  fin?: string
  ful?: string
  cancelled?: boolean
  lines?: Line[]
  refunds?: { agoMs: number; amount?: string }[]
  returns?: { name: string; status: string; agoMs: number; unprocessed?: number }[]
}

const titleOf = new Map<string, string>()

/** A dataset from its orders and stock. `now` anchors every age. */
export function store(now: number, orders: OrderSpec[], skus: Sku[], recordedOn = iso(now).slice(0, 10)): Dataset {
  for (const s of skus) titleOf.set(s.sku, s.title)
  const price = (sku: string) => (sku.length % 5 + 5).toFixed(2)
  const orderNodes: OrderNode[] = orders.map(o => {
    const lines = o.lines ?? [{ sku: skus[o.n % skus.length]!.sku, qty: 1 }]
    const placed = iso(now - o.ageMs)
    const refunds: RefundNode[] = (o.refunds ?? []).map(r => ({
      createdAt: iso(now - r.agoMs), note: null, totalRefundedSet: usd(r.amount ?? '10.00'),
      refundLineItems: { nodes: [{ quantity: 1, restockType: 'RETURN', lineItem: { sku: lines[0]!.sku } }] },
    }))
    const returns: ReturnNode[] = (o.returns ?? []).map(r => ({
      name: r.name, status: r.status, createdAt: iso(now - r.agoMs),
      returnLineItems: { nodes: [{ quantity: 1, unprocessedQuantity: r.unprocessed ?? 1, returnReasonDefinition: null, fulfillmentLineItem: { lineItem: { sku: lines[0]!.sku } } }] },
    }))
    const total = lines.reduce((t, l) => t + l.qty * Number(price(l.sku)), 0).toFixed(2)
    return {
      id: `gid://shopify/Order/${9_000_000_000 + o.n}`, name: `#${o.n}`, processedAt: placed, updatedAt: iso(now - (o.updatedAgoMs ?? o.ageMs)),
      cancelledAt: o.cancelled ? placed : null, displayFinancialStatus: o.fin ?? 'PAID', displayFulfillmentStatus: o.ful ?? 'FULFILLED',
      returnStatus: returns.length > 0 ? 'IN_PROGRESS' : 'NO_RETURN', currentTotalPriceSet: usd(total), totalRefundedSet: usd(refunds.length > 0 ? '10.00' : '0.00'),
      currentSubtotalLineItemsQuantity: lines.reduce((t, l) => t + l.qty, 0),
      lineItems: { nodes: lines.map(l => ({ sku: l.sku, title: titleOf.get(l.sku) ?? l.sku, currentQuantity: l.qty, unfulfilledQuantity: l.unfulfilled ?? (o.ful === 'UNFULFILLED' ? l.qty : 0), originalUnitPriceSet: usd(price(l.sku)) })) },
      refunds, returns: { nodes: returns },
    }
  })
  const level = (available: number): LevelNode => ({
    location: { name: 'Warehouse' },
    quantities: [{ name: 'available', quantity: available }, { name: 'on_hand', quantity: Math.max(available, 0) }, { name: 'committed', quantity: 0 }, { name: 'incoming', quantity: 0 }],
  })
  const products: ProductNode[] = skus.map((s, i) => ({
    id: `gid://shopify/Product/${7_000_000_000 + i}`, title: s.title, status: 'ACTIVE', totalInventory: s.available, tracksInventory: true,
    variants: { nodes: [{ id: `gid://shopify/ProductVariant/${8_000_000_000 + i}`, sku: s.sku, title: 'Default Title', price: price(s.sku), inventoryItem: { tracked: true, inventoryLevels: { nodes: [level(s.available)] } } }] },
  }))
  return { v: 1, apiVersion: '2026-10', recordedOn, documentHashes: currentDocumentHashes(), currency: 'USD', orders: orderNodes, products }
}

/** The six invented products every store sells. */
export const BASE_SKUS: Sku[] = [
  { sku: 'MC-LAN', title: 'Trail lantern', available: 400 }, { sku: 'MC-STK', title: 'Tent stakes', available: 400 }, { sku: 'MC-MUG', title: 'Insulated mug', available: 400 },
  { sku: 'MC-TRP', title: 'Camp tarp', available: 400 }, { sku: 'MC-ROP', title: 'Guy rope', available: 400 }, { sku: 'MC-STV', title: 'Camp stove', available: 400 },
]

/**
 * A healthy store: 24 fulfilled orders from 1 to 29 days old (one unit each, about two per product in 14 days), plenty of
 * stock, and a steady trickle of refunds (one every three days). It crosses none of the eight rules.
 */
export function healthyOrders(): OrderSpec[] {
  return Array.from({ length: 24 }, (_, i): OrderSpec => ({
    n: 1001 + i, ageMs: (1 + i * 1.2) * DAY,
    ...(i % 3 === 2 ? { refunds: [{ agoMs: (1 + i * 1.2) * DAY - 2 * HOUR }] } : {}),
  }))
}

export const healthy = (now: number): Dataset => store(now, healthyOrders(), BASE_SKUS)

// ---- one planted problem each (on top of the healthy store) ----

/** Paid, unfulfilled, not cancelled, placed more than 3 days ago: three orders, 5 to 6 days old (amber). */
export const lateOrders = (now: number): Dataset =>
  store(now, [...healthyOrders(), { n: 2001, ageMs: 5 * DAY, ful: 'UNFULFILLED' }, { n: 2002, ageMs: 5.5 * DAY, ful: 'UNFULFILLED' }, { n: 2003, ageMs: 6 * DAY, ful: 'UNFULFILLED' }], BASE_SKUS)

/** One order unfulfilled for 8 days and one for 4: red. */
export const lateOrdersRed = (now: number): Dataset =>
  store(now, [...healthyOrders(), { n: 2011, ageMs: 8 * DAY, ful: 'UNFULFILLED' }, { n: 2012, ageMs: 4 * DAY, ful: 'UNFULFILLED' }], BASE_SKUS)

/** Open orders whose payment is pending, authorized and not captured, or partial, for more than 2 days. */
export const unpaidOrders = (now: number): Dataset =>
  store(now, [
    ...healthyOrders(),
    { n: 2021, ageMs: 3 * DAY, fin: 'PENDING', ful: 'UNFULFILLED' }, { n: 2022, ageMs: 4 * DAY, fin: 'AUTHORIZED', ful: 'UNFULFILLED' }, { n: 2023, ageMs: 3.5 * DAY, fin: 'PARTIALLY_PAID', ful: 'UNFULFILLED' },
  ], BASE_SKUS)

/** Returns requested or open, with no progress for 5 days. */
export const openReturns = (now: number): Dataset =>
  store(now, [
    ...healthyOrders(),
    { n: 2031, ageMs: 9 * DAY, updatedAgoMs: 5 * DAY, returns: [{ name: '#2031-R1', status: 'OPEN', agoMs: 5 * DAY }] },
    { n: 2032, ageMs: 10 * DAY, updatedAgoMs: 6 * DAY, returns: [{ name: '#2032-R1', status: 'REQUESTED', agoMs: 6 * DAY }] },
  ], BASE_SKUS)

/** Returns received (closed) whose items weren't restocked 4 days on. */
export const returnsNotRestocked = (now: number): Dataset =>
  store(now, [
    ...healthyOrders(),
    { n: 2041, ageMs: 12 * DAY, updatedAgoMs: 4 * DAY, returns: [{ name: '#2041-R1', status: 'CLOSED', agoMs: 6 * DAY, unprocessed: 1 }] },
    { n: 2042, ageMs: 13 * DAY, updatedAgoMs: 3.5 * DAY, returns: [{ name: '#2042-R1', status: 'CLOSED', agoMs: 6 * DAY, unprocessed: 2 }] },
  ], BASE_SKUS)

/** Four refunds in the last 24 h against a background of about one every three days. */
export const refundSpike = (now: number): Dataset =>
  store(now, [
    ...healthyOrders(),
    ...[2, 5, 9, 14].map((h, i): OrderSpec => ({ n: 2051 + i, ageMs: 6 * DAY, refunds: [{ agoMs: h * HOUR, amount: '25.00' }] })),
  ], BASE_SKUS)

const sellers = (sku: string, from: number, units: number): OrderSpec[] =>
  Array.from({ length: units }, (_, i): OrderSpec => ({ n: from + i, ageMs: (1 + i) * DAY, lines: [{ sku, qty: 1 }] }))

/** A variant that sold ten units in the last ten days (about 0.7 a day) and has 4 left: under 7 days of sales. */
export const lowStock = (now: number): Dataset =>
  store(now, [...healthyOrders(), ...sellers('MC-LOW', 2061, 10)], [...BASE_SKUS, { sku: 'MC-LOW', title: 'Wool socks', available: 4 }])

/** A variant that sold ten units in the last ten days and has none left. */
export const outOfStock = (now: number): Dataset =>
  store(now, [...healthyOrders(), ...sellers('MC-OUT', 2071, 10)], [...BASE_SKUS, { sku: 'MC-OUT', title: 'Rain poncho', available: 0 }])

/** A variant with negative available stock. */
export const oversold = (now: number): Dataset =>
  store(now, healthyOrders(), [...BASE_SKUS, { sku: 'MC-NEG', title: 'Trail shell jacket', available: -3 }])

/** Late orders, low stock and a refund spike together. */
export const mixedA = (now: number): Dataset =>
  store(now, [
    ...healthyOrders(),
    { n: 2001, ageMs: 5 * DAY, ful: 'UNFULFILLED' }, { n: 2002, ageMs: 6 * DAY, ful: 'UNFULFILLED' },
    ...sellers('MC-LOW', 2061, 10),
    ...[2, 5, 9, 14].map((h, i): OrderSpec => ({ n: 2051 + i, ageMs: 6 * DAY, refunds: [{ agoMs: h * HOUR, amount: '25.00' }] })),
  ], [...BASE_SKUS, { sku: 'MC-LOW', title: 'Wool socks', available: 4 }])

/** Open returns, an oversold variant and unpaid orders together. */
export const mixedB = (now: number): Dataset =>
  store(now, [
    ...healthyOrders(),
    { n: 2031, ageMs: 9 * DAY, updatedAgoMs: 5 * DAY, returns: [{ name: '#2031-R1', status: 'OPEN', agoMs: 5 * DAY }] },
    { n: 2021, ageMs: 3 * DAY, fin: 'PENDING', ful: 'UNFULFILLED' }, { n: 2022, ageMs: 4 * DAY, fin: 'AUTHORIZED', ful: 'UNFULFILLED' },
  ], [...BASE_SKUS, { sku: 'MC-NEG', title: 'Trail shell jacket', available: -3 }])

// ---- clean stores (no problem; the expected result is zero items, coverage complete) ----

/** Only old fulfilled orders (20 to 80 days), steady stock. */
export const cleanOldOrders = (now: number): Dataset =>
  store(now, Array.from({ length: 12 }, (_, i): OrderSpec => ({ n: 3001 + i, ageMs: (20 + i * 5) * DAY })), BASE_SKUS)
/** Plenty of stock and steady refunds. */
export const cleanSteady = healthy
/** No orders at all. */
export const cleanEmpty = (now: number): Dataset => store(now, [], BASE_SKUS.slice(0, 3))

// ---- the recorded fixture, time-shifted ----

/** Every instant in the dataset moved by `deltaMs` (a UTC `…Z` string stays one). */
export function shifted(d: Dataset, deltaMs: number): Dataset {
  const move = (v: unknown): unknown => {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) return iso(Date.parse(v) + deltaMs)
    if (Array.isArray(v)) return v.map(move)
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'documentHashes' ? x : move(x)]))
    return v
  }
  return move(d) as Dataset
}

/** The fixture is recorded 2026-11-20; its newest rows are from the evening of the 19th. */
export const FIXTURE_RECORDED_AT = Date.parse('2026-11-20T00:00:00Z')
/** The recorded store with every date moved so it was recorded just now: its relative ages stay as recorded. */
export const fixtureStore = (now: number): Dataset => shifted(fixtureDataset as Dataset, now - FIXTURE_RECORDED_AT)
