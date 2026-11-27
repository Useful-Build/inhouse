// `shopify.inventory.reduce` (Stage 1 M3-S2, N21, section 0 Q1): lowers one item's available stock at one location by 1
// or more units (`inventoryAdjustQuantities` with a negative delta, write_inventory), with an idempotency key and a
// required reason. Destructive on the server's side (stock sold against can't be put back by us). Shape: ./inventory.ts.
import { readStock, REDUCE, ReduceArgsSchema, stockMutation, type StockArgs } from './inventory'
import type { ShopifyWriteOp } from './types'

export const inventoryReduce: ShopifyWriteOp<StockArgs> = {
  key: 'shopify.inventory.reduce',
  scope: 'write_inventory',
  args: ReduceArgsSchema,
  idempotent: true,
  document: (a, ctx) => stockMutation(REDUCE, a, ctx.idempotencyKey),
  read: (data, a) => readStock(REDUCE, data, a),
}
