// What `shopify.inventory.restock` and `shopify.inventory.reduce` share (Stage 1 M3-S2, N21): one stock change of one
// inventory item at one location, sent as Shopify's `inventoryAdjustQuantities` on the `available` quantity with an
// idempotency key (required since Admin API 2026-04), so the same key twice changes stock once. One root field: done
// (the group came back with exactly this change), refused (user errors, nothing changed: `sent: 'no'`) or unclear.
//
// `changeFromQuantity` is sent as null: Shopify requires the field and null skips its compare-and-swap. An adjustment is a
// delta, not a set, and the person approved the delta, never a count read earlier that a sale may since have changed.
// The reasons are Shopify's documented list (quantities-states, read 2026-11-27), narrowed per direction.
import { z } from 'zod'
import type { WriteResult } from '../../../../index/contract'
import { writeErr, type MutationDoc } from '../provider'
import { rootOutcome } from './types'

const ITEM_GID = /^gid:\/\/shopify\/InventoryItem\/([1-9]\d{0,19})$/
const LOCATION_GID = /^gid:\/\/shopify\/Location\/([1-9]\d{0,19})$/
/** The most stock units one call moves (Shopify's delta is a 32-bit Int; the ceiling's largest call sits far under). */
export const STOCK_UNITS_MAX = 1_000_000

/** Reasons a restock may give (raises `available`). */
export const RESTOCK_REASONS = ['restock', 'received', 'correction', 'cycle_count_available', 'other'] as const
/** Reasons a reduction may give (lowers `available`). */
export const REDUCE_REASONS = ['damaged', 'shrinkage', 'quality_control', 'correction', 'cycle_count_available', 'other'] as const

const base = {
  inventoryItemId: z.string().regex(ITEM_GID),
  locationId: z.string().regex(LOCATION_GID),
  quantity: z.int().min(1).max(STOCK_UNITS_MAX),
}
export const RestockArgsSchema = z.strictObject({ ...base, reason: z.enum(RESTOCK_REASONS) })
export const ReduceArgsSchema = z.strictObject({ ...base, reason: z.enum(REDUCE_REASONS) })
export type StockArgs = z.infer<typeof RestockArgsSchema> | z.infer<typeof ReduceArgsSchema>

type Direction = { operation: 'InventoryRestock' | 'InventoryReduce'; sign: 1 | -1 }

/** One document, one root field; the change and the key travel as variables, never in the text. */
export function stockDocument({ operation }: Direction): string {
  return `mutation ${operation}($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryAdjustmentGroup {
      id
      changes {
        name
        delta
      }
    }
    userErrors {
      field
      message
    }
  }
}`
}

export function stockMutation(d: Direction, a: StockArgs, idempotencyKey: string | undefined): MutationDoc {
  // The core refuses an idempotent operation's call without a key before it prepares anything.
  if (idempotencyKey === undefined) throw new Error(`${d.operation}: no idempotency key`)
  return {
    query: stockDocument(d),
    variables: {
      input: {
        name: 'available',
        reason: a.reason,
        changes: [{ inventoryItemId: a.inventoryItemId, locationId: a.locationId, delta: d.sign * a.quantity, changeFromQuantity: null }],
      },
      idempotencyKey,
    },
  }
}

const num = (re: RegExp, id: string) => re.exec(id)?.[1] ?? '?'

/** "stock +20 at location 601 (item 8001)". */
export const stockRef = (d: Direction, a: StockArgs): string =>
  `stock ${d.sign > 0 ? '+' : '-'}${a.quantity} at location ${num(LOCATION_GID, a.locationId)} (item ${num(ITEM_GID, a.inventoryItemId)})`

export function readStock(d: Direction, data: Record<string, unknown>, a: StockArgs): WriteResult {
  const delta = d.sign * a.quantity
  const outcome = rootOutcome(data.inventoryAdjustQuantities, 'inventoryAdjustmentGroup', g => {
    const changes = typeof g === 'object' && g !== null ? (g as { changes?: unknown }).changes : undefined
    return Array.isArray(changes) && changes.some(c => typeof c === 'object' && c !== null
      && (c as { name?: unknown }).name === 'available' && (c as { delta?: unknown }).delta === delta)
  })
  if (outcome === 'done') return { ok: true, value: { ref: stockRef(d, a) } }
  return outcome === 'refused' ? writeErr('upstream_rejected', 'no') : writeErr('upstream_unavailable', 'unknown')
}

export const RESTOCK: Direction = { operation: 'InventoryRestock', sign: 1 }
export const REDUCE: Direction = { operation: 'InventoryReduce', sign: -1 }
