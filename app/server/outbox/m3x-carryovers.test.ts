// M3-B's carry-overs that M3-X closes, on real D1. Ways it can fail, written down first:
//  #487: a multi-order call the hub says went out in part keeps only "unclear": the person checking can't see which
//        orders went out, were refused or are unclear (a single action's card and notice, a batch item's line); or text
//        that isn't the hub's groups of order numbers reaches a card;
//  #509: a batch stopped part way counts, in its notice, items its approval never covered;
//  #484 (Fable, low): a row both over a lowered limit and never able to pass again waits until it expires instead of
//        being withdrawn;
//  #527: a person withdraws a collecting batch whole through route 126 (its revision doesn't move when an item joins, so
//        an old `ifRev` takes back items the person never saw).
import { env } from 'cloudflare:workers'
import { withdrawAction } from '../api/actions.ts'
import { openStores } from '../db/stores.ts'
import { personPrincipal, ctx as handlerCtx } from '../db/test-support.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import type { WriteGateway, WriteResult } from '../../hub/index/contract.ts'
import { account, ceiling } from '../permissions/test-support.ts'
import { itemsPage } from './batch/rows.ts'
import { itemHub, pass, wideArgs } from './batch/test-support.ts'
import { cardOf } from './card.ts'
import { sendAction } from './dispatch.ts'
import { outcomeOf } from './hub-call.ts'
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

// #487 (review round 1): the hub's real answer, as hub/outbox-entry/shopify-ops.test.ts pins it (the code's fixed text,
// then the groups). hub/outbox-entry/partial-send.test.ts drives `partialOf` through the hub's own `readTags`.
const PARTIAL: WriteResult = { ok: false, error: { code: 'upstream_rejected', message: 'upstream rejected the request: sent 9001,9002; refused 424242' }, sent: 'unknown' }
const answering = (r: WriteResult): WriteGateway => ({ runAction: async () => r })

describe('#487: the groups of a partly-sent call', () => {
  it('the hub\'s real answer names its groups; anything else unclear stays as it was', () => {
    expect(outcomeOf({ value: PARTIAL })).toEqual({ kind: 'needs_check', why: 'unknown', partial: { sent: ['9001', '9002'], refused: ['424242'], unclear: [] } })
    // The groups without the hub's fixed text before them are never read.
    expect(outcomeOf({ value: { ...PARTIAL, error: { code: 'upstream_rejected', message: 'sent 9001,9002; refused 424242' } } })).toEqual({ kind: 'needs_check', why: 'unknown' })
    expect(outcomeOf({ value: { ok: false, error: { code: 'upstream_unavailable', message: 'upstream unavailable: timeout' }, sent: 'unknown' } })).toEqual({ kind: 'needs_check', why: 'unknown' })
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

describe('#527: route 126 takes back only the asker\'s own single card', () => {
  const stores = openStores(env)
  const withEnv = <C extends object>(c: C) => ({ ...c, env: { BRAND_AGENT: { getByName: () => ({ poke: async () => {}, actionChanged: async () => {} }) } } as never })
  const post = (id: string, ifRev: number) =>
    withdrawAction(withEnv(handlerCtx(stores, personPrincipal(ASKER, 'member'), { method: 'POST', path: `/api/actions/${id}/withdraw`, params: { id }, body: { ifRev }, nowMs: now }).c))

  it('a collecting batch, at the revision it had before more items joined: refused, nothing changes', async () => {
    for (let k = 1; k <= 5; k++) expect((await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: tagArgs(k) }, { mode: 'tool' })).outcome).toBe('waiting')
    const first = await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: tagArgs(100) }, { mode: 'tool' })
    if (first.outcome !== 'collected') throw new Error('expected a collected call')
    const seen = first.action
    for (let k = 1; k <= 3; k++) expect((await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: tagArgs(100 + k) }, { mode: 'tool' })).outcome).toBe('collected')
    const r = await post(seen.id, seen.rev)
    expect(r.status).toBe(403)
    expect(await outbox(db, clock).withdraw({ kind: 'member', actor: ME }, seen.id, { ifRev: seen.rev })).toEqual({ refused: { code: 'forbidden', reason: 'not_owner' } })
    expect(await rowOf(db, seen.id)).toMatchObject({ state: 'waiting', items_n: 4 })
    // A single card of its own is still the asker's to take back.
    const single = await db.prepare("SELECT id, rev FROM outbox_actions WHERE kind = 'single' AND state = 'waiting' LIMIT 1").first<{ id: string; rev: number }>()
    expect((await post(single!.id, single!.rev)).status).toBe(200)
  })

  it('the update itself refuses a batch, whatever the read before it said', async () => {
    for (let k = 1; k <= 5; k++) await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: tagArgs(k) }, { mode: 'tool' })
    const c = await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: tagArgs(200) }, { mode: 'tool' })
    if (c.outcome !== 'collected') throw new Error('expected a collected call')
    const pass = (o: object, k: string | symbol) => {
      const v = Reflect.get(o, k) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(o) : v
    }
    // A database whose first read of the row says it's a single card (as a stale read could): only the update decides.
    const lying = new Proxy(db, {
      get(target, key) {
        if (key !== 'prepare') return pass(target, key)
        return (sql: string) => {
          const st = target.prepare(sql)
          if (sql !== 'SELECT * FROM outbox_actions WHERE id = ?') return st
          return new Proxy(st, {
            get(t, k) {
              if (k !== 'bind') return pass(t, k)
              return (...v: unknown[]) => {
                const bound = t.bind(...v)
                return new Proxy(bound, {
                  get(b, kk) {
                    if (kk !== 'first') return pass(b, kk)
                    return async () => {
                      const row = await b.first<OutboxActionRow>()
                      return row && row.id === c.action.id && row.state === 'waiting' ? { ...row, kind: 'single' } : row
                    }
                  },
                })
              }
            },
          })
        }
      },
    }) as D1Database
    const r = await outbox(lying, clock).withdraw({ kind: 'member', actor: ME }, c.action.id, { ifRev: c.action.rev })
    expect(r).toEqual({ refused: { code: 'conflict' } })
    expect(await rowOf(db, c.action.id)).toMatchObject({ state: 'waiting', kind: 'batch' })
  })
})
