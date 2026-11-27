// What `shopify.order.tag_add` and `shopify.order.tag_remove` share (Stage 1 M3-S1, N21): 1 to 100 distinct orders and
// 1 to 5 distinct clean tags, scope `{ shop }`, one record and one unit per order. A call over the bulk threshold, or a
// multi-order call under a grant, splits into one item per order (`items`); a call collected into a batch stays one
// item, so its line names every order in it (at most the bulk threshold, 5). The hub checks the arguments again,
// strictly, and takes at most 5 orders in one call (hub/connectors/shopify/write/ops/tags.ts).
import { z } from 'zod'
import type { ResolveFacts } from '../../permissions/types.ts'

/** A Shopify order's GraphQL id, the form the read tools return. */
const ORDER_ID = /^gid:\/\/shopify\/Order\/[1-9][0-9]{0,19}$/
/** The most orders one call may name (N21); past the ceiling's bulk threshold it's one exact batch card. */
export const ORDERS_MAX = 100
/**
 * One tag as Shopify stores it: up to 40 characters, no comma (Shopify splits tags on commas), no surrounding space,
 * no control or format character (bidi, zero-width).
 */
export const TagSchema = z.string().min(1).max(40).regex(/^[^,\p{Cc}\p{Cf}]+$/u).refine(t => t === t.trim(), 'No surrounding space')
/** 1 to 5 tags, each once (case does not make a new tag in Shopify). */
export const TagsSchema = z.array(TagSchema).min(1).max(5).refine(t => new Set(t.map(x => x.toLowerCase())).size === t.length, 'Each tag once')

export const OrderTagsArgsSchema = z.strictObject({
  orderIds: z.array(z.string().regex(ORDER_ID)).min(1).max(ORDERS_MAX).refine(ids => new Set(ids).size === ids.length, 'Each order once'),
  tags: TagsSchema,
})
export type OrderTagsArgs = z.infer<typeof OrderTagsArgsSchema>

export const orderNumber = (orderId: string): string => orderId.slice(orderId.lastIndexOf('/') + 1)

/** The connected shop, which `resolve` has already required. */
export function shopScope(key: string, f: ResolveFacts): { shop: string } {
  const shop = f.accounts.shopify?.shop
  // `resolve` refuses an account with no shop before it asks for the scope.
  if (!shop) throw new Error(`${key}: scope asked for with no connected shop`)
  return { shop }
}

/** One item per order, each the operation's own arguments (N21, N22). */
export const itemsPerOrder = (a: OrderTagsArgs): OrderTagsArgs[] => a.orderIds.map(id => ({ orderIds: [id], tags: a.tags }))

/** "Order 1042 (store-a): add VIP, rush", or "Orders 1042, 1043 (store-a): ..." naming every order in the call. */
export function tagsItemLine(verb: 'add' | 'remove', a: OrderTagsArgs, f: ResolveFacts): string {
  const shop = f.accounts.shopify?.shop
  const orders = a.orderIds.map(orderNumber).join(', ')
  return `${a.orderIds.length === 1 ? 'Order' : 'Orders'} ${orders}${shop ? ` (${shop})` : ''}: ${verb} ${a.tags.join(', ')}`
}

/** The card: one order in the title as M2's; several orders named in a line of their own. */
export function tagsCard(verb: 'Add' | 'Remove', a: OrderTagsArgs): { title: string; lines: string[] } {
  const tags = a.tags.length === 1 ? 'a tag' : `${a.tags.length} tags`
  const where = a.orderIds.length === 1 ? `order ${orderNumber(a.orderIds[0]!)}` : `${a.orderIds.length} orders`
  const lines = a.tags.map(t => `Tag: ${t}`)
  if (a.orderIds.length > 1) lines.push(`Orders: ${a.orderIds.map(orderNumber).join(', ')}`)
  return { title: `${verb} ${tags} ${verb === 'Add' ? 'to' : 'from'} ${where}`, lines }
}
