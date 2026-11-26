// The test build's controls (P4 wave 4, p4-w6.md OC 2), Worker side. Import it only as `@test-controls`: `vite build
// --mode product-test` resolves that to this file, every other build to test-controls-off.ts, so this never enters the
// deployable Worker (scripts/check-product-build.mjs scans for the canary below and for this module). Reached only
// through route 67 (alarm-now.ts), inside `if (__INHOUSE_TEST_BUILD__ && env.INHOUSE_TEST_BUILD === '1')`: the
// generic alarm-now control, routine controls and job test controls. The off module has no test behavior.

/** The bundle-scan canary: it must be in the test build's Worker and never in the deployable one. */
export const TEST_CONTROLS_CANARY = 'inhouse-test-controls-canary-5d81e0a7'
export { crashResumeProbe } from '../do/brand-agent/test-crash-resume.ts'

/**
 * Runs one scheduler pass now (the BrandAgent's `alarm()` body), for specs that can't wait for the runtime's alarm.
 * It may overlap the runtime's own pass; the scheduler's handlers are idempotent by task id (BrandAgent.testRunAlarm).
 */
export async function runAlarmNow(pass: () => Promise<void>): Promise<{ ran: true }> {
  console.log({ event: 'test_control', control: 'alarm_now', canary: TEST_CONTROLS_CANARY })
  await pass()
  return { ran: true }
}

/**
 * The stop-after-batch switch. Module state, so it lives in the isolate of the BrandAgent that armed it, where the tick
 * runs (the brand has one object). One-shot: the next tick pass that reaches its hook clears it.
 */
let stopAfterBatch = false

/** Arms the switch: the next tick pass throws right after its decide batches commit (a crash between slot row and run). */
export function armStopAfterBatch(): { armed: true } {
  console.log({ event: 'test_control', control: 'stop_after_batch', canary: TEST_CONTROLS_CANARY })
  stopAfterBatch = true
  return { armed: true }
}

// Set via RPC on the BrandAgent so the reads and writes happen in the same isolate. Eviction clears the overrides.
let timings = new Map<string, number>()

/** Replaces the entire set. Pass an empty object in teardown to restore the defaults. */
export function setTimings(overrides: Record<string, number>): { set: true } {
  console.log({ event: 'test_control', control: 'set_timings', canary: TEST_CONTROLS_CANARY })
  timings = new Map(Object.entries(overrides))
  return { set: true }
}

export function timing(name: string, fallback: number): number {
  return timings.get(name) ?? fallback
}

/** Hard kill, not a runner stop: the existing monitor detects the exit. Never starts a container. */
export async function killRunner(container: { readonly running: boolean; destroy(): Promise<void> } | undefined): Promise<{ killed: boolean }> {
  if (!container?.running) return { killed: false }
  console.log({ event: 'test_control', control: 'kill_runner', canary: TEST_CONTROLS_CANARY })
  await container.destroy()
  return { killed: true }
}

/** Restores the tests' fresh state (routines/test-kit.ts `fresh`). */
export function resetTestControls(): void {
  stopAfterBatch = false
  timings.clear()
}

/** The tick's hook, called after its decide step (routines/tick.ts). Throws once when armed, and clears the switch. */
export function afterTickBatch(): void {
  if (!stopAfterBatch) return
  stopAfterBatch = false
  console.log({ event: 'test_control', control: 'stopped_after_batch', canary: TEST_CONTROLS_CANARY })
  throw new Error('test control: the tick stopped after its batch')
}

/**
 * Sets one live routine's cursor to `checkedUntilMs` (the caller checks it's in the past), for the missed-run and
 * catch-up cases. `rev` is left alone: a pass that read the old cursor finds its gated update matches nothing and decides
 * again next pass (tick.ts `decideRoutine`). `{ seeded: false }` when no live routine has that id.
 */
export async function seedCursor(db: D1Database, routineId: string, checkedUntilMs: number): Promise<{ seeded: boolean }> {
  console.log({ event: 'test_control', control: 'seed_cursor', canary: TEST_CONTROLS_CANARY })
  const res = await db.prepare('UPDATE routines SET checked_until_ms = ? WHERE id = ? AND deleted_at_ms IS NULL')
    .bind(checkedUntilMs, routineId).run()
  return { seeded: res.meta.changes === 1 }
}
