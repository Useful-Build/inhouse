// The product target's write families (Stage 1 M3-R, N30): `tag_ops`, `stock_ops` and `refund`, each only once every
// operation it needs is built, so no case runs against an operation the hub can't take. Its SQL on a real D1 is
// server/outbox/eval-write-log.test.ts's.
import { describe, expect, it } from 'vitest'
import { WRITE_OPERATIONS } from '../../hub/index/contract.ts'
import { newGrantId, writeProvides } from './write-door.ts'

describe('writeProvides', () => {
  it('provides a family only when all of its operations are in the list', () => {
    expect(writeProvides([])).toEqual(new Set())
    expect(writeProvides(['shopify.order.tag_add'])).toEqual(new Set())
    expect(writeProvides(['shopify.order.tag_add', 'shopify.order.tag_remove'])).toEqual(new Set(['tag_ops']))
    expect(writeProvides(['shopify.inventory.restock'])).toEqual(new Set())
    expect(writeProvides(['shopify.inventory.restock', 'shopify.inventory.reduce', 'shopify.refund.create'])).toEqual(new Set(['stock_ops', 'refund']))
  })
  it('reads the built operations by default, and never the parked `write_set`', () => {
    expect(writeProvides()).toEqual(writeProvides(WRITE_OPERATIONS))
    expect(writeProvides([...WRITE_OPERATIONS, 'shopify.order.tag_remove', 'shopify.inventory.restock', 'shopify.inventory.reduce', 'shopify.refund.create']).has('write_set')).toBe(false)
  })
})

describe('newGrantId', () => {
  it('is a permission id as the product makes one', () => {
    for (let i = 0; i < 50; i++) expect(newGrantId()).toMatch(/^pg_[A-Za-z0-9_-]{22}$/)
  })
})
