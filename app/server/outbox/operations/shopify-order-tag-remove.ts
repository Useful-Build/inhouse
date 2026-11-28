// `shopify.order.tag_remove` (Stage 1 M3-S1, N21): removes 1 to 5 tags from 1 to 100 orders in the brand's connected
// Shopify store. The same shape, limits and class as tag_add (no effect flag; adding the tag back undoes it).
// Shared shape: ./shopify-order-tags.ts.
import { itemsPerOrder, OrderTagsArgsSchema, shopScope, tagsBatchTitle, tagsCard, tagsDetail, tagsFacts, tagsItemLine, tagsItemRow, type OrderTagsArgs } from './shopify-order-tags.ts'
import type { OperationEntry } from './types.ts'

export const shopifyOrderTagRemove: OperationEntry<OrderTagsArgs> & { key: 'shopify.order.tag_remove' } = {
  key: 'shopify.order.tag_remove',
  tool: 'shopify_order_tag_remove',
  description: 'Remove 1 to 5 tags from 1 to 100 orders in the connected Shopify store. A person approves it first unless they chose "Always allow"; more than 5 orders at once always needs their OK.',
  args: OrderTagsArgsSchema,
  connector: 'shopify',
  scope: (_a, f) => shopScope('shopify.order.tag_remove', f),
  records: a => a.orderIds.length,
  units: a => a.orderIds.length,
  unitsLabel: 'orders',
  items: itemsPerOrder,
  itemLine: (a, f) => tagsItemLine('remove', a, f),
  facts: tagsFacts,
  detail: tagsDetail,
  itemRow: a => tagsItemRow('remove', a),
  batchTitle: (c, same) => tagsBatchTitle('remove', c.records, same),
  titleKey: '$.tags',
  effects: { money: false, customer: false, destructive: false, access: false },
  memberMay: true,
  reversible: true,
  idempotent: false,
  coalesces: true,
  defaults: { grant: { perDay: 50, unitsMax: 5 }, ceiling: { perDayMax: 200, unitsMax: 100 } },
  card: a => tagsCard('Remove', a),
}
