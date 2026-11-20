// The level 1 field allowlists (Acceptance 3). DOCUMENT_FIELDS holds every selected leaf path of every document (tool
// and recorder), RESULT_FIELDS every key path a tool's result can carry. fields.test.ts asserts each document parses to
// exactly its list, each tool's parser reads exactly its document's list, and a maximal result has exactly its result
// list; so a new field fails until both lists change, in review. DENIED_FIELDS is checked over every path.

export const DOCUMENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  OrdersSearch: [
    'orders.nodes.id', 'orders.nodes.name', 'orders.nodes.processedAt', 'orders.nodes.cancelledAt',
    'orders.nodes.displayFinancialStatus', 'orders.nodes.displayFulfillmentStatus', 'orders.nodes.returnStatus',
    'orders.nodes.currentTotalPriceSet.shopMoney.amount', 'orders.nodes.currentTotalPriceSet.shopMoney.currencyCode',
    'orders.nodes.totalRefundedSet.shopMoney.amount', 'orders.nodes.totalRefundedSet.shopMoney.currencyCode',
    'orders.nodes.currentSubtotalLineItemsQuantity', 'orders.nodes.lineItems.nodes.sku',
    'orders.nodes.lineItems.nodes.currentQuantity', 'orders.nodes.lineItems.pageInfo.hasNextPage',
    'orders.pageInfo.hasNextPage', 'orders.pageInfo.endCursor',
  ],
  OrderGet: [
    'orders.nodes.id', 'orders.nodes.name', 'orders.nodes.processedAt', 'orders.nodes.cancelledAt',
    'orders.nodes.displayFinancialStatus', 'orders.nodes.displayFulfillmentStatus', 'orders.nodes.returnStatus',
    'orders.nodes.currentTotalPriceSet.shopMoney.amount', 'orders.nodes.currentTotalPriceSet.shopMoney.currencyCode',
    'orders.nodes.totalRefundedSet.shopMoney.amount', 'orders.nodes.totalRefundedSet.shopMoney.currencyCode',
    'orders.nodes.lineItems.nodes.sku', 'orders.nodes.lineItems.nodes.title',
    'orders.nodes.lineItems.nodes.currentQuantity', 'orders.nodes.lineItems.nodes.unfulfilledQuantity',
    'orders.nodes.lineItems.nodes.originalUnitPriceSet.shopMoney.amount',
    'orders.nodes.lineItems.nodes.originalUnitPriceSet.shopMoney.currencyCode',
    'orders.nodes.lineItems.pageInfo.hasNextPage', 'orders.nodes.refunds.createdAt', 'orders.nodes.refunds.note',
    'orders.nodes.refunds.totalRefundedSet.shopMoney.amount',
    'orders.nodes.refunds.totalRefundedSet.shopMoney.currencyCode',
    'orders.nodes.refunds.refundLineItems.nodes.quantity', 'orders.nodes.refunds.refundLineItems.nodes.restockType',
    'orders.nodes.refunds.refundLineItems.nodes.lineItem.sku',
    'orders.nodes.refunds.refundLineItems.pageInfo.hasNextPage', 'orders.nodes.returns.nodes.name',
    'orders.nodes.returns.nodes.status', 'orders.nodes.returns.nodes.createdAt',
    'orders.nodes.returns.nodes.returnLineItems.nodes.quantity',
    'orders.nodes.returns.nodes.returnLineItems.nodes.unprocessedQuantity',
    'orders.nodes.returns.nodes.returnLineItems.nodes.returnReasonDefinition.name',
    'orders.nodes.returns.nodes.returnLineItems.nodes.fulfillmentLineItem.lineItem.sku',
    'orders.nodes.returns.nodes.returnLineItems.pageInfo.hasNextPage', 'orders.nodes.returns.pageInfo.hasNextPage',
  ],
  RefundsSearch: [
    'orders.nodes.id', 'orders.nodes.name', 'orders.nodes.refunds.createdAt', 'orders.nodes.refunds.note',
    'orders.nodes.refunds.totalRefundedSet.shopMoney.amount',
    'orders.nodes.refunds.totalRefundedSet.shopMoney.currencyCode',
    'orders.nodes.refunds.refundLineItems.nodes.quantity', 'orders.nodes.refunds.refundLineItems.nodes.restockType',
    'orders.nodes.refunds.refundLineItems.nodes.lineItem.sku',
    'orders.nodes.refunds.refundLineItems.pageInfo.hasNextPage', 'orders.pageInfo.hasNextPage',
    'orders.pageInfo.endCursor',
  ],
  ReturnsSearch: [
    'orders.nodes.id', 'orders.nodes.name', 'orders.nodes.returns.nodes.name', 'orders.nodes.returns.nodes.status',
    'orders.nodes.returns.nodes.createdAt', 'orders.nodes.returns.nodes.returnLineItems.nodes.quantity',
    'orders.nodes.returns.nodes.returnLineItems.nodes.unprocessedQuantity',
    'orders.nodes.returns.nodes.returnLineItems.nodes.returnReasonDefinition.name',
    'orders.nodes.returns.nodes.returnLineItems.nodes.fulfillmentLineItem.lineItem.sku',
    'orders.nodes.returns.nodes.returnLineItems.pageInfo.hasNextPage', 'orders.nodes.returns.pageInfo.hasNextPage',
    'orders.pageInfo.hasNextPage', 'orders.pageInfo.endCursor',
  ],
  ProductsSearch: [
    'shop.currencyCode', 'products.nodes.id', 'products.nodes.title', 'products.nodes.status',
    'products.nodes.totalInventory', 'products.nodes.tracksInventory', 'products.nodes.variants.nodes.id',
    'products.nodes.variants.nodes.sku', 'products.nodes.variants.nodes.title', 'products.nodes.variants.nodes.price',
    'products.nodes.variants.pageInfo.hasNextPage', 'products.pageInfo.hasNextPage', 'products.pageInfo.endCursor',
  ],
  InventoryLevelsGet: [
    'productVariants.nodes.id', 'productVariants.nodes.sku', 'productVariants.nodes.title',
    'productVariants.nodes.product.title', 'productVariants.nodes.inventoryItem.tracked',
    'productVariants.nodes.inventoryItem.inventoryLevels.nodes.location.name',
    'productVariants.nodes.inventoryItem.inventoryLevels.nodes.quantities.name',
    'productVariants.nodes.inventoryItem.inventoryLevels.nodes.quantities.quantity',
    'productVariants.nodes.inventoryItem.inventoryLevels.pageInfo.hasNextPage',
    'productVariants.pageInfo.hasNextPage',
  ],
  RecordScopes: [
    'currentAppInstallation.accessScopes.handle', 'shop.currencyCode',
  ],
  RecordOrders: [
    'orders.nodes.id', 'orders.nodes.name', 'orders.nodes.processedAt', 'orders.nodes.updatedAt',
    'orders.nodes.cancelledAt', 'orders.nodes.displayFinancialStatus', 'orders.nodes.displayFulfillmentStatus',
    'orders.nodes.returnStatus', 'orders.nodes.currentTotalPriceSet.shopMoney.amount',
    'orders.nodes.currentTotalPriceSet.shopMoney.currencyCode', 'orders.nodes.totalRefundedSet.shopMoney.amount',
    'orders.nodes.totalRefundedSet.shopMoney.currencyCode', 'orders.nodes.currentSubtotalLineItemsQuantity',
    'orders.nodes.lineItems.nodes.sku', 'orders.nodes.lineItems.nodes.title',
    'orders.nodes.lineItems.nodes.currentQuantity', 'orders.nodes.lineItems.nodes.unfulfilledQuantity',
    'orders.nodes.lineItems.nodes.originalUnitPriceSet.shopMoney.amount',
    'orders.nodes.lineItems.nodes.originalUnitPriceSet.shopMoney.currencyCode',
    'orders.nodes.lineItems.pageInfo.hasNextPage', 'orders.pageInfo.hasNextPage', 'orders.pageInfo.endCursor',
  ],
  RecordRefunds: [
    'orders.nodes.id', 'orders.nodes.refunds.createdAt', 'orders.nodes.refunds.note',
    'orders.nodes.refunds.totalRefundedSet.shopMoney.amount',
    'orders.nodes.refunds.totalRefundedSet.shopMoney.currencyCode',
    'orders.nodes.refunds.refundLineItems.nodes.quantity', 'orders.nodes.refunds.refundLineItems.nodes.restockType',
    'orders.nodes.refunds.refundLineItems.nodes.lineItem.sku',
    'orders.nodes.refunds.refundLineItems.pageInfo.hasNextPage', 'orders.pageInfo.hasNextPage',
    'orders.pageInfo.endCursor',
  ],
  RecordReturns: [
    'orders.nodes.id', 'orders.nodes.returns.nodes.name', 'orders.nodes.returns.nodes.status',
    'orders.nodes.returns.nodes.createdAt', 'orders.nodes.returns.nodes.returnLineItems.nodes.quantity',
    'orders.nodes.returns.nodes.returnLineItems.nodes.unprocessedQuantity',
    'orders.nodes.returns.nodes.returnLineItems.nodes.returnReasonDefinition.name',
    'orders.nodes.returns.nodes.returnLineItems.nodes.fulfillmentLineItem.lineItem.sku',
    'orders.nodes.returns.nodes.returnLineItems.pageInfo.hasNextPage', 'orders.nodes.returns.pageInfo.hasNextPage',
    'orders.pageInfo.hasNextPage', 'orders.pageInfo.endCursor',
  ],
  RecordProducts: [
    'products.nodes.id', 'products.nodes.title', 'products.nodes.status', 'products.nodes.totalInventory',
    'products.nodes.tracksInventory', 'products.nodes.variants.nodes.id', 'products.nodes.variants.nodes.sku',
    'products.nodes.variants.nodes.title', 'products.nodes.variants.nodes.price',
    'products.nodes.variants.nodes.inventoryItem.tracked',
    'products.nodes.variants.nodes.inventoryItem.inventoryLevels.nodes.location.name',
    'products.nodes.variants.nodes.inventoryItem.inventoryLevels.nodes.quantities.name',
    'products.nodes.variants.nodes.inventoryItem.inventoryLevels.nodes.quantities.quantity',
    'products.nodes.variants.nodes.inventoryItem.inventoryLevels.pageInfo.hasNextPage',
    'products.nodes.variants.pageInfo.hasNextPage', 'products.pageInfo.hasNextPage', 'products.pageInfo.endCursor',
  ],
}

export const RESULT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  orders_search: [
    'items.id', 'items.name', 'items.processedAt.iso', 'items.processedAt.ms', 'items.cancelled',
    'items.financialStatus', 'items.fulfillmentStatus', 'items.returnStatus', 'items.total.minor',
    'items.total.currency', 'items.refunded.minor', 'items.refunded.currency', 'items.itemCount', 'items.lines.sku',
    'items.lines.quantity', 'items.moreLines', 'items.truncated', 'nextCursor',
  ],
  order_get: [
    'order.id', 'order.name', 'order.processedAt.iso', 'order.processedAt.ms', 'order.cancelled',
    'order.financialStatus', 'order.fulfillmentStatus', 'order.returnStatus', 'order.total.minor',
    'order.total.currency', 'order.refunded.minor', 'order.refunded.currency', 'order.lines.sku', 'order.lines.title',
    'order.lines.quantity', 'order.lines.unfulfilledQuantity', 'order.lines.unitPrice.minor',
    'order.lines.unitPrice.currency', 'order.moreLines', 'order.refunds.createdAt.iso', 'order.refunds.createdAt.ms',
    'order.refunds.note', 'order.refunds.amount.minor', 'order.refunds.amount.currency', 'order.refunds.lines.sku',
    'order.refunds.lines.quantity', 'order.refunds.lines.restockType', 'order.refunds.moreLines', 'order.moreRefunds',
    'order.returns.name', 'order.returns.status', 'order.returns.createdAt.iso', 'order.returns.createdAt.ms',
    'order.returns.lines.sku', 'order.returns.lines.quantity', 'order.returns.lines.unprocessedQuantity',
    'order.returns.lines.reason', 'order.returns.moreLines', 'order.moreReturns', 'order.truncated',
  ],
  refunds_search: [
    'items.orderId', 'items.orderName', 'items.createdAt.iso', 'items.createdAt.ms', 'items.note',
    'items.amount.minor', 'items.amount.currency', 'items.lines.sku', 'items.lines.quantity',
    'items.lines.restockType', 'items.moreLines', 'items.moreRefunds', 'items.truncated', 'nextCursor',
  ],
  returns_search: [
    'items.orderId', 'items.orderName', 'items.returnName', 'items.status', 'items.createdAt.iso',
    'items.createdAt.ms', 'items.lines.sku', 'items.lines.quantity', 'items.lines.unprocessedQuantity',
    'items.lines.reason', 'items.moreLines', 'items.moreReturns', 'items.truncated', 'nextCursor',
  ],
  products_search: [
    'items.id', 'items.title', 'items.status', 'items.totalInventory', 'items.tracked', 'items.variants.id',
    'items.variants.sku', 'items.variants.title', 'items.variants.price.minor', 'items.variants.price.currency',
    'items.moreVariants', 'items.truncated', 'nextCursor',
  ],
  inventory_levels_get: [
    'sku', 'matches.variantId', 'matches.productTitle', 'matches.variantTitle', 'matches.tracked',
    'matches.levels.location', 'matches.levels.available', 'matches.levels.onHand', 'matches.levels.committed',
    'matches.levels.incoming', 'matches.moreLevels', 'matches.truncated', 'moreMatches',
  ],
}

/**
 * Never selected anywhere: Shopify's level 2 customer fields and nearby free text about the customer (OC 7). Matched
 * against every path segment. The order's own `note` is denied by path (ORDER_NOTE); the merchant's refund note stays.
 */
export const DENIED_FIELDS: readonly string[] = [
  'customer', 'email', 'phone', 'firstName', 'lastName', 'displayName', 'shippingAddress', 'billingAddress', 'address1',
  'address2', 'zip', 'city', 'province', 'provinceCode', 'latitude', 'longitude', 'customerNote', 'returnReasonNote',
  'clientIp', 'browserIp', 'customAttributes',
]
export const ORDER_NOTE = /^orders\.nodes\.note$/
