// Activity's "Stop allowing this" (#655). Ways it could break, written first: a row offers to stop a permission its
// action didn't run under (one on the same tool account, the old guess); a row offers one the viewer may not remove, or
// one already removed; an action a person answered offers any.
import { describe, expect, test } from 'vitest'
import type { ActionCard, Permission } from '../../agent/types'
import { stopAllowing } from './action-rows'

const at = { iso: '2026-11-16T13:00:00.000Z', ms: Date.UTC(2026, 10, 16, 13) }
const NONE: ActionCard['can'] = { allowOnce: false, alwaysAllow: false, approve: false, deny: false, undo: false, resolve: false, withdraw: false }
const tool = { accountId: 'shopify:northline-outdoor', label: 'Shopify' }
const card = (over: Partial<ActionCard> = {}): ActionCard => ({
  id: 'ac_AAAAAAAAAAAAAAAAAAAAAA', rev: 2, kind: 'ask', state: 'sent', title: 'Add 40 units of stock to item 8012', lines: [], tool, records: 1,
  reachesCustomer: false, reversible: true, chatId: null, askedBy: 'm_sam', askedAt: at, serverNow: at, can: NONE, nudgeAlways: false,
  approverKind: 'person', ...over,
})
const permission = (id: string, over: Partial<Permission> = {}): Permission => ({
  id, rev: 1, holder: { kind: 'member', memberId: 'm_sam' }, operation: 'shopify.inventory.restock', title: 'Add stock', tool, scope: 'northline-outdoor',
  perDay: 200, limits: { perDay: 200, unitsMax: 50, unitsLabel: 'stock units', effectivePerDay: 200 }, grantedBy: 'm_sam', grantedAt: at,
  can: { remove: true }, ...over,
})
const STOCK = 'pg_stockAAAAAAAAAAAAAAAA'
const TAGS = 'pg_tagsAAAAAAAAAAAAAAAAA'

describe('Stop allowing this follows the permission the action ran under', () => {
  test('the one the card names, never another on the same tool account', () => {
    const list = [permission(TAGS, { title: 'Add tags to orders', operation: 'shopify.order.tag_add' }), permission(STOCK)]
    expect(stopAllowing(card({ permissionId: STOCK }), list)?.id).toBe(STOCK)
    expect(stopAllowing(card({ permissionId: TAGS }), list)?.title).toBe('Add tags to orders')
  })
  test('none for an action a person answered, even with a permission on its tool account', () => {
    expect(stopAllowing(card(), [permission(STOCK)])).toBeNull()
  })
  test('none once that permission is gone, or when the viewer may not remove it', () => {
    expect(stopAllowing(card({ permissionId: STOCK }), [permission(TAGS)])).toBeNull()
    expect(stopAllowing(card({ permissionId: STOCK }), [permission(STOCK, { can: { remove: false } })])).toBeNull()
  })
})
