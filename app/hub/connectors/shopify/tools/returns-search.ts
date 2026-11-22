import { z } from 'zod'
import type { ToolDef } from '../../../registry/registry'
import { CAPS, LIMITS, RETURNS_SEARCH, type Clause } from '../documents'
import { buildQuery } from '../search'
import { cap, enumValue, instant, nextCursor, runQuery, within, zCursor, zHasNext, zId, zPage, zSku, type Cut } from '../shape'
import { mapReturnLines, zReturn } from './order-get'

const L = LIMITS.returnsSearch

export const OPEN_RETURN_STATUSES = ['return_requested', 'in_progress', 'inspection_complete', 'returned', 'return_failed'] as const

const input = z.strictObject({
  returnStatus: z.enum(OPEN_RETURN_STATUSES).optional().describe('Only orders with this return status (default: any order with a return).'),
  sku: zSku.optional().describe('Only orders with a line of this exact SKU.'),
  first: z.number().int().min(1).max(L.maxFirst).optional().describe(`Orders with returns to scan per page, 1 to ${L.maxFirst} (default ${L.defaultFirst}).`),
  after: zCursor.optional().describe('nextCursor from the previous page, with the same filters.'),
})
type Input = z.infer<typeof input>

const parser = z.object({
  orders: z.object({
    nodes: z.array(
      z.object({ id: zId, name: z.string(), returns: z.object({ nodes: z.array(zReturn(L.returnLines)), pageInfo: zHasNext }) }),
    ),
    pageInfo: zPage,
  }),
})
type Data = z.infer<typeof parser>

export function clausesFor(i: Input): Clause[] {
  const c: Clause[] = [
    i.returnStatus !== undefined
      ? { kind: 'eq', field: 'return_status', value: i.returnStatus }
      : { kind: 'eq', field: 'return_status', value: 'no_return', negate: true },
  ]
  if (i.sku !== undefined) c.push({ kind: 'eq', field: 'sku', value: i.sku })
  return c
}

export function variablesFor(i: Input): Record<string, unknown> {
  const v: Record<string, unknown> = { first: i.first ?? L.defaultFirst, query: buildQuery(clausesFor(i)) }
  if (i.after !== undefined) v.after = i.after
  return v
}

function map(d: Data, first: number) {
  const items = []
  for (const o of within(d.orders.nodes, first)) {
    const more = o.returns.pageInfo.hasNextPage
    for (const r of within(o.returns.nodes, L.returns)) {
      const cut: Cut = { truncated: false }
      items.push({
        orderId: o.id,
        orderName: cap(cut, o.name, CAPS.orderName),
        returnName: cap(cut, r.name, CAPS.returnName),
        status: enumValue(r.status),
        createdAt: instant(r.createdAt),
        lines: mapReturnLines(cut, r, L.returnLines),
        moreLines: r.returnLineItems.pageInfo.hasNextPage,
        moreReturns: more,
        truncated: cut.truncated,
      })
    }
  }
  return { items, nextCursor: nextCursor(d.orders.pageInfo) }
}

export const returnsSearch: ToolDef<Input> = {
  name: 'returns_search',
  description:
    'List returns on orders, optionally by order return status (return_requested, in_progress, inspection_complete, ' +
    `returned, return_failed) and sku. Scans up to \`first\` orders with returns per call (1 to ${L.maxFirst}, default ${L.defaultFirst}), most ` +
    `recently updated first, and returns up to ${L.returns} returns per order (moreReturns says an order has more): order name, ` +
    `return name, status, created date and up to ${L.returnLines} lines (sku, quantity, unprocessed quantity, reason). Unprocessed ` +
    "quantity above 0 means the items haven't been processed or restocked yet. Pass nextCursor as `after` with the " +
    'same filters for more.',
  mode: 'read',
  input,
  run: (ctx, i) => {
    const variables = variablesFor(i)
    return runQuery(ctx, RETURNS_SEARCH, variables, parser, d => map(d, variables.first as number))
  },
}

export const returnsSearchParser = parser
