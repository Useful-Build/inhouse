// `shopify.inventory.reduce` (Stage 1 M3-S2, N21, section 0 Q1): lowers one item's available stock at one location in
// the brand's connected Shopify store, with a required reason. Destructive: stock sold against in the meantime can't be
// put back by us, so it's an exact approval every time, never covered by a grant and never collected into a batch (the
// 6th waiting card in a chat is refused `too_many_waiting`). A member may approve it (section 0 Q2). N24: no grant;
// 500 stock units at most in one call. Shared shape: ./shopify-inventory.ts.
import { ReduceArgsSchema, stockCard, stockItemLine, stockItemRow, STOCK_ROW_HEADS, type ReduceArgs } from './shopify-inventory.ts'
import { shopScope } from './shopify-order-tags.ts'
import type { OperationEntry } from './types.ts'

export const shopifyInventoryReduce: OperationEntry<ReduceArgs> & { key: 'shopify.inventory.reduce' } = {
  key: 'shopify.inventory.reduce',
  tool: 'shopify_inventory_reduce',
  description: 'Lower the available stock of one inventory item at one location in the connected Shopify store by a number of units, with a reason. A person approves every one exactly.',
  args: ReduceArgsSchema,
  connector: 'shopify',
  scope: (_a, f) => shopScope('shopify.inventory.reduce', f),
  records: () => 1,
  units: a => a.quantity,
  unitsLabel: 'stock units',
  itemLine: (a, f) => stockItemLine('-', a, f),
  itemRow: a => stockItemRow('-', a),
  rowHeads: STOCK_ROW_HEADS,
  effects: { money: false, customer: false, destructive: true, access: false, unreviewed: false },
  memberMay: true,
  reversible: false,
  idempotent: false,
  coalesces: false,
  // N24 names no daily figure for an operation no grant covers; the ceiling row's daily value then means nothing
  // (`applies.perDay` is false) and suggests restock's.
  defaults: { grant: null, ceiling: { perDayMax: 1000, unitsMax: 500 } },
  card: a => stockCard('Remove', a),
}
