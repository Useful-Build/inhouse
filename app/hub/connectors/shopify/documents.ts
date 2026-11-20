// The Shopify connector's GraphQL documents and their nested limits (P4 W1). The tools, the recorded upstream
// (app/test/upstreams/shopify/) and the recorder read these same constants, so this file imports nothing at runtime:
// the recorded upstream is bundled into the hub's test build and may not pull in an npm package.
// Docs read 2026-11-20 (Admin GraphQL 2026-10): queries orders, products, productVariants, currentAppInstallation;
// objects Order, LineItem, Refund, RefundLineItem, Return, ReturnLineItem, ReturnReasonDefinition, FulfillmentLineItem,
// Product, ProductVariant, InventoryItem, InventoryLevel; enums OrderSortKeys, ProductSortKeys.

export const SHOPIFY_API_VERSION = '2026-10'

/** The connector's read and required scopes (route.ts), the recorder's scope check and the recorded upstream's grant. */
export const SHOPIFY_READ_SCOPES = ['read_orders', 'read_products', 'read_inventory', 'read_locations', 'read_returns'] as const

/**
 * Nested limits per tool. Every result list is capped by one of these, so each tool's worst-case JSON stays under
 * 24 KiB (shape.test.ts computes it). A list without pageInfo (Order.refunds) is requested longer than its cap, so the
 * mapper can tell "more" from "exactly full".
 */
export const LIMITS = {
  ordersSearch: { maxFirst: 20, defaultFirst: 10, lines: 5 },
  orderGet: { first: 2, lines: 20, refunds: 5, refundLines: 5, returns: 5, returnLines: 5 },
  // scan: refunds read per order, before the window filter (one more is asked for, to tell "more" from "exactly
  // full"); refunds: the most returned per order.
  refundsSearch: { maxFirst: 10, defaultFirst: 10, scan: 5, refunds: 2, refundLines: 3, maxItems: 20 },
  returnsSearch: { maxFirst: 5, defaultFirst: 5, returns: 3, returnLines: 5, maxItems: 15 },
  productsSearch: { maxFirst: 20, defaultFirst: 10, variants: 3 },
  inventoryLevelsGet: { first: 3, levels: 10 },
} as const

/** String caps, in bytes of the string's JSON encoding (escapes and multibyte characters counted), cut at a code point. */
export const CAPS = {
  orderName: 40,
  returnName: 40,
  title: 120,
  variantTitle: 40,
  refundNoteSearch: 120,
  refundNoteGet: 200,
  reason: 60,
  location: 60,
  sku: 64,
} as const

/** The recorder's nested limits and page sizes (smaller than the tools' where the fixture is small; see record docs). */
export const RECORDER = {
  pages: { orders: 40, refunds: 18, returns: 10, products: 17 },
  lines: 5,
  refunds: 3,
  refundLines: 5,
  returns: 3,
  returnLines: 5,
  variants: 3,
  levels: 2,
  maxCost: 900,
} as const

export const QUANTITY_NAMES = ['available', 'on_hand', 'committed', 'incoming'] as const

const MONEY = '{ shopMoney { amount currencyCode } }'
const L = LIMITS
const R = RECORDER
const QUANTITIES = `quantities(names: [${QUANTITY_NAMES.map(n => `"${n}"`).join(', ')}]) { name quantity }`
const RETURN_LINE = '... on ReturnLineItem { quantity unprocessedQuantity returnReasonDefinition { name } fulfillmentLineItem { lineItem { sku } } }'

export const ORDERS_SEARCH = `query OrdersSearch($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: PROCESSED_AT, reverse: true) {
    nodes {
      id name processedAt cancelledAt
      displayFinancialStatus displayFulfillmentStatus returnStatus
      currentTotalPriceSet ${MONEY}
      totalRefundedSet ${MONEY}
      currentSubtotalLineItemsQuantity
      lineItems(first: ${L.ordersSearch.lines}) { nodes { sku currentQuantity } pageInfo { hasNextPage } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

export const ORDER_GET = `query OrderGet($query: String!) {
  orders(first: ${L.orderGet.first}, query: $query) {
    nodes {
      id name processedAt cancelledAt
      displayFinancialStatus displayFulfillmentStatus returnStatus
      currentTotalPriceSet ${MONEY}
      totalRefundedSet ${MONEY}
      lineItems(first: ${L.orderGet.lines}) {
        nodes { sku title currentQuantity unfulfilledQuantity originalUnitPriceSet ${MONEY} }
        pageInfo { hasNextPage }
      }
      refunds(first: ${L.orderGet.refunds + 1}) {
        createdAt note
        totalRefundedSet ${MONEY}
        refundLineItems(first: ${L.orderGet.refundLines}) { nodes { quantity restockType lineItem { sku } } pageInfo { hasNextPage } }
      }
      returns(first: ${L.orderGet.returns}) {
        nodes {
          name status createdAt
          returnLineItems(first: ${L.orderGet.returnLines}) { nodes { ${RETURN_LINE} } pageInfo { hasNextPage } }
        }
        pageInfo { hasNextPage }
      }
    }
  }
}`

export const REFUNDS_SEARCH = `query RefundsSearch($first: Int!, $after: String, $query: String!) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
    nodes {
      id name
      refunds(first: ${L.refundsSearch.scan + 1}) {
        createdAt note
        totalRefundedSet ${MONEY}
        refundLineItems(first: ${L.refundsSearch.refundLines}) { nodes { quantity restockType lineItem { sku } } pageInfo { hasNextPage } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

export const RETURNS_SEARCH = `query ReturnsSearch($first: Int!, $after: String, $query: String!) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
    nodes {
      id name
      returns(first: ${L.returnsSearch.returns}) {
        nodes {
          name status createdAt
          returnLineItems(first: ${L.returnsSearch.returnLines}) { nodes { ${RETURN_LINE} } pageInfo { hasNextPage } }
        }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

export const PRODUCTS_SEARCH = `query ProductsSearch($first: Int!, $after: String, $query: String, $sortKey: ProductSortKeys!) {
  shop { currencyCode }
  products(first: $first, after: $after, query: $query, sortKey: $sortKey) {
    nodes {
      id title status totalInventory tracksInventory
      variants(first: ${L.productsSearch.variants}) { nodes { id sku title price } pageInfo { hasNextPage } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

export const INVENTORY_LEVELS_GET = `query InventoryLevelsGet($query: String!) {
  productVariants(first: ${L.inventoryLevelsGet.first}, query: $query) {
    nodes {
      id sku title product { title }
      inventoryItem {
        tracked
        inventoryLevels(first: ${L.inventoryLevelsGet.levels}) { nodes { location { name } ${QUANTITIES} } pageInfo { hasNextPage } }
      }
    }
    pageInfo { hasNextPage }
  }
}`

// The recorder's documents: the union of the tools' fields (plus updatedAt, which refunds_search filters on), so one
// recorded node serves every tool operation. Sorted by ID for a stable scan.
export const RECORD_SCOPES = `query RecordScopes {
  currentAppInstallation { accessScopes { handle } }
  shop { currencyCode }
}`

export const RECORD_ORDERS = `query RecordOrders($first: Int!, $after: String) {
  orders(first: $first, after: $after, sortKey: ID) {
    nodes {
      id name processedAt updatedAt cancelledAt
      displayFinancialStatus displayFulfillmentStatus returnStatus
      currentTotalPriceSet ${MONEY}
      totalRefundedSet ${MONEY}
      currentSubtotalLineItemsQuantity
      lineItems(first: ${R.lines}) {
        nodes { sku title currentQuantity unfulfilledQuantity originalUnitPriceSet ${MONEY} }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

export const RECORD_REFUNDS = `query RecordRefunds($first: Int!, $after: String, $query: String!) {
  orders(first: $first, after: $after, query: $query, sortKey: ID) {
    nodes {
      id
      refunds(first: ${R.refunds}) {
        createdAt note
        totalRefundedSet ${MONEY}
        refundLineItems(first: ${R.refundLines}) { nodes { quantity restockType lineItem { sku } } pageInfo { hasNextPage } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

export const RECORD_RETURNS = `query RecordReturns($first: Int!, $after: String, $query: String!) {
  orders(first: $first, after: $after, query: $query, sortKey: ID) {
    nodes {
      id
      returns(first: ${R.returns}) {
        nodes {
          name status createdAt
          returnLineItems(first: ${R.returnLines}) { nodes { ${RETURN_LINE} } pageInfo { hasNextPage } }
        }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

export const RECORD_PRODUCTS = `query RecordProducts($first: Int!, $after: String) {
  products(first: $first, after: $after, sortKey: ID) {
    nodes {
      id title status totalInventory tracksInventory
      variants(first: ${R.variants}) {
        nodes {
          id sku title price
          inventoryItem {
            tracked
            inventoryLevels(first: ${R.levels}) { nodes { location { name } ${QUANTITIES} } pageInfo { hasNextPage } }
          }
        }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

export const TOOL_OPERATIONS = {
  OrdersSearch: ORDERS_SEARCH,
  OrderGet: ORDER_GET,
  RefundsSearch: REFUNDS_SEARCH,
  ReturnsSearch: RETURNS_SEARCH,
  ProductsSearch: PRODUCTS_SEARCH,
  InventoryLevelsGet: INVENTORY_LEVELS_GET,
} as const

export const RECORDER_OPERATIONS = {
  RecordScopes: RECORD_SCOPES,
  RecordOrders: RECORD_ORDERS,
  RecordRefunds: RECORD_REFUNDS,
  RecordReturns: RECORD_RETURNS,
  RecordProducts: RECORD_PRODUCTS,
} as const

export const OPERATIONS: Readonly<Record<string, string>> = { ...TOOL_OPERATIONS, ...RECORDER_OPERATIONS }

/** FNV-1a 32-bit over UTF-16 code units, as 8 hex digits. Detects a changed document; not a security hash. */
export function documentHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function currentDocumentHashes(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, text] of Object.entries(OPERATIONS)) out[name] = documentHash(text)
  return out
}

// The search-query clauses search.ts builds and the recorded upstream's query.ts parses back. Types only.
export type EqField = 'financial_status' | 'fulfillment_status' | 'return_status' | 'sku' | 'name' | 'status'
export type EqClause = { kind: 'eq'; field: EqField; value: string; negate?: true }
export type Clause =
  | EqClause
  | { kind: 'range'; field: 'processed_at' | 'updated_at'; op: '>=' | '<'; at: string }
  | { kind: 'below'; field: 'inventory_total'; value: number }
  | { kind: 'phrase'; value: string }
  | { kind: 'any'; of: EqClause[] }

/** Instants in a search query: always this shape, single-quoted. */
export const QUERY_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
