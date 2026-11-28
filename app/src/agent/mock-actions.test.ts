// The demo's agent actions (Stage 1 M3-U). Ways they could break, written first:
//  - a scenario that hides them still lists one, or answers for one;
//  - an approval goes out before its 10 second hold on the demo clock, never goes out, or Undo after it still works;
//  - a batch answer without what it covers, or with totals the card never showed, goes through;
//  - the list pages skip or repeat items, or end early;
//  - a No leaves items pending, or Reset demo leaves an answered card answered.
import { describe, expect, test } from 'vitest'
import { FIRST_LINES, ITEMS_PAGE, MockActions } from './mock-actions'
import { ACTION_ITEMS_PAGE, BATCH_FIRST_LINES } from '../../shared/contract/actions'
import { AgentError } from './types'

function world() {
  let now = Date.UTC(2026, 10, 16, 13, 0)
  let shown = true
  const a = new MockActions({ now: () => now, shown: () => shown, meId: 'm_sam', memberId: id => `m_${id}` })
  return { a, tick: (ms: number) => { now += ms }, hide: (h: boolean) => { shown = !h } }
}
const refused = (run: () => unknown) => { try { run() } catch (e) { return e as AgentError } throw new Error('not refused') }

describe('the demo actions', () => {
  test("the page size and first lines are the contract's", () => {
    expect([ITEMS_PAGE, FIRST_LINES]).toEqual([ACTION_ITEMS_PAGE, BATCH_FIRST_LINES])
  })
  test('two batches (a list and a table) and an admins card, newest first; none where the scenario hides them', () => {
    const { a, hide } = world()
    expect(a.list().map(c => [c.title, c.approverKind, c.batch?.itemCount ?? null, c.state])).toEqual([
      ['Tag 450 orders as VIP', 'person', 450, 'waiting'], ['Restock 12 items', 'person', 12, 'waiting'], ['Refund $238.00 (USD) on order 4838', 'admins', null, 'waiting'],
    ])
    expect(a.list()[1]!.batch).toMatchObject({ totals: { records: 12, units: 2400, unitsLabel: 'stock units' }, firstRows: [{ ref: 'Item 8001', change: 'Location 601 · stock received', amount: '+20' }, {}, {}, {}, {}, {}, {}, {}, {}, {}] })
    hide(true)
    expect(a.list()).toEqual([])
    expect(refused(() => a.get('ac_demoVipTagBatch0000000')).code).toBe('not_found')
  })
  test("the batch's items page 100 at a time, in order, to the end", () => {
    const { a } = world()
    const id = a.list()[0]!.id
    const ns: number[] = []
    for (let after = 0; ;) {
      const p = a.items(id, after)
      ns.push(...p.items.map(i => i.n))
      if (p.next === undefined) break
      after = p.next
    }
    expect(ns).toEqual(Array.from({ length: 450 }, (_, i) => i + 1))
  })
  test('an approval holds 10 seconds on the demo clock, then all of it goes out; Undo after that is refused', () => {
    const { a, tick } = world()
    const card = a.list()[0]!
    expect(refused(() => a.answer(card.id, card.rev, 'approve')).code).toBe('invalid')
    expect(refused(() => a.answer(card.id, card.rev, 'approve', { upTo: 450, totals: { records: 450, units: 451 } }))).toMatchObject({ code: 'conflict', reason: 'totals_changed' })
    const approved = a.answer(card.id, card.rev, 'approve', { upTo: 450, totals: { records: 450, units: 450 } })
    expect(approved).toMatchObject({ state: 'approved', can: { undo: true } })
    expect(approved.sendAt!.ms - approved.serverNow.ms).toBe(10_000)
    tick(9_999)
    expect(a.get(card.id).state).toBe('approved')
    tick(1)
    expect(a.get(card.id)).toMatchObject({ state: 'sent', result: 'Sent. 450 of 450 went out' })
    expect(new Set(a.items(card.id, 400).items.map(i => i.state))).toEqual(new Set(['sent']))
    expect(refused(() => a.undo(card.id, approved.rev)).code).toBe('conflict')
  })
  test("a table's answer must carry its units: the stock the items 1 to upTo add up to", () => {
    const { a } = world()
    const restock = a.list()[1]!
    expect(refused(() => a.answer(restock.id, restock.rev, 'approve', { upTo: 12, totals: { records: 12, units: 12 } }))).toMatchObject({ code: 'conflict', reason: 'totals_changed' })
    expect(a.answer(restock.id, restock.rev, 'approve', { upTo: 12, totals: { records: 12, units: 2400 } }).state).toBe('approved')
  })
  test('No withdraws every item; Reset demo puts every card back', () => {
    const { a } = world()
    const card = a.list()[0]!
    expect(a.answer(card.id, card.rev, 'deny', { upTo: 450, totals: { records: 450, units: 450 } }).state).toBe('denied')
    expect(new Set(a.items(card.id, 0).items.map(i => i.state))).toEqual(new Set(['withdrawn']))
    a.reset()
    expect(a.list().map(c => c.state)).toEqual(['waiting', 'waiting', 'waiting'])
  })
  test('the admins card: an admin answers it; a stale rev is a conflict with the card as it is now', () => {
    const { a } = world()
    const refund = a.list()[2]!
    expect(refund).toMatchObject({ approverKind: 'admins', askedBy: 'm_dana', chatId: null, guardrail: 'money' })
    const approved = a.answer(refund.id, refund.rev, 'approve')
    expect(refused(() => a.answer(refund.id, refund.rev, 'deny'))).toMatchObject({ code: 'conflict', current: { state: 'approved', rev: approved.rev } })
    expect(a.undo(refund.id, approved.rev).state).toBe('undone')
  })
})
