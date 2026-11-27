// The hub's Shopify write operations (Stage 1 M3-S1; M3-S2 adds stock and refunds): one line per operation (a shared entry file, plan section 1).
// Typed by `ShopifyWriteKey`, so a `shopify.` key in `WRITE_OPERATIONS` with no entry here fails the typecheck.
import { draftOrderCreate } from './draft-order-create'
import { inventoryReduce } from './inventory-reduce'
import { inventoryRestock } from './inventory-restock'
import { orderTagAdd } from './order-tag-add'
import { orderTagRemove } from './order-tag-remove'
import { refundCreate } from './refund-create'
import { prepared, type PreparedShopifyWriteOp, type ShopifyWriteKey } from './types'

export type { ShopifyWriteKey } from './types'

export const SHOPIFY_WRITE_OPS: { readonly [K in ShopifyWriteKey]: PreparedShopifyWriteOp & { key: K } } = {
  'shopify.order.tag_add': { ...prepared(orderTagAdd), key: 'shopify.order.tag_add' },
  'shopify.order.tag_remove': { ...prepared(orderTagRemove), key: 'shopify.order.tag_remove' },
  'shopify.draft_order.create': { ...prepared(draftOrderCreate), key: 'shopify.draft_order.create' },
  'shopify.inventory.restock': { ...prepared(inventoryRestock), key: 'shopify.inventory.restock' }, // M3-S2
  'shopify.inventory.reduce': { ...prepared(inventoryReduce), key: 'shopify.inventory.reduce' }, // M3-S2
  'shopify.refund.create': { ...prepared(refundCreate), key: 'shopify.refund.create' }, // M3-S2
}

export const isShopifyWriteKey = (key: string): key is ShopifyWriteKey => Object.hasOwn(SHOPIFY_WRITE_OPS, key)
