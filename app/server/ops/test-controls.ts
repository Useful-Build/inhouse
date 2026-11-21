// The test build's controls (P4 wave 4, p4-w6.md OC 2), Worker side. Import it only as `@test-controls`: `vite build
// --mode product-test` resolves that to this file, every other build to test-controls-off.ts, so this never enters the
// deployable Worker (scripts/check-product-build.mjs scans for the canary below and for this module). Reached only
// through route 67 (alarm-now.ts), inside `if (__INHOUSE_TEST_BUILD__ && env.INHOUSE_TEST_BUILD === '1')`. P4 adds
// the generic alarm-now control here; the routine-specific controls come with W2's tick.

/** The bundle-scan canary: it must be in the test build's Worker and never in the deployable one. */
export const TEST_CONTROLS_CANARY = 'inhouse-test-controls-canary-5d81e0a7'

/**
 * Runs one scheduler pass now (the BrandAgent's `alarm()` body), for specs that can't wait for the runtime's alarm.
 * The caller runs it inside `blockConcurrencyWhile`, so it never interleaves with another event on the object.
 */
export async function runAlarmNow(pass: () => Promise<void>): Promise<{ ran: true }> {
  console.log({ event: 'test_control', control: 'alarm_now', canary: TEST_CONTROLS_CANARY })
  await pass()
  return { ran: true }
}
