// The fake's `draftOrderCreate` (Stage 1 M3-S1): takes `input.lineItems` of known variants with whole positive
// quantities, and an optional note and tags; makes a draft with the next id (from 1001, deterministic). Any other input
// field is a user error, so a hub that sends a customer, address, discount or held stock fails loud here too.
import type { FakeDraftOrder } from '../server.js'
import { userError, type FakeWriteOp } from './types.js'

const ALLOWED = new Set(['lineItems', 'note', 'tags'])

export const fakeDraftOrderCreate: FakeWriteOp<'shopify.draft_order.create'> = {
  key: 'shopify.draft_order.create',
  mutation: 'DraftOrderCreate',
  root: 'draftOrderCreate',
  cost: () => 10,
  run(fake, variables, refuse) {
    const refused = (field: string[], message: string) => ({ draftOrderCreate: { draftOrder: null, userErrors: [userError(field, message)] } })
    if (refuse) return refused(['input'], 'Refused by fake write upstream (draftOrderCreate)')
    const input = typeof variables.input === 'object' && variables.input !== null ? variables.input as Record<string, unknown> : {}
    const extra = Object.keys(input).find(k => !ALLOWED.has(k))
    if (extra) return refused(['input', extra], 'Not accepted by the fake')
    const raw = Array.isArray(input.lineItems) ? input.lineItems as unknown[] : []
    if (raw.length === 0) return refused(['input', 'lineItems'], 'Add at least 1 product')
    const lines: FakeDraftOrder['lines'] = []
    for (const item of raw) {
      const l = (typeof item === 'object' && item !== null ? item : {}) as { variantId?: unknown; quantity?: unknown }
      if (typeof l.variantId !== 'string' || !fake.variants.has(l.variantId)) return refused(['input', 'lineItems', 'variantId'], 'Product variant not found')
      if (typeof l.quantity !== 'number' || !Number.isInteger(l.quantity) || l.quantity < 1) return refused(['input', 'lineItems', 'quantity'], 'Quantity must be at least 1')
      lines.push({ variantId: l.variantId, quantity: l.quantity })
    }
    const draft: FakeDraftOrder = { id: `gid://shopify/DraftOrder/${1001 + fake.drafts.length}`, lines }
    if (typeof input.note === 'string') draft.note = input.note
    if (Array.isArray(input.tags)) draft.tags = input.tags.filter((t): t is string => typeof t === 'string')
    fake.drafts.push(draft)
    return { draftOrderCreate: { draftOrder: { id: draft.id }, userErrors: [] } }
  },
}
