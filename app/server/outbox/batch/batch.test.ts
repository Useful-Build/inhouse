// Batches' unit cases on real D1 (Stage 1 M3-B, N22). Ways it can fail, written down first:
//  1. collecting: the 6th waiting card of a kind doesn't collect (or a money or destructive one isn't refused
//     `too_many_waiting`); a 2nd collecting batch opens for the same chat and key; a full batch takes more; a replay or a
//     repeated payload makes a second item; an item lands at a position an approval covers;
//  2. an answer approves items it didn't show (a growing card), or totals that don't match; items after `upTo` are lost,
//     sent, or stay on the answered card; a No withdraws items it didn't cover;
//  3. sending: an item is sent twice, past the approval, after a refused claim or with no live use; a pass runs past 20
//     items; a throttled item counts as sent or is tried more than 5 times; a revoke, a lowered ceiling, a deleted chat
//     or a Pause mid-batch doesn't stop later items, or their pending items aren't moved (or withdrawn) with their units
//     back once; an item that went out is ever given back;
//  4. the end: a batch with an unclear item doesn't wait for a person; resolving items doesn't end it; the sweep treats a
//     batch row as a stale single, misses a stale item or a lost batch; a restore leaves a pending item claimable;
//  5. #493: an "Always allow" on a card over a bulk threshold lowered since loops back to waiting.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { AuditArgsSchema } from '../../../shared/contract/audit.ts'
import { POLICY_REV } from '../../permissions/policy.ts'
import { ceiling, insertGrant } from '../../permissions/test-support.ts'
import { cardsOf } from '../card.ts'
import { outboxStore } from '../store.ts'
import { restoreHoldStmts } from '../restore-hold.ts'
import { sweepOutbox } from '../sweep.ts'
import { ASKER, SHOP_GEN, fresh, notices, outbox, requestCtx, rowOf, tagArgs, world } from '../test-support.ts'
import type { OutboxActionRow, OutboxRequestResult } from '../types.ts'
import { OPERATIONS } from '../operations/index.ts'
import type { OperationEntry } from '../operations/types.ts'
import { insertItemsStmt } from './rows.ts'
import { stopBatch } from './send.ts'
import { afterNthCall, itemHub, itemsOf, pass, wideArgs } from './test-support.ts'
import type { ItemMode } from './test-support.ts'

const db = env.DB
const T0 = 1_800_000_000_000
let now = T0
const clock = () => now
const ME = { memberId: ASKER, role: 'member' as const }
const HOLD = 10_000

beforeEach(async () => {
  now = T0
  await world(db)
  await db.prepare("UPDATE chats SET deleted_at_ms = NULL WHERE id = 'c_ob_chat'").run()
})

const ask = (order: number, o: Partial<Parameters<typeof requestCtx>[0]> = {}) =>
  outbox(db, clock).request(requestCtx({ nowMs: now, ...o }), { operation: 'shopify.order.tag_add', args: tagArgs(order) }, { mode: 'tool' })

/** Five waiting single cards, then `n` more calls that collect. Returns the batch. */
async function collecting(n: number, from = 100): Promise<OutboxActionRow> {
  for (let k = 1; k <= 5; k++) expect((await ask(k)).outcome).toBe('waiting')
  let last: OutboxRequestResult | null = null
  for (let k = 0; k < n; k++) last = await ask(from + k)
  if (!last || last.outcome !== 'collected') throw new Error(`expected a collected call, got ${last?.outcome}`)
  return last.action
}

const totals = async (id: string, upTo: number) => {
  const r = await db.prepare('SELECT COALESCE(SUM(records), 0) AS records, COALESCE(SUM(units), 0) AS units FROM outbox_items WHERE action_id = ? AND n <= ?').bind(id, upTo).first<{ records: number; units: number }>()
  return { records: r!.records, units: r!.units }
}

const approve = async (b: OutboxActionRow, upTo = b.items_n) => {
  const r = await outbox(db, clock).answer(ME, b.id, { choice: 'approve', ifRev: b.rev, upTo, totals: await totals(b.id, upTo) })
  if (!('action' in r)) throw new Error(`answer refused: ${r.refused.code} ${r.refused.reason ?? ''}`)
  return r.action
}

const grant = async (o: { perDay?: number; unitsMax?: number } = {}) => {
  const id = `pg_${fresh('g').replace(/[^A-Za-z0-9]/g, '').padEnd(22, 'A').slice(0, 22)}`
  await insertGrant(db, {
    id, holder: `member:${ASKER}`, accountId: 'shopify:store', accountGen: SHOP_GEN, operation: 'shopify.order.tag_add', scopeKey: 'shop=store-a',
    perDay: o.perDay ?? 50, unitsMax: o.unitsMax ?? 5, policyRev: POLICY_REV, grantedRole: 'member', ceilingRev: 1, revokedAtMs: null,
  })
  return id
}

const releases = async (actionId: string) =>
  (await db.prepare('SELECT n, units, reason FROM permission_item_releases WHERE action_id = ? ORDER BY n').bind(actionId).all<{ n: number; units: number; reason: string }>()).results

describe('collecting (failure 1)', () => {
  it('the 6th waiting card of a kind collects; the five singles stay; later calls join the same batch', async () => {
    const b = await collecting(3)
    expect(b).toMatchObject({ kind: 'batch', state: 'waiting', verdict: 'exact', guardrail: 'bulk', items_n: 3, records: 3, units: 3, tool_use_id: null })
    expect(b.coalesce_key).toBe(`shopify.order.tag_add|shopify:store|${SHOP_GEN}|shop=store-a`)
    const singles = await db.prepare("SELECT COUNT(*) AS n FROM outbox_actions WHERE kind = 'single' AND state = 'waiting'").first<{ n: number }>()
    expect(singles?.n).toBe(5)
    expect((await itemsOf(db, b.id)).map(i => [i.n, i.state, i.line])).toEqual([
      [1, 'pending', 'Order 100 (store-a): add vip'], [2, 'pending', 'Order 101 (store-a): add vip'], [3, 'pending', 'Order 102 (store-a): add vip'],
    ])
    // Another chat has room for its own singles.
    expect((await ask(1, { chatId: 'c_ob_other' })).outcome).toBe('waiting')
  })

  it('an operation that never collects is refused `too_many_waiting` at its 6th waiting card', async () => {
    const table = OPERATIONS as unknown as Record<string, OperationEntry>
    const was = table['shopify.order.tag_add']!
    table['shopify.order.tag_add'] = { ...was, coalesces: false } as OperationEntry
    try {
      for (let k = 1; k <= 5; k++) expect((await ask(k)).outcome).toBe('waiting')
      expect(await ask(6)).toMatchObject({ outcome: 'refused', reason: 'too_many_waiting' })
      expect((await db.prepare("SELECT COUNT(*) AS n FROM outbox_actions WHERE kind = 'batch'").first<{ n: number }>())?.n).toBe(0)
    } finally {
      table['shopify.order.tag_add'] = was
    }
  })

  it('a replay returns its own item wherever it sits; a repeated payload returns the pending item; other arguments conflict', async () => {
    const b = await collecting(1)
    const tu = fresh('tu')
    const first = await ask(200, { invocation: { runId: 'r', turnId: 't', toolUseId: tu } })
    expect(first).toMatchObject({ outcome: 'collected', existing: false, item: { n: 2 } })
    expect(await ask(200, { invocation: { runId: 'r', turnId: 't', toolUseId: tu } })).toMatchObject({ outcome: 'collected', existing: true, item: { n: 2 } })
    expect(await ask(200)).toMatchObject({ outcome: 'collected', existing: true, item: { n: 2 } })
    expect(await ask(201, { invocation: { runId: 'r', turnId: 't', toolUseId: tu } })).toMatchObject({ outcome: 'refused', reason: 'invocation_conflict' })
    // After a split the item sits on the new card; the replay finds it there.
    await approve(await rowOf(db, b.id) as OutboxActionRow, 1)
    const again = await ask(200, { invocation: { runId: 'r', turnId: 't', toolUseId: tu } })
    expect(again).toMatchObject({ outcome: 'collected', existing: true, item: { n: 1 } })
    if (again.outcome === 'collected') expect(again.action.id).not.toBe(b.id)
    expect((await itemsOf(db, b.id)).length).toBe(1)
  })

  it('a full batch stops collecting; the next call is refused `batch_full` until it is answered', async () => {
    await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 1, batchMax: 2 })
    const b = await collecting(2)
    expect(b.coalesce_key).toBeNull()
    expect(await ask(300)).toMatchObject({ outcome: 'refused', reason: 'batch_full' })
    await approve(b)
    expect(await ask(300)).toMatchObject({ outcome: 'collected', existing: false, item: { n: 1 } })
  })

  it('parallel appends: one collecting batch, its positions 1 to the tip with no gap, every call either in it once or told busy', async () => {
    for (let k = 1; k <= 5; k++) await ask(k)
    const results = await Promise.all(Array.from({ length: 12 }, (_, k) => ask(400 + k)))
    const batches = await db.prepare("SELECT id, items_n FROM outbox_actions WHERE kind = 'batch'").all<{ id: string; items_n: number }>()
    expect(batches.results).toHaveLength(1)
    const items = await itemsOf(db, batches.results[0]!.id)
    expect(items.map(i => i.n)).toEqual(items.map((_, k) => k + 1))
    expect(batches.results[0]!.items_n).toBe(items.length)
    for (const r of results) expect(['collected', 'refused']).toContain(r.outcome)
    expect(results.filter(r => r.outcome === 'collected')).toHaveLength(items.length)
    for (const r of results) if (r.outcome === 'refused') expect(r.reason).toBe('busy')
  })

  it('an item never enters at a position an approval covers, and its arguments never change', async () => {
    const b = await approve(await collecting(2))
    await expect(db.prepare("UPDATE outbox_items SET args_json = '{}' WHERE action_id = ?").bind(b.id).run()).rejects.toThrow(/fixed/)
    await expect(db.prepare("UPDATE outbox_items SET n = n + 10 WHERE action_id = ?").bind(b.id).run()).rejects.toThrow()
    // A position the approval covers, emptied (here by hand): the items' insert puts nothing there, and no item moves in.
    const [first] = await itemsOf(db, b.id)
    await db.prepare('DELETE FROM outbox_items WHERE item_id = ?').bind(first!.item_id).run()
    const other = await collecting(1, 700)
    const stray = { itemId: 'oi_stray', n: 1, toolUseId: null, args: tagArgs(9), payloadHash: 'h', line: 'l', records: 1, units: 1 }
    await db.batch([insertItemsStmt(b.id, 'c_ob_chat', [stray], now, { sql: 'SELECT 1', params: [] })].map(s => db.prepare(s.sql).bind(...s.params)))
    expect((await itemsOf(db, b.id)).map(i => i.n)).toEqual([2])
    const theirs = (await itemsOf(db, other.id))[0]!
    await expect(db.prepare('UPDATE outbox_items SET action_id = ?, n = 1, moved_from = ? WHERE item_id = ?').bind(b.id, other.id, theirs.item_id).run()).rejects.toThrow(/approval covers/)
  })
})

describe('answers (failure 2)', () => {
  it('approve what you saw: items after `upTo` move to a new collecting card, ids and calls kept', async () => {
    const b = await collecting(4)
    const before = await itemsOf(db, b.id)
    const a = await approve(b, 2)
    expect(a).toMatchObject({ state: 'approved', approved_upto: 2, items_n: 2, records: 2, units: 2, coalesce_key: null })
    expect((await itemsOf(db, b.id)).map(i => i.item_id)).toEqual(before.slice(0, 2).map(i => i.item_id))
    const rest = await db.prepare("SELECT * FROM outbox_actions WHERE kind = 'batch' AND id <> ?").bind(b.id).first<OutboxActionRow>()
    expect(rest).toMatchObject({ state: 'waiting', items_n: 2, records: 2, units: 2, coalesce_key: b.coalesce_key, tool_use_id: null })
    const moved = await itemsOf(db, rest!.id)
    expect(moved.map(i => [i.n, i.item_id, i.tool_use_id, i.moved_from])).toEqual(before.slice(2).map((i, k) => [k + 1, i.item_id, i.tool_use_id, b.id]))
    // The answer's line names what it covered; the new card has its own request line.
    const lines = await db.prepare("SELECT action, target_id, args_json FROM audit_log WHERE target_id IN (?, ?) AND action IN ('action.answered', 'action.requested') ORDER BY id DESC LIMIT 2").bind(b.id, rest!.id).all<{ action: string; target_id: string; args_json: string }>()
    for (const l of lines.results) expect(AuditArgsSchema.safeParse({ action: l.action, ...JSON.parse(l.args_json) }).success).toBe(true)
    expect(lines.results.map(l => [l.action, l.target_id])).toEqual(expect.arrayContaining([['action.answered', b.id], ['action.requested', rest!.id]]))
  })

  it('totals that no longer match the stored items are refused, and nothing changes', async () => {
    const b = await collecting(3)
    expect(await outbox(db, clock).answer(ME, b.id, { choice: 'approve', ifRev: b.rev, upTo: 3, totals: { records: 2, units: 3 } }))
      .toEqual({ refused: { code: 'conflict', reason: 'totals_changed' } })
    expect(await outbox(db, clock).answer(ME, b.id, { choice: 'approve', ifRev: b.rev, upTo: 4, totals: { records: 4, units: 4 } }))
      .toEqual({ refused: { code: 'conflict', reason: 'totals_changed' } })
    expect(await rowOf(db, b.id)).toMatchObject({ state: 'waiting', items_n: 3 })
    expect(await outbox(db, clock).answer(ME, b.id, { choice: 'approve', ifRev: b.rev })).toEqual({ refused: { code: 'invalid' } })
    const single = await db.prepare("SELECT * FROM outbox_actions WHERE kind = 'single' LIMIT 1").first<OutboxActionRow>()
    expect(await outbox(db, clock).answer(ME, single!.id, { choice: 'once', ifRev: 1, upTo: 1, totals: { records: 1, units: 1 } })).toEqual({ refused: { code: 'invalid' } })
  })

  it('a No covers only what it saw: items 1 to `upTo` withdrawn with the batch, the rest on a new card', async () => {
    const b = await collecting(3)
    const r = await outbox(db, clock).answer(ME, b.id, { choice: 'deny', ifRev: b.rev, upTo: 1, totals: await totals(b.id, 1) })
    expect(r).toMatchObject({ action: { state: 'denied', items_n: 1 } })
    expect((await itemsOf(db, b.id)).map(i => i.state)).toEqual(['withdrawn'])
    const rest = await db.prepare("SELECT * FROM outbox_actions WHERE kind = 'batch' AND id <> ?").bind(b.id).first<OutboxActionRow>()
    expect(rest).toMatchObject({ state: 'waiting', items_n: 2 })
    expect((await itemsOf(db, rest!.id)).map(i => i.state)).toEqual(['pending', 'pending'])
  })

  it('an item past a ceiling lowered since is refused at the answer (`over_limit`)', async () => {
    {
      await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 1, unitsMax: 100 })
      for (let k = 1; k <= 5; k++) {
        expect((await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: wideArgs([k]) }, { mode: 'tool' })).outcome).toBe('waiting')
      }
      const r = await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: wideArgs([7, 8]) }, { mode: 'tool' })
      if (r.outcome !== 'collected') throw new Error(`expected collected, got ${r.outcome}`)
      await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 2, unitsMax: 1 })
      expect(await outbox(db, clock).answer(ME, r.action.id, { choice: 'approve', ifRev: 1, upTo: 1, totals: { records: 2, units: 2 } }))
        .toEqual({ refused: { code: 'conflict', reason: 'over_limit' } })
    }
  })
})

describe('sending (failure 3)', () => {
  const sendAll = async (id: string, next: (n: number) => ItemMode = () => 'ok', o: Parameters<typeof pass>[2] extends infer P ? Partial<P> : never = {}) => {
    const hub = itemHub(db, req => next(req.item?.n ?? 0))
    let r = await pass(db, id, { nowMs: now, hub: hub.gateway, ...o })
    for (let k = 0; k < 40 && r.again.length > 0; k++) {
      now = Math.max(now, ...r.again)
      r = await pass(db, id, { nowMs: now, hub: hub.gateway, ...o })
    }
    for (const c of hub.calls) expect(c.violation).toBeNull()
    return { hub, last: r }
  }

  it('after the hold the batch is claimed once, then its items go out in order, 20 a pass, and it ends sent', async () => {
    const b = await approve(await collecting(25))
    now += HOLD
    const hub = itemHub(db, () => 'ok')
    const first = await pass(db, b.id, { nowMs: now, hub: hub.gateway })
    expect(hub.calls.map(c => c.req.item!.n)).toEqual(Array.from({ length: 20 }, (_, k) => k + 1))
    expect(first.again).toEqual([now + 1_000])
    expect(await rowOf(db, b.id)).toMatchObject({ state: 'sending', attempt: 1 })
    now += 1_000
    const second = await pass(db, b.id, { nowMs: now, hub: hub.gateway })
    expect(hub.calls).toHaveLength(25)
    for (const c of hub.calls) expect(c.violation).toBeNull()
    expect(second.outcome).toEqual({ kind: 'sent', ref: '25 of 25 went out' })
    expect(await rowOf(db, b.id)).toMatchObject({ state: 'sent', result_json: JSON.stringify({ ref: '25 of 25 went out' }) })
    const sent = await db.prepare("SELECT args_json FROM audit_log WHERE action = 'action.sent' AND target_id = ?").bind(b.id).first<{ args_json: string }>()
    expect(JSON.parse(sent!.args_json)).toEqual({ actionId: b.id, attempt: 1, items: { sent: 25, failed: 0 } })
    // A finished batch's items take its end (retention's age).
    expect((await itemsOf(db, b.id)).every(i => i.final_at_ms !== null && i.state === 'sent')).toBe(true)
  })

  it('a pass also stops after 10 s', async () => {
    const b = await approve(await collecting(3))
    now += HOLD
    let real = now
    const hub = itemHub(db, () => { real += 6_000; return 'ok' })
    const r = await pass(db, b.id, { nowMs: now, hub: hub.gateway, clock: () => real })
    expect(hub.calls).toHaveLength(2)
    expect(r.again).toEqual([real + 1_000])
  })

  it('a throttled item ran nothing: it waits and is tried again, and fails after its 5th throttle', async () => {
    const b = await approve(await collecting(2))
    now += HOLD
    const seen = new Map<number, number>()
    const { hub } = await sendAll(b.id, n => {
      seen.set(n, (seen.get(n) ?? 0) + 1)
      return n === 1 && seen.get(1)! <= 2 ? 'throttle' : n === 2 ? 'throttle' : 'ok'
    })
    const items = await itemsOf(db, b.id)
    expect(items.map(i => [i.state, i.throttles])).toEqual([['sent', 2], ['failed', 5]])
    expect(hub.calls.filter(c => c.req.item!.n === 2)).toHaveLength(5)
    expect(await rowOf(db, b.id)).toMatchObject({ state: 'sent', result_json: JSON.stringify({ ref: '1 of 2 went out' }) })
  })

  it('a ceiling lowered mid-batch stops it: later items move to a new card with the reason, nothing more goes out', async () => {
    const b = await approve(await collecting(5))
    now += HOLD
    const hub = itemHub(db, () => 'ok')
    let calls = 0
    const gateway = {
      async runAction(req: Parameters<typeof hub.gateway.runAction>[0]) {
        const r = await hub.gateway.runAction(req)
        if (++calls === 2) await ceiling(db, 'shopify.order.tag_add', { enabled: false, perDayMax: 50, loweredRev: 2 })
        return r
      },
    }
    const r = await pass(db, b.id, { nowMs: now, hub: gateway })
    expect(hub.calls).toHaveLength(2)
    // #501: counted against what was approved, the moved ones named; the card keeps only what stayed on it.
    expect(r.outcome).toEqual({ kind: 'sent', ref: '2 of 5 went out; the other 3 moved to a new card for a new OK' })
    expect(await rowOf(db, b.id)).toMatchObject({ items_n: 2, records: 2, units: 2, approved_upto: 5 })
    const [old] = await cardsOf(db, [(await rowOf(db, b.id))!], ME, now)
    expect(old).toMatchObject({ result: 'Sent. 2 of 5 went out; the other 3 moved to a new card for a new OK', batch: { itemCount: 2, totals: { records: 2, units: 2 } } })
    const rest = await db.prepare("SELECT * FROM outbox_actions WHERE kind = 'batch' AND id <> ?").bind(b.id).first<OutboxActionRow>()
    expect(rest).toMatchObject({ state: 'waiting', items_n: 3, lapsed_reason: 'over_ceiling', coalesce_key: null })
    expect((await itemsOf(db, rest!.id)).map(i => [i.n, i.moved_from])).toEqual([[1, b.id], [2, b.id], [3, b.id]])
    expect(r.notices).toEqual([expect.objectContaining({ kind: 'approval_lapsed', actionId: rest!.id, body: expect.stringMatching(/^2 of 5 went out before this stopped\. The other 3 need a new OK/) })])
  })

  it('a batch stopped before any item went out lapses in place: every item moved to a new card, nothing sent', async () => {
    const b = await approve(await collecting(3))
    now += HOLD
    const hub = itemHub(db, () => 'ok')
    // The ceiling goes off right after the batch's own claim, before its first item's.
    const r = await pass(afterNthCall(db, 2, async () => { await ceiling(db, 'shopify.order.tag_add', { enabled: false, perDayMax: 50, loweredRev: 2 }) }), b.id, { nowMs: now, hub: hub.gateway })
    expect(hub.calls).toHaveLength(0)
    expect(await rowOf(db, b.id)).toMatchObject({ state: 'withdrawn', lapsed_reason: 'over_ceiling', result_json: null, error_code: null, items_n: 0, records: 0, units: 0 })
    expect(await itemsOf(db, b.id)).toEqual([])
    // #501: its card says why, and where its changes went.
    const [old] = await cardsOf(db, [(await rowOf(db, b.id))!], ME, now)
    expect(old!.lapsed).toBe('Nothing here went out. Its changes moved to a new card. This kind of action was turned off, so this needs your OK again.')
    const rest = await db.prepare("SELECT * FROM outbox_actions WHERE kind = 'batch' AND id <> ?").bind(b.id).first<OutboxActionRow>()
    expect(rest).toMatchObject({ state: 'waiting', items_n: 3, lapsed_reason: 'over_ceiling' })
    const line = await db.prepare("SELECT args_json FROM audit_log WHERE action = 'action.lapsed' AND target_id = ?").bind(b.id).first<{ args_json: string }>()
    expect(JSON.parse(line!.args_json)).toEqual({ actionId: b.id, reason: 'over_ceiling', released: false })
    expect(r.notices).toEqual([expect.objectContaining({ actionId: rest!.id, body: expect.stringMatching(/^0 of 3 went out before this stopped/) })])
  })

  it('a deleted chat mid-batch withdraws what is left, with no notice', async () => {
    const b = await approve(await collecting(3))
    now += HOLD
    await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms, deleted_at_ms) VALUES ('c_ob_chat', ?, 't', 1, 1, 1) ON CONFLICT (id) DO UPDATE SET deleted_at_ms = 1").bind(ASKER).run()
    const r = await pass(db, b.id, { nowMs: now, hub: itemHub(db, () => 'ok').gateway })
    // The batch's claim itself finds the deletion first: withdrawn whole, its items with it.
    expect(await rowOf(db, b.id)).toMatchObject({ state: 'withdrawn', lapsed_reason: 'chat_deleted' })
    expect((await itemsOf(db, b.id)).map(i => i.state)).toEqual(['withdrawn', 'withdrawn', 'withdrawn'])
    expect(r.notices).toEqual([])
  })

  it('a Pause at an item\'s permit sends nothing more; the rest move to a new card', async () => {
    const b = await approve(await collecting(3))
    now += HOLD
    const gate = { paused: false, pauseGen: 0 }
    const hub = itemHub(db, () => { gate.paused = true; gate.pauseGen = 1; return 'ok' })
    await pass(db, b.id, { nowMs: now, hub: hub.gateway, gate })
    expect(hub.calls).toHaveLength(1)
    const rest = await db.prepare("SELECT * FROM outbox_actions WHERE kind = 'batch' AND id <> ?").bind(b.id).first<OutboxActionRow>()
    expect(rest).toMatchObject({ state: 'waiting', items_n: 2, lapsed_reason: 'paused' })
    expect(await rowOf(db, b.id)).toMatchObject({ state: 'sent', items_n: 1, result_json: JSON.stringify({ ref: '1 of 3 went out; the other 2 moved to a new card for a new OK' }) })
  })

  it('#502: a late result never changes an item a person resolved', async () => {
    const b = await approve(await collecting(2))
    now += HOLD
    const late: Promise<void>[] = []
    const hub = itemHub(db, req => (req.item!.n === 1 ? 'hang' : 'ok'))
    const r = await pass(db, b.id, { nowMs: now, hub: hub.gateway, timeoutMs: 1, onLate: p => { late.push(p) } })
    expect(r.outcome).toEqual({ kind: 'needs_check', why: 'unknown' })
    const row = (await rowOf(db, b.id))!
    expect(await outbox(db, clock).resolve(ME, b.id, { outcome: 'sent', ifRev: row.rev, item: 1 })).toMatchObject({ action: { state: 'sent' } })
    // The hub answers now that it didn't go out: the person's word stands, and nothing is given back.
    hub.release({ ok: false, error: { code: 'upstream_rejected', message: 'refused' }, sent: 'no' })
    await Promise.all(late)
    expect((await itemsOf(db, b.id)).map(i => [i.state, i.resolved_by])).toEqual([['sent', ASKER], ['sent', null]])
    expect(await rowOf(db, b.id)).toMatchObject({ state: 'sent' })
    expect(await releases(b.id)).toEqual([])
  })

  it('a late result settles an unclear item nobody resolved, and the batch then ends', async () => {
    const b = await approve(await collecting(2))
    now += HOLD
    const late: Promise<void>[] = []
    const hub = itemHub(db, req => (req.item!.n === 1 ? 'hang' : 'ok'))
    await pass(db, b.id, { nowMs: now, hub: hub.gateway, timeoutMs: 1, onLate: p => { late.push(p) } })
    hub.release({ ok: true, value: { ref: 'late' } })
    await Promise.all(late)
    expect((await itemsOf(db, b.id)).map(i => i.state)).toEqual(['sent', 'sent'])
    expect(await rowOf(db, b.id)).toMatchObject({ state: 'sent', result_json: JSON.stringify({ ref: '2 of 2 went out' }) })
  })

  it('an unclear item is a check for a person; resolved item by item, the batch then ends', async () => {
    const b = await approve(await collecting(3))
    now += HOLD
    const { last } = await sendAll(b.id, n => (n === 2 ? 'unknown' : 'ok'))
    expect(last.outcome).toEqual({ kind: 'needs_check', why: 'unknown' })
    const row = await rowOf(db, b.id) as OutboxActionRow
    expect(row.state).toBe('needs_check')
    expect(await outbox(db, clock).resolve(ME, b.id, { outcome: 'failed', ifRev: row.rev })).toEqual({ refused: { code: 'invalid' } })
    expect(await outbox(db, clock).resolve(ME, b.id, { outcome: 'failed', ifRev: row.rev, item: 1 })).toEqual({ refused: { code: 'conflict' } })
    const done = await outbox(db, clock).resolve(ME, b.id, { outcome: 'failed', ifRev: row.rev, item: 2 })
    expect(done).toMatchObject({ action: { state: 'sent', result_json: JSON.stringify({ ref: '2 of 3 went out' }) } })
    expect((await itemsOf(db, b.id)).map(i => i.state)).toEqual(['sent', 'failed', 'sent'])
  })
})

describe('grant-backed batches and their units (failure 3)', () => {
  beforeEach(async () => {
    await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 1, unitsMax: 100 })
  })

  const call = (orders: number[]) => outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: wideArgs(orders) }, { mode: 'tool' })

  it('a multi-record call under a grant is its own run batch: one use for all its units, one item per order', async () => {
    await grant()
    const r = await call([1, 2, 3])
    if (r.outcome !== 'approved') throw new Error(`expected approved, got ${r.outcome}`)
    expect(r.action).toMatchObject({ kind: 'batch', verdict: 'run', items_n: 3, approved_upto: 3, records: 3, units: 3 })
    expect(r.action.tool_use_id).not.toBeNull()
    const uses = await db.prepare('SELECT units FROM permission_uses WHERE action_id = ?').bind(r.action.id).all<{ units: number }>()
    expect(uses.results).toEqual([{ units: 3 }])
    expect((await itemsOf(db, r.action.id)).map(i => [i.n, i.records, i.line])).toEqual([[1, 1, 'Order 1 (store-a): add vip'], [2, 1, 'Order 2 (store-a): add vip'], [3, 1, 'Order 3 (store-a): add vip']])
  })

  it('a call over the bulk threshold is one exact card with the full list', async () => {
    const r = await call([1, 2, 3, 4, 5, 6, 7])
    expect(r).toMatchObject({ outcome: 'waiting', action: { kind: 'batch', verdict: 'exact', guardrail: 'bulk', items_n: 7, approved_upto: null } })
    if (r.outcome !== 'waiting') return
    const [card] = await cardsOf(db, [r.action], ME, now)
    expect(card).toMatchObject({ kind: 'exact', title: 'Add a tag to 7 orders', records: 7, batch: { itemCount: 7, totals: { records: 7, units: 7, unitsLabel: 'orders' } } })
    expect(card!.batch!.firstLines).toHaveLength(7)
    const page = await outboxStore({ db }).items(ME, r.action.id, { after: 0 })
    expect(page).toEqual({ page: { items: Array.from({ length: 7 }, (_, k) => ({ n: k + 1, line: `Order ${k + 1} (store-a): add vip`, state: 'pending' })) } })
  })

  it('a failed item gives its units back once; an item that went out never does; the rest stopped by a revoke go back once', async () => {
    const g = await grant()
    const r = await call([1, 2, 3, 4])
    if (r.outcome !== 'approved') throw new Error(`expected approved, got ${r.outcome}`)
    now += HOLD
    let calls = 0
    const hub = itemHub(db, req => (req.item!.n === 2 ? 'no' : 'ok'))
    const gateway = {
      async runAction(req: Parameters<typeof hub.gateway.runAction>[0]) {
        const res = await hub.gateway.runAction(req)
        if (++calls === 2) await db.prepare('UPDATE permission_grants SET revoked_at_ms = ? WHERE id = ?').bind(now, g).run()
        return res
      },
    }
    await pass(db, r.action.id, { nowMs: now, hub: gateway })
    for (const c of hub.calls) expect(c.violation).toBeNull()
    expect(hub.calls).toHaveLength(2)
    expect((await itemsOf(db, r.action.id)).map(i => i.state)).toEqual(['sent', 'failed'])
    // Item 1 went out: never given back. Item 2 failed; items 3 and 4 moved to a new card after the revoke.
    expect(await releases(r.action.id)).toEqual([{ n: 2, units: 1, reason: 'failed' }, { n: 3, units: 1, reason: 'moved' }, { n: 4, units: 1, reason: 'moved' }])
    // Repeating every release changes nothing.
    await pass(db, r.action.id, { nowMs: now, hub: gateway })
    expect(await releases(r.action.id)).toHaveLength(3)
    const day = await db.prepare(`SELECT (SELECT SUM(units) FROM permission_uses WHERE grant_id = ? AND released_at_ms IS NULL)
      - (SELECT COALESCE(SUM(ir.units), 0) FROM permission_item_releases ir JOIN permission_uses u ON u.action_id = ir.action_id AND u.action_rev = ir.action_rev
         WHERE u.grant_id = ? AND u.released_at_ms IS NULL) AS n`).bind(g, g).first<{ n: number }>()
    expect(day?.n).toBe(1)
  })

  it('N32: a grant-backed batch of 4 orders revoked during its hold sends nothing, and its use goes back', async () => {
    const g = await grant()
    const r = await call([1, 2, 3, 4])
    if (r.outcome !== 'approved') throw new Error(`expected approved, got ${r.outcome}`)
    await db.prepare('UPDATE permission_grants SET revoked_at_ms = ? WHERE id = ?').bind(now + 1_000, g).run()
    now += HOLD
    const hub = itemHub(db, () => 'ok')
    const p = await pass(db, r.action.id, { nowMs: now, hub: hub.gateway })
    expect(hub.calls).toHaveLength(0)
    expect(await rowOf(db, r.action.id)).toMatchObject({ state: 'waiting', lapsed_reason: 'permission_removed', grant_id: null })
    expect((await db.prepare('SELECT COUNT(*) AS n FROM permission_uses WHERE action_id = ? AND released_at_ms IS NULL').bind(r.action.id).first<{ n: number }>())?.n).toBe(0)
    expect(p.notices).toEqual([expect.objectContaining({ kind: 'approval_lapsed', actionId: r.action.id })])
  })

  it('a stop is decided from the items pending at that moment, even with a throttled item going back to pending beside it', async () => {
    await grant()
    const r = await call([1, 2, 3, 4])
    if (r.outcome !== 'approved') throw new Error(`expected approved, got ${r.outcome}`)
    // Mid-batch: item 1 went out, item 2 is in another pass's call; items 3 and 4 wait.
    await db.batch([
      db.prepare("UPDATE outbox_actions SET state = 'sending', rev = rev + 1, attempt = 1, claimed_at_ms = ? WHERE id = ?").bind(now, r.action.id),
      db.prepare("UPDATE outbox_items SET state = 'sent', attempt = 1 WHERE action_id = ? AND n = 1").bind(r.action.id),
      db.prepare("UPDATE outbox_items SET state = 'sending', attempt = 1, claimed_at_ms = ? WHERE action_id = ? AND n = 2").bind(now, r.action.id),
    ])
    const batch = (await rowOf(db, r.action.id))!
    // The other pass's item comes back throttled (pending again) as the stop runs, at its first database call.
    const race = () => db.prepare("UPDATE outbox_items SET state = 'pending', throttles = 1, claimed_at_ms = NULL WHERE action_id = ? AND n = 2 AND state = 'sending'").bind(r.action.id).run()
    await stopBatch({ db: afterNthCall(db, 1, async () => { await race() }), requestId: fresh('stop'), notify: notices().notify }, batch, 'lapse', 'paused', now)
    const rest = (await db.prepare("SELECT * FROM outbox_actions WHERE kind = 'batch' AND id <> ?").bind(r.action.id).first<OutboxActionRow>())!
    const moved = await itemsOf(db, rest.id)
    // The new card holds exactly what moved, numbered from 1, with totals that match (so it can be answered).
    expect(moved.map(i => i.n)).toEqual(moved.map((_, k) => k + 1))
    expect(rest).toMatchObject({ items_n: moved.length, records: moved.length, units: moved.length })
    expect(await outbox(db, clock).answer(ME, rest.id, { choice: 'deny', ifRev: 1, upTo: moved.length, totals: { records: moved.length, units: moved.length } })).toMatchObject({ action: { state: 'denied' } })
    // Units came back for exactly the items that moved, never for one still on the old card.
    const back = await releases(r.action.id)
    expect(back.map(b => b.reason)).toEqual(moved.map(() => 'moved'))
    const old = await itemsOf(db, r.action.id)
    expect(back.map(b => b.n).filter(n => old.some(i => i.n === n))).toEqual([])
    expect((await rowOf(db, r.action.id))!.items_n).toBe(Math.max(...old.map(i => i.n)))
  })

  it('an item throttled 5 times fails and gives its units back once', async () => {
    await grant()
    const r = await call([1, 2])
    if (r.outcome !== 'approved') throw new Error(`expected approved, got ${r.outcome}`)
    now += HOLD
    const hub = itemHub(db, req => (req.item!.n === 1 ? 'throttle' : 'ok'))
    let p = await pass(db, r.action.id, { nowMs: now, hub: hub.gateway })
    for (let k = 0; k < 10 && p.again.length > 0; k++) {
      now = Math.max(now, ...p.again)
      p = await pass(db, r.action.id, { nowMs: now, hub: hub.gateway })
    }
    for (const c of hub.calls) expect(c.violation).toBeNull()
    expect((await itemsOf(db, r.action.id)).map(i => [i.state, i.throttles, i.error_code])).toEqual([['failed', 5, 'rate_limited'], ['sent', 0, null]])
    expect(await releases(r.action.id)).toEqual([{ n: 1, units: 1, reason: 'failed' }])
  })

  it('#493: "Always allow" on a card over a bulk threshold lowered since keeps the person\'s own approval, and it sends', async () => {
    const r = await call([1, 2, 3])
    if (r.outcome !== 'waiting') throw new Error(`expected waiting, got ${r.outcome}`)
    expect(r.action).toMatchObject({ kind: 'single', verdict: 'ask', records: 3 })
    await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 1, unitsMax: 100, bulkThreshold: 2 })
    const a = await outbox(db, clock).answer(ME, r.action.id, { choice: 'always', ifRev: 1 })
    expect(a).toMatchObject({ action: { state: 'approved', grant_id: null, approved_by: ASKER } })
    expect((await db.prepare('SELECT COUNT(*) AS n FROM permission_uses WHERE action_id = ?').bind(r.action.id).first<{ n: number }>())?.n).toBe(0)
    now += HOLD
    const { sendNow } = await import('../test-support.ts')
    await sendNow(db, r.action.id, now)
    expect(await rowOf(db, r.action.id)).toMatchObject({ state: 'sent' })
  })
})

describe('the sweep and a restore (failure 4)', () => {
  it('a batch row is never a stale single; a stale item is a check; a batch whose task was lost runs again', async () => {
    const b = await approve(await collecting(2))
    now += HOLD
    const hub = itemHub(db, req => (req.item!.n === 1 ? 'hang' : 'ok'))
    const running = pass(db, b.id, { nowMs: now, hub: hub.gateway, timeoutMs: 60_000 })
    await expect.poll(async () => (await itemsOf(db, b.id))[0]!.state).toBe('sending')
    now += 61_000
    const ensured: string[] = []
    await sweepOutbox({ db, nowMs: now, state: () => ({ paused: false, pauseGen: 0 }), scheduler: { ensure: t => { ensured.push(t.id) } }, notify: notices().notify, requestId: fresh('sweep') })
    expect(await rowOf(db, b.id)).toMatchObject({ state: 'sending' })
    expect((await itemsOf(db, b.id)).map(i => i.state)).toEqual(['needs_check', 'pending'])
    expect(ensured).toContain(`outbox-send:${b.id}`)
    const line = await db.prepare("SELECT args_json FROM audit_log WHERE action = 'action.needs_check' AND target_id = ?").bind(b.id).first<{ args_json: string }>()
    expect(JSON.parse(line!.args_json)).toMatchObject({ why: 'stale', item: 1 })
    // The call answers after all: its item is a check now, so the answer isn't stored over it.
    hub.release({ ok: true, value: { ref: 'late' } })
    await running
    expect((await itemsOf(db, b.id))[0]!.state).toBe('needs_check')
  })

  it('a restore holds every pending and sending item of a held batch', async () => {
    const b = await approve(await collecting(2))
    await db.batch(restoreHoldStmts({ restoreId: 'rs_1', afterId: 0, gap: false, at: { nowMs: now, actorId: ASKER, requestId: fresh('restore') } }, fresh('hold')).map(s => db.prepare(s.sql).bind(...s.params)))
    expect(await rowOf(db, b.id)).toMatchObject({ state: 'needs_check' })
    expect((await itemsOf(db, b.id)).map(i => i.state)).toEqual(['needs_check', 'needs_check'])
    const r = await pass(db, b.id, { nowMs: now + HOLD, hub: itemHub(db, () => 'ok').gateway })
    expect(r.outcome).toEqual({ kind: 'needs_check', why: 'unknown' })
  })
})
