// The fake's `inventoryAdjustQuantities` (Stage 1 M3-S2), under the two operation names the hub sends: `InventoryRestock`
// (a positive delta) and `InventoryReduce` (a negative one). Strict as Shopify's input is: the `available` quantity, a
// reason from Shopify's documented list, one change per call with `changeFromQuantity` passed (null skips the
// compare-and-swap; a number must equal the level), a known item at a known location. The idempotency key is the
// server's (../server.ts): the same key twice changes stock once.
import type { FakeShopifyWriteUpstream } from '../server.js'
import { obj, userError, type FakeWriteOp } from './types.js'

/** Shopify's documented reasons (quantities-states, read 2026-11-27). */
const SHOPIFY_REASONS = new Set([
  'correction', 'cycle_count_available', 'damaged', 'movement_created', 'movement_updated', 'movement_received', 'movement_canceled', 'other',
  'promotion', 'quality_control', 'received', 'reservation_created', 'reservation_deleted', 'reservation_updated', 'restock', 'safety_stock', 'shrinkage',
])
const INPUT_KEYS = ['name', 'reason', 'changes']
const CHANGE_KEYS = ['inventoryItemId', 'locationId', 'delta', 'changeFromQuantity']

const exactKeys = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k))

/** `<item>|<location>`: the fake's stock levels key. */
export const levelKey = (item: string, location: string) => `${item}|${location}`

function stockOp<K extends string>(key: K, name: 'InventoryRestock' | 'InventoryReduce', sign: 1 | -1): FakeWriteOp<K> {
  return {
    key,
    kind: 'mutation',
    name,
    document: () => `mutation ${name}($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        inventoryAdjustmentGroup { id changes { name delta } }
        userErrors { field message }
      }
    }`,
    root: 'inventoryAdjustQuantities',
    cost: () => 10,
    idempotent: true,
    run(fake: FakeShopifyWriteUpstream, variables, refuse) {
      const refused = (field: string[], message: string) => ({ inventoryAdjustQuantities: { inventoryAdjustmentGroup: null, userErrors: [userError(field, message)] } })
      if (refuse) return refused(['input'], 'Refused by fake write upstream (inventoryAdjustQuantities)')
      const input = obj(variables.input)
      if (!exactKeys(input, INPUT_KEYS)) return refused(['input'], 'Not accepted by the fake')
      if (input.name !== 'available') return refused(['input', 'name'], 'The fake adjusts available only')
      if (typeof input.reason !== 'string' || !SHOPIFY_REASONS.has(input.reason)) return refused(['input', 'reason'], 'Reason is not valid')
      const changes = Array.isArray(input.changes) ? input.changes : []
      if (changes.length !== 1) return refused(['input', 'changes'], 'One change per call')
      const c = obj(changes[0])
      if (!exactKeys(c, CHANGE_KEYS)) return refused(['input', 'changes', '0'], 'changeFromQuantity must be passed')
      const level = typeof c.inventoryItemId === 'string' && typeof c.locationId === 'string' ? levelKey(c.inventoryItemId, c.locationId) : ''
      const now = fake.stock.get(level)
      if (now === undefined) return refused(['input', 'changes', '0', 'inventoryItemId'], 'The item is not stocked at this location')
      if (typeof c.delta !== 'number' || !Number.isInteger(c.delta) || Math.sign(c.delta) !== sign) return refused(['input', 'changes', '0', 'delta'], 'Delta is not valid here')
      if (c.changeFromQuantity !== null && c.changeFromQuantity !== now) return refused(['input', 'changes', '0', 'changeFromQuantity'], 'CHANGE_FROM_QUANTITY_STALE')
      fake.stock.set(level, now + c.delta)
      const id = `gid://shopify/InventoryAdjustmentGroup/${++fake.adjustments}`
      return { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id, changes: [{ name: 'available', delta: c.delta }] }, userErrors: [] } }
    },
  }
}

export const fakeInventoryRestock = stockOp('shopify.inventory.restock', 'InventoryRestock', 1)
export const fakeInventoryReduce = stockOp('shopify.inventory.reduce', 'InventoryReduce', -1)
