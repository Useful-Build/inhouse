// The graded morning-check cases' expectations (p4-w3.md section 6; the problem-kind list in B2's addendum), as literals and
// with no import: the node runner and the grader read this file; ./cases.ts joins each case to its dataset function.
// A case's expected result: coverage, gaps, and each item's key, severity and the order, product or return names its
// sources must show. `sources` entries are required names (an array entry means any one of its names).

export const AMBER = '#b97a14'
export const RED = '#b23c22'
export type Gap = 'orders' | 'products' | 'inventory' | 'refunds' | 'returns'
export const GAPS: readonly Gap[] = ['orders', 'products', 'inventory', 'refunds', 'returns']

/** A fault the case's upstream answers for named GraphQL operations (or for every request). */
export type FaultSpec =
  | { kind: 'unavailable'; ops: 'all' }
  | { kind: 'credentials_rejected' | 'oversize'; ops: readonly string[] }

export interface ExpectedItem {
  key: string
  sev: typeof AMBER | typeof RED
  /** Names every one of which must show in `sources[].n`; an array entry is satisfied by any one of its names. */
  sources: readonly (string | readonly string[])[]
}

export interface MorningCaseMeta {
  id: string
  group: 'graded' | 'clean' | 'outage'
  /** The name of the dataset function in ./datasets.ts. */
  builder: string
  fault?: FaultSpec
  coverage: 'complete' | 'incomplete'
  gaps: readonly Gap[]
  items: readonly ExpectedItem[]
  /**
   * The reads that succeed depend on the model's order (a rejected token marks the account failed, so every later read fails
   * too): `gaps` must include the listed ones, and `items` may be any subset of the expected (never an extra key).
   */
  lenient?: true
  note?: string
}

const complete = { coverage: 'complete', gaps: [] } as const

export const META: readonly MorningCaseMeta[] = [
  // One dataset per kind (8), plus the red check of late-orders.
  { id: 'late-orders', group: 'graded', builder: 'lateOrders', ...complete, items: [{ key: 'late-orders', sev: AMBER, sources: ['#2001', '#2002', '#2003'] }] },
  { id: 'late-orders-red', group: 'graded', builder: 'lateOrdersRed', ...complete, items: [{ key: 'late-orders', sev: RED, sources: ['#2011', '#2012'] }], note: 'one order unfulfilled for 8 days: red' },
  { id: 'unpaid-orders', group: 'graded', builder: 'unpaidOrders', ...complete, items: [{ key: 'unpaid-orders', sev: AMBER, sources: ['#2021', '#2022', '#2023'] }] },
  { id: 'open-returns', group: 'graded', builder: 'openReturns', ...complete, items: [{ key: 'open-returns', sev: AMBER, sources: ['#2031', '#2032'] }] },
  { id: 'returns-not-restocked', group: 'graded', builder: 'returnsNotRestocked', ...complete, items: [{ key: 'returns-not-restocked', sev: AMBER, sources: ['#2041', '#2042'] }] },
  { id: 'refund-spike', group: 'graded', builder: 'refundSpike', ...complete, items: [{ key: 'refund-spike', sev: RED, sources: ['#2051', '#2052', '#2053', '#2054'] }] },
  { id: 'low-stock', group: 'graded', builder: 'lowStock', ...complete, items: [{ key: 'low-stock', sev: AMBER, sources: [['MC-LOW', 'Wool socks']] }] },
  { id: 'out-of-stock', group: 'graded', builder: 'outOfStock', ...complete, items: [{ key: 'out-of-stock', sev: RED, sources: [['MC-OUT', 'Rain poncho']] }] },
  { id: 'oversold', group: 'graded', builder: 'oversold', ...complete, items: [{ key: 'oversold', sev: RED, sources: [['MC-NEG', 'Trail shell jacket']] }] },
  // Two mixed.
  {
    id: 'mixed-a', group: 'graded', builder: 'mixedA', ...complete,
    items: [
      { key: 'late-orders', sev: AMBER, sources: ['#2001', '#2002'] }, { key: 'low-stock', sev: AMBER, sources: [['MC-LOW', 'Wool socks']] },
      { key: 'refund-spike', sev: RED, sources: ['#2051', '#2052', '#2053', '#2054'] },
    ],
  },
  {
    id: 'mixed-b', group: 'graded', builder: 'mixedB', ...complete,
    items: [
      { key: 'open-returns', sev: AMBER, sources: ['#2031'] }, { key: 'oversold', sev: RED, sources: [['MC-NEG', 'Trail shell jacket']] },
      { key: 'unpaid-orders', sev: AMBER, sources: ['#2021', '#2022'] },
    ],
  },
  // The recorded fixture as it is (time-shifted to now), expected items checked by hand against the rules: #1001 is a paid,
  // unfulfilled order 5.3 days old (the other five unfulfilled are under 2 days); 21 refunds in the last 24 h against none
  // before; the SKU P4-0038 is at -4; the 11 open returns are under a day old; no other variant is under 15 in stock.
  // `refund-spike` names 21 orders and a card holds at most 10 sources, so it requires none.
  {
    id: 'fixture', group: 'graded', builder: 'fixtureStore', ...complete,
    items: [{ key: 'late-orders', sev: AMBER, sources: ['#1001'] }, { key: 'refund-spike', sev: RED, sources: [] }, { key: 'oversold', sev: RED, sources: [['P4-0038', 'Trail Rain Jacket']] }],
  },
  // Clean stores: no problem, zero items, coverage complete.
  { id: 'clean-old-orders', group: 'clean', builder: 'cleanOldOrders', ...complete, items: [] },
  { id: 'clean-steady', group: 'clean', builder: 'cleanSteady', ...complete, items: [] },
  { id: 'clean-empty', group: 'clean', builder: 'cleanEmpty', ...complete, items: [] },
  // Outages (the late-orders store, so what can still be read still shows): an outage that comes back `complete` fails.
  { id: 'outage-all', group: 'outage', builder: 'lateOrders', fault: { kind: 'unavailable', ops: 'all' }, coverage: 'incomplete', gaps: GAPS, items: [], note: 'every request answers 503 (upstream_unavailable)' },
  {
    id: 'outage-credentials', group: 'outage', builder: 'lateOrders', fault: { kind: 'credentials_rejected', ops: ['RefundsSearch'] },
    coverage: 'incomplete', gaps: ['refunds'], lenient: true, items: [{ key: 'late-orders', sev: AMBER, sources: ['#2001', '#2002', '#2003'] }], note: 'one read answers credentials_rejected; the account then stays rejected',
  },
  {
    id: 'outage-too-large', group: 'outage', builder: 'lateOrders', fault: { kind: 'oversize', ops: ['ReturnsSearch'] },
    coverage: 'incomplete', gaps: ['returns'], items: [{ key: 'late-orders', sev: AMBER, sources: ['#2001', '#2002', '#2003'] }], note: 'one read hits its bound (result_too_large)',
  },
]


/** The case's shop host, an invented name: `example-mc-late-orders.myshopify.com`. */
export const hostOf = (id: string): string => `example-mc-${id}.myshopify.com`

/** The GraphQL operation each gap's reads use (the hub's documents). */
export const OPERATIONS_OF: Readonly<Record<Gap, readonly string[]>> = {
  orders: ['OrdersSearch', 'OrderGet'], products: ['ProductsSearch'], inventory: ['InventoryLevelsGet'], refunds: ['RefundsSearch'], returns: ['ReturnsSearch'],
}
