// `shopify.draft_order.create` (Stage 1 M3-S1, N21, section 0 Q1): one draft order of 1 to 20 product variants with
// quantities, and an optional note and tags (`draftOrderCreate`, write_draft_orders). Nothing else reaches Shopify's
// input: no customer, email, address, discount, shipping line, invoice or held stock (`reserveInventoryUntil`), and the
// draft is never sent or completed. One root field: done, refused (`sent: 'no'`) or unclear (`sent: 'unknown'`).
import { z } from 'zod'
import { writeErr } from '../provider'
import { ShopifyTagsSchema } from './tags'
import { rootOutcome, type ShopifyWriteOp } from './types'

const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,19}$/
const DRAFT_GID = /^gid:\/\/shopify\/DraftOrder\/([1-9]\d{0,19})$/
/** A staff note: up to 500 characters, line breaks allowed, no other control or format character (bidi, zero-width). */
const NOTE_RE = /^[^\p{Cc}\p{Cf}]*(?:\n[^\p{Cc}\p{Cf}]*)*$/u

export const DraftOrderCreateArgsSchema = z.strictObject({
  lines: z.array(z.strictObject({ variantId: z.string().regex(VARIANT_GID), quantity: z.int().min(1).max(100) })).min(1).max(20)
    .refine(ls => new Set(ls.map(l => l.variantId)).size === ls.length, 'Each variant once'),
  note: z.string().min(1).max(500).regex(NOTE_RE).optional(),
  tags: ShopifyTagsSchema.optional(),
})
export type DraftOrderCreateArgs = z.infer<typeof DraftOrderCreateArgsSchema>

export const DRAFT_ORDER_CREATE_MUTATION = `mutation DraftOrderCreate($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder {
      id
    }
    userErrors {
      field
      message
    }
  }
}`

export const draftOrderCreate: ShopifyWriteOp<DraftOrderCreateArgs> = {
  key: 'shopify.draft_order.create',
  scope: 'write_draft_orders',
  idempotent: false,
  args: DraftOrderCreateArgsSchema,
  document: a => ({
    query: DRAFT_ORDER_CREATE_MUTATION,
    variables: {
      input: {
        lineItems: a.lines.map(l => ({ variantId: l.variantId, quantity: l.quantity })),
        ...(a.note !== undefined ? { note: a.note } : {}),
        ...(a.tags !== undefined ? { tags: a.tags } : {}),
      },
    },
  }),
  read: (data, a) => {
    let num: string | undefined
    const outcome = rootOutcome(data.draftOrderCreate, 'draftOrder', d => {
      const id = typeof d === 'object' && d !== null ? (d as { id?: unknown }).id : undefined
      num = typeof id === 'string' ? DRAFT_GID.exec(id)?.[1] : undefined
      return num !== undefined
    })
    if (outcome === 'done') {
      const items = a.lines.reduce((n, l) => n + l.quantity, 0)
      return { ok: true, value: { ref: `draft order ${num}: ${items} ${items === 1 ? 'item' : 'items'}` } }
    }
    return outcome === 'refused' ? writeErr('upstream_rejected', 'no') : writeErr('upstream_unavailable', 'unknown')
  },
}
