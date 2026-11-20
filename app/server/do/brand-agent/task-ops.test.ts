// PR 5, the due-task seams (asks D and E, `revive`): registry seeds, `poke` and `revive`. Expected values are literals
// written here (due times off the fake clock, payload strings, answers). Ways they can fail, written down first:
//  1. a declared seed isn't ensured on start, an existing seed's due time is moved, or an undeclared kind is seeded;
//  2. `poke` runs an unregistered kind, takes over another kind's task id, keeps a stale payload, or schedules a past
//     time in the past instead of now;
//  3. `revive` changes the payload, leaves attempts or the due time as they were, revives a task that wasn't
//     quarantined, one of another kind, or an unregistered kind; the runs signal clears while another task is still
//     quarantined.
import { describe, expect, it } from 'vitest'
import { MIN, inAgent } from '../../testing/brand-agent/core-harness.ts'
import type { Harness } from '../../testing/brand-agent/core-harness.ts'
import { registrySeeds, withSeed } from './scheduler.ts'
import type { TaskHandler } from './scheduler.ts'
import { poke, revive } from './task-ops.ts'

const done: TaskHandler = async () => ({ done: true })
const row = (h: Harness, id: string) => h.sql.exec<{ kind: string; due_at_ms: number; payload_json: string | null; attempts: number; state: string; gen: number; last_error: string | null }>(
  'SELECT kind, due_at_ms, payload_json, attempts, state, gen, last_error FROM due_tasks WHERE id = ?', id).toArray()[0] ?? null

describe('D: seeds a registry entry declares (failure 1)', () => {
  it('registrySeeds lists only declared seeds, with their kind', () => {
    expect(registrySeeds({ plain: done, beat: withSeed(done, { id: 'beat' }), other: withSeed(done, { id: 'other:main' }) }))
      .toEqual([{ id: 'beat', kind: 'beat' }, { id: 'other:main', kind: 'other' }])
  })

  it('ensureSeeds() creates a missing seed due now and never moves an existing one', () => inAgent(async h => {
    h.core.ensureSeeds()
    expect(row(h, 'beat')).toMatchObject({ kind: 'beat', due_at_ms: h.clock.now, payload_json: null, state: 'ready' })
    const first = h.clock.now
    h.clock.now += 5 * MIN
    const again = h.restart()
    expect(row(again, 'beat')).toMatchObject({ due_at_ms: first })
    // A kind with no seed declared is never seeded.
    expect(row(again, 'plain')).toBeNull()
  }, { handlers: { beat: withSeed(async () => ({ retryAtMs: 1, error: 'never runs here' }), { id: 'beat' }), plain: done } }))
})

describe('E: poke (failure 2)', () => {
  const handlers = { beat: done, other: done }

  it('schedules now, a past due time as now, a later one as given; drops any payload', () => inAgent(async h => {
    const now = h.clock.now
    poke(h.sched, h.sql, h.registry, now, { kind: 'beat', id: 'beat:poke' })
    expect(row(h, 'beat:poke')).toMatchObject({ kind: 'beat', due_at_ms: now, payload_json: null, attempts: 0, state: 'ready' })
    h.sched.schedule({ id: 'beat:held', kind: 'beat', dueAtMs: now + 9 * MIN, payload: { keep: 'me' } })
    poke(h.sched, h.sql, h.registry, now, { kind: 'beat', id: 'beat:held', dueAtMs: now - 3 * MIN })
    expect(row(h, 'beat:held')).toMatchObject({ due_at_ms: now, payload_json: null })
    poke(h.sched, h.sql, h.registry, now, { kind: 'beat', id: 'beat:later', dueAtMs: now + 2 * MIN })
    expect(row(h, 'beat:later')).toMatchObject({ due_at_ms: now + 2 * MIN })
  }, { handlers }))

  it('refuses an unregistered kind, and an id another kind holds', () => inAgent(async h => {
    const now = h.clock.now
    expect(() => poke(h.sched, h.sql, h.registry, now, { kind: 'no-such', id: 'x' })).toThrow('unregistered kind no-such')
    expect(row(h, 'x')).toBeNull()
    h.sched.schedule({ id: 'shared', kind: 'other', dueAtMs: now + MIN, payload: [1] })
    expect(() => poke(h.sched, h.sql, h.registry, now, { kind: 'beat', id: 'shared' })).toThrow('is a other task')
    expect(row(h, 'shared')).toMatchObject({ kind: 'other', due_at_ms: now + MIN, payload_json: '[1]' })
  }, { handlers }))
})

describe('revive (failure 3)', () => {
  const failing: TaskHandler = async (_t, ctx) => ({ retryAtMs: ctx.nowMs, error: 'still broken' })
  /** Runs the failing task until the scheduler quarantines it (10 attempts). */
  const quarantine = async (h: Harness, id: string, payload: unknown) => {
    h.sched.schedule({ id, kind: 'flaky', dueAtMs: h.clock.now, payload })
    for (let i = 0; i < 10; i++) await h.tick(1)
    expect(row(h, id)).toMatchObject({ state: 'quarantined', attempts: 10 })
  }

  it('one quarantined task: ready, attempts 0, due now, its payload kept byte for byte; it runs again with it', async () => {
    const seen: unknown[] = []
    let broken = true
    await inAgent(async h => {
      const payload = { turnId: 't_x', structuredOutput: { b: [2, 1], a: 'é' }, failure: null }
      await quarantine(h, 'flaky:s1', payload)
      const before = row(h, 'flaky:s1')!
      h.clock.now += 7 * MIN
      expect(revive(h.sched, h.registry, { kind: 'flaky', id: 'flaky:s1' })).toBe('revived')
      const after = row(h, 'flaky:s1')!
      expect(after.payload_json).toBe(before.payload_json)
      expect(after.payload_json).toBe('{"turnId":"t_x","structuredOutput":{"b":[2,1],"a":"é"},"failure":null}')
      expect(after).toMatchObject({ state: 'ready', attempts: 0, due_at_ms: h.clock.now, last_error: null })
      expect(after.gen).toBeGreaterThan(before.gen)
      broken = false
      await h.tick(1)
      expect(seen).toEqual([payload])
      expect(row(h, 'flaky:s1')).toBeNull()
    }, { handlers: { flaky: async (t, ctx) => (broken ? failing(t, ctx) : (seen.push(t.payload), { done: true })) } })
  })

  it('a ready task is not_quarantined and untouched; a missing id or another kind is not_found; an unknown kind throws', () => inAgent(async h => {
    h.sched.schedule({ id: 'flaky:ready', kind: 'flaky', dueAtMs: h.clock.now + 4 * MIN, payload: { p: 1 } })
    const before = row(h, 'flaky:ready')
    expect(revive(h.sched, h.registry, { kind: 'flaky', id: 'flaky:ready' })).toBe('not_quarantined')
    expect(row(h, 'flaky:ready')).toEqual(before)
    expect(revive(h.sched, h.registry, { kind: 'flaky', id: 'flaky:none' })).toBe('not_found')
    await quarantine(h, 'flaky:q', null)
    const q = row(h, 'flaky:q')
    expect(revive(h.sched, h.registry, { kind: 'other', id: 'flaky:q' })).toBe('not_found')
    expect(row(h, 'flaky:q')).toEqual(q)
    expect(() => revive(h.sched, h.registry, { kind: 'no-such', id: 'flaky:q' })).toThrow('unregistered kind no-such')
    expect(row(h, 'flaky:q')).toEqual(q)
  }, { handlers: { flaky: failing, other: done } }))

  it('the runs signal stays red until no quarantined task remains', async () => {
    let broken = true
    await inAgent(async h => {
      await quarantine(h, 'flaky:a', 1)
      await quarantine(h, 'flaky:b', 2)
      const red = () => h.core.runsHealth(h.sched.quarantinedCount()).quarantined
      expect(red()).toEqual({ ok: false, detail: '2 quarantined' })
      broken = false
      revive(h.sched, h.registry, { kind: 'flaky', id: 'flaky:a' })
      await h.tick(1)
      expect(red()).toEqual({ ok: false, detail: '1 quarantined' })
      revive(h.sched, h.registry, { kind: 'flaky', id: 'flaky:b' })
      await h.tick(1)
      expect(red()).toEqual({ ok: true, detail: '0 quarantined' })
    }, { handlers: { flaky: async (t, ctx) => (broken ? failing(t, ctx) : { done: true }) } })
  })
})
