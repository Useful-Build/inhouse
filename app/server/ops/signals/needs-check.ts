// Stage 1 M2-B's health signals (N11):
// - `outbox_needs_check`: amber (ok, so it never blocks a deploy, a rollback or the release smoke) while any action needs
//   a person's check; a monitor that reads the signals raises it. A count only.
// - `outbox_sending_stale`: red when a row is still `sending` a sweep past its deadline (the sweep isn't running).
// - `outbox_gate`: red when the gate and BrandAgent disagree about Pause for longer than a sweep (the pause hook failed
//   and the sweep hasn't repaired it). Nothing is claimed meanwhile, so it's safe, but nothing sends either.
import { brandAgent } from '../../do/brand-agent/client.ts'
import { timing } from '../../outbox/timing.ts'
import type { Signal, SignalResult } from './types.ts'

type Health = { needsCheck: number; staleSending: number; gate: { paused: boolean; updatedAtMs: number } }

export const needsCheckSignal = (h: Health): SignalResult =>
  h.needsCheck > 0 ? { ok: true, amber: true, detail: `${h.needsCheck} need a check` } : { ok: true }

export const staleSendingSignal = (h: Health): SignalResult =>
  h.staleSending > 0 ? { ok: false, detail: `${h.staleSending} sending past the deadline` } : { ok: true }

export const gateSignal = (h: Health, objectPaused: boolean, nowMs: number): SignalResult =>
  h.gate.paused !== objectPaused && nowMs - h.gate.updatedAtMs > 2 * timing().sweepEveryMs
    ? { ok: false, detail: `gate ${h.gate.paused ? 'paused' : 'open'}, agent ${objectPaused ? 'paused' : 'running'}` }
    : { ok: true }

export function outboxSignals(now: () => number = () => Date.now()): readonly Signal[] {
  return [
    { name: 'outbox_needs_check', check: async ({ stores }) => needsCheckSignal(await stores.outbox.health(now())) },
    { name: 'outbox_sending_stale', check: async ({ stores }) => staleSendingSignal(await stores.outbox.health(now())) },
    {
      name: 'outbox_gate',
      async check({ env, stores }) {
        const [h, p] = await Promise.all([stores.outbox.health(now()), brandAgent(env).getPause()])
        return gateSignal(h, p.paused, now())
      },
    },
  ]
}
