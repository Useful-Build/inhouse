// The gate and the pause hook on the real engine (N12). Ways it can fail, written down first:
//  1. `doPauseState` reads the object's flags differently from the engine (`isPaused`, `pauseGen`), so the gate's `do_gen`
//     never matches the dispatcher's `pauseGen` (nothing ever sends) or matches a stale one (a resume sends);
//  2. the hook doesn't run on Pause or on Resume, or syncs the state from before the change;
//  3. compose.ts doesn't register it, so a real BrandAgent's Pause leaves approvals claimable.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { inAgent } from '../testing/brand-agent/core-harness.ts'
import { p6Hooks } from '../do/brand-agent/compose.ts'
import type { BrandAgentParts } from '../do/brand-agent/ports.ts'
import { runInDurableObject } from 'cloudflare:test'
import { createLagTable, doPauseState, lagSince, noteLag, outboxPauseHook, readGate } from './gate.ts'
import { sweepOutbox } from './sweep.ts'
import { notices, world } from './test-support.ts'

const db = env.DB
const ADMIN = { kind: 'person' as const, memberId: 'm_admin' }

beforeEach(() => world(db))

describe('the object\'s pause state (failure 1)', () => {
  it('agrees with the engine across pauses and resumes, a restart included', () => inAgent(async h => {
    const same = () => expect(doPauseState(h.sql)).toEqual({ paused: h.core.isPaused(), pauseGen: h.core.pauseGen() })
    same()
    expect(doPauseState(h.sql)).toEqual({ paused: false, pauseGen: 0 })
    await h.core.pause(ADMIN)
    same()
    expect(doPauseState(h.sql)).toEqual({ paused: true, pauseGen: 1 })
    await h.core.pause(ADMIN)
    same()
    await h.core.resume(ADMIN)
    same()
    expect(doPauseState(h.restart().sql)).toEqual({ paused: false, pauseGen: 3 })
  }))
})

describe('the hook (failures 2 and 3)', () => {
  it('syncs the gate to the state after each Pause and Resume', () => inAgent(async h => {
    const told = notices()
    h.core.registerPauseHook(outboxPauseHook({ db, sql: h.sql, notify: told.notify }))
    const before = await readGate(db)
    await h.core.pause(ADMIN)
    expect(await readGate(db)).toMatchObject({ paused: 1, do_gen: 1, epoch: before.epoch + 1 })
    await h.core.resume(ADMIN)
    expect(await readGate(db)).toMatchObject({ paused: 0, do_gen: 2, epoch: before.epoch + 2 })
  }))

  it('is the pause hook compose.ts gives every BrandAgent', () => inAgent(async h => {
    const hooks = p6Hooks(env as unknown as Env, { sql: h.sql } as unknown as BrandAgentParts)
    expect(hooks.pause).toHaveLength(1)
    for (const hook of hooks.pause) h.core.registerPauseHook(hook)
    await h.core.pause(ADMIN)
    expect(await readGate(db)).toMatchObject({ paused: 1, do_gen: 1 })
  }))
})

describe("one task at a time (nit 11: the permit's deadline doesn't rely on it, but the pass is serial today)", () => {
  it('a pass runs the send tasks and the sweep one after another, never overlapping', () => {
    let running = 0
    let most = 0
    const order: string[] = []
    const slow = (name: string) => async () => {
      running++
      most = Math.max(most, running)
      order.push(`start:${name}`)
      await new Promise(r => setTimeout(r, 5))
      order.push(`end:${name}`)
      running--
      return { done: true as const }
    }
    return inAgent(async h => {
      h.sched.schedule({ id: 'outbox-send:ac_a', kind: 'outbox-send', dueAtMs: h.clock.now })
      h.sched.schedule({ id: 'outbox-send:ac_b', kind: 'outbox-send', dueAtMs: h.clock.now })
      h.sched.schedule({ id: 'outbox-sweep', kind: 'outbox-sweep', dueAtMs: h.clock.now })
      await h.tick(1_000)
      expect(most).toBe(1)
      expect(order.filter(o => o.startsWith('start'))).toHaveLength(3)
    }, { handlers: { 'outbox-send': slow('send'), 'outbox-sweep': slow('sweep') } })
  })
})

describe('the lag record (round 2: the gate signal measures from here)', () => {
  /** A D1 whose batches fail: the sync can't run. */
  const broken = { batch: async () => { throw new Error('D1 down') }, prepare: (q: string) => db.prepare(q) } as unknown as D1Database

  it('a failed hook sets it, a second failure keeps the first moment, a successful sync clears it', () => inAgent(async h => {
    createLagTable(h.sql)
    let failing = true
    const hook = outboxPauseHook({ db: new Proxy(db, { get: (t, k) => (failing ? Reflect.get(broken, k) : Reflect.get(t, k)) }) as D1Database, sql: h.sql, notify: notices().notify })
    h.core.registerPauseHook(hook)
    expect(lagSince(h.sql)).toBeNull()
    h.clock.now += 1_000
    await expect(h.core.pause(ADMIN)).rejects.toThrow()
    const first = lagSince(h.sql)
    expect(first).toEqual(expect.any(Number))
    h.clock.now += 60_000
    await expect(h.core.resume(ADMIN)).rejects.toThrow()
    expect(lagSince(h.sql)).toBe(first)
    failing = false
    await h.core.pause(ADMIN)
    expect(lagSince(h.sql)).toBeNull()
    expect(await readGate(db)).toMatchObject({ paused: 1, do_gen: h.core.pauseGen() })
  }))

  it('the sweep notes it when it finds the gate behind and clears it once synced', () => inAgent(async h => {
    createLagTable(h.sql)
    noteLag(h.sql, 3, 5)
    await h.core.pause(ADMIN)
    const lag = { note: (gen: number, at: number) => noteLag(h.sql, gen, at), clear: () => { createLagTable(h.sql); h.sql.exec('DELETE FROM outbox_lag') } }
    await sweepOutbox({ db, nowMs: 10, state: () => doPauseState(h.sql), lag, scheduler: { ensure: () => {} }, notify: notices().notify, requestId: 'sweep-lag' })
    expect(lagSince(h.sql)).toBeNull()
    expect(await readGate(db)).toMatchObject({ paused: 1, do_gen: 1 })
  }))

  it("BrandAgent's outboxLag() returns its generation and the lag's first moment", async () => {
    const stub = env.BRAND_AGENT.getByName(`lag-${Math.random()}`)
    expect(await stub.outboxLag()).toEqual({ pauseGen: 0, lagSinceMs: null })
    await runInDurableObject(stub, async (_i, state) => { noteLag(state.storage.sql, 2, 1_234) })
    expect(await stub.outboxLag()).toEqual({ pauseGen: 0, lagSinceMs: 1_234 })
  })
})

