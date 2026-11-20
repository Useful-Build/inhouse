import { z } from 'zod'
import type { ToolDef } from '../../../registry/registry'
import { CAPS, LIMITS, REFUNDS_SEARCH, type Clause } from '../documents'
import { buildQuery, queryInstant } from '../search'
import { cap, capNullable, instant, money, nextCursor, runQuery, within, zCursor, zId, zInstantInput, zPage, zSku, type Cut } from '../shape'
import { mapRefundLines, zRefund } from './order-get'

const L = LIMITS.refundsSearch

const input = z.strictObject({
  createdFrom: zInstantInput.describe('Only refunds created at or after this ISO 8601 instant (with offset).'),
  createdTo: zInstantInput.optional().describe('Only refunds created before this ISO 8601 instant (with offset).'),
  sku: zSku.optional().describe('Only refunds on orders with a line of this exact SKU.'),
  first: z.number().int().min(1).max(L.maxFirst).optional().describe(`Refunded orders to scan per page, 1 to ${L.maxFirst} (default ${L.defaultFirst}).`),
  after: zCursor.optional().describe('nextCursor from the previous page, with the same filters.'),
})
type Input = z.infer<typeof input>

const parser = z.object({
  orders: z.object({
    nodes: z.array(z.object({ id: zId, name: z.string(), refunds: z.array(zRefund(L.refundLines)) })),
    pageInfo: zPage,
  }),
})
type Data = z.infer<typeof parser>

export function clausesFor(i: Input): Clause[] {
  const c: Clause[] = [
    {
      kind: 'any',
      of: [
        { kind: 'eq', field: 'financial_status', value: 'refunded' },
        { kind: 'eq', field: 'financial_status', value: 'partially_refunded' },
      ],
    },
    { kind: 'range', field: 'updated_at', op: '>=', at: queryInstant(i.createdFrom) },
  ]
  if (i.sku !== undefined) c.push({ kind: 'eq', field: 'sku', value: i.sku })
  return c
}

export function variablesFor(i: Input): Record<string, unknown> {
  const v: Record<string, unknown> = { first: i.first ?? L.defaultFirst, query: buildQuery(clausesFor(i)) }
  if (i.after !== undefined) v.after = i.after
  return v
}

function map(d: Data, i: Input, first: number) {
  const from = Date.parse(i.createdFrom)
  const to = i.createdTo === undefined ? Infinity : Date.parse(i.createdTo)
  const items = []
  for (const o of within(d.orders.nodes, first)) {
    const refunds = within(o.refunds, L.refunds + 1)
    const more = refunds.length > L.refunds
    for (const r of refunds.slice(0, L.refunds)) {
      if (r.createdAt === null) continue
      const createdAt = instant(r.createdAt)
      if (createdAt.ms < from || createdAt.ms >= to) continue
      const cut: Cut = { truncated: false }
      items.push({
        orderId: o.id,
        orderName: cap(cut, o.name, CAPS.orderName),
        createdAt,
        note: capNullable(cut, r.note, CAPS.refundNoteSearch),
        amount: money(r.totalRefundedSet.shopMoney.amount, r.totalRefundedSet.shopMoney.currencyCode),
        lines: mapRefundLines(cut, r, L.refundLines),
        moreLines: r.refundLineItems.pageInfo.hasNextPage,
        moreRefunds: more,
        truncated: cut.truncated,
      })
    }
  }
  return { items, nextCursor: nextCursor(d.orders.pageInfo) }
}

export const refundsSearch: ToolDef<Input> = {
  name: 'refunds_search',
  description:
    'List refunds created in a time window, optionally only those on orders with a sku. createdFrom (required) and ' +
    `createdTo are ISO 8601 instants. Scans up to \`first\` refunded orders per call (1 to ${L.maxFirst}, default ${L.defaultFirst}), most ` +
    `recently updated first, and returns their refunds in the window, up to ${L.refunds} per order (moreRefunds says an order has ` +
    `more; use order_get for all): order name, date, note (up to ${CAPS.refundNoteSearch} characters), amount in minor units and up to ${L.refundLines} ` +
    'refunded lines (sku, quantity, restock type). Pass nextCursor as `after` with the same filters for more. Use it ' +
    'for refund spikes by product and reason.',
  mode: 'read',
  input,
  run: (ctx, i) => {
    const variables = variablesFor(i)
    return runQuery(ctx, REFUNDS_SEARCH, variables, parser, d => map(d, i, variables.first as number))
  },
}

export const refundsSearchParser = parser
