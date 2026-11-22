// The remote mode's runner env (run.mjs --target, and the scripted proof e2e/api/morning-check-remote.spec.ts): a deployed
// build answers, so there's no restart per case. The case's shop is the test shop override the door writes in the build's
// D1 (door.ts), the slot is read back through the same door, and the run's HTTP calls are the caller's (run.mjs mints its
// own tokens, the spec uses its kit). Route 67 (the scheduler nudge) is the test build's only, behind a release token:
// with no `alarm`, Run now's own poke and the scheduler's heartbeat move the slot, and the polls just wait (with the case's
// deadline, as ever).
import type { MorningDoor } from './door.ts'
import type { RunnerEnv } from './runner.ts'

export interface RemoteDeps {
  door: MorningDoor
  /** Presses Run now (route 54) as a person with this key; throws on any answer but 2xx. */
  runNow(clientKey: string): Promise<void>
  /** Route 67 (`POST /api/ops/alarm`, release token, test build only); null where there's no release token (the eval build). */
  alarm: ((body: { action: 'alarm'; pokeTick?: true }) => Promise<void>) | null
  pause(): Promise<void>
  nowMs(): number
  caseTimeoutMs: number
  settleMs: number
  /** Where a loud line goes (default console.error): a leftover override found by the run's first clear. */
  warn?(line: string): void
}

export function remoteEnv(d: RemoteDeps): RunnerEnv {
  const warn = d.warn ?? (line => console.error(line))
  let first = true
  return {
    nowMs: d.nowMs,
    useShop: host => d.door.setShop(host),
    // runAll's first clear is the run's start: a row there is a leftover from a run that didn't clear (or one running now:
    // one runner per deployment), said loudly. Later clears remove the case's own row.
    async releaseShop() {
      const removed = await d.door.clearShop()
      if (first && removed !== null) warn(`morning-check: removed a leftover test shop override (${removed}) at the start of the run. Another run may not have cleared it, or one is running against this deployment now: only one runner per deployment.`)
      first = false
    },
    newKey: () => crypto.randomUUID().replaceAll('-', ''),
    async trigger(clientKey) {
      await d.runNow(clientKey)
      if (d.alarm) await d.alarm({ action: 'alarm', pokeTick: true })
    },
    async nudge() {
      if (d.alarm) await d.alarm({ action: 'alarm' })
    },
    pause: d.pause,
    reader: d.door,
    caseTimeoutMs: d.caseTimeoutMs,
    settleMs: d.settleMs,
  }
}

export interface SignalDeps {
  on(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void
  exit(code: number): void
  error(line: string): void
}
const processSignals: SignalDeps = { on: (s, h) => void process.once(s, h), exit: code => process.exit(code), error: line => console.error(line) }

/**
 * run.mjs's stop handlers: on SIGINT or SIGTERM the door is closed first (runAll may still be going, and its next setShop
 * must not write an override after the clear), then the override is cleared (awaited) before the process exits 130 or 143,
 * so an interrupted run leaves no override behind. A clear that fails is printed; the exit code stays the signal's.
 */
export function clearOnSignals(door: Pick<MorningDoor, 'close' | 'clearShop'>, d: SignalDeps = processSignals): void {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    d.on(signal, () => {
      door.close()
      d.error(`run.mjs: ${signal}: clearing the test shop override before exiting`)
      door.clearShop().then(
        () => d.exit(code),
        (e: unknown) => {
          d.error(`run.mjs: the test shop override could not be cleared: ${e instanceof Error ? e.message : String(e)}`)
          d.exit(code)
        },
      )
    })
  }
}
