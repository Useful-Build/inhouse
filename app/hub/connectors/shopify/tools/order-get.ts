import { z } from 'zod'
import type { ToolDef } from '../../../registry/registry'
import { CAPS, LIMITS, ORDER_GET } from '../documents'
import { buildQuery } from '../search'
import { cap, capNullable, enumValue, fail, instant, money, nullableInstant, runQuery, within, zHasNext, zInt, zMoneyBag, type Cut } from '../shape'
import { mapOrderCore, orderCore } from './orders-search'

const L = LIMITS.orderGet
const NAME = /^#?[A-Za-z0-9-]{1,32}$/

const input = z.strictObject({
  name: z.string().regex(NAME).describe('The order name as shown in results, for example #1001.'),
})
type Input = z.infer<typeof input>

export const zRefund = (lines: number) =>
  z.object({
    createdAt: z.string().nullable(),
    note: z.string().nullable(),
    totalRefundedSet: zMoneyBag,
    refundLineItems: z.object({
      nodes: z.array(z.object({ quantity: zInt, restockType: z.string(), lineItem: z.object({ sku: z.string().nullable() }) })).max(lines),
      pageInfo: zHasNext,
    }),
  })

export const zReturnLine = z.object({
  quantity: zInt,
  unprocessedQuantity: zInt,
  returnReasonDefinition: z.object({ name: z.string() }).nullable(),
  fulfillmentLineItem: z.object({ lineItem: z.object({ sku: z.string().nullable() }) }),
})

export const zReturn = (lines: number) =>
  z.object({
    name: z.string(),
    status: z.string(),
    createdAt: z.string(),
    returnLineItems: z.object({ nodes: z.array(zReturnLine).max(lines), pageInfo: zHasNext }),
  })

const parser = z.object({
  orders: z.object({
    nodes: z
      .array(
        z.object({
          ...orderCore,
          lineItems: z.object({
            nodes: z.array(
              z.object({ sku: z.string().nullable(), title: z.string(), currentQuantity: zInt, unfulfilledQuantity: zInt, originalUnitPriceSet: zMoneyBag }),
            ),
            pageInfo: zHasNext,
          }),
          refunds: z.array(zRefund(L.refundLines)),
          returns: z.object({ nodes: z.array(zReturn(L.returnLines)), pageInfo: zHasNext }),
        }),
      )
      .max(L.first),
  }),
})
type Data = z.infer<typeof parser>

export type RefundNode = z.infer<ReturnType<typeof zRefund>>
export type ReturnNode = z.infer<ReturnType<typeof zReturn>>

export const mapRefundLines = (cut: Cut, r: RefundNode, max: number) =>
  within(r.refundLineItems.nodes, max).map(l => ({ sku: capNullable(cut, l.lineItem.sku, CAPS.sku), quantity: l.quantity, restockType: enumValue(l.restockType) }))

export const mapReturnLines = (cut: Cut, r: ReturnNode, max: number) =>
  within(r.returnLineItems.nodes, max).map(l => ({
    sku: capNullable(cut, l.fulfillmentLineItem.lineItem.sku, CAPS.sku),
    quantity: l.quantity,
    unprocessedQuantity: l.unprocessedQuantity,
    reason: l.returnReasonDefinition === null ? null : cap(cut, l.returnReasonDefinition.name, CAPS.reason),
  }))

const bare = (name: string) => (name.startsWith('#') ? name.slice(1) : name)

function map(d: Data, name: string) {
  const exact = d.orders.nodes.filter(o => bare(o.name) === bare(name))
  if (exact.length > 1) fail('two orders with one name')
  const o = exact[0]
  if (!o) return { order: null }
  const cut: Cut = { truncated: false }
  const refunds = within(o.refunds, L.refunds + 1)
  return {
    order: {
      ...mapOrderCore(o, cut),
      lines: within(o.lineItems.nodes, L.lines).map(l => ({
        sku: capNullable(cut, l.sku, CAPS.sku),
        title: cap(cut, l.title, CAPS.title),
        quantity: l.currentQuantity,
        unfulfilledQuantity: l.unfulfilledQuantity,
        unitPrice: money(l.originalUnitPriceSet.shopMoney.amount, l.originalUnitPriceSet.shopMoney.currencyCode),
      })),
      moreLines: o.lineItems.pageInfo.hasNextPage,
      refunds: refunds.slice(0, L.refunds).map(r => ({
        createdAt: nullableInstant(r.createdAt),
        note: capNullable(cut, r.note, CAPS.refundNoteGet),
        amount: money(r.totalRefundedSet.shopMoney.amount, r.totalRefundedSet.shopMoney.currencyCode),
        lines: mapRefundLines(cut, r, L.refundLines),
        moreLines: r.refundLineItems.pageInfo.hasNextPage,
      })),
      moreRefunds: refunds.length > L.refunds,
      returns: within(o.returns.nodes, L.returns).map(r => ({
        name: cap(cut, r.name, CAPS.returnName),
        status: enumValue(r.status),
        createdAt: instant(r.createdAt),
        lines: mapReturnLines(cut, r, L.returnLines),
        moreLines: r.returnLineItems.pageInfo.hasNextPage,
      })),
      moreReturns: o.returns.pageInfo.hasNextPage,
      truncated: cut.truncated,
    },
  }
}

export const variablesFor = (i: Input): Record<string, unknown> => ({ query: buildQuery([{ kind: 'eq', field: 'name', value: i.name }]) })

export const orderGet: ToolDef<Input> = {
  name: 'order_get',
  description:
    `Get one order by its name as shown in results (for example #1001): up to ${L.lines} lines (sku, title, current and ` +
    `unfulfilled quantity, unit price), up to ${L.refunds} refunds (date, note, amount, up to ${L.refundLines} refunded lines with sku, quantity ` +
    `and restock type) and up to ${L.returns} returns (name, status, date, up to ${L.returnLines} lines with sku, quantity, unprocessed ` +
    'quantity and reason). Returns order: null when no order has that name. Customer names, emails, phones and ' +
    'addresses are never available.',
  mode: 'read',
  input,
  run: (ctx, i) => runQuery(ctx, ORDER_GET, variablesFor(i), parser, d => map(d, i.name)),
}

export const orderGetParser = parser
