import { z } from 'zod'
import type { ToolDef } from '../../../registry/registry'
import { CAPS, INVENTORY_LEVELS_GET, LIMITS, QUANTITY_NAMES } from '../documents'
import { buildQuery } from '../search'
import { cap, fail, runQuery, within, zHasNext, zId, zInt, zSku, type Cut } from '../shape'

const L = LIMITS.inventoryLevelsGet

const input = z.strictObject({
  sku: zSku.describe('The exact SKU (case-sensitive). Find one with products_search first.'),
})
type Input = z.infer<typeof input>

const parser = z.object({
  productVariants: z.object({
    nodes: z
      .array(
        z.object({
          id: zId,
          sku: z.string().nullable(),
          title: z.string(),
          product: z.object({ title: z.string() }),
          inventoryItem: z.object({
            tracked: z.boolean(),
            inventoryLevels: z.object({
              nodes: z
                .array(
                  z.object({
                    location: z.object({ name: z.string() }),
                    quantities: z.array(z.object({ name: z.string(), quantity: zInt })).max(QUANTITY_NAMES.length),
                  }),
                )
                .max(L.levels),
              pageInfo: zHasNext,
            }),
          }),
        }),
      )
      .max(L.first),
    pageInfo: zHasNext,
  }),
})
type Data = z.infer<typeof parser>

function quantity(list: readonly { name: string; quantity: number }[], name: string): number {
  const found = list.filter(q => q.name === name)
  if (found.length !== 1) fail('quantity')
  return found[0]!.quantity
}

function map(d: Data, sku: string) {
  const exact = d.productVariants.nodes.filter(v => v.sku === sku)
  return {
    sku,
    matches: within(exact, L.first).map(v => {
      const cut: Cut = { truncated: false }
      return {
        variantId: v.id,
        productTitle: cap(cut, v.product.title, CAPS.title),
        variantTitle: cap(cut, v.title, CAPS.variantTitle),
        tracked: v.inventoryItem.tracked,
        levels: v.inventoryItem.inventoryLevels.nodes.map(l => ({
          location: cap(cut, l.location.name, CAPS.location),
          available: quantity(l.quantities, 'available'),
          onHand: quantity(l.quantities, 'on_hand'),
          committed: quantity(l.quantities, 'committed'),
          incoming: quantity(l.quantities, 'incoming'),
        })),
        moreLevels: v.inventoryItem.inventoryLevels.pageInfo.hasNextPage,
        truncated: cut.truncated,
      }
    }),
    moreMatches: d.productVariants.pageInfo.hasNextPage,
  }
}

export const variablesFor = (i: Input): Record<string, unknown> => ({ query: buildQuery([{ kind: 'eq', field: 'sku', value: i.sku }]) })

export const inventoryLevelsGet: ToolDef<Input> = {
  name: 'inventory_levels_get',
  description:
    `Get stock for one SKU (exact, case-sensitive): available, on hand, committed and incoming quantities at each location (up to ${L.levels}), ` +
    'whether inventory is tracked, and the product and variant title. Available can be negative when oversold. Takes ' +
    'sku only; find a SKU with products_search first. Returns matches: [] when no variant has that SKU.',
  mode: 'read',
  input,
  run: (ctx, i) => runQuery(ctx, INVENTORY_LEVELS_GET, variablesFor(i), parser, d => map(d, i.sku)),
}

export const inventoryLevelsGetParser = parser
