// `shopify.order.tag_add` (N9; widened to a list of orders in Stage 1 M3-S1, N21): adds 1 to 5 tags to 1 to 100 orders
// in the brand's connected Shopify store. Scope `{ shop }`, one record and one unit per order, no effect flag (a tag
// reaches no customer and moves no money), so a member may ask for it and "Always allow" may cover it within its limits.
// Shared shape: ./shopify-order-tags.ts.
import { itemsPerOrder, OrderTagsArgsSchema, shopScope, tagsCard, tagsItemLine, tagsItemRow, tagsBatchTitle, TAG_ROW_HEADS, type OrderTagsArgs } from './shopify-order-tags.ts'
import type { OperationEntry } from './types.ts'

export { OrderTagsArgsSchema as TagAddArgsSchema }
export type TagAddArgs = OrderTagsArgs

export const shopifyOrderTagAdd: OperationEntry<TagAddArgs> & { key: 'shopify.order.tag_add' } = {
  key: 'shopify.order.tag_add',
  tool: 'shopify_order_tag_add',
  description: 'Add 1 to 5 tags to 1 to 100 orders in the connected Shopify store. A person approves it first unless they chose "Always allow"; more than 5 orders at once always needs their OK.',
  args: OrderTagsArgsSchema,
  connector: 'shopify',
  scope: (_a, f) => shopScope('shopify.order.tag_add', f),
  records: a => a.orderIds.length,
  units: a => a.orderIds.length,
  unitsLabel: 'orders',
  items: itemsPerOrder,
  itemLine: (a, f) => tagsItemLine('add', a, f),
  itemRow: a => tagsItemRow('add', a),
  rowHeads: TAG_ROW_HEADS,
  batchTitle: (c, same) => tagsBatchTitle('add', c.records, same),
  titleKey: '$.tags',
  effects: { money: false, customer: false, destructive: false, access: false },
  memberMay: true,
  reversible: true,
  idempotent: false,
  coalesces: true,
  defaults: { grant: { perDay: 50, unitsMax: 5 }, ceiling: { perDayMax: 200, unitsMax: 100 } },
  card: a => tagsCard('Add', a),
}
