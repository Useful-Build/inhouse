// Stage 1 M2-B's signals (N11). Ways they can fail: an open check doesn't show (or blocks a deploy instead of amber); a
// send stuck past a sweep stays green; a gate behind the agent's pause generation for longer than two sweeps stays
// green (a gate whose `paused` agrees but whose generation is behind included), or one merely mid-sync turns red.
import { describe, expect, it } from 'vitest'
import { gateSignal, needsCheckSignal, staleSendingSignal } from './needs-check.ts'

const NOW = 1_800_000_000_000
const health = (o: Partial<{ needsCheck: number; staleSending: number; paused: boolean; doGen: number; updatedAtMs: number }> = {}) =>
  ({ needsCheck: o.needsCheck ?? 0, staleSending: o.staleSending ?? 0, gate: { paused: o.paused ?? false, doGen: o.doGen ?? 2, updatedAtMs: o.updatedAtMs ?? NOW - 3_600_000 } })

describe('the outbox signals', () => {
  it('an open check is amber, still ok, and counts', () => {
    expect(needsCheckSignal(health())).toEqual({ ok: true })
    expect(needsCheckSignal(health({ needsCheck: 2 }))).toEqual({ ok: true, amber: true, detail: '2 need a check' })
  })

  it('a send stuck past a sweep is red', () => {
    expect(staleSendingSignal(health())).toEqual({ ok: true })
    expect(staleSendingSignal(health({ staleSending: 1 }))).toEqual({ ok: false, detail: '1 sending past the deadline' })
  })

  it('a gate behind for more than two sweeps is red, by generation, timed from when it was first seen behind', () => {
    // In step, however long since the last sync.
    expect(gateSignal(health({ doGen: 2 }), { pauseGen: 2, lagSinceMs: null }, NOW)).toEqual({ ok: true })
    // Behind, but a sync is in flight (not yet seen behind by a failed sync or a sweep), or seen only a minute ago.
    expect(gateSignal(health({ doGen: 2 }), { pauseGen: 4, lagSinceMs: null }, NOW)).toEqual({ ok: true })
    expect(gateSignal(health({ doGen: 2 }), { pauseGen: 4, lagSinceMs: NOW - 60_000 }, NOW)).toEqual({ ok: true })
    // Behind by generation with `paused` agreeing (a fast Pause then Resume whose hooks failed), for over two sweeps.
    expect(gateSignal(health({ doGen: 2, paused: false }), { pauseGen: 4, lagSinceMs: NOW - 121_000 }, NOW))
      .toEqual({ ok: false, detail: 'gate at generation 2, agent at 4' })
  })
})
