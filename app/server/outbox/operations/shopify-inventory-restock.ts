// `shopify.inventory.restock` (Stage 1 M3-S2, N21, section 0 Q1): raises one item's available stock at one location in
// the brand's connected Shopify store. No effect flag (it can be lowered again, and reaches no customer and no money),
// so a member may ask for it and "Always allow" may cover it within its limits (N24: 200 stock units a day, 50 in one
// call). Calls collect into one batch card past a grant's count. Shared shape: ./shopify-inventory.ts.
import { RestockArgsSchema, stockCard, stockItemLine, stockItemRow, STOCK_ROW_HEADS, type RestockArgs } from './shopify-inventory.ts'
import { shopScope } from './shopify-order-tags.ts'
import type { OperationEntry } from './types.ts'
import { countOf } from '../words.ts'

export const shopifyInventoryRestock: OperationEntry<RestockArgs> & { key: 'shopify.inventory.restock' } = {
  key: 'shopify.inventory.restock',
  tool: 'shopify_inventory_restock',
  description: 'Raise the available stock of one inventory item at one location in the connected Shopify store by a number of units, with a reason (default restock). A person approves it first unless they chose "Always allow".',
  args: RestockArgsSchema,
  connector: 'shopify',
  scope: (_a, f) => shopScope('shopify.inventory.restock', f),
  records: () => 1,
  units: a => a.quantity,
  unitsLabel: 'stock units',
  itemLine: (a, f) => stockItemLine('+', a, f),
  itemRow: a => stockItemRow('+', a),
  rowHeads: STOCK_ROW_HEADS,
  batchTitle: c => `Restock ${countOf(c.records, 'item', 'items')}`,
  effects: { money: false, customer: false, destructive: false, access: false },
  memberMay: true,
  reversible: true,
  idempotent: false,
  coalesces: true,
  defaults: { grant: { perDay: 200, unitsMax: 50 }, ceiling: { perDayMax: 1000, unitsMax: 500 } },
  card: a => stockCard('Add', a),
}
