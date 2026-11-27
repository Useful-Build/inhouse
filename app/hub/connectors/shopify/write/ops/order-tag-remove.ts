// `shopify.order.tag_remove` (Stage 1 M3-S1, N21): removes 1 to 5 tags from 1 to 5 orders in one hub call (`tagsRemove`,
// write_orders). A tag the order doesn't have is no error in Shopify. Shared shape and partial outcome: ./tags.ts.
import { readTags, ShopifyOrderTagsArgsSchema, tagsDocument, type ShopifyOrderTagsArgs } from './tags'
import type { ShopifyWriteOp } from './types'

export const orderTagRemove: ShopifyWriteOp<ShopifyOrderTagsArgs> = {
  key: 'shopify.order.tag_remove',
  scope: 'write_orders',
  args: ShopifyOrderTagsArgsSchema,
  document: a => tagsDocument({ operation: 'OrderTagsRemove', field: 'tagsRemove' }, a),
  read: (data, a) => readTags(data, a, 'removed '),
}
