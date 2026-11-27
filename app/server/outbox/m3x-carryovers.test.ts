// M3-B's carry-overs that M3-X closes, on real D1. Ways it can fail, written down first:
//  #487: a multi-order call the hub says went out in part keeps only "unclear": the person checking can't see which
//        orders went out, were refused or are unclear (a single action's card and notice, a batch item's line); or text
//        that isn't the hub's groups of order numbers reaches a card;
//  #509: a batch stopped part way counts, in its notice, items its approval never covered;
//  #484 (Fable, low): a row both over a lowered limit and never able to pass again waits until it expires instead of
//        being withdrawn.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { WriteGateway, WriteResult } from '../../hub/index/contract.ts'
import { account, ceiling } from '../permissions/test-support.ts'
import { itemsPage } from './batch/rows.ts'
import { itemHub, pass, wideArgs } from './batch/test-support.ts'
import { cardOf } from './card.ts'
import { sendAction } from './dispatch.ts'
import { outcomeOf, partialOf } from './hub-call.ts'
import { ASKER, SHOP_GEN, fresh, notices, outbox, requestCtx, rowOf, tagArgs, world } from './test-support.ts'
import type { OutboxActionRow, OutboxRequestResult } from './types.ts'
import { needsCheckText } from './words.ts'

const db = env.DB
const T0 = 1_800_000_000_000
let now = T0
const clock = () => now
const HOLD = 10_000
const ME = { memberId: ASKER, role: 'member' as const }

beforeEach(async () => {
  now = T0
  await world(db)
  // Calls of up to 5 orders (N24's ceiling largest call is 100; M2's default is 1).
  await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 1, unitsMax: 5 })
})

const PARTIAL: WriteResult = { ok: false, error: { code: 'upstream_rejected', message: 'sent 9001,9002; refused 424242' }, sent: 'unknown' }
const answering = (r: WriteResult): WriteGateway => ({ runAction: async () => r })

describe('#487: the groups of a partly-sent call', () => {
  it('reads only the hub\'s groups of order numbers', () => {
    expect(partialOf('sent 9001,9002; refused 424242')).toEqual({ sent: ['9001', '9002'], refused: ['424242'], unclear: [] })
    expect(partialOf('refused 1; unclear 2,3')).toEqual({ sent: [], refused: ['1'], unclear: ['2', '3'] })
    for (const bad of [undefined, '', 'unclear', 'sent order', 'sent 1; sent 2', 'sent 1;refused 2', 'sent 1, 2', 'went 1', 'sent 1; <b>x</b>', 'sent 1\nrefused 2']) {
      expect(partialOf(bad), String(bad)).toBeNull()
    }
    expect(outcomeOf({ value: PARTIAL })).toEqual({ kind: 'needs_check', why: 'unknown', partial: { sent: ['9001', '9002'], refused: ['424242'], unclear: [] } })
    // Anything else unclear stays as it was.
    expect(outcomeOf({ value: { ok: false, error: { code: 'upstream_unavailable', message: 'timeout' }, sent: 'unknown' } })).toEqual({ kind: 'needs_check', why: 'unknown' })
    expect(needsCheckText(null)).toBe(needsCheckText(JSON.stringify({})))
  })

  it('a 3-order call with one refused order: the card and the notice name which went out', async () => {
    const r = await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: wideArgs([9001, 9002, 424242]) }, { mode: 'tool' })
    if (r.outcome !== 'waiting') throw new Error(`expected a card, got ${r.outcome}`)
    const a = await outbox(db, clock).answer(ME, r.action.id, { choice: 'once', ifRev: r.action.rev })
    if (!('action' in a)) throw new Error('answer refused')
    now += HOLD
    const note = notices()
    await sendAction(a.action.id, { db, nowMs: now, hub: answering(PARTIAL), notify: note.notify, requestId: fresh('s'), again: () => {}, gate: { paused: false, pauseGen: 0 }, timeoutMs: 1_000 })
    const row = (await rowOf(db, a.action.id))!
    expect(row).toMatchObject({ state: 'needs_check' })
    const words = 'Part of this went out. Orders 9001, 9002 went out. Order 424242 was refused. Check in the tool, then say whether it went out.'
    expect(cardOf(row, ME, now).result).toBe(words)
    expect(note.list).toEqual([expect.objectContaining({ kind: 'needs_check', body: words })])
  })

  it('a collected item that went out in part says so in the full list', async () => {
    for (let k = 1; k <= 5; k++) expect((await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: tagArgs(k) }, { mode: 'tool' })).outcome).toBe('waiting')
    const c = await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: wideArgs([9001, 9002, 424242]) }, { mode: 'tool' })
    if (c.outcome !== 'collected') throw new Error(`expected a collected call, got ${c.outcome}`)
    const b = c.action
    const a = await outbox(db, clock).answer(ME, b.id, { choice: 'approve', ifRev: b.rev, upTo: 1, totals: { records: 3, units: 3 } })
    if (!('action' in a)) throw new Error(`answer refused: ${JSON.stringify(a)}`)
    now += HOLD
    await pass(db, b.id, { nowMs: now, hub: answering(PARTIAL) })
    const page = await itemsPage(db, (await rowOf(db, b.id))!, 0)
    expect(page.items).toEqual([expect.objectContaining({ n: 1, state: 'needs_check', result: 'Part of this went out. Orders 9001, 9002 went out. Order 424242 was refused. Check in the tool, then say whether it went out.' })])
  })
})

describe('#509: a stopped batch\'s notice counts what its approval covered', () => {
  it('6 collected, approved up to 3, stopped after 1 went out: "1 of 3"', async () => {
    for (let k = 1; k <= 5; k++) expect((await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: tagArgs(k) }, { mode: 'tool' })).outcome).toBe('waiting')
    let last: OutboxRequestResult | null = null
    for (let k = 0; k < 6; k++) last = await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: tagArgs(100 + k) }, { mode: 'tool' })
    if (!last || last.outcome !== 'collected') throw new Error('expected a collected call')
    const b: OutboxActionRow = last.action
    const a = await outbox(db, clock).answer(ME, b.id, { choice: 'approve', ifRev: b.rev, upTo: 3, totals: { records: 3, units: 3 } })
    if (!('action' in a)) throw new Error('answer refused')
    now += HOLD
    const hub = itemHub(db, () => 'ok')
    let calls = 0
    const gateway: WriteGateway = {
      async runAction(req) {
        const r = await hub.gateway.runAction(req)
        if (++calls === 1) await ceiling(db, 'shopify.order.tag_add', { enabled: false, perDayMax: 50, loweredRev: 2 })
        return r
      },
    }
    const r = await pass(db, b.id, { nowMs: now, hub: gateway })
    expect(hub.calls).toHaveLength(1)
    expect(r.notices).toEqual([expect.objectContaining({ kind: 'approval_lapsed', body: expect.stringMatching(/^1 of 3 went out before this stopped\. The other 2 need a new OK/) })])
  })
})

describe('#484: withdraw-class reasons come before a lowered limit', () => {
  it('a row over a lowered ceiling whose account also changed is withdrawn, not sent back to wait', async () => {
    const r = await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: tagArgs(1) }, { mode: 'tool' })
    if (r.outcome !== 'waiting') throw new Error('expected a card')
    const a = await outbox(db, clock).answer(ME, r.action.id, { choice: 'once', ifRev: r.action.rev })
    if (!('action' in a)) throw new Error('answer refused')
    await ceiling(db, 'shopify.order.tag_add', { enabled: false, perDayMax: 50, loweredRev: 2 })
    await account(db, 'shopify:store', SHOP_GEN + 1)
    now += HOLD
    const hub = itemHub(db, () => 'ok')
    await sendAction(a.action.id, { db, nowMs: now, hub: hub.gateway, notify: notices().notify, requestId: fresh('s'), again: () => {}, gate: { paused: false, pauseGen: 0 }, timeoutMs: 1_000 })
    expect(hub.calls).toEqual([])
    expect(await rowOf(db, a.action.id)).toMatchObject({ state: 'withdrawn', lapsed_reason: 'account_changed' })
  })

  it('a row over a lowered largest call (and nothing else) still goes back to wait', async () => {
    const r = await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: wideArgs([1, 2]) }, { mode: 'tool' })
    if (r.outcome !== 'waiting') throw new Error('expected a card')
    await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 1, unitsMax: 2 })
    const a = await outbox(db, clock).answer(ME, r.action.id, { choice: 'once', ifRev: r.action.rev })
    if (!('action' in a)) throw new Error(`answer refused ${JSON.stringify(a)}`)
    await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 2, unitsMax: 1 })
    now += HOLD
    await sendAction(a.action.id, { db, nowMs: now, hub: itemHub(db, () => 'ok').gateway, notify: notices().notify, requestId: fresh('s'), again: () => {}, gate: { paused: false, pauseGen: 0 }, timeoutMs: 1_000 })
    expect(await rowOf(db, a.action.id)).toMatchObject({ state: 'waiting', lapsed_reason: 'over_limit' })
  })
})
