// `shopify.order.tag_add` (N9): adds 1 to 5 tags to one order in the brand's connected Shopify store. Scope `{ shop }`,
// one record, one unit, no effect flag (a tag reaches no customer and moves no money), so a member may ask for it and
// "Always allow" may cover it. The hub checks the arguments again, strictly (N13).
import { z } from 'zod'
import type { OperationEntry } from './types.ts'

/** A Shopify order's GraphQL id, the form the read tools return. */
const ORDER_ID = /^gid:\/\/shopify\/Order\/[1-9][0-9]{0,19}$/
/**
 * One tag as Shopify stores it: up to 40 characters, no comma (Shopify splits tags on commas), no surrounding space,
 * no control or format character (bidi, zero-width).
 */
const TagSchema = z.string().min(1).max(40).regex(/^[^,\p{Cc}\p{Cf}]+$/u).refine(t => t === t.trim(), 'No surrounding space')

export const TagAddArgsSchema = z.strictObject({
  orderId: z.string().regex(ORDER_ID),
  tags: z.array(TagSchema).min(1).max(5).refine(t => new Set(t.map(x => x.toLowerCase())).size === t.length, 'Each tag once'),
})
export type TagAddArgs = z.infer<typeof TagAddArgsSchema>

const orderNumber = (orderId: string): string => orderId.slice(orderId.lastIndexOf('/') + 1)

export const shopifyOrderTagAdd: OperationEntry<TagAddArgs> & { key: 'shopify.order.tag_add' } = {
  key: 'shopify.order.tag_add',
  tool: 'shopify_order_tag_add',
  description: 'Add 1 to 5 tags to one order in the connected Shopify store. A person approves it first unless they chose "Always allow".',
  args: TagAddArgsSchema,
  connector: 'shopify',
  scope(_a, f) {
    const shop = f.accounts.shopify?.shop
    // `resolve` refuses an account with no shop before it asks for the scope.
    if (!shop) throw new Error('shopify.order.tag_add: scope asked for with no connected shop')
    return { shop }
  },
  records: () => 1,
  units: () => 1,
  effects: { money: false, customer: false, destructive: false, access: false },
  memberMay: true,
  reversible: true,
  idempotent: false,
  defaultPerDay: 50,
  card: a => ({
    title: `Add ${a.tags.length === 1 ? 'a tag' : `${a.tags.length} tags`} to order ${orderNumber(a.orderId)}`,
    lines: a.tags.map(t => `Tag: ${t}`),
  }),
}
