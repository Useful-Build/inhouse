// evals/run.ts's stop handlers, in a module of their own so a test can drive them (run.ts is a script that runs on import).
import { CANCEL_SIGNALS, signalHost, type SignalHost } from './signals.ts'
import { shieldWranglerCalls } from './targets/door.ts'

/**
 * On SIGINT, SIGHUP or SIGTERM: the target gives back what it holds (the eval lease), then the process exits 130, 129 or 143.
 * One give-back per run: a later signal while it runs is said and ignored, so a second Ctrl-C, or a SIGINT then a SIGTERM,
 * can't start a second `close()` beside the first or cut it short; from the first signal on the wrangler calls run out of its
 * reach (#716).
 */
export function giveBackOnSignals(close: () => Promise<boolean>, d: SignalHost = signalHost()): void {
  let stopping = false
  for (const [signal, code] of CANCEL_SIGNALS) {
    d.on(signal, () => {
      if (stopping) {
        d.error(`${signal} again: still giving back the eval lease`)
        return
      }
      stopping = true
      shieldWranglerCalls()
      d.error(`${signal}: giving back the eval lease before exiting`)
      void close().then(() => d.exit(code))
    })
  }
}
