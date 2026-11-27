// `shopify.order.tag_add` (Stage 1 M2-C; a list of orders since M3-S1, N21): adds 1 to 5 tags to 1 to 5 orders in one
// hub call (`tagsAdd`, write_orders). Shared shape and partial outcome: ./tags.ts.
import { readTags, ShopifyOrderTagsArgsSchema, tagsDocument, type ShopifyOrderTagsArgs } from './tags'
import type { ShopifyWriteOp } from './types'

export const orderTagAdd: ShopifyWriteOp<ShopifyOrderTagsArgs> = {
  key: 'shopify.order.tag_add',
  scope: 'write_orders',
  idempotent: false,
  args: ShopifyOrderTagsArgsSchema,
  document: a => tagsDocument({ operation: 'OrderTagsAdd', field: 'tagsAdd' }, a),
  read: (data, a) => readTags(data, a, ''),
}
