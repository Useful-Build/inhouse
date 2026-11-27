// Batches' property suite (Stage 1 M3-B, N22) on real D1 with a fake hub: random sequences of calls (one at a time and
// in parallel, replays among them), answers with `upTo` (stale totals and a tip that moved among them), passes of the
// send task (the hub answering, refusing, throttling, unsure, throwing or hanging, and a Pause landing inside a call),
// crashes at an item boundary, Pause and Resume, a revoke, a ceiling lowered and raised, the clock, the sweep, a person
// resolving an item, and a restore's hold.
// Invariants, written before the code:
//  B1. each item has at most one hub call that ran (a throttled call ran nothing), and at most 1 + its throttles calls;
//  B2. every call followed a winning item claim at that attempt, for an item at or under its batch's `approved_upto`, the
//      batch `sending`, a grant-backed batch's use live (the fake hub reads them at call time), and the rules still let it
//      out at the call: the operation enabled, the item within the ceiling's largest call, a grant-backed batch's grant
//      live and made under the current ceiling;
//  B3. a moved or withdrawn item is never sent from its old batch: every call names the batch the item sits in at the
//      call, and no item `withdrawn` is ever called after;
//  B4. items 1 to `upTo` never change after an answer: each keeps its id, arguments, line and counts, and stays at its
//      position in that batch unless it moved on, pending, to a new card (`moved_from`); nothing else ever takes a
//      position an approval covers;
//  B5. at most one collecting batch per chat and key, and no step fails on the index (a lapse, a sweep, a Pause);
//  B6. released units are counted once: per item at most one release, never for an item that went out, and a batch's
//      releases never pass its use; while its use is held, every item it failed, withdrew or moved on has given its units
//      back; no grant's day passes its limit;
//  B7. a waiting batch's tip is its last position and its totals its items';
//  B8. resuming sends nothing: every call is for a batch approved since the last Pause or Resume;
//  B9. a batch held for a check (a restore's hold, or its end) has no item left to send.
// A rule that changes while an item's call is in flight can't recall that call (as M2: the claim is the last word), so
// the call-time rule check in B2 lets through only the calls of items already claimed when a disturbance landed.
import { fc } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBatch } from '../../db/sql.ts'
import { POLICY_REV } from '../../permissions/policy.ts'
import { ceiling, insertGrant } from '../../permissions/test-support.ts'
import { syncGate } from '../gate.ts'
import { restoreHoldStmts } from '../restore-hold.ts'
import { sweepOutbox } from '../sweep.ts'
import { ASKER, SHOP_GEN, fresh, notices, outbox, requestCtx, world } from '../test-support.ts'
import type { OutboxActionRow, OutboxItemRow } from '../types.ts'
import { itemClaimStmt } from './send.ts'
import { afterNthCall, itemHub, itemsOf, pass, wideArgs, widenTagAdd } from './test-support.ts'
import type { ItemMode } from './test-support.ts'

const db = env.DB
const T0 = 1_800_000_000_000
const CHATS = ['c_bp_one', 'c_bp_two']

/**
 * Something that lands inside a pass: a fast Pause then Resume (`flip`), a revoke, or the ceiling lowered. `at`: 1 to 4
 * inside the pass's n-th hub call; 5 to 14 as its (at - 4)-th D1 call settles (every await of the claims, the permit's
 * reads and the results); 0 never.
 */
type Disturb = 'flip' | 'revoke' | 'lower'

type Step =
  | { k: 'call'; chat: number; orders: number[]; replay: boolean }
  | { k: 'burst'; chat: number; from: number; n: number }
  | { k: 'answer'; i: number; choice: 'approve' | 'deny'; cut: number; stale: boolean }
  | { k: 'pass'; i: number; modes: ItemMode[]; at: number; disturb: Disturb; afterHold: boolean }
  | { k: 'drive'; i: number; cut: number; modes: ItemMode[]; passes: number; at: number; disturb: Disturb }
  | { k: 'crash'; i: number }
  | { k: 'flip'; pulse: boolean }
  | { k: 'grant'; perDay: number }
  | { k: 'revoke' }
  | { k: 'ceiling'; enabled: boolean }
  | { k: 'tick'; ms: number }
  | { k: 'sweep' }
  | { k: 'resolve'; i: number; outcome: 'sent' | 'failed' }
  | { k: 'restore' }

const order = fc.integer({ min: 1, max: 40 })
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 8, arbitrary: fc.record({ k: fc.constant('call' as const), chat: fc.constantFrom(0, 0, 0, 1), orders: fc.uniqueArray(order, { minLength: 1, maxLength: 5 }), replay: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('burst' as const), chat: fc.nat({ max: 1 }), from: fc.integer({ min: 100, max: 900 }), n: fc.integer({ min: 2, max: 6 }) }) },
  {
    weight: 5,
    arbitrary: fc.record({
      k: fc.constant('answer' as const), i: fc.nat({ max: 7 }), choice: fc.constantFrom('approve' as const, 'approve' as const, 'approve' as const, 'deny' as const),
      cut: fc.oneof({ weight: 2, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.nat({ max: 4 }) }), stale: fc.constantFrom(false, false, false, true),
    }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      k: fc.constant('pass' as const), i: fc.nat({ max: 7 }),
      modes: fc.array(fc.constantFrom<ItemMode>('ok', 'ok', 'ok', 'no', 'throttle', 'unknown', 'throw', 'hang'), { minLength: 1, maxLength: 6 }),
      at: fc.oneof({ weight: 4, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 4 }) }, { weight: 2, arbitrary: fc.integer({ min: 5, max: 14 }) }),
      disturb: fc.constantFrom<Disturb>('flip', 'flip', 'revoke', 'lower'),
      afterHold: fc.boolean(),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      k: fc.constant('drive' as const), i: fc.nat({ max: 7 }), cut: fc.oneof({ weight: 3, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.nat({ max: 3 }) }),
      modes: fc.array(fc.constantFrom<ItemMode>('ok', 'ok', 'ok', 'ok', 'no', 'throttle', 'unknown', 'throw', 'hang'), { minLength: 1, maxLength: 6 }),
      passes: fc.integer({ min: 1, max: 4 }),
      at: fc.oneof({ weight: 3, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 4 }) }, { weight: 2, arbitrary: fc.integer({ min: 5, max: 14 }) }),
      disturb: fc.constantFrom<Disturb>('flip', 'revoke', 'lower'),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('crash' as const), i: fc.nat({ max: 7 }) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('flip' as const), pulse: fc.constantFrom(true, true, false) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('grant' as const), perDay: fc.integer({ min: 2, max: 8 }) }) },
  { weight: 1, arbitrary: fc.constant({ k: 'revoke' as const }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('ceiling' as const), enabled: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant('tick' as const), ms: fc.oneof({ weight: 9, arbitrary: fc.integer({ min: 0, max: 70_000 }) }, { weight: 1, arbitrary: fc.constant(8 * 86_400_000) }) }) },
  { weight: 2, arbitrary: fc.constant({ k: 'sweep' as const }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('resolve' as const), i: fc.nat({ max: 7 }), outcome: fc.constantFrom('sent' as const, 'failed' as const) }) },
  { weight: 1, arbitrary: fc.constant({ k: 'restore' as const }) },
)

const ITEM_FIXED = (i: OutboxItemRow) => JSON.stringify([i.item_id, i.chat_id, i.tool_use_id, i.args_json, i.payload_hash, i.line, i.records, i.units])

async function runSequence(withGrant: boolean, steps: Step[]): Promise<void> {
  await world(db)
  // Writes through the widened tag_add: up to 100 orders, 3 a call at most before a call is a bulk batch.
  await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 1, unitsMax: 100, bulkThreshold: 3, batchMax: 12 })
  let now = T0
  const clock = () => now
  const object = { paused: false, pauseGen: 0 }
  const note = notices()
  const problems: string[] = []
  const toolUses: { chat: string; tu: string; orders: number[] }[] = []
  /** Approved prefixes: per batch, the fixed content of items 1 to `upTo` when the answer won. */
  const approvedItems = new Map<string, Map<number, string>>()
  /** Item ids called, with whether the call ran something. */
  const ran = new Map<string, number>()
  const calledWithdrawn: string[] = []
  let mode: ItemMode[] = ['ok']
  let disturbAt = 0
  let disturbing: Disturb = 'flip'
  /** The items in flight when a disturbance landed: their calls may still go out. */
  let inFlight = new Set<string>()
  const disturbNow = async () => {
    inFlight = new Set((await env.DB.prepare("SELECT item_id FROM outbox_items WHERE state = 'sending'").all<{ item_id: string }>()).results.map(r => r.item_id))
    if (disturbing === 'flip') { flip(); flip() }
    else if (disturbing === 'revoke') await env.DB.prepare("UPDATE permission_grants SET revoked_at_ms = ?, revoke_reason = 'removed', rev = rev + 1 WHERE revoked_at_ms IS NULL").bind(now).run()
    else await env.DB.prepare("UPDATE permission_ceiling SET units_max = 1, lowered_rev = lowered_rev + 1 WHERE operation = 'shopify.order.tag_add'").run()
  }
  let callNo = 0
  /** Raised by every Pause and Resume; each batch's approval, the era it was given in. */
  let era = 0
  const approvedEra = new Map<string, number>()
  const flip = () => {
    object.paused = !object.paused
    object.pauseGen++
    era++
  }
  const hub = itemHub(db, () => mode[(callNo++) % mode.length] ?? 'ok')
  const gateway = {
    async runAction(req: Parameters<typeof hub.gateway.runAction>[0]) {
      const item = req.item ? await db.prepare('SELECT * FROM outbox_items WHERE action_id = ? AND n = ?').bind(req.actionId, req.item.n).first<OutboxItemRow>() : null
      if (item?.state === 'withdrawn') calledWithdrawn.push(item.item_id)
      if (approvedEra.get(req.actionId) !== era) problems.push(`B8: a call for ${req.actionId} approved in era ${approvedEra.get(req.actionId)}, now ${era}`)
      const rules = await db.prepare(`SELECT c.enabled, c.units_max, c.lowered_rev, g.revoked_at_ms, g.ceiling_rev, a.grant_id
        FROM outbox_actions a JOIN permission_ceiling c ON c.operation = a.operation LEFT JOIN permission_grants g ON g.id = a.grant_id WHERE a.id = ?`)
        .bind(req.actionId).first<{ enabled: number; units_max: number; lowered_rev: number; revoked_at_ms: number | null; ceiling_rev: number | null; grant_id: string | null }>()
      const broke = !rules || rules.enabled !== 1 ? 'with the operation off'
        : item && item.units > rules.units_max ? `past the largest call (${item.units} > ${rules.units_max})`
          : rules.grant_id !== null && (rules.revoked_at_ms !== null || rules.ceiling_rev !== rules.lowered_rev) ? 'grant-backed with its grant gone' : null
      if (broke !== null && !(item && inFlight.has(item.item_id))) problems.push(`B2: a call for ${req.actionId} ${broke}`)
      const p = hub.gateway.runAction(req)
      if (disturbAt > 0 && callNo === disturbAt) await disturbNow()
      const r = await p
      if (item && (r.ok || hub.calls.at(-1)?.ran)) ran.set(item.item_id, (ran.get(item.item_id) ?? 0) + 1)
      return r
    },
  }
  const batches = async () => (await db.prepare("SELECT * FROM outbox_actions WHERE kind = 'batch' ORDER BY created_at_ms, id").all<OutboxActionRow>()).results
  const aimBatch = async (i: number, state?: string) => {
    const all = await batches()
    const pick = state ? all.filter(b => b.state === state) : all
    const from = pick.length > 0 ? pick : all
    return from.length === 0 ? null : from[i % from.length]!
  }
  const call = async (chat: string, orders: number[], tu: string) => {
    const port = outbox(db, clock)
    const r = await port.request(requestCtx({ nowMs: now, chatId: chat, invocation: { runId: 'r_bp', turnId: 't_bp', toolUseId: tu } }), { operation: 'shopify.order.tag_add', args: wideArgs(orders) }, { mode: 'tool' })
    if (r.outcome === 'approved') approvedEra.set(r.action.id, era)
    return r
  }

  // Five waiting single cards in the first chat, so its next calls collect from the start; then, in half the runs, a
  // grant (its multi-record calls run as their own batches, and calls past its day collect).
  for (let k = 0; k < 5; k++) await call(CHATS[0]!, [1000 + k], fresh('tu'))
  if (withGrant) {
    await insertGrant(db, {
      id: `pg_${fresh('g').replace(/[^A-Za-z0-9]/g, '').padEnd(22, 'A').slice(0, 22)}`, holder: `member:${ASKER}`, accountId: 'shopify:store',
      accountGen: SHOP_GEN, operation: 'shopify.order.tag_add', scopeKey: 'shop=store-a', perDay: 8, unitsMax: 3, policyRev: POLICY_REV,
      grantedRole: 'member', ceilingRev: 1, revokedAtMs: null,
    })
  }

  for (const s of steps) {
    try {
      switch (s.k) {
        case 'call': {
          const prior = s.replay && toolUses.length > 0 ? toolUses[s.orders[0]! % toolUses.length]! : null
          const chat = prior?.chat ?? CHATS[s.chat]!
          const tu = prior?.tu ?? fresh('tu')
          const orders = prior?.orders ?? s.orders
          if (!prior) toolUses.push({ chat, tu, orders })
          await call(chat, orders, tu)
          break
        }
        case 'burst': {
          const chat = CHATS[s.chat]!
          await Promise.all(Array.from({ length: s.n }, (_, k) => {
            const tu = fresh('tu')
            toolUses.push({ chat, tu, orders: [s.from + k] })
            return call(chat, [s.from + k], tu)
          }))
          break
        }
        case 'answer': {
          const b = await aimBatch(s.i, 'waiting')
          if (!b || b.items_n === 0) break
          const upTo = Math.max(1, b.items_n - s.cut)
          const t = await db.prepare('SELECT COALESCE(SUM(records), 0) AS records, COALESCE(SUM(units), 0) AS units FROM outbox_items WHERE action_id = ? AND n <= ?').bind(b.id, upTo).first<{ records: number; units: number }>()
          const totals = s.stale ? { records: t!.records + 1, units: t!.units } : t!
          const snapshot = new Map((await itemsOf(db, b.id)).filter(i => i.n <= upTo).map(i => [i.n, ITEM_FIXED(i)]))
          const r = await outbox(db, clock).answer({ memberId: ASKER, role: 'member' }, b.id, { choice: s.choice, ifRev: b.rev, upTo, totals })
          if ('action' in r) {
            if (s.stale) problems.push(`B4: an answer with stale totals won (${b.id})`)
            if (s.choice === 'approve') {
              approvedItems.set(b.id, snapshot)
              approvedEra.set(b.id, era)
            }
          }
          break
        }
        case 'pass': {
          const b = await aimBatch(s.i, s.i % 3 === 2 ? 'sending' : 'approved')
          if (!b) break
          // The task runs when it's due: half the time at the hold's end.
          if (s.afterHold && b.state === 'approved' && b.send_at_ms !== null) now = Math.max(now, b.send_at_ms)
          mode = s.modes
          disturbing = s.disturb
          disturbAt = s.at > 0 && s.at <= 4 ? callNo + s.at : 0
          const passDb = s.at > 4 ? afterNthCall(db, s.at - 4, disturbNow) : db
          await pass(passDb, b.id, { nowMs: now, hub: gateway, gate: object, timeoutMs: 1 })
          disturbAt = 0
          inFlight = new Set()
          break
        }
        case 'drive': {
          // A person approves a waiting batch as the card shows it, and its task runs at the hold's end and after.
          const b = await aimBatch(s.i, 'waiting')
          if (!b || b.state !== 'waiting' || b.items_n === 0) break
          const upTo = Math.max(1, b.items_n - s.cut)
          const t = await db.prepare('SELECT COALESCE(SUM(records), 0) AS records, COALESCE(SUM(units), 0) AS units FROM outbox_items WHERE action_id = ? AND n <= ?').bind(b.id, upTo).first<{ records: number; units: number }>()
          const snapshot = new Map((await itemsOf(db, b.id)).filter(i => i.n <= upTo).map(i => [i.n, ITEM_FIXED(i)]))
          const r = await outbox(db, clock).answer({ memberId: ASKER, role: 'member' }, b.id, { choice: 'approve', ifRev: b.rev, upTo, totals: t! })
          if (!('action' in r)) break
          approvedItems.set(b.id, snapshot)
          approvedEra.set(b.id, era)
          now = Math.max(now, r.action.send_at_ms ?? now)
          mode = s.modes
          disturbing = s.disturb
          disturbAt = s.at > 0 && s.at <= 4 ? callNo + s.at : 0
          for (let k = 0; k < s.passes; k++) {
            const passDb = k === 0 && s.at > 4 ? afterNthCall(db, s.at - 4, disturbNow) : db
            const pr = await pass(passDb, b.id, { nowMs: now, hub: gateway, gate: object, timeoutMs: 1 })
            if (pr.again.length === 0) break
            now = Math.max(now, ...pr.again)
          }
          disturbAt = 0
          inFlight = new Set()
          break
        }
        case 'crash': {
          // A crash at an item boundary: the item claimed, the task gone before its call.
          const b = await aimBatch(s.i, 'sending')
          if (!b || b.state !== 'sending') break
          const item = await db.prepare("SELECT * FROM outbox_items WHERE action_id = ? AND state = 'pending' ORDER BY n LIMIT 1").bind(b.id).first<OutboxItemRow>()
          if (item) await runBatch(db, [itemClaimStmt({ actionId: b.id, itemId: item.item_id, nowMs: now, pauseGen: object.pauseGen, stamp: fresh('crash') })])
          break
        }
        case 'flip':
          // A Pause (or a Resume); a pulse is a Pause and its Resume, each synced.
          for (let k = 0; k < (s.pulse ? 2 : 1); k++) {
            flip()
            await syncGate({ db, state: () => ({ ...object }), nowMs: now, requestId: fresh('sync'), notify: note.notify })
          }
          break
        case 'grant': {
          if (!(await db.prepare('SELECT 1 FROM permission_grants WHERE revoked_at_ms IS NULL').first())) {
            await insertGrant(db, {
              id: `pg_${fresh('g').replace(/[^A-Za-z0-9]/g, '').padEnd(22, 'A').slice(0, 22)}`, holder: `member:${ASKER}`, accountId: 'shopify:store',
              accountGen: SHOP_GEN, operation: 'shopify.order.tag_add', scopeKey: 'shop=store-a', perDay: s.perDay, unitsMax: 3, policyRev: POLICY_REV,
              grantedRole: 'member', ceilingRev: (await db.prepare("SELECT lowered_rev FROM permission_ceiling WHERE operation = 'shopify.order.tag_add'").first<{ lowered_rev: number }>())!.lowered_rev,
              revokedAtMs: null,
            })
          }
          break
        }
        case 'revoke':
          await db.prepare("UPDATE permission_grants SET revoked_at_ms = ?, revoke_reason = 'removed', rev = rev + 1 WHERE revoked_at_ms IS NULL").bind(now).run()
          break
        case 'ceiling': {
          const rev = (await db.prepare("SELECT lowered_rev FROM permission_ceiling WHERE operation = 'shopify.order.tag_add'").first<{ lowered_rev: number }>())!.lowered_rev
          await ceiling(db, 'shopify.order.tag_add', { enabled: s.enabled, perDayMax: 50, loweredRev: s.enabled ? rev : rev + 1, unitsMax: 100, bulkThreshold: 3, batchMax: 12 })
          break
        }
        case 'tick':
          now += s.ms
          break
        case 'sweep':
          await sweepOutbox({ db, nowMs: now, state: () => ({ ...object }), scheduler: { ensure: () => {} }, notify: note.notify, requestId: fresh('sweep') })
          break
        case 'resolve': {
          const b = await aimBatch(s.i, 'needs_check')
          if (!b || b.state !== 'needs_check') break
          const item = await db.prepare("SELECT n FROM outbox_items WHERE action_id = ? AND state = 'needs_check' ORDER BY n LIMIT 1").bind(b.id).first<{ n: number }>()
          if (item) await outbox(db, clock).resolve({ memberId: ASKER, role: 'member' }, b.id, { outcome: s.outcome, ifRev: b.rev, item: item.n })
          break
        }
        case 'restore': {
          const stmts = restoreHoldStmts({ restoreId: fresh('rs'), afterId: 0, gap: false, at: { nowMs: now, actorId: ASKER, requestId: fresh('restore') } }, fresh('hold'))
          await runBatch(db, stmts)
          // The confirm releases the hold (the gate re-seats at the next sync).
          await db.prepare('UPDATE outbox_gate SET restore_hold = 0, do_gen = ? WHERE id = 1').bind(object.pauseGen).run()
          break
        }
      }
    } catch (err) {
      problems.push(`B5: ${s.k} threw: ${err instanceof Error ? err.message : String(err)}`)
    }

    // ---- the invariants, after every step ----
    for (const c of hub.calls) if (c.violation) problems.push(`B2: ${c.violation}`)
    for (const [id, n] of ran) if (n > 1) problems.push(`B1: item ${id} ran ${n} times`)
    if (calledWithdrawn.length > 0) problems.push(`B3: a withdrawn item was called: ${calledWithdrawn.join(', ')}`)
    const items = (await db.prepare('SELECT * FROM outbox_items').all<OutboxItemRow>()).results
    const byId = new Map(items.map(i => [i.item_id, i]))
    for (const i of items) {
      const calls = hub.calls.filter(c => c.req.actionId === i.action_id && c.req.item?.n === i.n).length
      if (calls > 1 + i.throttles && i.moved_from === null) problems.push(`B1: item ${i.item_id} called ${calls} times with ${i.throttles} throttles`)
    }
    for (const [batch, snap] of approvedItems) {
      const row = (await db.prepare('SELECT * FROM outbox_actions WHERE id = ?').bind(batch).first<OutboxActionRow>())!
      const now = items.filter(i => i.action_id === batch && row.approved_upto !== null && i.n <= row.approved_upto)
      for (const i of now) if (snap.get(i.n) !== ITEM_FIXED(i)) problems.push(`B4: position ${i.n} of ${batch} changed after its answer`)
      for (const fixed of snap.values()) {
        const id = JSON.parse(fixed)[0] as string
        const i = byId.get(id)
        if (!i) continue
        if (ITEM_FIXED(i) !== fixed) problems.push(`B4: item ${id} changed`)
        if (i.action_id !== batch && i.moved_from === null) problems.push(`B4: item ${id} left ${batch} without a move`)
      }
    }
    const open = await db.prepare('SELECT chat_id, coalesce_key, COUNT(*) AS n FROM outbox_actions WHERE coalesce_key IS NOT NULL GROUP BY chat_id, coalesce_key HAVING n > 1').all()
    if (open.results.length > 0) problems.push('B5: two collecting batches for one chat and key')
    const leaking = await db.prepare("SELECT ir.id FROM permission_item_releases ir JOIN outbox_items i ON i.item_id IS NOT NULL AND ir.action_id = i.action_id AND ir.n = i.n WHERE i.state = 'sent' AND i.moved_from IS NULL").all()
    if (leaking.results.length > 0) problems.push(`B6: a sent item was given back: ${JSON.stringify(leaking.results)}`)
    const over = await db.prepare(`SELECT u.id FROM permission_uses u WHERE (SELECT COALESCE(SUM(ir.units), 0) FROM permission_item_releases ir WHERE ir.action_id = u.action_id AND ir.action_rev = u.action_rev) > u.units`).all()
    if (over.results.length > 0) problems.push('B6: a batch gave back more than its use')
    const day = await db.prepare(`SELECT g.id, d.day FROM permission_grants g JOIN (SELECT DISTINCT grant_id, day FROM permission_uses) d ON d.grant_id = g.id WHERE
      (SELECT COALESCE(SUM(u.units), 0) FROM permission_uses u WHERE u.grant_id = g.id AND u.day = d.day AND u.released_at_ms IS NULL)
      - (SELECT COALESCE(SUM(ir.units), 0) FROM permission_uses u JOIN permission_item_releases ir ON ir.action_id = u.action_id AND ir.action_rev = u.action_rev
         WHERE u.grant_id = g.id AND u.day = d.day AND u.released_at_ms IS NULL) > g.per_day`).all()
    if (day.results.length > 0) problems.push('B6: a grant passed its day')
    const owed = await db.prepare(`SELECT a.id,
        (SELECT COUNT(*) FROM outbox_items i WHERE i.action_id = a.id AND i.state = 'failed') AS failed,
        (SELECT COUNT(*) FROM permission_item_releases r WHERE r.action_id = a.id AND r.action_rev = a.approved_rev AND r.reason = 'failed') AS failed_back,
        (SELECT COUNT(*) FROM outbox_items i WHERE i.action_id = a.id AND i.state = 'withdrawn') AS withdrawn,
        (SELECT COUNT(*) FROM permission_item_releases r WHERE r.action_id = a.id AND r.action_rev = a.approved_rev AND r.reason = 'withdrawn') AS withdrawn_back,
        (SELECT COUNT(*) FROM outbox_items i WHERE i.moved_from = a.id) AS moved,
        (SELECT COUNT(*) FROM permission_item_releases r WHERE r.action_id = a.id AND r.action_rev = a.approved_rev AND r.reason = 'moved') AS moved_back
      FROM outbox_actions a WHERE a.kind = 'batch' AND a.grant_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM permission_uses u WHERE u.id = a.id || '#' || a.approved_rev AND u.released_at_ms IS NULL)`).all<Record<string, number | string>>()
    for (const o of owed.results) {
      if (o.failed !== o.failed_back || o.withdrawn !== o.withdrawn_back || (o.moved as number) > (o.moved_back as number)) problems.push(`B6: ${o.id} owes units back: ${JSON.stringify(o)}`)
    }
    const heldOpen = await db.prepare("SELECT a.id FROM outbox_actions a JOIN outbox_items i ON i.action_id = a.id WHERE a.kind = 'batch' AND a.state = 'needs_check' AND i.state = 'pending'").all()
    if (heldOpen.results.length > 0) problems.push('B9: a batch held for a check still has items to send')
    for (const b of await batches()) {
      if (b.state !== 'waiting') continue
      const mine = items.filter(i => i.action_id === b.id)
      const max = mine.reduce((m, i) => Math.max(m, i.n), 0)
      if (b.items_n !== max) problems.push(`B7: ${b.id}'s tip ${b.items_n} isn't its last position ${max}`)
      if (b.records !== mine.reduce((t, i) => t + i.records, 0) || b.units !== mine.reduce((t, i) => t + i.units, 0)) problems.push(`B7: ${b.id}'s totals drifted`)
    }
    if (problems.length > 0) break
  }
  hub.release({ ok: true, value: { ref: 'late' } })
  expect(problems).toEqual([])
}

describe('batches (property)', () => {
  let restore: () => void = () => {}
  beforeAll(() => { restore = widenTagAdd() })
  afterAll(() => restore())

  it('holds B1 to B7 over random sequences', async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.array(stepArb, { minLength: 6, maxLength: 36 }), runSequence), { numRuns: 120 })
  }, 600_000)
})
