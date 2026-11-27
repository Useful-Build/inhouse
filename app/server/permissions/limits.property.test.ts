// Stage 1 M3-L's limits on real D1 (N23, N22's releases; P7's reservations): the reservation, the item releases, the
// ceiling's writer and the outbox's checks at the answer and the claim. Ways it can fail, written down first:
//  L1. parallel reservations take more than the day has left (50 calls against 49 units left give 50), or fewer;
//  L2. a reservation passes a largest-call limit (the grant's or the ceiling's), or `units_max` is applied to a day's
//      total instead of to each call (two calls of `units_max` each refused while the day has room);
//  L3. an item release is counted twice (a repeat of the same item and revision gives units back again), gives back
//      more than its use holds, counts after its whole use was released (units given back twice), or lands on a use
//      that's gone;
//  L4. lowering a ceiling value leaves `lowered_rev` where it was (an old grant keeps covering), raising one moves it,
//      or a change leaves `rev` where it was;
//  L5. a ceiling's largest call lowered while a card waits still lets the answer approve it; lowered during the hold
//      still lets the claim send it (a person's approval or a grant's), or the dispatcher can't name why it stopped;
//  L6. "Always allow" makes a grant without the operation's default largest call, or the list shows another.
import { fc } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { openStores } from '../db/stores.ts'
import { runBatch } from '../db/sql.ts'
import { sendAction } from '../outbox/dispatch.ts'
import { grantDefaults } from '../outbox/operations/index.ts'
import { outboxFacts } from '../outbox/facts.ts'
import { ASKER, HUB_FACTS, SHOP_GEN, fakeHub, fresh, notices, outbox, requestCtx, rowOf, tagArgs, world } from '../outbox/test-support.ts'
import { newActionId } from '../outbox/sql.ts'
import { setCeilingStmt } from './ceiling.ts'
import { POLICY_REV } from './policy.ts'
import { account, ceiling, insertGrant, person, resetPermissions } from './test-support.ts'
import { releaseItemSql, releaseUseSql, reserveUseSql } from './uses.ts'
import type { GrantFacts } from './types.ts'

const db = env.DB
const NOW = 1_800_000_000_000
const DAYS = ['2026-11-26', '2026-11-27'] as const
const HOLDER = 'm_limits'

let k = 0
const grantId = () => `pg_lim${Date.now().toString(36)}${++k}`.padEnd(25, 'A').slice(0, 25)
const grantOf = (over: Partial<GrantFacts> = {}): GrantFacts => ({
  id: grantId(), holder: `member:${HOLDER}`, accountId: 'shopify:store', accountGen: SHOP_GEN, operation: 'shopify.order.tag_add',
  scopeKey: `shop=lim-${k}`, perDay: 50, unitsMax: 1, policyRev: POLICY_REV, grantedRole: 'member', ceilingRev: 1, revokedAtMs: null, ...over,
})
const exec = (s: { sql: string; params: readonly unknown[] }) => db.prepare(s.sql).bind(...s.params)
const run = (s: { sql: string; params: readonly unknown[] }) => exec(s).run()
const reserve = (g: string, actionId: string, units: number, day: string = DAYS[0]) => reserveUseSql({ actionId, actionRev: 1, grantId: g, day, units, atMs: NOW })

/** The day's units the reservation counts for this grant, read the way a person would add them up. */
async function inUse(g: string, day: string): Promise<number> {
  const uses = (await db.prepare('SELECT action_id, action_rev, units FROM permission_uses WHERE grant_id = ? AND day = ? AND released_at_ms IS NULL')
    .bind(g, day).all<{ action_id: string; action_rev: number; units: number }>()).results
  let n = 0
  for (const u of uses) {
    const back = await db.prepare('SELECT COALESCE(SUM(units), 0) AS n FROM permission_item_releases WHERE action_id = ? AND action_rev = ?')
      .bind(u.action_id, u.action_rev).first<number>('n')
    n += u.units - (back ?? 0)
  }
  return n
}

async function freshGrant(o: { perDay: number; perDayMax: number; unitsMax: number; ceilingUnitsMax: number }): Promise<GrantFacts> {
  await resetPermissions(db)
  await person(db, HOLDER, 'member')
  await account(db, 'shopify:store', SHOP_GEN)
  await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: o.perDayMax, loweredRev: 1, unitsMax: o.ceilingUnitsMax })
  const g = grantOf({ perDay: o.perDay, unitsMax: o.unitsMax })
  await insertGrant(db, g)
  return g
}

describe('the reservation under its limits (L1, L2)', () => {
  it('L1: 50 parallel reservations against 49 units left give exactly 49', async () => {
    const g = await freshGrant({ perDay: 100, perDayMax: 100, unitsMax: 51, ceilingUnitsMax: 51 })
    expect((await run(reserve(g.id, 'ac_lim_first', 51))).meta.changes).toBe(1)
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => db.batch([exec(reserve(g.id, `ac_lim_par${i}`, 1))])))
    expect(results.reduce((n, r) => n + r[0].meta.changes, 0)).toBe(49)
    expect(await inUse(g.id, DAYS[0])).toBe(100)
  })

  it('L1: any number of parallel calls take exactly what the day has left', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 1, max: 30 }), async (left, calls) => {
      const g = await freshGrant({ perDay: 20, perDayMax: 40, unitsMax: 20, ceilingUnitsMax: 20 })
      if (left < 20) expect((await run(reserve(g.id, 'ac_lim_pre', 20 - left))).meta.changes).toBe(1)
      const results = await Promise.all(Array.from({ length: calls }, (_, i) => db.batch([exec(reserve(g.id, `ac_lim_p${i}`, 1))])))
      expect(results.reduce((n, r) => n + r[0].meta.changes, 0)).toBe(Math.min(left, calls))
      expect(await inUse(g.id, DAYS[0])).toBe(20 - left + Math.min(left, calls))
    }), { numRuns: 25 })
  })

  it('L2: units_max bounds each call, never the day: calls of the largest size each pass while the day has room', async () => {
    const g = await freshGrant({ perDay: 12, perDayMax: 50, unitsMax: 4, ceilingUnitsMax: 5 })
    expect((await run(reserve(g.id, 'ac_lim_big', 5))).meta.changes).toBe(0)
    for (const i of [1, 2, 3]) expect((await run(reserve(g.id, `ac_lim_ok${i}`, 4))).meta.changes, `call ${i}`).toBe(1)
    expect((await run(reserve(g.id, 'ac_lim_day', 1))).meta.changes).toBe(0)
    expect(await inUse(g.id, DAYS[0])).toBe(12)
  })
})

describe('item releases (L3) and the reservation, against a model', () => {
  type Step =
    | { kind: 'reserve'; units: number; day: 0 | 1 }
    | { kind: 'item'; pick: number; n: number; units: number }
    | { kind: 'release'; pick: number }
    /** The last item release again, exactly (a retried task, a replayed move). */
    | { kind: 'again' }
  const stepArb: fc.Arbitrary<Step> = fc.oneof(
    { weight: 3, arbitrary: fc.record({ kind: fc.constant('reserve' as const), units: fc.integer({ min: 1, max: 6 }), day: fc.constantFrom(0 as const, 1 as const) }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant('item' as const), pick: fc.nat(), n: fc.integer({ min: 1, max: 3 }), units: fc.integer({ min: 1, max: 3 }) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('release' as const), pick: fc.nat() }) },
    { weight: 2, arbitrary: fc.constant({ kind: 'again' as const }) },
  )

  it('every reservation fits exactly when the model says, and each item is given back at most once', async () => {
    let fits = 0
    let misses = 0
    let repeats = 0
    await fc.assert(fc.asyncProperty(
      fc.record({ perDay: fc.integer({ min: 1, max: 12 }), perDayMax: fc.integer({ min: 1, max: 12 }), unitsMax: fc.integer({ min: 1, max: 6 }), ceilingUnitsMax: fc.integer({ min: 1, max: 6 }) }),
      fc.array(stepArb, { maxLength: 16 }),
      async (limits, steps) => {
        const g = await freshGrant(limits)
        const dayMax = Math.min(limits.perDay, limits.perDayMax)
        type Use = { id: string; units: number; day: string; live: boolean; back: Map<number, number> }
        const model: Use[] = []
        let last: { u: Use; n: number; units: number } | null = null
        const used = (day: string) => model.filter(u => u.live && u.day === day).reduce((n, u) => n + u.units - [...u.back.values()].reduce((a, b) => a + b, 0), 0)
        for (const [i, s] of steps.entries()) {
          if (s.kind === 'reserve') {
            const day = DAYS[s.day]
            const want = s.units <= limits.unitsMax && s.units <= limits.ceilingUnitsMax && used(day) + s.units <= dayMax
            const id = `ac_lim_m${i}`
            expect((await run(reserve(g.id, id, s.units, day))).meta.changes, `reserve ${s.units} on ${day}`).toBe(want ? 1 : 0)
            if (want) { model.push({ id, units: s.units, day, live: true, back: new Map() }); fits++ } else misses++
          } else if ((s.kind === 'item' && model.length > 0) || (s.kind === 'again' && last)) {
            const picked: { u: Use; n: number; units: number } = s.kind === 'item' ? { u: model[s.pick % model.length], n: s.n, units: s.units } : last!
            const { u, n, units } = picked
            last = { u, n, units }
            const given = [...u.back.values()].reduce((a, b) => a + b, 0)
            const want = u.live && !u.back.has(n) && given + units <= u.units
            if (u.back.has(n)) repeats++
            const r = await run(releaseItemSql({ actionId: u.id, actionRev: 1, n, units, reason: 'failed', atMs: NOW }))
            expect(r.meta.changes, `item ${n} of ${u.id}`).toBe(want ? 1 : 0)
            if (want) u.back.set(n, units)
          } else if (s.kind === 'release' && model.length > 0) {
            const u = model[s.pick % model.length]
            await run(releaseUseSql({ actionId: u.id, actionRev: 1, reason: 'failed', atMs: NOW }))
            u.live = false
          }
          for (const day of DAYS) {
            const n = await inUse(g.id, day)
            expect(n).toBe(used(day))
            expect(n).toBeLessThanOrEqual(dayMax)
            expect(n).toBeGreaterThanOrEqual(0)
          }
        }
        const dup = await db.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM permission_item_releases GROUP BY action_id, action_rev, n HAVING COUNT(*) > 1)').first<number>('n')
        expect(dup).toBe(0)
      },
    ), {
      // 60 random runs, plus one fixed case that draws each counted answer (a fit, a miss and a repeated item release)
      // so the tally below never rests on the draw: 60 random runs can miss a repeat (issue #511). Examples count
      // toward numRuns in fast-check, hence 61.
      numRuns: 61,
      examples: [[
        { perDay: 2, perDayMax: 2, unitsMax: 2, ceilingUnitsMax: 2 },
        [
          { kind: 'reserve', units: 2, day: 0 },
          { kind: 'reserve', units: 1, day: 0 },
          { kind: 'item', pick: 0, n: 1, units: 1 },
          { kind: 'again' },
        ],
      ]],
    })
    // Both answers and repeated item releases were drawn: a property that only ever fits proves nothing.
    expect(fits).toBeGreaterThan(0)
    expect(misses).toBeGreaterThan(0)
    expect(repeats).toBeGreaterThan(0)
  })

  it('a released item frees its units for the day; a later release of the whole use frees only the rest', async () => {
    const g = await freshGrant({ perDay: 10, perDayMax: 10, unitsMax: 10, ceilingUnitsMax: 10 })
    expect((await run(reserve(g.id, 'ac_lim_batch', 10))).meta.changes).toBe(1)
    expect((await run(reserve(g.id, 'ac_lim_none', 1))).meta.changes).toBe(0)
    for (let i = 0; i < 3; i++) await run(releaseItemSql({ actionId: 'ac_lim_batch', actionRev: 1, n: 4, units: 3, reason: 'moved', atMs: NOW }))
    expect(await inUse(g.id, DAYS[0])).toBe(7)
    expect((await run(reserve(g.id, 'ac_lim_after', 3))).meta.changes).toBe(1)
    expect((await run(reserve(g.id, 'ac_lim_over', 1))).meta.changes).toBe(0)
    await run(releaseUseSql({ actionId: 'ac_lim_batch', actionRev: 1, reason: 'failed', atMs: NOW }))
    expect(await inUse(g.id, DAYS[0])).toBe(3)
    // Once the use is released, its items give nothing back again.
    expect((await run(releaseItemSql({ actionId: 'ac_lim_batch', actionRev: 1, n: 5, units: 1, reason: 'withdrawn', atMs: NOW }))).meta.changes).toBe(0)
    // No use, no release; another revision's use is another use.
    expect((await run(releaseItemSql({ actionId: 'ac_lim_ghost', actionRev: 1, n: 1, units: 1, reason: 'failed', atMs: NOW }))).meta.changes).toBe(0)
    expect((await run(releaseItemSql({ actionId: 'ac_lim_after', actionRev: 2, n: 1, units: 1, reason: 'failed', atMs: NOW }))).meta.changes).toBe(0)
  })

  it('a release only under the caller\'s own condition', async () => {
    const g = await freshGrant({ perDay: 10, perDayMax: 10, unitsMax: 10, ceilingUnitsMax: 10 })
    await run(reserve(g.id, 'ac_lim_cond', 4))
    expect((await run(releaseItemSql({ actionId: 'ac_lim_cond', actionRev: 1, n: 1, units: 1, reason: 'failed', atMs: NOW }, { sql: 'SELECT 1 WHERE 0', params: [] }))).meta.changes).toBe(0)
    expect((await run(releaseItemSql({ actionId: 'ac_lim_cond', actionRev: 1, n: 1, units: 1, reason: 'failed', atMs: NOW }, { sql: 'SELECT 1 WHERE ? = 1', params: [1] }))).meta.changes).toBe(1)
  })
})

describe('the ceiling\'s writer (L4)', () => {
  const valuesArb = fc.record({
    enabled: fc.boolean(), perDayMax: fc.integer({ min: 1, max: 4 }), unitsMax: fc.integer({ min: 1, max: 4 }),
    bulkThreshold: fc.integer({ min: 1, max: 5 }), batchMax: fc.integer({ min: 1, max: 4 }),
  })
  type Values = typeof valuesArb extends fc.Arbitrary<infer V> ? V : never
  const lowered = (a: Values, b: Values) => (a.enabled && !b.enabled) || b.perDayMax < a.perDayMax || b.unitsMax < a.unitsMax
    || b.bulkThreshold < a.bulkThreshold || b.batchMax < a.batchMax

  it('raises lowered_rev exactly when a value is lowered, and rev on every change', async () => {
    let raised = 0
    let kept = 0
    await fc.assert(fc.asyncProperty(fc.array(valuesArb, { minLength: 1, maxLength: 8 }), async seq => {
      await resetPermissions(db)
      let want = { lowered: 1, rev: 1 }
      for (const [i, v] of seq.entries()) {
        await runBatch(db, [setCeilingStmt({ operation: 'slack.channel.post', ...v, actorId: 'm_system', nowMs: NOW + i })])
        if (i > 0) {
          const down = lowered(seq[i - 1], v)
          want = { lowered: want.lowered + (down ? 1 : 0), rev: want.rev + 1 }
          if (down) raised++
          else kept++
        }
        const row = await db.prepare("SELECT * FROM permission_ceiling WHERE operation = 'slack.channel.post'").first<Record<string, number>>()
        expect(row).toMatchObject({
          enabled: v.enabled ? 1 : 0, per_day_max: v.perDayMax, units_max: v.unitsMax, bulk_threshold: v.bulkThreshold, batch_max: v.batchMax,
          lowered_rev: want.lowered, rev: want.rev, updated_at_ms: NOW + i,
        })
      }
    }), { numRuns: 60 })
    expect(raised).toBeGreaterThan(0)
    expect(kept).toBeGreaterThan(0)
  })

  it('left out, the limits are 0760\'s defaults; out of range, it throws', async () => {
    await resetPermissions(db)
    await runBatch(db, [setCeilingStmt({ operation: 'slack.channel.post', enabled: true, perDayMax: 5, actorId: 'm_system', nowMs: NOW })])
    expect(await db.prepare("SELECT units_max, bulk_threshold, batch_max FROM permission_ceiling WHERE operation = 'slack.channel.post'").first())
      .toEqual({ units_max: 1, bulk_threshold: 5, batch_max: 500 })
    const base = { operation: 'slack.channel.post' as const, enabled: true, perDayMax: 5, actorId: 'm_system', nowMs: NOW }
    for (const bad of [{ unitsMax: 0 }, { unitsMax: 1.5 }, { bulkThreshold: 6 }, { bulkThreshold: 0 }, { batchMax: 501 }, { perDayMax: 0 }]) {
      expect(() => setCeilingStmt({ ...base, ...bad }), JSON.stringify(bad)).toThrow()
    }
  })
})

describe('the outbox at the answer and the claim (L5, L6)', () => {
  const T0 = NOW

  /** A tag card waiting on the asker, its units as given (a widened call, M3-S1), written directly. */
  async function waitingCard(units: number): Promise<string> {
    const id = newActionId()
    await db.prepare(
      `INSERT INTO outbox_actions (id, rev, state, verdict, origin, via, asked_by, approver, chat_id, account_id, account_gen, operation,
         policy_rev, scope_json, scope_key, args_json, payload_hash, records, units, card_json, expires_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, 1, 'waiting', 'ask', 'chat', 'tool', ?, ?, 'c_limits', 'shopify:store', ?, 'shopify.order.tag_add', ?, '{"shop":"store-a"}',
         'shop=store-a', ?, ?, 1, ?, '{"title":"Tag","lines":[],"label":"Shopify","nudge":false}', ?, ?, ?)`,
    ).bind(id, ASKER, ASKER, SHOP_GEN, POLICY_REV, JSON.stringify(tagArgs(1)), fresh('h'), units, T0 + 86_400_000, T0, T0).run()
    return id
  }
  const send = async (id: string, nowMs: number) => {
    const hub = fakeHub(db, () => 'ok')
    const outcome = await sendAction(id, { db, nowMs, hub: hub.gateway, notify: notices().notify, requestId: fresh('send'), again: () => {}, gate: { paused: false, pauseGen: 0 }, timeoutMs: 1_000 })
    return { outcome, calls: hub.calls }
  }
  const setLimit = (unitsMax: number) => ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 1, unitsMax })

  beforeEach(async () => {
    await world(db)
  })

  it('L5: a ceiling lowered while the card waits refuses the approval (over_limit), not the No', async () => {
    await setLimit(3)
    const id = await waitingCard(3)
    await setLimit(2)
    const ob = outbox(db, () => T0)
    expect(await ob.answer({ memberId: ASKER, role: 'member' }, id, { choice: 'once', ifRev: 1 })).toEqual({ refused: { code: 'conflict', reason: 'over_limit' } })
    expect((await rowOf(db, id))?.state).toBe('waiting')
    await setLimit(3)
    const ok = await ob.answer({ memberId: ASKER, role: 'member' }, id, { choice: 'once', ifRev: 1 })
    expect('action' in ok && ok.action.state).toBe('approved')
    const id2 = await waitingCard(3)
    await setLimit(2)
    const no = await ob.answer({ memberId: ASKER, role: 'member' }, id2, { choice: 'deny', ifRev: 1 })
    expect('action' in no && no.action.state).toBe('denied')
  })

  it('L5: a ceiling lowered during the hold stops the claim of a person\'s approval: no hub call, back to waiting as over_limit', async () => {
    await setLimit(3)
    const id = await waitingCard(3)
    const answered = await outbox(db, () => T0).answer({ memberId: ASKER, role: 'member' }, id, { choice: 'once', ifRev: 1 })
    expect('action' in answered && answered.action.state).toBe('approved')
    await setLimit(2)
    const { outcome, calls } = await send(id, T0 + 60_000)
    expect(outcome).toEqual({ kind: 'not_claimed' })
    expect(calls).toHaveLength(0)
    expect(await rowOf(db, id)).toMatchObject({ state: 'waiting', lapsed_reason: 'over_limit', approved_by: null })
  })

  it('L5: a ceiling lowered during the hold stops a grant-backed claim and gives its use back', async () => {
    await setLimit(3)
    const g = grantOf({ holder: `member:${ASKER}`, scopeKey: 'shop=store-a', unitsMax: 3 })
    await insertGrant(db, g)
    const id = await waitingCard(3)
    // As a `run` leaves it: approved under the grant at revision 1, its use reserved (store.ts's run path).
    await run(reserveUseSql({ actionId: id, actionRev: 1, grantId: g.id, day: DAYS[0], units: 3, atMs: T0 }))
    await db.prepare(`UPDATE outbox_actions SET state = 'approved', verdict = 'run', grant_id = ?, approved_by = ?, approved_rev = 1, approved_at_ms = ?,
        approved_epoch = 1, send_at_ms = ? WHERE id = ?`).bind(g.id, `grant:${g.id}`, T0, T0 + 10_000, id).run()
    // Lowering it raises `lowered_rev` too (the writer), so set it as the screen would.
    await runBatch(db, [setCeilingStmt({ operation: 'shopify.order.tag_add', enabled: true, perDayMax: 50, unitsMax: 2, actorId: 'm_system', nowMs: T0 })])
    const { outcome, calls } = await send(id, T0 + 60_000)
    expect(outcome).toEqual({ kind: 'not_claimed' })
    expect(calls).toHaveLength(0)
    expect(await rowOf(db, id)).toMatchObject({ state: 'waiting', lapsed_reason: 'over_limit', grant_id: null })
    expect(await db.prepare('SELECT released_at_ms, release_reason FROM permission_uses WHERE id = ?').bind(`${id}#1`).first()).toEqual({ released_at_ms: T0 + 60_000, release_reason: 'lapsed' })
  })

  it('L5: within the limit, the same approval is claimed and sent once', async () => {
    await setLimit(3)
    const id = await waitingCard(3)
    await outbox(db, () => T0).answer({ memberId: ASKER, role: 'member' }, id, { choice: 'once', ifRev: 1 })
    const { outcome, calls } = await send(id, T0 + 60_000)
    expect(outcome.kind).toBe('sent')
    expect(calls).toHaveLength(1)
  })

  it('L5: the request\'s facts carry the ceiling\'s and the grant\'s limits as stored', async () => {
    await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 40, loweredRev: 3, unitsMax: 7, bulkThreshold: 2, batchMax: 120, rev: 4 })
    const g = grantOf({ holder: `member:${ASKER}`, scopeKey: 'shop=store-a', perDay: 9, unitsMax: 6, ceilingRev: 3 })
    await insertGrant(db, g)
    const ctx = requestCtx({ nowMs: T0 })
    const f = await outboxFacts({ db, hubAccounts: async () => HUB_FACTS }).decideFacts(
      { operation: 'shopify.order.tag_add', args: tagArgs(1), accountId: 'shopify:store', accountGen: SHOP_GEN, scope: { shop: 'store-a' }, scopeKey: 'shop=store-a',
        records: 1, units: 1, effects: { money: false, customer: false, destructive: false, access: false }, memberMay: true, payloadHash: '0'.repeat(64), policyRev: POLICY_REV },
      ctx,
    )
    expect(f.ceiling['shopify.order.tag_add']).toEqual({ enabled: true, perDayMax: 40, loweredRev: 3, unitsMax: 7, bulkThreshold: 2, batchMax: 120, rev: 4 })
    expect(f.grants.find(x => x.id === g.id)).toMatchObject({ perDay: 9, unitsMax: 6, ceilingRev: 3 })
  })

  it('L6: "Always allow" makes a grant with the operation\'s defaults, and the list shows its limits', async () => {
    const ob = outbox(db, () => T0)
    const asked = await ob.request(requestCtx({ nowMs: T0 }), { operation: 'shopify.order.tag_add', args: tagArgs(42) }, { mode: 'tool' })
    expect(asked.outcome).toBe('waiting')
    if (asked.outcome !== 'waiting') return
    const answered = await ob.answer({ memberId: ASKER, role: 'member' }, asked.action.id, { choice: 'always', ifRev: asked.action.rev })
    expect('action' in answered && answered.action.grant_id).toMatch(/^pg_/)
    const defaults = grantDefaults('shopify.order.tag_add')
    expect(await db.prepare('SELECT per_day, units_max FROM permission_grants WHERE holder = ?').bind(`member:${ASKER}`).first())
      .toEqual({ per_day: defaults.perDay, units_max: defaults.unitsMax })
    const [p] = await openStores(env).permissions.list({ memberId: ASKER, role: 'member' })
    expect(p.limits).toEqual({ perDay: defaults.perDay, unitsMax: defaults.unitsMax, unitsLabel: 'orders', effectivePerDay: Math.min(defaults.perDay, 50) })
  })
})
