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
import { doPauseState, outboxPauseHook, readGate } from './gate.ts'
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
    h.core.registerPauseHook(outboxPauseHook({ db, state: () => doPauseState(h.sql), notify: told.notify }))
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
