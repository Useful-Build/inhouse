// The demo's agent actions (Stage 1 M3-U). Ways they could break, written first:
//  - a scenario that hides them still lists one, or answers for one;
//  - an approval goes out before its 10 second hold on the demo clock, never goes out, or Undo after it still works;
//  - a batch answer without what it covers, or with totals the card never showed, goes through;
//  - the list pages skip or repeat items, or end early;
//  - a No leaves items pending, or Reset demo leaves an answered card answered.
// The demo catch-up (PR 1) adds, written first:
//  - an ask card offers other than Allow once, Always allow and No, or a teammate's card offers the admin any button;
//  - Always allow makes no permission, makes a second one for the same holder and operation, or one with limits or
//    words other than the server's; Remove leaves it, takes a stale rev, or a Reset keeps what Always allow made;
//  - a Pause leaves a card in its hold to go out, sends back one that already went out, or gives no notice or update;
//    an approval goes through while paused;
//  - a card that needs a check settles to other words than the server's, or someone who can't resolve it does;
//  - a brand with no Slack still shows a Slack card or permission;
//  - a card or a permission drifts from the contract's schema (the server's own words: server/outbox/demo-parity.test.ts).
import { describe, expect, test } from 'vitest'
import { FIRST_LINES, ITEMS_PAGE, MockActions } from './mock-actions'
import { ACTION_ITEMS_PAGE, ActionCardSchema, BATCH_FIRST_LINES } from '../../shared/contract/actions'
import { PermissionSchema } from '../../shared/contract/permissions'
import { AgentError } from './types'

function world() {
  let now = Date.UTC(2026, 10, 16, 13, 0)
  let shown = true
  let paused = false
  const changed: { actionId: string; rev: number }[] = []
  const sentBack: { actionId: string; rev: number; atMs: number }[] = []
  let slack = true
  const a = new MockActions({
    now: () => now, shown: () => shown, hasTool: t => t !== 'slack' || slack, meId: 'm_sam', memberId: id => `m_${id}`, paused: () => paused,
    changed: u => { changed.push(u) }, sentBack: u => { sentBack.push(u) },
  })
  return { a, tick: (ms: number) => { now += ms }, hide: (h: boolean) => { shown = !h }, pause: (p: boolean) => { paused = p }, noSlack: () => { slack = false }, changed, sentBack, now: () => now }
}
const byTitle = (a: MockActions, title: string) => {
  const c = a.list().find(x => x.title === title)
  if (!c) throw new Error(`no card "${title}"`)
  return c
}
const WHOLESALE = 'Add a tag to order 4512'
const POST = 'Post to #ops-alerts in Slack'
const GIFT = 'Add a tag to order 4377'
const PRIYA = 'Remove a tag from order 4470'
const SENT = 'Add 40 units of stock to item 8012'
// The server's words, as sample-data/actions.json holds them (server/outbox/demo-parity.test.ts holds the two equal).
const SENT_TEXT = 'Sent.'
const FAILED_TEXT = 'It didn’t go out.'
const NEEDS_CHECK_TEXT = 'It isn’t clear whether this went out. Check in the tool, then say whether it did.'
const LAPSE_TEXT = { paused: 'The agent was paused, so this needs your OK again.' }
const refused = (run: () => unknown) => { try { run() } catch (e) { return e as AgentError } throw new Error('not refused') }

describe('the demo actions', () => {
  test("the page size and first lines are the contract's", () => {
    expect([ITEMS_PAGE, FIRST_LINES]).toEqual([ACTION_ITEMS_PAGE, BATCH_FIRST_LINES])
  })
  test('two batches (a list and a table), an admins card and the single cards, newest first; none where the scenario hides them', () => {
    const { a, hide } = world()
    expect(a.list().map(c => [c.title, c.approverKind, c.batch?.itemCount ?? null, c.state])).toEqual([
      ['Tag 450 orders as VIP', 'person', 450, 'waiting'], [POST, 'person', null, 'waiting'], [WHOLESALE, 'person', null, 'waiting'],
      ['Restock 12 items', 'person', 12, 'waiting'], [PRIYA, 'person', null, 'waiting'], ['Refund $238.00 (USD) on order 4838', 'admins', null, 'waiting'],
      [SENT, 'person', null, 'sent'], [GIFT, 'person', null, 'needs_check'],
    ])
    for (const c of a.list()) ActionCardSchema.parse(c)
    expect(byTitle(a, 'Restock 12 items').batch).toMatchObject({ totals: { records: 12, units: 2400, unitsLabel: 'stock units' }, firstRows: [{ ref: 'Item 8001', change: 'Location 601 · stock received', amount: '+20' }, {}, {}, {}, {}, {}, {}, {}, {}, {}] })
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
    const restock = byTitle(a, 'Restock 12 items')
    expect(refused(() => a.answer(restock.id, restock.rev, 'approve', { upTo: 12, totals: { records: 12, units: 12 } }))).toMatchObject({ code: 'conflict', reason: 'totals_changed' })
    expect(a.answer(restock.id, restock.rev, 'approve', { upTo: 12, totals: { records: 12, units: 2400 } }).state).toBe('approved')
  })
  test('No withdraws every item; Reset demo puts every card back', () => {
    const { a } = world()
    const card = a.list()[0]!
    expect(a.answer(card.id, card.rev, 'deny', { upTo: 450, totals: { records: 450, units: 450 } }).state).toBe('denied')
    expect(new Set(a.items(card.id, 0).items.map(i => i.state))).toEqual(new Set(['withdrawn']))
    a.reset()
    expect(a.list().map(c => c.state)).toEqual(['waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'sent', 'needs_check'])
  })
  test('the admins card: an admin answers it; a stale rev is a conflict with the card as it is now', () => {
    const { a } = world()
    const refund = byTitle(a, 'Refund $238.00 (USD) on order 4838')
    expect(refund).toMatchObject({ approverKind: 'admins', askedBy: 'm_dana', chatId: null, guardrail: 'money' })
    const approved = a.answer(refund.id, refund.rev, 'approve')
    expect(refused(() => a.answer(refund.id, refund.rev, 'deny'))).toMatchObject({ code: 'conflict', current: { state: 'approved', rev: approved.rev } })
    expect(a.undo(refund.id, approved.rev).state).toBe('undone')
  })

  test('a batch that is paused in its hold waits again, with its items pending', () => {
    const { a, pause } = world()
    const card = a.list()[0]!
    a.answer(card.id, card.rev, 'approve', { upTo: 450, totals: { records: 450, units: 450 } })
    pause(true)
    a.pause()
    expect(a.get(card.id)).toMatchObject({ state: 'waiting', can: { approve: true, deny: true }, lapsed: LAPSE_TEXT.paused })
    expect(new Set(a.items(card.id, 0).items.map(i => i.state))).toEqual(new Set(['pending']))
  })
})

describe('asking first and Always allow (the demo catch-up, PR 1)', () => {
  test("the ask cards offer Allow once, Always allow and No; the nudged one says so; a teammate's offers nothing", () => {
    const { a } = world()
    const ask = { allowOnce: true, alwaysAllow: true, approve: false, deny: true, undo: false, resolve: false, withdraw: false }
    expect(byTitle(a, WHOLESALE)).toMatchObject({ kind: 'ask', can: ask, nudgeAlways: false, chatId: 'order-tags', askedBy: 'm_sam', lines: ['Tag: Wholesale'] })
    expect(byTitle(a, POST)).toMatchObject({ kind: 'ask', can: ask, nudgeAlways: true, chatId: 'order-tags', reversible: false, tool: { label: 'Slack' } })
    const priya = byTitle(a, PRIYA)
    expect(priya).toMatchObject({ askedBy: 'm_priya', chatId: null })
    expect(Object.values(priya.can).some(Boolean)).toBe(false)
    expect(refused(() => a.answer(priya.id, priya.rev, 'once')).code).toBe('forbidden')
    // An exact card takes no Allow once or Always allow.
    const refund = byTitle(a, 'Refund $238.00 (USD) on order 4838')
    expect(refused(() => a.answer(refund.id, refund.rev, 'always')).code).toBe('forbidden')
  })

  test('Allow once holds 10 seconds then goes out, and makes no permission', () => {
    const { a, tick } = world()
    const before = a.permissions()
    const card = byTitle(a, WHOLESALE)
    const once = a.answer(card.id, card.rev, 'once')
    expect(once).toMatchObject({ state: 'approved', can: { undo: true } })
    expect(once.permissionId).toBeUndefined()
    expect(once.sendAt!.ms - once.serverNow.ms).toBe(10_000)
    tick(10_000)
    expect(a.get(card.id)).toMatchObject({ state: 'sent', result: SENT_TEXT })
    expect(a.permissions()).toEqual(before)
  })

  test("Always allow grants the operation's permission once, with the server's words and limits, and the card names it", () => {
    const { a, now } = world()
    const card = byTitle(a, WHOLESALE)
    const always = a.answer(card.id, card.rev, 'always')
    const made = a.permissions()[0]!
    PermissionSchema.parse(made)
    expect(always.permissionId).toBe(made.id)
    expect(made).toMatchObject({
      operation: 'shopify.order.tag_add', title: 'Add tags to orders', scope: 'northline-outdoor', holder: { kind: 'member', memberId: 'm_sam' },
      tool: { label: 'Shopify' }, limits: { perDay: 50, unitsMax: 5, unitsLabel: 'orders', effectivePerDay: 50 }, can: { remove: true },
    })
    expect(made.grantedAt.ms).toBe(now())
    // Undo takes back the action; the permission stays (ask-card.ts ALWAYS_STAYS).
    a.undo(card.id, always.rev)
    expect(a.permissions().map(p => p.id)).toContain(made.id)
    // The nudged Slack post makes the Slack one; a second Always allow for an operation already granted makes no other.
    const post = byTitle(a, POST)
    a.answer(post.id, post.rev, 'always')
    expect(a.permissions().filter(p => p.holder.kind === 'member' && p.holder.memberId === 'm_sam').map(p => p.title).sort()).toEqual(['Add stock', 'Add tags to orders', 'Post messages to a channel'])
    a.reset()
    expect(a.permissions().map(p => p.id)).toEqual(['pg_demoDanaOpsAlerts00000', 'pg_demoAddStock0000000000'])
  })

  test("the seeded permissions: Sam's Add stock and Dana's posts to #ops-alerts, each removable; Remove checks the rev", () => {
    const { a, hide } = world()
    const list = a.permissions()
    for (const p of list) PermissionSchema.parse(p)
    expect(list.map(p => [p.title, p.scope, p.holder.kind === 'member' ? p.holder.memberId : null, p.limits.effectivePerDay, p.limits.unitsMax, p.limits.unitsLabel])).toEqual([
      ['Post messages to a channel', '#ops-alerts', 'm_dana', 50, 1, 'posts'],
      ['Add stock', 'northline-outdoor', 'm_sam', 200, 50, 'stock units'],
    ])
    const stock = list[1]!
    expect(refused(() => a.removePermission(stock.id, stock.rev + 1))).toMatchObject({ code: 'conflict', current: { id: stock.id, rev: stock.rev } })
    expect(a.removePermission(stock.id, stock.rev).map(p => p.id)).toEqual([list[0]!.id])
    expect(refused(() => a.removePermission(stock.id, stock.rev)).code).toBe('not_found')
    hide(true)
    expect(a.permissions()).toEqual([])
  })

  test('a brand with no Slack has no Slack card or permission, and answers for neither', () => {
    const { a, noSlack } = world()
    const post = byTitle(a, POST)
    noSlack()
    expect(a.list().some(c => c.tool.label === 'Slack')).toBe(false)
    expect(a.permissions().map(p => p.title)).toEqual(['Add stock'])
    expect(refused(() => a.answer(post.id, post.rev, 'once')).code).toBe('not_found')
    expect(refused(() => a.removePermission('pg_demoDanaOpsAlerts00000', 1)).code).toBe('not_found')
  })

  test('the card that went out yesterday names the permission it ran under', () => {
    const { a } = world()
    expect(byTitle(a, SENT)).toMatchObject({ state: 'sent', result: SENT_TEXT, permissionId: 'pg_demoAddStock0000000000', can: { undo: false } })
  })

  test("Needs a check: the server's words, then It went out or It didn't go out, at the rev it was read at", () => {
    const { a } = world()
    const card = byTitle(a, GIFT)
    expect(card).toMatchObject({ state: 'needs_check', result: NEEDS_CHECK_TEXT, can: { resolve: true } })
    expect(refused(() => a.resolve(card.id, card.rev + 1, 'sent')).code).toBe('conflict')
    expect(a.resolve(card.id, card.rev, 'failed')).toMatchObject({ state: 'failed', result: FAILED_TEXT, can: { resolve: false } })
    a.reset()
    const again = byTitle(a, GIFT)
    expect(a.resolve(again.id, again.rev, 'sent')).toMatchObject({ state: 'sent', result: SENT_TEXT })
    expect(refused(() => a.resolve(byTitle(a, WHOLESALE).id, 1, 'sent')).code).toBe('conflict')
  })

  test('Pause in the hold sends the card back to waiting, with its buttons, the lapse words, an update and a notice', () => {
    const { a, tick, pause, changed, sentBack, now } = world()
    // One card goes out before the Pause: it stays sent.
    const post = byTitle(a, POST)
    a.answer(post.id, post.rev, 'once')
    tick(10_000)
    const card = byTitle(a, WHOLESALE)
    const always = a.answer(card.id, card.rev, 'always')
    tick(4_000)
    pause(true)
    a.pause()
    const back = a.get(card.id)
    expect(back).toMatchObject({
      state: 'waiting', rev: always.rev + 1, lapsed: LAPSE_TEXT.paused,
      can: { allowOnce: true, alwaysAllow: true, deny: true, undo: false },
    })
    expect(back.sendAt).toBeUndefined()
    expect(back.permissionId).toBeUndefined()
    ActionCardSchema.parse(back)
    expect(a.get(post.id).state).toBe('sent')
    expect(changed).toEqual([{ actionId: card.id, rev: back.rev }])
    expect(sentBack).toEqual([{ actionId: card.id, rev: back.rev, atMs: now() }])
    // It never goes out by itself, and no approval is taken while paused; No still is.
    tick(60_000)
    expect(a.get(card.id).state).toBe('waiting')
    expect(refused(() => a.answer(card.id, back.rev, 'once'))).toMatchObject({ code: 'conflict', reason: 'paused' })
    expect(refused(() => a.answer(card.id, back.rev, 'always'))).toMatchObject({ code: 'conflict', reason: 'paused' })
    // Resumed, it can be allowed again: the answer moves past the lapse words.
    pause(false)
    const again = a.answer(card.id, back.rev, 'once')
    expect(again.state).toBe('approved')
    expect(again.lapsed).toBeUndefined()
    // A second Pause with nothing in its hold changes nothing.
    tick(10_000)
    pause(true)
    a.pause()
    expect(changed).toHaveLength(1)
    expect(a.get(card.id).state).toBe('sent')
  })
})
