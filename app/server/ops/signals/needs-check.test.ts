// Stage 1 M2-B's signals (N11). Ways they can fail: an open check doesn't show (or blocks a deploy instead of amber); a
// send stuck past a sweep stays green; a gate that disagrees with the agent for longer than a sweep stays green, or one
// that's merely mid-sync turns red.
import { describe, expect, it } from 'vitest'
import { gateSignal, needsCheckSignal, staleSendingSignal } from './needs-check.ts'

const NOW = 1_800_000_000_000
const health = (o: Partial<{ needsCheck: number; staleSending: number; paused: boolean; updatedAtMs: number }> = {}) =>
  ({ needsCheck: o.needsCheck ?? 0, staleSending: o.staleSending ?? 0, gate: { paused: o.paused ?? false, updatedAtMs: o.updatedAtMs ?? NOW } })

describe('the outbox signals', () => {
  it('an open check is amber, still ok, and counts', () => {
    expect(needsCheckSignal(health())).toEqual({ ok: true })
    expect(needsCheckSignal(health({ needsCheck: 2 }))).toEqual({ ok: true, amber: true, detail: '2 need a check' })
  })

  it('a send stuck past a sweep is red', () => {
    expect(staleSendingSignal(health())).toEqual({ ok: true })
    expect(staleSendingSignal(health({ staleSending: 1 }))).toEqual({ ok: false, detail: '1 sending past the deadline' })
  })

  it('a gate out of step for more than two sweeps is red; mid-sync it is green', () => {
    expect(gateSignal(health({ paused: false }), false, NOW)).toEqual({ ok: true })
    expect(gateSignal(health({ paused: false, updatedAtMs: NOW - 60_000 }), true, NOW)).toEqual({ ok: true })
    expect(gateSignal(health({ paused: false, updatedAtMs: NOW - 121_000 }), true, NOW)).toEqual({ ok: false, detail: 'gate open, agent paused' })
  })
})
