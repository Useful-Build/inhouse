// The fake's card-facts queries (Stage 1 M3, card details, #488): an order's name, customer and current total, and a
// variant's product title, title and SKU, by `nodes(ids:)`. Queries only: they change nothing and are logged as reads.
// An id the fake doesn't hold answers null, as Shopify's `nodes` does. `CardOrders` asks the customer, so the fake
// answers it only while its grant holds `read_customers` (else ACCESS_DENIED, as Shopify does for a missing scope);
// `CardVariants` likewise needs `read_products`. No npm packages (bundled into the hub's test build).
import type { FakeShopifyWriteUpstream } from '../server.js'
import { cents } from './refund.js'
import type { FakeWriteOp } from './types.js'

const ids = (variables: Record<string, unknown>): string[] =>
  Array.isArray(variables.ids) ? variables.ids.filter((x): x is string => typeof x === 'string') : []

const ORDER_FIELDS = 'id name currentTotalPriceSet { shopMoney { amount currencyCode } }'

function orderNode(fake: FakeShopifyWriteUpstream, id: string, withCustomer: boolean): Record<string, unknown> | null {
  const o = fake.orders.get(id)
  if (!o) return null
  const f = fake.orderFacts.get(id) ?? { customer: null, totalMinor: 0 }
  return {
    id: o.id,
    name: o.name,
    currentTotalPriceSet: { shopMoney: { amount: cents(f.totalMinor), currencyCode: fake.currency } },
    ...(withCustomer ? { customer: f.customer === null ? null : { displayName: f.customer } } : {}),
  }
}

export const fakeCardOrders: FakeWriteOp<'shopify.card.orders'> = {
  key: 'shopify.card.orders',
  kind: 'query',
  name: 'CardOrders',
  document: () => `query CardOrders($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { ${ORDER_FIELDS} customer { displayName } } } }`,
  root: 'nodes',
  cost: v => 1 + ids(v).length,
  needs: 'read_customers',
  run: (fake, v) => ({ nodes: ids(v).map(id => orderNode(fake, id, true)) }),
}

export const fakeCardOrdersNoCustomer: FakeWriteOp<'shopify.card.orders_no_customer'> = {
  key: 'shopify.card.orders_no_customer',
  kind: 'query',
  name: 'CardOrdersNoCustomer',
  document: () => `query CardOrdersNoCustomer($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { ${ORDER_FIELDS} } } }`,
  root: 'nodes',
  cost: v => 1 + ids(v).length,
  run: (fake, v) => ({ nodes: ids(v).map(id => orderNode(fake, id, false)) }),
}

export const fakeCardVariants: FakeWriteOp<'shopify.card.variants'> = {
  key: 'shopify.card.variants',
  kind: 'query',
  name: 'CardVariants',
  document: () => 'query CardVariants($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id title sku product { title } } } }',
  root: 'nodes',
  cost: v => 1 + ids(v).length,
  needs: 'read_products',
  run: (fake, v) => ({
    nodes: ids(v).map(id => {
      const p = fake.variants.has(id) ? fake.products.get(id) : undefined
      return p ? { id, title: p.variant, sku: p.sku, product: { title: p.product } } : null
    }),
  }),
}
