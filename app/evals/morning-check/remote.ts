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
}

export function remoteEnv(d: RemoteDeps): RunnerEnv {
  return {
    nowMs: d.nowMs,
    useShop: host => d.door.setShop(host),
    releaseShop: () => d.door.clearShop(),
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
