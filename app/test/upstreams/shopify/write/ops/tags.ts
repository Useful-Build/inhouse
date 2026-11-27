// The fake's `tagsAdd` and `tagsRemove` (Stage 1 M3-S1): one aliased root field per order (`o0` with `$id0`, `o1` with
// `$id1`, ...), the tags in `$tags`, each order answered on its own as Shopify does. An unknown order is that order's
// user error; the others still run (a partial outcome the hub must report).
import type { FakeShopifyWriteUpstream } from '../server.js'
import { userError, type FakeWriteOp } from './types.js'

/** The `$idN` variables in order, stopping at the first gap. */
function orderIds(variables: Record<string, unknown>): string[] {
  const ids: string[] = []
  for (let i = 0; typeof variables[`id${i}`] === 'string'; i++) ids.push(variables[`id${i}`] as string)
  return ids
}

/** `mutation <name>($tags: [String!]!, $id0: ID!, ...) { o0: <root>(id: $id0, tags: $tags) { node { id } userErrors { field message } } ... }` */
function tagsDocument(name: string, root: string, n: number): string {
  const ids = Array.from({ length: n }, (_, i) => `$id${i}: ID!`).join(', ')
  const fields = Array.from({ length: n }, (_, i) => `o${i}: ${root}(id: $id${i}, tags: $tags) { node { id } userErrors { field message } }`).join('\n')
  return `mutation ${name}($tags: [String!]!, ${ids}) {\n${fields}\n}`
}

function tagsOp<K extends string>(key: K, name: string, root: 'tagsAdd' | 'tagsRemove', apply: (tags: string[], change: string[]) => string[]): FakeWriteOp<K> {
  return {
    key,
    kind: 'mutation',
    name,
    document: variables => tagsDocument(name, root, orderIds(variables).length),
    root: 'o0',
    cost: variables => 10 * orderIds(variables).length,
    run(fake: FakeShopifyWriteUpstream, variables, refuse) {
      const change = Array.isArray(variables.tags) ? variables.tags.filter((t): t is string => typeof t === 'string') : []
      const data: Record<string, unknown> = {}
      orderIds(variables).forEach((id, i) => {
        const order = fake.orders.get(id)
        if (refuse) data[`o${i}`] = { node: null, userErrors: [userError(['tags'], `Refused by fake write upstream (${root})`)] }
        else if (!order) data[`o${i}`] = { node: null, userErrors: [userError(['id'], 'Order not found')] }
        else {
          order.tags = apply(order.tags, change)
          data[`o${i}`] = { node: { id: order.id }, userErrors: [] }
        }
      })
      return data
    },
  }
}

export const fakeOrderTagAdd = tagsOp('shopify.order.tag_add', 'OrderTagsAdd', 'tagsAdd', (tags, add) => [...tags, ...add.filter(t => !tags.includes(t))])
export const fakeOrderTagRemove = tagsOp('shopify.order.tag_remove', 'OrderTagsRemove', 'tagsRemove', (tags, remove) => tags.filter(t => !remove.includes(t)))
