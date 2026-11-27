// `shopify.inventory.restock` (Stage 1 M3-S2, N21, section 0 Q1): raises one item's available stock at one location by 1
// or more units (`inventoryAdjustQuantities`, write_inventory), with an idempotency key. Shared shape: ./inventory.ts.
import { readStock, RESTOCK, RestockArgsSchema, stockMutation, type StockArgs } from './inventory'
import type { ShopifyWriteOp } from './types'

export const inventoryRestock: ShopifyWriteOp<StockArgs> = {
  key: 'shopify.inventory.restock',
  scope: 'write_inventory',
  args: RestockArgsSchema,
  idempotent: true,
  document: (a, ctx) => stockMutation(RESTOCK, a, ctx.idempotencyKey),
  read: (data, a) => readStock(RESTOCK, data, a),
}
