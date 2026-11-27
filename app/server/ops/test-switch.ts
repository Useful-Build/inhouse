// Whether the test build's controls are switched on at run time (#460 review, Neon): the eval build never, and a
// test-compiled Worker only with `INHOUSE_TEST_BUILD` set to "1", as route 67 (alarm-now.ts) gates every control. Used
// where a control is reached without route 67: the BrandAgent's constructor (the kept job timings) and `testObserve`.
// In every other build `@test-controls` is the off module already; this adds the run-time switch on top.
declare const __INHOUSE_EVAL_BUILD__: boolean

export function testControlsOn(env: object, evalBuild: boolean = __INHOUSE_EVAL_BUILD__): boolean {
  return !evalBuild && (env as { INHOUSE_TEST_BUILD?: unknown }).INHOUSE_TEST_BUILD === '1'
}
