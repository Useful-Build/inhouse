// Stage 1 M2-B's health signals (N11):
// - `outbox_needs_check`: amber (ok, so it never blocks a deploy, a rollback or the release smoke) while any action needs
//   a person's check; a monitor that reads the signals raises it. A count only.
// - `outbox_sending_stale`: red when a row is still `sending` a sweep past its deadline (the sweep isn't running).
// - `outbox_gate`: red when the gate's `do_gen` has been behind BrandAgent's `pause_gen` for longer than two sweeps,
//   measured from when the object first saw it behind (a failed sync, or the sweep finding it so; gate.ts `noteLag`),
//   never from the last sync, so a sync merely in flight stays green. Nothing is claimed meanwhile, so it's safe, but
//   nothing sends either.
import { brandAgent } from '../../do/brand-agent/client.ts'
import { timing } from '../../outbox/timing.ts'
import type { Signal, SignalResult } from './types.ts'

type Health = { needsCheck: number; staleSending: number; gate: { paused: boolean; doGen: number; updatedAtMs: number } }
/** What BrandAgent says: its pause generation, and since when it has seen the gate behind (null: not behind). */
export type Lag = { pauseGen: number; lagSinceMs: number | null }

export const needsCheckSignal = (h: Health): SignalResult =>
  h.needsCheck > 0 ? { ok: true, amber: true, detail: `${h.needsCheck} need a check` } : { ok: true }

export const staleSendingSignal = (h: Health): SignalResult =>
  h.staleSending > 0 ? { ok: false, detail: `${h.staleSending} sending past the deadline` } : { ok: true }

export const gateSignal = (h: Health, lag: Lag, nowMs: number): SignalResult =>
  h.gate.doGen !== lag.pauseGen && lag.lagSinceMs !== null && nowMs - lag.lagSinceMs > 2 * timing().sweepEveryMs
    ? { ok: false, detail: `gate at generation ${h.gate.doGen}, agent at ${lag.pauseGen}` }
    : { ok: true }

export function outboxSignals(now: () => number = () => Date.now()): readonly Signal[] {
  return [
    { name: 'outbox_needs_check', check: async ({ stores }) => needsCheckSignal(await stores.outbox.health(now())) },
    { name: 'outbox_sending_stale', check: async ({ stores }) => staleSendingSignal(await stores.outbox.health(now())) },
    {
      name: 'outbox_gate',
      async check({ env, stores }) {
        const [h, lag] = await Promise.all([stores.outbox.health(now()), brandAgent(env).outboxLag()])
        return gateSignal(h, lag, now())
      },
    },
  ]
}
