import { z } from 'zod'
import type { ToolDef } from '../../../registry/registry'
import { CAPS, LIMITS, PRODUCTS_SEARCH, type Clause } from '../documents'
import { buildQuery } from '../search'
import { cap, capNullable, enumValue, money, nextCursor, runQuery, within, zCursor, zHasNext, zId, zInt, zPage, type Cut } from '../shape'

const L = LIMITS.productsSearch

export const PRODUCT_STATUSES = ['active', 'draft', 'archived'] as const
export const TEXT = /^[\p{L}\p{N}][\p{L}\p{N} .'&-]{0,59}$/u

const input = z.strictObject({
  text: z.string().regex(TEXT).optional().describe('Words in the product title, or a SKU.'),
  status: z.enum(PRODUCT_STATUSES).optional().describe('Only products with this status.'),
  stockBelow: z
    .number()
    .int()
    .min(-100_000)
    .max(100_000)
    .optional()
    .describe('Only products whose total inventory is below this number, sorted lowest first (1: out of stock or oversold).'),
  first: z.number().int().min(1).max(L.maxFirst).optional().describe(`Products per page, 1 to ${L.maxFirst} (default ${L.defaultFirst}).`),
  after: zCursor.optional().describe('nextCursor from the previous page, with the same filters.'),
})
type Input = z.infer<typeof input>

const parser = z.object({
  shop: z.object({ currencyCode: z.string() }),
  products: z.object({
    nodes: z.array(
      z.object({
        id: zId,
        title: z.string(),
        status: z.string(),
        totalInventory: zInt,
        tracksInventory: z.boolean(),
        variants: z.object({
          nodes: z.array(z.object({ id: zId, sku: z.string().nullable(), title: z.string(), price: z.string() })),
          pageInfo: zHasNext,
        }),
      }),
    ),
    pageInfo: zPage,
  }),
})
type Data = z.infer<typeof parser>

export function clausesFor(i: Input): Clause[] {
  const c: Clause[] = []
  if (i.text !== undefined) c.push({ kind: 'phrase', value: i.text })
  if (i.status !== undefined) c.push({ kind: 'eq', field: 'status', value: i.status })
  if (i.stockBelow !== undefined) c.push({ kind: 'below', field: 'inventory_total', value: i.stockBelow })
  return c
}

export function variablesFor(i: Input): Record<string, unknown> {
  const v: Record<string, unknown> = { first: i.first ?? L.defaultFirst, sortKey: i.stockBelow !== undefined ? 'INVENTORY_TOTAL' : 'TITLE' }
  if (i.after !== undefined) v.after = i.after
  const q = buildQuery(clausesFor(i))
  if (q !== undefined) v.query = q
  return v
}

function map(d: Data, first: number) {
  const currency = d.shop.currencyCode
  return {
    items: within(d.products.nodes, first).map(p => {
      const cut: Cut = { truncated: false }
      return {
        id: p.id,
        title: cap(cut, p.title, CAPS.title),
        status: enumValue(p.status),
        totalInventory: p.totalInventory,
        tracked: p.tracksInventory,
        variants: within(p.variants.nodes, L.variants).map(v => ({
          id: v.id,
          sku: capNullable(cut, v.sku, CAPS.sku),
          title: cap(cut, v.title, CAPS.variantTitle),
          price: money(v.price, currency),
        })),
        moreVariants: p.variants.pageInfo.hasNextPage,
        truncated: cut.truncated,
      }
    }),
    nextCursor: nextCursor(d.products.pageInfo),
  }
}

export const productsSearch: ToolDef<Input> = {
  name: 'products_search',
  description:
    'Search the product catalogue by text (words in the title or a SKU), status (active, draft, archived) or stock ' +
    '(stockBelow: total inventory below this number, for example 1 for out of stock or oversold, sorted lowest first). ' +
    `Returns at most \`first\` products (1 to ${L.maxFirst}, default ${L.defaultFirst}): id, title, status, total inventory, whether stock is ` +
    `tracked and up to ${L.variants} variants (sku, title, price in minor units). Pass nextCursor as \`after\` with the same filters ` +
    'for more. For stock by location of one SKU, use inventory_levels_get with that sku.',
  mode: 'read',
  input,
  run: (ctx, i) => {
    const variables = variablesFor(i)
    return runQuery(ctx, PRODUCTS_SEARCH, variables, parser, d => map(d, variables.first as number))
  },
}

export const productsSearchParser = parser
