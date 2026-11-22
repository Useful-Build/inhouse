import { z } from 'zod'
import type { ToolDef } from '../../../registry/registry'
import { CAPS, LIMITS, ORDERS_SEARCH, type Clause } from '../documents'
import { buildQuery, queryInstant } from '../search'
import {
  cap,
  capNullable,
  enumValue,
  instant,
  money,
  nextCursor,
  nullableEnum,
  runQuery,
  within,
  zCount,
  zCursor,
  zHasNext,
  zId,
  zInstantInput,
  zInt,
  zMoneyBag,
  zPage,
  zSku,
  type Cut,
} from '../shape'

const L = LIMITS.ordersSearch

export const FINANCIAL_STATUSES = ['paid', 'pending', 'authorized', 'partially_paid', 'partially_refunded', 'refunded', 'voided', 'expired'] as const
export const FULFILLMENT_STATUSES = ['unshipped', 'shipped', 'fulfilled', 'partial', 'scheduled', 'on_hold', 'unfulfilled', 'request_declined'] as const
export const RETURN_STATUSES = ['return_requested', 'in_progress', 'inspection_complete', 'returned', 'return_failed', 'no_return'] as const

const input = z.strictObject({
  processedFrom: zInstantInput.optional().describe('Only orders processed at or after this ISO 8601 instant (with offset).'),
  processedTo: zInstantInput.optional().describe('Only orders processed before this ISO 8601 instant (with offset).'),
  financialStatus: z.enum(FINANCIAL_STATUSES).optional().describe('Only orders with this financial status.'),
  fulfillmentStatus: z.enum(FULFILLMENT_STATUSES).optional().describe('Only orders with this fulfillment status.'),
  returnStatus: z.enum(RETURN_STATUSES).optional().describe('Only orders with this return status.'),
  sku: zSku.optional().describe('Only orders with a line of this exact SKU.'),
  first: z.number().int().min(1).max(L.maxFirst).optional().describe(`Orders per page, 1 to ${L.maxFirst} (default ${L.defaultFirst}).`),
  after: zCursor.optional().describe('nextCursor from the previous page, with the same filters.'),
})
type Input = z.infer<typeof input>

export const orderCore = {
  id: zId,
  name: z.string(),
  processedAt: z.string(),
  cancelledAt: z.string().nullable(),
  displayFinancialStatus: z.string().nullable(),
  displayFulfillmentStatus: z.string(),
  returnStatus: z.string(),
  currentTotalPriceSet: zMoneyBag,
  totalRefundedSet: zMoneyBag,
}

const parser = z.object({
  orders: z.object({
    nodes: z.array(
      z.object({
        ...orderCore,
        currentSubtotalLineItemsQuantity: zCount,
        lineItems: z.object({ nodes: z.array(z.object({ sku: z.string().nullable(), currentQuantity: zInt })), pageInfo: zHasNext }),
      }),
    ),
    pageInfo: zPage,
  }),
})
type Data = z.infer<typeof parser>
type OrderCore = { [K in keyof typeof orderCore]: z.infer<(typeof orderCore)[K]> }

/** The fields orders_search and order_get share. */
export function mapOrderCore(o: OrderCore, cut: Cut) {
  return {
    id: o.id,
    name: cap(cut, o.name, CAPS.orderName),
    processedAt: instant(o.processedAt),
    cancelled: o.cancelledAt !== null && instant(o.cancelledAt) !== null,
    financialStatus: nullableEnum(o.displayFinancialStatus),
    fulfillmentStatus: enumValue(o.displayFulfillmentStatus),
    returnStatus: enumValue(o.returnStatus),
    total: money(o.currentTotalPriceSet.shopMoney.amount, o.currentTotalPriceSet.shopMoney.currencyCode),
    refunded: money(o.totalRefundedSet.shopMoney.amount, o.totalRefundedSet.shopMoney.currencyCode),
  }
}

export function clausesFor(i: Input): Clause[] {
  const c: Clause[] = []
  if (i.processedFrom !== undefined) c.push({ kind: 'range', field: 'processed_at', op: '>=', at: queryInstant(i.processedFrom) })
  if (i.processedTo !== undefined) c.push({ kind: 'range', field: 'processed_at', op: '<', at: queryInstant(i.processedTo) })
  if (i.financialStatus !== undefined) c.push({ kind: 'eq', field: 'financial_status', value: i.financialStatus })
  if (i.fulfillmentStatus !== undefined) c.push({ kind: 'eq', field: 'fulfillment_status', value: i.fulfillmentStatus })
  if (i.returnStatus !== undefined) c.push({ kind: 'eq', field: 'return_status', value: i.returnStatus })
  if (i.sku !== undefined) c.push({ kind: 'eq', field: 'sku', value: i.sku })
  return c
}

export function variablesFor(i: Input): Record<string, unknown> {
  const v: Record<string, unknown> = { first: i.first ?? L.defaultFirst }
  if (i.after !== undefined) v.after = i.after
  const q = buildQuery(clausesFor(i))
  if (q !== undefined) v.query = q
  return v
}

function map(d: Data, first: number) {
  return {
    items: within(d.orders.nodes, first).map(o => {
      const cut: Cut = { truncated: false }
      const lines = within(o.lineItems.nodes, L.lines)
      return {
        ...mapOrderCore(o, cut),
        itemCount: o.currentSubtotalLineItemsQuantity,
        lines: lines.map(l => ({ sku: capNullable(cut, l.sku, CAPS.sku), quantity: l.currentQuantity })),
        moreLines: o.lineItems.pageInfo.hasNextPage,
        truncated: cut.truncated,
      }
    }),
    nextCursor: nextCursor(d.orders.pageInfo),
  }
}

export const ordersSearch: ToolDef<Input> = {
  name: 'orders_search',
  description:
    'Search the store\'s orders, newest first by processed date. Filters (all optional): processedFrom and processedTo ' +
    '(ISO 8601 instants), financialStatus, fulfillmentStatus, returnStatus, sku (exact). Returns at most `first` orders ' +
    `(1 to ${L.maxFirst}, default ${L.defaultFirst}) and nextCursor; pass it as \`after\` with the same filters for the next page. Each order: ` +
    'id, name (like #1001), processedAt, cancelled, statuses, current total and refunded amount in minor units, item ' +
    `count and up to ${L.lines} lines (sku, quantity). Use order_get for one order's lines, refunds and returns. Customer names, ` +
    'emails, phones and addresses are never available.',
  mode: 'read',
  input,
  run: (ctx, i) => {
    const variables = variablesFor(i)
    return runQuery(ctx, ORDERS_SEARCH, variables, parser, d => map(d, variables.first as number))
  },
}

export const ordersSearchParser = parser
