// `shopify.draft_order.create` (Stage 1 M3-S1, N21, section 0 Q1): one draft order in the brand's connected Shopify
// store: 1 to 20 product variants with quantities, an optional staff note and tags. No customer, email, address,
// discount, invoice or held stock, so it reaches no customer and moves no money: no effect flag, one record, one unit.
// The hub checks the arguments again, strictly, and sends nothing else (hub/connectors/shopify/write/ops/draft-order-create.ts).
import { z } from 'zod'
import { shopScope, TagsSchema } from './shopify-order-tags.ts'
import type { OperationEntry } from './types.ts'
import { countOf } from '../words.ts'

const VARIANT_ID = /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]{0,19}$/
/** A staff note: up to 500 characters, line breaks allowed, no other control or format character (bidi, zero-width). */
const NoteSchema = z.string().min(1).max(500).regex(/^[^\p{Cc}\p{Cf}]*(?:\n[^\p{Cc}\p{Cf}]*)*$/u)

export const DraftOrderArgsSchema = z.strictObject({
  lines: z.array(z.strictObject({ variantId: z.string().regex(VARIANT_ID), quantity: z.int().min(1).max(100) })).min(1).max(20)
    .refine(ls => new Set(ls.map(l => l.variantId)).size === ls.length, 'Each variant once'),
  note: NoteSchema.optional(),
  tags: TagsSchema.optional(),
})
export type DraftOrderArgs = z.infer<typeof DraftOrderArgsSchema>

const variantNumber = (id: string): string => id.slice(id.lastIndexOf('/') + 1)
const lineWords = (l: DraftOrderArgs['lines'][number]) => `${l.quantity} × variant ${variantNumber(l.variantId)}`
const itemCount = (a: DraftOrderArgs) => a.lines.reduce((n, l) => n + l.quantity, 0)

export const shopifyDraftOrderCreate: OperationEntry<DraftOrderArgs> & { key: 'shopify.draft_order.create' } = {
  key: 'shopify.draft_order.create',
  tool: 'shopify_draft_order_create',
  description: 'Create one draft order in the connected Shopify store: 1 to 20 product variants with quantities, and an optional note and tags. It has no customer and is never sent or completed. A person approves it first unless they chose "Always allow".',
  args: DraftOrderArgsSchema,
  connector: 'shopify',
  scope: (_a, f) => shopScope('shopify.draft_order.create', f),
  records: () => 1,
  units: () => 1,
  unitsLabel: 'draft orders',
  // Every product and quantity, the note and the tags: nothing a person approves is cut.
  itemLine: (a, f) => {
    const shop = f.accounts.shopify?.shop
    return [
      `Draft order${shop ? ` (${shop})` : ''}: ${a.lines.map(lineWords).join(', ')}`,
      ...(a.note !== undefined ? [`note: ${a.note}`] : []),
      ...(a.tags !== undefined ? [`tags: ${a.tags.join(', ')}`] : []),
    ].join('; ')
  },
  // Stage 1 M3-U (N33): a draft as a row: its products and quantities, the note and the tags.
  itemRow: a => ({
    ref: 'Draft',
    change: [a.lines.map(lineWords).join(', '), ...(a.note !== undefined ? [`note: ${a.note}`] : []), ...(a.tags !== undefined ? [`tags: ${a.tags.join(', ')}`] : [])].join('; '),
  }),
  rowHeads: { ref: 'Order', change: 'Products', amount: 'Amount' },
  batchTitle: c => `Create ${countOf(c.records, 'draft order', 'draft orders')}`,
  effects: { money: false, customer: false, destructive: false, access: false },
  memberMay: true,
  reversible: true,
  idempotent: false,
  coalesces: true,
  defaults: { grant: { perDay: 10, unitsMax: 1 }, ceiling: { perDayMax: 50, unitsMax: 1 } },
  card: a => ({
    title: `Create a draft order of ${itemCount(a) === 1 ? '1 item' : `${itemCount(a)} items`}`,
    lines: [
      ...a.lines.map(lineWords),
      ...(a.note !== undefined ? [`Note: ${a.note}`] : []),
      ...(a.tags !== undefined ? [`Tags: ${a.tags.join(', ')}`] : []),
    ],
  }),
}
