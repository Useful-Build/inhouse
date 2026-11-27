// What `shopify.order.tag_add` and `shopify.order.tag_remove` share (Stage 1 M3-S1, N21): 1 to 5 orders and 1 to 5 tags
// per hub call, sent as ONE mutation document with one aliased root field per order (`o0` to `o4`), which Shopify runs
// in order. A call over the bulk threshold never reaches the hub whole: the server splits it into one item per order.
//
// A multi-order call's partial outcome, as the hub reports it (each order is its own root field, so Shopify answers each):
// - every order done: `ok`, a ref naming every order;
// - every order refused (user errors, no result): `upstream_rejected`, `sent: 'no'` (nothing changed);
// - anything else (some done, or any unclear): `sent: 'unknown'`, never `'no'` and never `ok`, with the order numbers
//   in each group in the message ("sent 9001; refused 9002; unclear 9003"). The action then needs a person's check,
//   which names what went out. Nothing is retried.
import { z } from 'zod'
import type { WriteResult } from '../../../../index/contract'
import { writeErr, type MutationDoc } from '../provider'
import { rootOutcome, type RootOutcome } from './types'

/** The most orders one hub call takes: the ceiling's largest `bulk_threshold` (shared/contract/ceiling.ts `BULK_THRESHOLD_MAX`). */
export const ORDERS_PER_CALL_MAX = 5

const ORDER_GID = /^gid:\/\/shopify\/Order\/([1-9]\d{0,19})$/
// Tags (#491: exactly the server's rule, server/outbox/operations/shopify-order-tags.ts `TagSchema`): 1..40 chars, no
// comma (Shopify splits on commas), no control or format character (C0, DEL, C1, bidi, zero-width), no surrounding space
// (refused, never trimmed: what the person approved is what goes out).
const TAG_RE = /^[^,\p{Cc}\p{Cf}]+$/u

/** One tag, exactly as the server checked it (40 UTF-16 units at most, as zod counts). */
export const ShopifyTagSchema = z.string().min(1).max(40).regex(TAG_RE).refine(t => t === t.trim(), 'No surrounding space')
/** 1 to 5 tags, each once; case doesn't make a new tag in Shopify. */
export const ShopifyTagsSchema = z.array(ShopifyTagSchema).min(1).max(5)
  .refine(t => new Set(t.map(x => x.toLowerCase())).size === t.length, 'Each tag once')

export const ShopifyOrderTagsArgsSchema = z.strictObject({
  orderIds: z.array(z.string().regex(ORDER_GID)).min(1).max(ORDERS_PER_CALL_MAX)
    .refine(ids => new Set(ids).size === ids.length, 'Each order once'),
  tags: ShopifyTagsSchema,
})
export type ShopifyOrderTagsArgs = z.infer<typeof ShopifyOrderTagsArgsSchema>

export const orderNumber = (orderId: string): string => ORDER_GID.exec(orderId)?.[1] ?? 'order'

type TagsField = { operation: 'OrderTagsAdd' | 'OrderTagsRemove'; field: 'tagsAdd' | 'tagsRemove' }

/** One document, one aliased root field per order, the tags shared. Variables only: no value is written into the text. */
export function tagsDocument({ operation, field }: TagsField, a: ShopifyOrderTagsArgs): MutationDoc {
  const ids = a.orderIds.map((_, i) => `$id${i}: ID!`).join(', ')
  const roots = a.orderIds.map((_, i) => `  o${i}: ${field}(id: $id${i}, tags: $tags) {\n    node {\n      id\n    }\n    userErrors {\n      field\n      message\n    }\n  }`)
  const variables: Record<string, unknown> = { tags: a.tags }
  a.orderIds.forEach((id, i) => { variables[`id${i}`] = id })
  return { query: `mutation ${operation}($tags: [String!]!, ${ids}) {\n${roots.join('\n')}\n}`, variables }
}

/** Safe human-readable ref (order id digits and tag names, bounded). */
export function formatOrderTagRef(orderIds: readonly string[], tags: readonly string[], verb: '' | 'removed '): string {
  const orders = orderIds.map(orderNumber)
  return `${orders.length === 1 ? 'order' : 'orders'} ${orders.join(', ')}: ${verb}${tags.join(', ')}`.slice(0, 500)
}

/** Reads every order's root field and answers as the header says. */
export function readTags(data: Record<string, unknown>, a: ShopifyOrderTagsArgs, verb: '' | 'removed '): WriteResult {
  const outcomes: RootOutcome[] = a.orderIds.map((id, i) =>
    rootOutcome(data[`o${i}`], 'node', node => typeof node === 'object' && node !== null && (node as { id?: unknown }).id === id))
  if (outcomes.every(o => o === 'done')) return { ok: true, value: { ref: formatOrderTagRef(a.orderIds, a.tags, verb) } }
  const group = (o: RootOutcome) => a.orderIds.filter((_, i) => outcomes[i] === o).map(orderNumber)
  if (outcomes.every(o => o === 'refused')) return writeErr('upstream_rejected', 'no', `refused ${group('refused').join(',')}`)
  const parts = ([['sent', 'done'], ['refused', 'refused'], ['unclear', 'unclear']] as const)
    .map(([word, o]) => [word, group(o)] as const)
    .filter(([, nums]) => nums.length > 0)
    .map(([word, nums]) => `${word} ${nums.join(',')}`)
  return writeErr(outcomes.includes('unclear') ? 'upstream_unavailable' : 'upstream_rejected', 'unknown', parts.join('; '))
}
