// The hub's Shopify write operations (Stage 1 M3-S1): one line per operation (a shared entry file, plan section 1).
// Typed by `ShopifyWriteKey`, so a `shopify.` key in `WRITE_OPERATIONS` with no entry here fails the typecheck.
import { draftOrderCreate } from './draft-order-create'
import { orderTagAdd } from './order-tag-add'
import { orderTagRemove } from './order-tag-remove'
import { prepared, type PreparedShopifyWriteOp, type ShopifyWriteKey } from './types'

export type { ShopifyWriteKey } from './types'

export const SHOPIFY_WRITE_OPS: { readonly [K in ShopifyWriteKey]: PreparedShopifyWriteOp & { key: K } } = {
  'shopify.order.tag_add': { ...prepared(orderTagAdd), key: 'shopify.order.tag_add' },
  'shopify.order.tag_remove': { ...prepared(orderTagRemove), key: 'shopify.order.tag_remove' },
  'shopify.draft_order.create': { ...prepared(draftOrderCreate), key: 'shopify.draft_order.create' },
}

export const isShopifyWriteKey = (key: string): key is ShopifyWriteKey => Object.hasOwn(SHOPIFY_WRITE_OPS, key)
