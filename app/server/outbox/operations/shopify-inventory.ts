// What `shopify.inventory.restock` and `shopify.inventory.reduce` share (Stage 1 M3-S2, N21): one item's `available`
// stock at one location, changed by 1 or more units, with a reason from Shopify's list narrowed per direction. Scope
// `{ shop }`, one record, `units` = the quantity ("stock units"). The hub checks the same arguments again, strictly, and
// sends them as `inventoryAdjustQuantities` with the action's idempotency key (hub/connectors/shopify/write/ops/inventory.ts).
import { z } from 'zod'
import type { ResolveFacts } from '../../permissions/types.ts'

const ITEM_ID = /^gid:\/\/shopify\/InventoryItem\/[1-9][0-9]{0,19}$/
const LOCATION_ID = /^gid:\/\/shopify\/Location\/[1-9][0-9]{0,19}$/
/** The most stock units one call moves (the hub's bound; the ceiling's largest call sits far under it). */
export const STOCK_UNITS_MAX = 1_000_000

/** Reasons a restock may give (Shopify's quantities-states list, read 2026-11-27). */
export const RESTOCK_REASONS = ['restock', 'received', 'correction', 'cycle_count_available', 'other'] as const
/** Reasons a reduction may give. */
export const REDUCE_REASONS = ['damaged', 'shrinkage', 'quality_control', 'correction', 'cycle_count_available', 'other'] as const

const base = {
  inventoryItemId: z.string().regex(ITEM_ID),
  locationId: z.string().regex(LOCATION_ID),
  quantity: z.int().min(1).max(STOCK_UNITS_MAX),
}
/** A restock's reason is optional to the agent and always sent: absent, it's `restock` (in the hashed arguments). */
export const RestockArgsSchema = z.strictObject({ ...base, reason: z.enum(RESTOCK_REASONS).default('restock') })
/** A reduction always says why. */
export const ReduceArgsSchema = z.strictObject({ ...base, reason: z.enum(REDUCE_REASONS) })
export type RestockArgs = z.infer<typeof RestockArgsSchema>
export type ReduceArgs = z.infer<typeof ReduceArgsSchema>
type StockArgs = RestockArgs | ReduceArgs

const num = (id: string) => id.slice(id.lastIndexOf('/') + 1)
const REASON_WORDS: Readonly<Record<StockArgs['reason'], string>> = {
  restock: 'restock', received: 'stock received', correction: 'correction', cycle_count_available: 'stock count', other: 'other',
  damaged: 'damaged', shrinkage: 'shrinkage', quality_control: 'quality control',
}
const units = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'unit' : 'units'}`

/** "Item 8001 at location 601 (store-a): +20 (restock)": the item, the place, the signed change and why. */
export function stockItemLine(sign: '+' | '-', a: StockArgs, f: ResolveFacts): string {
  const shop = f.accounts.shopify?.shop
  return `Item ${num(a.inventoryItemId)} at location ${num(a.locationId)}${shop ? ` (${shop})` : ''}: ${sign}${a.quantity.toLocaleString('en-US')} (${REASON_WORDS[a.reason]})`
}

export function stockCard(verb: 'Add' | 'Remove', a: StockArgs): { title: string; lines: string[] } {
  return {
    title: `${verb} ${units(a.quantity)} of stock ${verb === 'Add' ? 'to' : 'from'} item ${num(a.inventoryItemId)}`,
    lines: [`Location: ${num(a.locationId)}`, `Reason: ${REASON_WORDS[a.reason]}`],
  }
}
