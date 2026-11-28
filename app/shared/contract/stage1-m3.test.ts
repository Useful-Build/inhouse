// Control run for the sandbox write loop (do not merge): a comment-only change so main can be deployed as a PR.
// Stage 1 M3's shared contracts (M3-A: N22, N23, N25, N26, N33). Ways they can go wrong, written first:
//  1. a card claims more than a batch can hold, or carries more than its first 10 lines (an emptied batch still reads);
//  2. a card leaves out who answers it or whether its asker may take it back, or names someone other than a person or
//     the admins;
//  3. a batch answer says how far it approves without the totals it saw, or the other way round (the server could then
//     approve a list the person never saw summed), or an answer smuggles another key;
//  4. an items page runs past 100 items, a position of 0, or a query that isn't a whole position;
//  5. a permission without its limits, or a negative effective limit;
//  6. a ceiling change outside the bounds the migration checks (bulk past 5, batch past 500, a limit of 0), an extra key
//     riding along, or a create that names no revision; a money row shown as a count;
//  7. an item resolve that names no position or a position outside a batch; the refusals M3's routes send missing from
//     the error reasons the client reads.
import { describe, expect, it } from 'vitest'
import {
  ACTION_ITEMS_PAGE, ActionCardSchema, ActionItemsPageSchema, ActionItemsQuerySchema, AnswerActionInputSchema, BATCH_FIRST_LINES, BATCH_ITEMS_MAX,
  ResolveActionInputSchema, WithdrawActionInputSchema,
} from './actions.ts'
import { BULK_THRESHOLD_MAX, CeilingListSchema, CeilingRowSchema, LIMIT_MAX, UpdateCeilingInputSchema } from './ceiling.ts'
import { ErrorBodySchema } from './common.ts'
import { AuditArgsSchema } from './audit.ts'
import { PermissionSchema } from './permissions.ts'

const R = 'A'.repeat(22)
const at = { iso: '2026-11-27T10:00:00.000Z', ms: 1_795_773_600_000 }
const card = {
  id: `ac_${R}`, rev: 1, kind: 'exact', state: 'waiting', title: 'Tag 450 orders VIP', lines: ['More than 5 orders at once'],
  tool: { accountId: 'shopify:store', label: 'Shopify (Store A)' }, records: 450, reachesCustomer: false, reversible: true, guardrail: 'bulk',
  chatId: 'chat-1', askedBy: 'm_owner', askedAt: at, serverNow: at,
  can: { allowOnce: false, alwaysAllow: false, approve: true, deny: true, undo: false, resolve: false, withdraw: false }, nudgeAlways: false, approverKind: 'person',
}
const HEADS = { ref: 'Order', change: 'Change', amount: 'Amount' }
const batch = {
  itemCount: 450, firstLines: Array.from({ length: 10 }, (_, i) => `Order ${1001 + i} (store-a): add VIP`),
  firstRows: Array.from({ length: 10 }, (_, i) => ({ ref: `#${1001 + i}`, change: 'add VIP' })), heads: HEADS, totals: { records: 450, units: 450, unitsLabel: 'orders' },
}

describe('the batch card (1, 2)', () => {
  it('parses a single card and a batch card, each with who answers it', () => {
    expect(ActionCardSchema.safeParse(card).success).toBe(true)
    expect(ActionCardSchema.safeParse({ ...card, batch }).success).toBe(true)
    expect(ActionCardSchema.safeParse({ ...card, batch: { ...batch, totals: { ...batch.totals, amount: '$24.90 (USD)' } } }).success).toBe(true)
    expect(ActionCardSchema.safeParse({ ...card, approverKind: 'admins', waitingFor: 'an admin', chatId: null }).success).toBe(true)
  })
  it('refuses a card without who answers it, or with anyone else', () => {
    const { approverKind: _, ...without } = card
    expect(ActionCardSchema.safeParse(without).success).toBe(false)
    const { withdraw: __, ...canWithout } = card.can
    expect(ActionCardSchema.safeParse({ ...card, can: canWithout }).success).toBe(false)
    expect(ActionCardSchema.safeParse({ ...card, can: { ...card.can, withdraw: true } }).success).toBe(true)
    for (const approverKind of ['asker', 'role:admin', 'team', ''])
      expect(ActionCardSchema.safeParse({ ...card, approverKind }).success, approverKind).toBe(false)
  })
  it('holds at most 500 items and the first 10 lines', () => {
    expect(BATCH_ITEMS_MAX).toBe(500)
    expect(BATCH_FIRST_LINES).toBe(10)
    expect(ActionCardSchema.safeParse({ ...card, batch: { ...batch, itemCount: 500 } }).success).toBe(true)
    expect(ActionCardSchema.safeParse({ ...card, batch: { itemCount: 0, firstLines: [], firstRows: [], heads: HEADS, totals: { records: 0, units: 0, unitsLabel: 'orders' } } }).success).toBe(true)
    for (const itemCount of [-1, 501, 1.5]) expect(ActionCardSchema.safeParse({ ...card, batch: { ...batch, itemCount } }).success, String(itemCount)).toBe(false)
    expect(ActionCardSchema.safeParse({ ...card, batch: { ...batch, firstLines: [...batch.firstLines, 'one more'] } }).success).toBe(false)
    // Stage 1 M3-U: the same first items as rows, at most 10, each with its record and change; and the rows' heads.
    expect(ActionCardSchema.safeParse({ ...card, batch: { ...batch, firstRows: [...batch.firstRows, { ref: '#1', change: 'add VIP' }] } }).success).toBe(false)
    expect(ActionCardSchema.safeParse({ ...card, batch: { ...batch, firstRows: [{ ref: '#1' }] } }).success).toBe(false)
    expect(ActionCardSchema.safeParse({ ...card, batch: { ...batch, firstRows: [{ ref: 'Item 1', change: 'Location 6', amount: '+20' }] } }).success).toBe(true)
    // A list has no heads; a table's heads name all three columns.
    const { heads: _h, ...headless } = batch
    expect(ActionCardSchema.safeParse({ ...card, batch: headless }).success).toBe(true)
    expect(ActionCardSchema.safeParse({ ...card, batch: { ...batch, heads: { ref: 'Item', change: 'Where' } } }).success).toBe(false)
    expect(ActionCardSchema.safeParse({ ...card, batch: { ...batch, totals: { records: 450, units: -1, unitsLabel: 'orders' } } }).success).toBe(false)
    expect(ActionCardSchema.safeParse({ ...card, batch: { ...batch, totals: { records: 450, units: 450 } } }).success).toBe(false)
  })
})

describe('the answer (3)', () => {
  it('takes a single answer as before, and a batch answer with both upTo and totals', () => {
    expect(AnswerActionInputSchema.safeParse({ choice: 'approve', ifRev: 1 }).success).toBe(true)
    expect(AnswerActionInputSchema.safeParse({ choice: 'approve', ifRev: 3, upTo: 120, totals: { records: 120, units: 120 } }).success).toBe(true)
    expect(AnswerActionInputSchema.safeParse({ choice: 'deny', ifRev: 3, upTo: 500, totals: { records: 500, units: 2400 } }).success).toBe(true)
  })
  it('refuses one without the other, a range outside a batch, or anything extra', () => {
    const ok = (v: unknown) => AnswerActionInputSchema.safeParse(v).success
    expect(ok({ choice: 'approve', ifRev: 1, upTo: 120 })).toBe(false)
    expect(ok({ choice: 'approve', ifRev: 1, totals: { records: 120, units: 120 } })).toBe(false)
    for (const upTo of [0, 501, 2.5, '120']) expect(ok({ choice: 'approve', ifRev: 1, upTo, totals: { records: 1, units: 1 } }), String(upTo)).toBe(false)
    expect(ok({ choice: 'approve', ifRev: 1, upTo: 2, totals: { records: 2, units: 2, amount: 5 } })).toBe(false)
    expect(ok({ choice: 'approve', ifRev: 1, upTo: 2, totals: { records: 2 } })).toBe(false)
    expect(ok({ choice: 'approve', ifRev: 1, upTo: 2, totals: { records: 2, units: 2 }, items: [1, 2] })).toBe(false)
  })
})

describe('the items page (4)', () => {
  const item = { n: 11, line: 'Order 1011 (store-a): add VIP', row: { ref: '#1011', change: 'add VIP' }, state: 'pending' }
  it('pages 100 items at a time after a position', () => {
    expect(ACTION_ITEMS_PAGE).toBe(100)
    expect(ActionItemsPageSchema.safeParse({ items: Array.from({ length: 100 }, (_, i) => ({ ...item, n: i + 1 })), next: 100 }).success).toBe(true)
    expect(ActionItemsPageSchema.safeParse({ items: [{ ...item, state: 'sent', result: 'Sent. #1011: VIP' }] }).success).toBe(true)
    expect(ActionItemsPageSchema.safeParse({ items: Array.from({ length: 101 }, (_, i) => ({ ...item, n: i + 1 })) }).success).toBe(false)
    for (const state of ['waiting', 'approved', 'moved']) expect(ActionItemsPageSchema.safeParse({ items: [{ ...item, state }] }).success, state).toBe(false)
    expect(ActionItemsPageSchema.safeParse({ items: [{ ...item, n: 0 }] }).success).toBe(false)
    expect(ActionItemsPageSchema.safeParse({ items: [], next: 0 }).success).toBe(false)
    // Stage 1 M3-U: every item carries its row.
    const { row: _r, ...rowless } = item
    expect(ActionItemsPageSchema.safeParse({ items: [rowless] }).success).toBe(false)
  })
  it('reads `after` from the query text, from 0, and nothing else', () => {
    expect(ActionItemsQuerySchema.parse({})).toEqual({ after: 0 })
    expect(ActionItemsQuerySchema.parse({ after: '200' })).toEqual({ after: 200 })
    for (const after of ['-1', '501', '1.5', 'x']) expect(ActionItemsQuerySchema.safeParse({ after }).success, after).toBe(false)
    expect(ActionItemsQuerySchema.safeParse({ after: '0', limit: '5' }).success).toBe(false)
  })
})

describe('permission limits (5)', () => {
  const p = {
    id: `pg_${R}`, rev: 1, holder: { kind: 'member', memberId: 'm_owner' }, operation: 'shopify.order.tag_add', title: 'Add tags to orders',
    tool: { accountId: 'shopify:store', label: 'Shopify' }, scope: 'store-a', perDay: 50, grantedBy: 'm_owner', grantedAt: at, can: { remove: true },
  }
  it('lists each permission with its limits', () => {
    expect(PermissionSchema.safeParse({ ...p, limits: { perDay: 50, unitsMax: 5, unitsLabel: 'orders', effectivePerDay: 50 } }).success).toBe(true)
    expect(PermissionSchema.safeParse({ ...p, limits: { perDay: 50, unitsMax: 5, unitsLabel: 'orders', effectivePerDay: 0 } }).success).toBe(true)
    expect(PermissionSchema.safeParse(p).success).toBe(false)
    expect(PermissionSchema.safeParse({ ...p, limits: { perDay: 50, unitsMax: 0, unitsLabel: 'orders', effectivePerDay: 50 } }).success).toBe(false)
    expect(PermissionSchema.safeParse({ ...p, limits: { perDay: 50, unitsMax: 5, unitsLabel: 'orders', effectivePerDay: -1 } }).success).toBe(false)
  })
})

describe('the ceiling (6)', () => {
  const values = { enabled: true, perDayMax: 200, unitsMax: 100, bulkThreshold: 5, batchMax: 500 }
  const row = {
    ...values, operation: 'shopify.order.tag_add', title: 'Add tags to orders', description: 'Adds 1 to 5 tags to up to 100 orders.', tool: 'Shopify',
    measure: { kind: 'count', label: 'orders' }, applies: { perDay: true, batch: true }, guardrails: [], approverKind: 'person', suggested: { perDayMax: 200, unitsMax: 100 }, rev: 3, updatedAt: at, updatedBy: 'm_team',
  }
  it('lists every operation, with a row or without one yet', () => {
    expect(CeilingListSchema.safeParse({ items: [row], can: { edit: false }, writesOff: true }).success).toBe(true)
    const none = { ...row, enabled: false, rev: null, updatedAt: null, updatedBy: null }
    expect(CeilingRowSchema.safeParse(none).success).toBe(true)
    const refund = {
      ...row, operation: 'shopify.refund.create', guardrails: ['money', 'customer'], approverKind: 'admins', measure: { kind: 'money', currency: 'USD' },
      applies: { perDay: false, batch: false }, unitsMax: 50_000,
    }
    expect(CeilingRowSchema.safeParse(refund).success).toBe(true)
    expect(CeilingRowSchema.safeParse({ ...refund, measure: { kind: 'money', currency: null } }).success).toBe(true)
    for (const currency of ['usd', 'US', '$']) expect(CeilingRowSchema.safeParse({ ...refund, measure: { kind: 'money', currency } }).success, currency).toBe(false)
    expect(CeilingRowSchema.safeParse({ ...refund, measure: { kind: 'money', label: 'dollars' } }).success).toBe(false)
    expect(CeilingRowSchema.safeParse({ ...refund, applies: undefined }).success).toBe(false)
    expect(CeilingListSchema.safeParse({ items: [row], can: { edit: true } }).success).toBe(false)
  })
  it('takes a change inside the bounds 0760 checks, with the revision it read', () => {
    const ok = (v: unknown) => UpdateCeilingInputSchema.safeParse(v).success
    expect(BULK_THRESHOLD_MAX).toBe(5)
    expect(ok({ ...values, ifRev: 3 })).toBe(true)
    expect(ok({ ...values, ifRev: null })).toBe(true)
    expect(ok({ ...values, bulkThreshold: 1, batchMax: 1, perDayMax: 1, unitsMax: 1, ifRev: 1 })).toBe(true)
    expect(ok(values)).toBe(false)
    expect(ok({ ...values, ifRev: 0 })).toBe(false)
    for (const [k, v] of [['bulkThreshold', 6], ['bulkThreshold', 0], ['batchMax', 501], ['batchMax', 0], ['perDayMax', 0], ['unitsMax', 0], ['unitsMax', 1.5], ['enabled', 1]] as const)
      expect(ok({ ...values, ifRev: 1, [k]: v }), `${k}=${v}`).toBe(false)
    expect(ok({ ...values, ifRev: 1, operation: 'shopify.refund.create' })).toBe(false)
    expect(ok({ ...values, ifRev: 1, loweredRev: 9 })).toBe(false)
  })
})

describe('item resolve, withdraw and refusals (7)', () => {
  it('resolves a batch item by its position, or a single action without one', () => {
    expect(ResolveActionInputSchema.safeParse({ outcome: 'sent', ifRev: 2 }).success).toBe(true)
    expect(ResolveActionInputSchema.safeParse({ outcome: 'failed', ifRev: 2, item: 11 }).success).toBe(true)
    for (const item of [0, 501, 1.5, '11']) expect(ResolveActionInputSchema.safeParse({ outcome: 'failed', ifRev: 2, item }).success, String(item)).toBe(false)
    expect(ResolveActionInputSchema.safeParse({ outcome: 'failed', ifRev: 2, items: [11] }).success).toBe(false)
  })
  it('takes a withdraw with its revision only', () => {
    expect(WithdrawActionInputSchema.safeParse({ ifRev: 1 }).success).toBe(true)
    expect(WithdrawActionInputSchema.safeParse({}).success).toBe(false)
    expect(WithdrawActionInputSchema.safeParse({ ifRev: 1, reason: 'x' }).success).toBe(false)
  })
  it('lets the client read the refusals M3 sends', () => {
    for (const reason of ['writes_off', 'over_limit', 'totals_changed'])
      expect(ErrorBodySchema.parse({ error: { code: 'conflict', reason } }).error.reason, reason).toBe(reason)
  })
  it('audits units and daily counts up to the ceiling bound, a lapse over the limit, and an item resolve', () => {
    const ok = (v: unknown) => AuditArgsSchema.safeParse(v).success
    const id = `ac_${R}`
    const requested = { action: 'action.requested', actionId: id, operation: 'shopify.order.tag_add', verdict: 'exact', guardrail: 'money', origin: 'chat', records: 1 }
    expect(ok({ ...requested, units: LIMIT_MAX })).toBe(true)
    expect(ok({ ...requested, units: LIMIT_MAX + 1 })).toBe(false)
    const granted = { action: 'permission.granted', permissionId: `pg_${R}`, operation: 'shopify.order.tag_add', accountId: 'shopify:store', scopeKey: 'shop=store-a', holder: 'member' }
    expect(ok({ ...granted, perDay: LIMIT_MAX })).toBe(true)
    expect(ok({ ...granted, perDay: LIMIT_MAX + 1 })).toBe(false)
    expect(ok({ action: 'action.lapsed', actionId: id, reason: 'over_limit', released: true })).toBe(true)
    expect(ok({ action: 'action.resolved', actionId: id, outcome: 'failed', released: true, item: 11 })).toBe(true)
    expect(ok({ action: 'action.resolved', actionId: id, outcome: 'failed', released: true, item: 0 })).toBe(false)
  })
})
