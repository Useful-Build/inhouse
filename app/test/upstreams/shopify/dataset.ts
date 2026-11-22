// The recorded Shopify dataset: its type and a hand-written checker (no npm packages here: this folder is bundled into
// the hub's test build). Nodes are in the recorder documents' shape, the union of the tools' fields, so one node serves
// every operation. A dataset is a plain value: tests build variants by editing a copy, never by changing the fake.

export type MoneyBag = { shopMoney: { amount: string; currencyCode: string } }
export type LineNode = { sku: string | null; title: string; currentQuantity: number; unfulfilledQuantity: number; originalUnitPriceSet: MoneyBag }
export type RefundNode = {
  createdAt: string | null
  note: string | null
  totalRefundedSet: MoneyBag
  refundLineItems: { nodes: { quantity: number; restockType: string; lineItem: { sku: string | null } }[] }
}
export type ReturnLineNode = {
  quantity: number
  unprocessedQuantity: number
  returnReasonDefinition: { name: string } | null
  fulfillmentLineItem: { lineItem: { sku: string | null } }
}
export type ReturnNode = { name: string; status: string; createdAt: string; returnLineItems: { nodes: ReturnLineNode[] } }
export type OrderNode = {
  id: string
  name: string
  processedAt: string
  updatedAt: string
  cancelledAt: string | null
  displayFinancialStatus: string | null
  displayFulfillmentStatus: string
  returnStatus: string
  currentTotalPriceSet: MoneyBag
  totalRefundedSet: MoneyBag
  currentSubtotalLineItemsQuantity: number
  lineItems: { nodes: LineNode[] }
  refunds: RefundNode[]
  returns: { nodes: ReturnNode[] }
}
export type LevelNode = { location: { name: string }; quantities: { name: string; quantity: number }[] }
export type VariantNode = {
  id: string
  sku: string | null
  title: string
  price: string
  inventoryItem: { tracked: boolean; inventoryLevels: { nodes: LevelNode[] } }
}
export type ProductNode = {
  id: string
  title: string
  status: string
  totalInventory: number
  tracksInventory: boolean
  variants: { nodes: VariantNode[] }
}
export type Dataset = {
  v: 1
  apiVersion: string
  recordedOn: string
  documentHashes: Record<string, string>
  currency: string
  orders: OrderNode[]
  products: ProductNode[]
}

// The checker. Each function throws with the path of the first bad value.
type Check = (v: unknown, path: string) => void

const bad = (path: string, what: string): never => {
  throw new Error(`shopify dataset: ${path} ${what}`)
}
const str: Check = (v, p) => {
  if (typeof v !== 'string') bad(p, 'must be a string')
}
const int: Check = (v, p) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) bad(p, 'must be an integer')
}
const bool: Check = (v, p) => {
  if (typeof v !== 'boolean') bad(p, 'must be a boolean')
}
const gid: Check = (v, p) => {
  if (typeof v !== 'string' || !/^gid:\/\/shopify\/[A-Za-z]+\/[0-9]+$/.test(v)) bad(p, 'must be a gid')
}
const instant: Check = (v, p) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) || !Number.isFinite(Date.parse(v))) bad(p, 'must be a UTC instant')
}
const nullable =
  (c: Check): Check =>
  (v, p) => {
    if (v !== null) c(v, p)
  }
const list =
  (c: Check): Check =>
  (v, p) => {
    if (!Array.isArray(v)) bad(p, 'must be an array')
    ;(v as unknown[]).forEach((x, i) => c(x, `${p}[${i}]`))
  }
const obj =
  (shape: Record<string, Check>): Check =>
  (v, p) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(p, 'must be an object')
    const o = v as Record<string, unknown>
    for (const k of Object.keys(o)) if (!(k in shape)) bad(`${p}.${k}`, 'is not a known field')
    for (const [k, c] of Object.entries(shape)) {
      if (!(k in o)) bad(`${p}.${k}`, 'is missing')
      c(o[k], `${p}.${k}`)
    }
  }
const nodes = (c: Check) => obj({ nodes: list(c) })

const money = obj({ shopMoney: obj({ amount: str, currencyCode: str }) })
const order = obj({
  id: gid,
  name: str,
  processedAt: instant,
  updatedAt: instant,
  cancelledAt: nullable(instant),
  displayFinancialStatus: nullable(str),
  displayFulfillmentStatus: str,
  returnStatus: str,
  currentTotalPriceSet: money,
  totalRefundedSet: money,
  currentSubtotalLineItemsQuantity: int,
  lineItems: nodes(obj({ sku: nullable(str), title: str, currentQuantity: int, unfulfilledQuantity: int, originalUnitPriceSet: money })),
  refunds: list(
    obj({
      createdAt: nullable(instant),
      note: nullable(str),
      totalRefundedSet: money,
      refundLineItems: nodes(obj({ quantity: int, restockType: str, lineItem: obj({ sku: nullable(str) }) })),
    }),
  ),
  returns: nodes(
    obj({
      name: str,
      status: str,
      createdAt: instant,
      returnLineItems: nodes(
        obj({
          quantity: int,
          unprocessedQuantity: int,
          returnReasonDefinition: nullable(obj({ name: str })),
          fulfillmentLineItem: obj({ lineItem: obj({ sku: nullable(str) }) }),
        }),
      ),
    }),
  ),
})
const product = obj({
  id: gid,
  title: str,
  status: str,
  totalInventory: int,
  tracksInventory: bool,
  variants: nodes(
    obj({
      id: gid,
      sku: nullable(str),
      title: str,
      price: str,
      inventoryItem: obj({
        tracked: bool,
        inventoryLevels: nodes(obj({ location: obj({ name: str }), quantities: list(obj({ name: str, quantity: int })) })),
      }),
    }),
  ),
})
const hashes: Check = (v, p) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(p, 'must be an object')
  for (const [k, h] of Object.entries(v as object)) if (typeof h !== 'string' || !/^[0-9a-f]{8}$/.test(h)) bad(`${p}.${k}`, 'must be a hash')
}
const dataset = obj({
  v: (v, p) => {
    if (v !== 1) bad(p, 'must be 1')
  },
  apiVersion: (v, p) => {
    if (typeof v !== 'string' || !/^\d{4}-(01|04|07|10)$/.test(v)) bad(p, 'must be an API version')
  },
  recordedOn: (v, p) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad(p, 'must be YYYY-MM-DD')
  },
  documentHashes: hashes,
  currency: (v, p) => {
    if (typeof v !== 'string' || !/^[A-Z]{3}$/.test(v)) bad(p, 'must be a currency code')
  },
  orders: list(order),
  products: list(product),
})

/** Throws (loud) unless `value` is a well-formed dataset with unique ids. */
export function checkDataset(value: unknown): Dataset {
  dataset(value, 'dataset')
  const d = value as Dataset
  const ids = new Set<string>()
  for (const id of [...d.orders.map(o => o.id), ...d.products.map(p => p.id), ...d.products.flatMap(p => p.variants.nodes.map(v => v.id))]) {
    if (ids.has(id)) bad('dataset', `has a duplicate id ${id}`)
    ids.add(id)
  }
  return d
}
