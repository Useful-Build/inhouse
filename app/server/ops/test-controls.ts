// The test build's controls (P4 wave 4, p4-w6.md OC 2), Worker side. Import it only as `@test-controls`: `vite build
// --mode product-test` resolves that to this file, every other build to test-controls-off.ts, so this never enters the
// deployable Worker (scripts/check-product-build.mjs scans for the canary below and for this module). Reached only
// through route 67 (alarm-now.ts), inside `if (__INHOUSE_TEST_BUILD__ && env.INHOUSE_TEST_BUILD === '1')`: the
// generic alarm-now control, and the two routine controls W6's slot specs need (p4-w6.md section 3): stop a tick after
// its batch, and seed a routine's `checked_until_ms`. The one hook product code calls, `afterTickBatch` (routines/tick.ts),
// does nothing in the off module, so the product build holds no test branch.

/** The bundle-scan canary: it must be in the test build's Worker and never in the deployable one. */
export const TEST_CONTROLS_CANARY = 'inhouse-test-controls-canary-5d81e0a7'

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

/** Clears the switch, armed or not: the tests' fresh state (routines/test-kit.ts `fresh`), so an unconsumed arm can't leak. */
export function resetTestControls(): void {
  stopAfterBatch = false
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
