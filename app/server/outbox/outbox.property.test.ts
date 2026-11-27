// The outbox's property suite (M2-B "Tests", N11, N12; P6 acceptance 1, 2, 4, 5, 6): random sequences of requests,
// answers (a double answer and a stale revision among them), Undo, the clock, the dispatcher (the hub answering, refusing,
// unsure, throwing, garbled or hanging), crashes, the sweep, Pause and Resume (a hook that throws among them, and a Pause
// landing at every point of a send), late results and a person resolving, all on real D1 with a fake hub.
// Invariants, written before the code:
//  P1. at most one hub call per action, ever;
//  P2. a call only after a winning claim, at that claim's attempt (the fake hub reads the row at call time);
//  P3. a row in `sending` is never claimed again: no state goes back to `approved`, and a row that left `sending` for
//      `waiting` (the permit) made no call for that attempt;
//  P4. after a sweep, no row is still `sending` past its 60 s deadline;
//  P5. resuming sends nothing: every call is for an approval given since the last Pause or Resume (a hook that failed
//      included: the object's flag moves, the gate doesn't);
//  P6. a grant-backed call has a live use (the fake hub checks at call time), and at every step an action holds exactly
//      one unreleased use when it's grant-backed and approved, sending, sent or needing a check, and none otherwise; no
//      unreleased use belongs to no action; no grant's day passes its limit;
//  P7. a person's resolution of "Needs a check" stands: a late result never changes it.
import { fc } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { WriteResult } from '../../hub/index/contract.ts'
import { runBatch } from '../db/sql.ts'
import { insertGrant } from '../permissions/test-support.ts'
import { POLICY_REV } from '../permissions/policy.ts'
import { claimStmt } from './claim.ts'
import { sendAction } from './dispatch.ts'
import { syncGate } from './gate.ts'
import { sweepOutbox } from './sweep.ts'
import { ADMIN, ASKER, OTHER, SHOP_GEN, fakeHub, fresh, notices, outbox, requestCtx, rowOf, tagArgs, world } from './test-support.ts'
import type { HubMode } from './test-support.ts'
import type { OutboxActionRow } from './types.ts'

const db = env.DB
const T0 = 1_800_000_000_000

type Step =
  | { k: 'grant'; perDay: number }
  | { k: 'revoke' }
  | { k: 'request'; order: number }
  | { k: 'answer'; i: number; choice: 'once' | 'always' | 'approve' | 'deny'; stale: boolean; race: 'none' | 'twice' | 'pause' }
  | { k: 'undo'; i: number; stale: boolean }
  | { k: 'tick'; ms: number }
  | { k: 'dispatch'; i: number; mode: HubMode; flipAt: number }
  | { k: 'crash'; i: number; at: 'after_claim' | 'after_call' }
  | { k: 'sweep' }
  | { k: 'flip'; hookFails: boolean; pulse: boolean }
  | { k: 'late'; result: 'ok' | 'no' }
  | { k: 'resolve'; i: number; outcome: 'sent' | 'failed'; by: 'asker' | 'admin' | 'other' }

const idx = fc.nat({ max: 7 })
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 1, arbitrary: fc.record({ k: fc.constant('grant' as const), perDay: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 1, arbitrary: fc.constant({ k: 'revoke' as const }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('request' as const), order: fc.integer({ min: 1, max: 3 }) }) },
  {
    weight: 6,
    arbitrary: fc.record({
      k: fc.constant('answer' as const), i: idx, choice: fc.constantFrom('once', 'once', 'always', 'approve', 'deny'), stale: fc.constantFrom(false, false, false, true),
      race: fc.constantFrom('none', 'none', 'none', 'none', 'twice', 'pause'),
    }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('undo' as const), i: idx, stale: fc.boolean() }) },
  { weight: 5, arbitrary: fc.record({ k: fc.constant('tick' as const), ms: fc.oneof({ weight: 19, arbitrary: fc.integer({ min: 0, max: 70_000 }) }, { weight: 1, arbitrary: fc.constant(8 * 86_400_000) }) }) },
  // flipAt: a fast Pause then Resume at the dispatcher's n-th read of the object's pause state (1 before the claim, 2 at
  // the claim, 3 and 4 at the permit); 5 inside the hub call (after the permit); 6 to 11 as the dispatcher's 1st to 6th
  // D1 call settles (every await of the claim and the send); 0 never.
  {
    weight: 8,
    arbitrary: fc.record({
      k: fc.constant('dispatch' as const), i: idx, mode: fc.constantFrom<HubMode>('ok', 'ok', 'ok', 'no', 'unknown', 'throw', 'bad', 'hang'),
      flipAt: fc.oneof({ weight: 6, arbitrary: fc.constant(0) }, { weight: 2, arbitrary: fc.integer({ min: 1, max: 11 }) }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('crash' as const), i: idx, at: fc.constantFrom('after_claim' as const, 'after_call' as const) }) },
  { weight: 3, arbitrary: fc.constant({ k: 'sweep' as const }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('flip' as const), hookFails: fc.boolean(), pulse: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('late' as const), result: fc.constantFrom('ok' as const, 'no' as const) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('resolve' as const), i: idx, outcome: fc.constantFrom('sent' as const, 'failed' as const), by: fc.constantFrom('asker' as const, 'admin' as const, 'other' as const) }) },
)

/** `db`, calling `then` once its `n`-th call (a statement's run, first or all, or a batch) settles. */
function afterNthCall(db: D1Database, n: number, then: () => void): D1Database {
  let calls = 0
  const tick = () => {
    if (++calls === n) then()
  }
  const real = new WeakMap<object, D1PreparedStatement>()
  const wrap = (st: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(st, {
      get(target, key) {
        if (key === 'bind') return (...v: unknown[]) => wrap(target.bind(...v))
        if (key === 'first' || key === 'all' || key === 'run' || key === 'raw') {
          return async (...a: unknown[]) => {
            const r = await (target[key] as (...x: unknown[]) => Promise<unknown>).apply(target, a)
            tick()
            return r
          }
        }
        const v = Reflect.get(target, key) as unknown
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v
      },
    })
    real.set(proxy, st)
    return proxy
  }
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql))
      if (key === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          const r = await target.batch(stmts.map(x => real.get(x) ?? x))
          tick()
          return r
        }
      }
      const v = Reflect.get(target, key) as unknown
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v
    },
  })
}

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  waiting: ['waiting', 'approved', 'denied', 'withdrawn', 'expired'],
  // One dispatch step goes from approved through sending to its result; one sweep may lapse an approval (the gate's
  // sync) and then expire the card.
  approved: ['approved', 'sending', 'undone', 'waiting', 'withdrawn', 'failed', 'sent', 'needs_check', 'expired'],
  sending: ['sending', 'sent', 'failed', 'needs_check', 'waiting'],
  needs_check: ['needs_check', 'sent', 'failed'],
  sent: ['sent'], failed: ['failed'], undone: ['undone'], denied: ['denied'], withdrawn: ['withdrawn'], expired: ['expired'],
}

async function runSequence(steps: Step[]): Promise<number> {
  await world(db)
  let now = T0
  const clock = () => now
  const port = outbox(db, clock)
  const ids: string[] = []
  const object = { paused: false, pauseGen: 0 }
  /** Raised by every Pause and Resume of the object, whatever its hook did. */
  let era = 0
  /** The era each action's current approval was given in. */
  const approvedEra = new Map<string, number>()
  const resolved = new Map<string, 'sent' | 'failed'>()
  const late: Promise<void>[] = []
  const problems: string[] = []
  let flipInCall = false
  const flip = () => {
    object.paused = !object.paused
    object.pauseGen++
    era++
  }
  const hub = fakeHub(db, () => current, () => {
    // P5: the call is for an approval given in this era.
    const id = hub.calls[hub.calls.length - 1].req.actionId
    if (approvedEra.get(id) !== era) problems.push(`P5: a call for ${id} approved in era ${approvedEra.get(id)}, now ${era}`)
    if (flipInCall) { flip(); flip() }
  })
  let current: HubMode = 'ok'
  const note = notices()
  const at = (i: number) => (ids.length === 0 ? null : ids[i % ids.length])
  /** Half the time the step aims at a row in `state` (the alarm fires for approved rows; a person resolves a check). */
  const aim = async (i: number, state: string) => {
    if (i % 2 === 1) return at(i)
    const r = await db.prepare('SELECT id FROM outbox_actions WHERE state = ? ORDER BY created_at_ms LIMIT 1').bind(state).first<{ id: string }>()
    return r?.id ?? at(i)
  }
  const sync = () => syncGate({ db, state: () => ({ ...object }), nowMs: now, requestId: fresh('sync'), notify: note.notify })
  const remember = (row: OutboxActionRow | null) => {
    if (row && row.state === 'approved') approvedEra.set(row.id, era)
  }
  let before = new Map<string, OutboxActionRow>()

  for (const s of steps) {
    switch (s.k) {
      case 'grant': {
        const live = await db.prepare('SELECT 1 FROM permission_grants WHERE revoked_at_ms IS NULL').first()
        if (!live) {
          await insertGrant(db, {
            id: `pg_${fresh('g').replace(/[^A-Za-z0-9]/g, '').padEnd(22, 'A').slice(0, 22)}`, holder: `member:${ASKER}`, accountId: 'shopify:store',
            accountGen: SHOP_GEN, operation: 'shopify.order.tag_add', scopeKey: 'shop=store-a', perDay: s.perDay, unitsMax: 1, policyRev: POLICY_REV,
            grantedRole: 'member', ceilingRev: 1, revokedAtMs: null,
          })
        }
        break
      }
      case 'revoke':
        await db.prepare("UPDATE permission_grants SET revoked_at_ms = ?, revoke_reason = 'removed', rev = rev + 1 WHERE revoked_at_ms IS NULL").bind(now).run()
        break
      case 'request': {
        const r = await port.request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: tagArgs(s.order) }, { mode: 'tool' })
        if (r.outcome === 'refused') problems.push(`request refused: ${r.reason}`)
        else {
          if (!ids.includes(r.action.id)) ids.push(r.action.id)
          if (r.outcome === 'approved') approvedEra.set(r.action.id, era)
        }
        break
      }
      case 'answer': {
        const id = await aim(s.i, 'waiting')
        if (!id) break
        const row = (await rowOf(db, id))!
        const ifRev = s.stale ? row.rev - 1 || 1 : row.rev
        const actor = { memberId: ASKER, role: 'member' as const }
        const answer = () => port.answer(actor, id, { choice: s.choice, ifRev })
        if (s.race === 'twice') {
          const both = await Promise.all([answer(), answer()])
          if (both.filter(b => 'action' in b).length > 1) problems.push('two answers to one revision both won')
        } else if (s.race === 'pause') {
          // A Pause landing while the answer is in flight, then a Resume.
          flip()
          await Promise.all([answer(), sync()])
          flip()
          await sync()
        } else {
          await answer()
        }
        remember(await rowOf(db, id))
        break
      }
      case 'undo': {
        const id = await aim(s.i, 'approved')
        if (!id) break
        const row = (await rowOf(db, id))!
        const r = await port.undo({ memberId: ASKER, role: 'member' }, id, { ifRev: s.stale ? row.rev - 1 || 1 : row.rev })
        if ('action' in r && row.state !== 'approved') problems.push(`P2: undo won on a ${row.state} row`)
        break
      }
      case 'tick':
        now += s.ms
        break
      case 'dispatch': {
        const id = await aim(s.i, 'approved')
        if (!id) break
        current = s.mode
        let reads = 0
        // A fast Pause then Resume at that point: the object ends unpaused, two generations on, its hooks not yet run.
        const read = () => {
          if (++reads === s.flipAt) { flip(); flip() }
        }
        flipInCall = s.flipAt === 5
        await sendAction(id, {
          db: s.flipAt > 5 ? afterNthCall(db, s.flipAt - 5, () => { flip(); flip() }) : db, nowMs: now, hub: hub.gateway, notify: note.notify, requestId: fresh('send'), again: () => {}, timeoutMs: 1,
          gate: { get paused() { read(); return object.paused }, get pauseGen() { read(); return object.pauseGen } },
          onLate: p => late.push(p),
        })
        flipInCall = false
        break
      }
      case 'crash': {
        const id = await aim(s.i, 'approved')
        if (!id) break
        const stamp = fresh('crash')
        await runBatch(db, [claimStmt({ actionId: id, nowMs: now, pauseGen: object.pauseGen, stamp })])
        const row = await rowOf(db, id)
        // After the call: the effect happened at the tool, and the process died before the result was saved.
        if (s.at === 'after_call' && row?.stamp === stamp) {
          current = 'ok'
          await hub.gateway.runAction({ actionId: id, attempt: row.attempt, requestId: stamp, accountId: row.account_id, expect: { connectedAtMs: row.account_gen }, operation: row.operation, args: JSON.parse(row.args_json) })
        }
        break
      }
      case 'sweep': {
        await sweepOutbox({ db, nowMs: now, state: () => ({ ...object }), scheduler: { ensure: () => {} }, notify: note.notify, requestId: fresh('sweep') })
        const stuck = await db.prepare("SELECT id FROM outbox_actions WHERE state = 'sending' AND claimed_at_ms <= ?").bind(now - 60_000).all()
        if (stuck.results.length > 0) problems.push('P4: a sending row past its deadline after a sweep')
        break
      }
      case 'flip':
        // A Pause or a Resume (or, `pulse`, a Pause then a Resume), each hook run or failing.
        flip()
        if (!s.hookFails) await sync()
        if (s.pulse) {
          flip()
          if (!s.hookFails) await sync()
        }
        break
      case 'late': {
        hub.release(s.result === 'ok' ? { ok: true, value: { ref: 'vip' } } : { ok: false, error: { code: 'upstream_rejected', message: 'x' }, sent: 'no' } as WriteResult)
        await Promise.all(late.splice(0))
        break
      }
      case 'resolve': {
        const id = await aim(s.i, 'needs_check')
        if (!id) break
        const row = (await rowOf(db, id))!
        const who = s.by === 'asker' ? { memberId: ASKER, role: 'member' as const } : s.by === 'admin' ? { memberId: ADMIN, role: 'admin' as const } : { memberId: OTHER, role: 'member' as const }
        const r = await port.resolve(who, id, { outcome: s.outcome, ifRev: row.rev })
        if ('action' in r) {
          if (s.by === 'other') problems.push('P7: a member who is neither the approver nor an admin resolved a check')
          resolved.set(id, s.outcome)
        }
        break
      }
    }

    // Per-step invariants: transitions (P3) and uses (P6).
    const rows = (await db.prepare('SELECT * FROM outbox_actions').all<OutboxActionRow>()).results
    for (const r of rows) {
      const was = before.get(r.id)
      if (was && !ALLOWED[was.state].includes(r.state)) problems.push(`P3: ${was.state} -> ${r.state}`)
      if (was && was.state === 'sending' && r.state === 'waiting' && hub.calls.some(c => c.req.actionId === r.id && c.req.attempt === was.attempt)) {
        problems.push('P3: a row that made a call went back to waiting')
      }
      const uses = (await db.prepare('SELECT units FROM permission_uses WHERE action_id = ? AND released_at_ms IS NULL').bind(r.id).all()).results
      const want = r.grant_id !== null && ['approved', 'sending', 'sent', 'needs_check'].includes(r.state) ? 1 : 0
      if (uses.length !== want) problems.push(`P6: ${r.state} row (grant ${r.grant_id ?? 'none'}) holds ${uses.length} unreleased uses`)
    }
    const over = await db.prepare(
      `SELECT u.grant_id FROM permission_uses u JOIN permission_grants g ON g.id = u.grant_id WHERE u.released_at_ms IS NULL
       GROUP BY u.grant_id, u.day HAVING SUM(u.units) > MAX(g.per_day)`,
    ).all()
    if (over.results.length > 0) problems.push('P6: a grant past its day')
    const orphan = await db.prepare('SELECT u.id FROM permission_uses u WHERE u.released_at_ms IS NULL AND NOT EXISTS (SELECT 1 FROM outbox_actions a WHERE a.id = u.action_id)').all()
    if (orphan.results.length > 0) problems.push('P6: an unreleased use with no action')
    before = new Map(rows.map(r => [r.id, r]))
    if (problems.length > 0) break
  }

  hub.release({ ok: true, value: { ref: 'late' } })
  await Promise.all(late)
  // P1 and P2.
  const perAction = new Map<string, number>()
  for (const c of hub.calls) {
    perAction.set(c.req.actionId, (perAction.get(c.req.actionId) ?? 0) + 1)
    if (c.violation) problems.push(`P2/P6: ${c.violation}`)
  }
  for (const [id, n] of perAction) if (n > 1) problems.push(`P1: ${n} calls for ${id}`)
  // P7.
  for (const [id, outcome] of resolved) {
    const r = await rowOf(db, id)
    if (r?.state !== outcome) problems.push(`P7: resolved ${outcome}, now ${r?.state}`)
  }
  expect(problems).toEqual([])
  return hub.calls.length
}

/** The send path's own steps, after a prefix that leaves approved actions behind: one asked, one under a grant. */
// The send path's clock moves in steps under the 70 s the sweep and permit rules need, never by days: an 8-day jump
// (the first property's expiry case) lapses every approval at once and leaves the send path nothing to send.
const sendStepArb: fc.Arbitrary<Step> = stepArb
  .filter(s => ['dispatch', 'crash', 'sweep', 'flip', 'late', 'resolve', 'tick', 'undo', 'revoke'].includes(s.k))
  .map(s => (s.k === 'tick' && s.ms > 70_000 ? { k: 'tick', ms: s.ms % 70_001 } : s))
const PREFIX: Step[] = [
  { k: 'grant', perDay: 2 },
  { k: 'request', order: 1 },
  { k: 'revoke' },
  { k: 'request', order: 2 },
  { k: 'answer', i: 1, choice: 'once', stale: false, race: 'none' },
  { k: 'request', order: 3 },
  { k: 'answer', i: 2, choice: 'always', stale: false, race: 'none' },
  { k: 'tick', ms: 11_000 },
]

// #542 (seed 476006337, shrunk): the collecting batch opened at the 3rd step expires with the 8-day tick; the 14th step's
// call (the grant's day spent by the 11th, so it collects) must open a fresh batch before the 15th step's sweep, not be
// told "busy".
const EXPIRED_COLLECTOR: Step[] = [
  { k: 'grant', perDay: 1 }, { k: 'request', order: 1 }, { k: 'request', order: 2 }, { k: 'dispatch', i: 0, mode: 'ok', flipAt: 0 },
  { k: 'answer', i: 0, choice: 'once', stale: false, race: 'none' }, { k: 'tick', ms: 691_200_000 }, { k: 'dispatch', i: 0, mode: 'ok', flipAt: 1 },
  { k: 'tick', ms: 0 }, { k: 'tick', ms: 0 }, { k: 'late', result: 'ok' }, { k: 'request', order: 1 },
  { k: 'answer', i: 0, choice: 'once', stale: false, race: 'none' }, { k: 'undo', i: 1, stale: false }, { k: 'request', order: 1 }, { k: 'sweep' },
  { k: 'tick', ms: 0 }, { k: 'request', order: 1 }, { k: 'answer', i: 0, choice: 'once', stale: false, race: 'none' },
]

describe('the outbox under random sequences (P1 to P7)', () => {
  it('holds every invariant over every kind of step', async () => {
    await fc.assert(fc.asyncProperty(fc.array(stepArb, { minLength: 15, maxLength: 40 }), async steps => { await runSequence(steps) }), { numRuns: 300, examples: [[EXPIRED_COLLECTOR]] })
  }, 120_000)

  it('holds every invariant on the send path: claims, crashes, the sweep, Pause and late results', async () => {
    let calls = 0
    await fc.assert(fc.asyncProperty(fc.array(sendStepArb, { minLength: 5, maxLength: 25 }), async tail => { calls += await runSequence([...PREFIX, ...tail]) }), { numRuns: 300 })
    // The suite must actually send: a run where the hub was never called proves nothing about P1 and P2.
    expect(calls, `the send path called the hub ${calls} times`).toBeGreaterThan(100)
  }, 120_000)
})
