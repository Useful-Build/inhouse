// The eval write log end to end on real D1 (Stage 1 M3-R, N30; Q3 = D). In the eval deployment the hub's
// EvalWriteGateway and the product Worker share one database (the eval hub binds it as EVAL_WRITE_LOG), so here the
// gateway's core (`evalWrite`) runs on the same D1 the outbox uses, and the harness's write door (evals/targets/write-door.ts)
// seeds and reads it through plain SQL as `wrangler d1 execute` would. Ways it can fail, written down first:
//  1. a door-seeded ceiling and grant don't give a `run`, or the send doesn't land in the log as the request was made
//     (operation, arguments, account, the expected generation and shop, the action and its attempt), or the door can't
//     read it back;
//  2. a write that wasn't approved reaches the log (no grant: a card waits, nothing is sent);
//  3. a fault set by the door isn't played, is played more often than asked, or answers the outbox wrongly (refuse must
//     be a sure `no`, unknown an unclear answer, throttle a sure `no` with its wait);
//  4. the gateway writes or claims a send with no log bound, or logs a request the contract refuses;
//  5. the door's reset leaves anything a later case-repeat could inherit (the log, a fault, an open action, a grant, the
//     ceiling), or the door builds a statement from a value it didn't check.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { evalWrite, evalWriteRef } from '../../hub/testing/eval-write.ts'
import type { WriteGateway, WriteRequest } from '../../hub/index/contract.ts'
import { DoorRefusal } from '../../evals/targets/sql.ts'
import type { RunSql } from '../../evals/targets/sql.ts'
import { SHOPIFY_ACCOUNT, createWriteDoor } from '../../evals/targets/write-door.ts'
import { ACCOUNT_IDS } from './facts.ts'
import { sendAction } from './dispatch.ts'
import { ASKER, SHOP_GEN, fresh, notices, outbox, requestCtx, rowOf, tagArgs, world } from './test-support.ts'

const db = env.DB
const T0 = 1_800_000_000_000
const HOLD_OVER = T0 + 10_000
const OP = 'shopify.order.tag_add' as const
const statements: string[] = []
const run: RunSql = async sql => {
  statements.push(sql)
  return (await db.prepare(sql).all<Record<string, unknown>>()).results
}
const door = createWriteDoor(run, () => String(T0))
/** The eval hub's gateway, on this D1 (the eval hub binds the product's database). */
const gateway = (nowMs: number): WriteGateway => ({ runAction: req => evalWrite(db, req, nowMs) })

beforeEach(async () => {
  await world(db)
  // From writes off: the door's own reset clears the ceiling `world` set.
  await door.resetWrites()
  statements.length = 0
})

const ask = (order = 1) => outbox(db, () => T0).request(requestCtx({ nowMs: T0 }), { operation: OP, args: tagArgs(order) }, { mode: 'tool' })
const send = (id: string) => sendAction(id, { db, nowMs: HOLD_OVER, hub: gateway(HOLD_OVER), notify: notices().notify, requestId: fresh('send'), again: () => {}, gate: { paused: false, pauseGen: 0 }, timeoutMs: 5_000 })
const seeded = async () => {
  await door.setCeiling(OP, 50)
  return door.grant({ memberId: ASKER, operation: OP, perDay: 5 })
}
const request = (o: Partial<WriteRequest> = {}): WriteRequest => ({
  actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA', attempt: 1, requestId: 'req-1', accountId: SHOPIFY_ACCOUNT,
  expect: { connectedAtMs: SHOP_GEN, shop: 'store-a' }, operation: OP, args: tagArgs(7), ...o,
})

describe('a door-seeded ceiling and grant give a run that lands in the log (failures 1 and 2)', () => {
  it('runs under the seeded grant, and the send is logged as it was made and read back by the door', async () => {
    const g = await seeded()
    const r = await ask(1)
    expect(r.outcome).toBe('approved')
    if (r.outcome !== 'approved') return
    expect(r.action).toMatchObject({ verdict: 'run', grant_id: g, approved_by: `grant:${g}` })
    await send(r.action.id)
    const log = await door.writeLog()
    expect(log).toEqual([{
      n: expect.any(Number), atMs: HOLD_OVER, actionId: r.action.id, attempt: 1, requestId: expect.any(String), accountId: 'shopify:store',
      operation: OP, args: tagArgs(1), expect: { connectedAtMs: SHOP_GEN, shop: 'store-a' }, item: null, idempotencyKey: null, outcome: 'sent',
    }])
    const row = await rowOf(db, r.action.id)
    expect(row).toMatchObject({ state: 'sent' })
    expect(JSON.parse(row!.result_json!)).toEqual({ ref: evalWriteRef(log[0]!.n) })
  })

  it('logs nothing for an action no one approved: without a grant it waits on a card', async () => {
    await door.setCeiling(OP, 50)
    const r = await ask(2)
    expect(r.outcome).toBe('waiting')
    expect(await door.writeLog()).toEqual([])
  })

  it('the door seeds on the outbox\'s own account, and refuses a grant the outbox would never make', async () => {
    expect(SHOPIFY_ACCOUNT).toBe(ACCOUNT_IDS.shopify)
    // The operation is off: no grant.
    await expect(door.grant({ memberId: ASKER, operation: OP, perDay: 5 })).rejects.toThrow(DoorRefusal)
    await door.setCeiling(OP, 50)
    // Not an active person.
    await expect(door.grant({ memberId: 'm_nobody', operation: OP, perDay: 5 })).rejects.toThrow(/isn't an active person/)
    // A Slack operation has no Shopify store scope.
    await expect(door.grant({ memberId: ASKER, operation: 'slack.channel.post', perDay: 5 })).rejects.toThrow(/not a Shopify write operation/)
  })
})

describe('the door\'s faults, as the outbox reads them (failure 3)', () => {
  it('refuse fails the action, sure nothing went out; unknown leaves it for a check; each logged with what it played', async () => {
    await seeded()
    await door.setWriteFault(OP, 'refuse')
    const a = await ask(3)
    if (a.outcome !== 'approved') throw new Error(a.outcome)
    await send(a.action.id)
    expect(await rowOf(db, a.action.id)).toMatchObject({ state: 'failed', error_code: 'upstream_rejected' })
    await door.setWriteFault(OP, 'unknown')
    const b = await ask(4)
    if (b.outcome !== 'approved') throw new Error(b.outcome)
    await send(b.action.id)
    expect(await rowOf(db, b.action.id)).toMatchObject({ state: 'needs_check' })
    expect((await door.writeLog()).map(l => [l.actionId, l.outcome])).toEqual([[a.action.id, 'refuse'], [b.action.id, 'unknown']])
  })

  it('plays a fault exactly `times` times, then sends; throttle carries its wait; a cleared fault is gone', async () => {
    await door.setWriteFault(OP, 'throttle', { times: 2, retryAfterMs: 3_000 })
    const throttled = { ok: false, error: { code: 'rate_limited', message: 'rate limited by the upstream: eval_fault', retryAfterMs: 3_000 }, sent: 'no' }
    expect(await evalWrite(db, request({ attempt: 1 }), T0)).toEqual(throttled)
    expect(await evalWrite(db, request({ attempt: 2 }), T0)).toEqual(throttled)
    expect(await evalWrite(db, request({ attempt: 3 }), T0)).toMatchObject({ ok: true })
    await door.setWriteFault(OP, 'refuse', { times: 5 })
    await door.setWriteFault(OP, null)
    expect(await evalWrite(db, request({ attempt: 4, item: { n: 2, of: 3 }, idempotencyKey: 'ac_AAAAAAAAAAAAAAAAAAAAAA:2' }), T0)).toMatchObject({ ok: true })
    const log = await door.writeLog()
    expect(log.map(l => [l.attempt, l.outcome])).toEqual([[1, 'throttle'], [2, 'throttle'], [3, 'sent'], [4, 'sent']])
    expect(log[3]).toMatchObject({ item: { n: 2, of: 3 }, idempotencyKey: 'ac_AAAAAAAAAAAAAAAAAAAAAA:2' })
  })
})

describe('the gateway refuses rather than pretends (failure 4)', () => {
  it('with no log bound it answers not_configured, sure nothing went out', async () => {
    expect(await evalWrite(undefined, request(), T0)).toEqual({ ok: false, error: { code: 'not_configured', message: 'connector not configured: eval_write_log' }, sent: 'no' })
  })
  it('a request the contract refuses is invalid_args and never logged', async () => {
    for (const bad of [{ ...request(), operation: 'shopify.order.cancel' }, { ...request(), attempt: 0 }, { ...request(), extra: 1 }, null, 'x']) {
      expect(await evalWrite(db, bad, T0)).toMatchObject({ ok: false, error: { code: 'invalid_args' }, sent: 'no' })
    }
    expect(await door.writeLog()).toEqual([])
  })
})

describe('the door\'s reset and its input checks (failure 5)', () => {
  it('clears the log, the faults, open actions, grants and the ceiling, and writes are off again', async () => {
    await seeded()
    const r = await ask(5)
    if (r.outcome !== 'approved') throw new Error(r.outcome)
    await send(r.action.id)
    await door.setCeiling(OP, 50)
    const waiting = await (async () => {
      await db.prepare('DELETE FROM permission_grants').run()
      const w = await ask(6)
      if (w.outcome !== 'waiting') throw new Error(w.outcome)
      return w.action.id
    })()
    await door.setWriteFault(OP, 'refuse')
    await door.resetWrites()
    expect(await door.writeLog()).toEqual([])
    expect(await rowOf(db, waiting)).toBeNull()
    // The sent action is final: the reset keeps it (retention's), only open actions go.
    expect(await rowOf(db, r.action.id)).toMatchObject({ state: 'sent' })
    for (const t of ['eval_write_fault', 'permission_grants', 'permission_uses', 'permission_ceiling']) {
      expect((await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n, t).toBe(0)
    }
    expect(await ask(7)).toMatchObject({ outcome: 'refused', reason: 'over_ceiling' })
  })

  it('refuses a value it didn\'t check before any statement runs', async () => {
    const bad: [string, () => Promise<unknown>][] = [
      ['an unknown operation', () => door.setCeiling('shopify.order.cancel' as typeof OP, 5)],
      ['a fractional limit', () => door.setCeiling(OP, 1.5)],
      ['a zero limit', () => door.setCeiling(OP, 0)],
      ['a quoted member id', () => door.grant({ memberId: "m'; DROP TABLE members; --", operation: OP, perDay: 5 })],
      ['a huge daily limit', () => door.grant({ memberId: ASKER, operation: OP, perDay: 1e9 })],
      ['an unknown fault', () => door.setWriteFault(OP, 'explode' as 'refuse')],
      ['a wait on a refuse', () => door.setWriteFault(OP, 'refuse', { retryAfterMs: 5 })],
      ['zero times', () => door.setWriteFault(OP, 'unknown', { times: 0 })],
    ]
    for (const [name, call] of bad) await expect(call(), name).rejects.toThrow(DoorRefusal)
    expect(statements).toEqual([])
  })
})
