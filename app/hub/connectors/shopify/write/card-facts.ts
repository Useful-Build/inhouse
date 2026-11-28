// The facts an approval card shows beside a write's ids (Stage 1 M3, card details, #488): each order's name, customer and
// current total, and each draft-order variant's product title, variant title and SKU. Read from the write store with
// the write app's token (core.ts `cardFacts`), never the read app's: the read app holds no `read_customers`, and the
// agent's tools never show a customer's name. Queries only, sent as fixed documents with the ids as variables; each
// string is capped here and cleaned again by the product (server/outbox/detail.ts) before a card stores it.
//
// Docs read 2026-11-27 (Admin GraphQL 2026-10):
// - https://shopify.dev/docs/api/admin-graphql/latest/queries/nodes (up to 250 ids; null for an id with no node)
// - https://shopify.dev/docs/api/admin-graphql/latest/objects/Order (`name`, `customer`, `currentTotalPriceSet`;
//   `read_orders`, which `write_orders` grants)
// - https://shopify.dev/docs/api/admin-graphql/latest/objects/Customer (`displayName`; `read_customers`)
// - https://shopify.dev/docs/apps/launch/protected-customer-data (a name is level 2 protected customer data; a field the
//   app isn't approved for is answered null with an `errors` entry)
// - https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant (`title`, `sku`, `product`; `read_products`)
import { z } from 'zod'
import { CARD_FACTS_CAPS } from '../../../index/contract'
import type { CardFacts, CardOrderFacts, CardVariantFacts } from '../../../index/contract'
import { cap, type Cut } from '../shape'
import type { MutationDoc } from './provider'

/**
 * Read scopes the write app may also hold, only for the card: `read_customers` (an order's customer) and `read_products`
 * (a variant's product). Optional: a grant without them still writes, and the card then shows what it can.
 */
export const SHOPIFY_WRITE_CARD_SCOPES = ['read_customers', 'read_products'] as const

const ORDER_FIELDS = 'id name currentTotalPriceSet { shopMoney { amount currencyCode } }'

export const CARD_ORDERS_QUERY = `query CardOrders($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Order { ${ORDER_FIELDS} customer { displayName } } }
}`
/** The same without the customer, for a write app with no `read_customers`. */
export const CARD_ORDERS_NO_CUSTOMER_QUERY = `query CardOrdersNoCustomer($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Order { ${ORDER_FIELDS} } }
}`
export const CARD_VARIANTS_QUERY = `query CardVariants($ids: [ID!]!) {
  nodes(ids: $ids) { ... on ProductVariant { id title sku product { title } } }
}`

export const ordersDoc = (ids: readonly string[], withCustomer: boolean): MutationDoc =>
  ({ query: withCustomer ? CARD_ORDERS_QUERY : CARD_ORDERS_NO_CUSTOMER_QUERY, variables: { ids: [...ids] } })
export const variantsDoc = (ids: readonly string[]): MutationDoc => ({ query: CARD_VARIANTS_QUERY, variables: { ids: [...ids] } })

const zMoney = z.object({ shopMoney: z.object({ amount: z.string().regex(/^-?\d{1,15}(?:\.\d{1,6})?$/), currencyCode: z.string().regex(/^[A-Z]{3}$/) }) })
const zOrder = z.object({
  id: z.string(),
  name: z.string(),
  currentTotalPriceSet: zMoney.nullable(),
  customer: z.object({ displayName: z.string().nullable() }).nullable().optional(),
})
const zVariant = z.object({ id: z.string(), title: z.string(), sku: z.string().nullable(), product: z.object({ title: z.string() }) })
// A node of another type (an id that names something else) answers `{}` from the inline fragment: not found.
const zNodes = <T extends z.ZodType>(node: T) => z.object({ nodes: z.array(z.union([node, z.object({}).strict(), z.null()])) })

const capped = (s: string, max: number) => cap({ truncated: false } satisfies Cut, s, max)

/** The orders' answer, one entry per id asked, in order; null when it doesn't read (the card then shows no facts). */
export function readOrders(ids: readonly string[], data: Record<string, unknown>): CardOrderFacts[] | null {
  const parsed = zNodes(zOrder).safeParse(data)
  if (!parsed.success || parsed.data.nodes.length !== ids.length) return null
  return ids.map((id, i): CardOrderFacts => {
    const n = parsed.data.nodes[i]
    if (!n || !('id' in n) || n.id !== id) return { id, found: false }
    const total = n.currentTotalPriceSet ? { amount: n.currentTotalPriceSet.shopMoney.amount, currencyCode: n.currentTotalPriceSet.shopMoney.currencyCode } : null
    const customer = n.customer?.displayName ?? null
    return { id, found: true, name: capped(n.name, CARD_FACTS_CAPS.orderName), customer: customer === null ? null : capped(customer, CARD_FACTS_CAPS.customer), total }
  })
}

/** The variants' answer, one entry per id asked, in order; null when it doesn't read. */
export function readVariants(ids: readonly string[], data: Record<string, unknown>): CardVariantFacts[] | null {
  const parsed = zNodes(zVariant).safeParse(data)
  if (!parsed.success || parsed.data.nodes.length !== ids.length) return null
  return ids.map((id, i): CardVariantFacts => {
    const n = parsed.data.nodes[i]
    if (!n || !('id' in n) || n.id !== id) return { id, found: false }
    return {
      id, found: true,
      product: capped(n.product.title, CARD_FACTS_CAPS.product),
      variant: capped(n.title, CARD_FACTS_CAPS.variant),
      sku: n.sku === null ? null : capped(n.sku, CARD_FACTS_CAPS.sku),
    }
  })
}

export type { CardFacts }
