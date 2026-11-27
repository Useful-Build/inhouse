// What `@test-controls` resolves to in every build but the test build (vite.config.ts): the test controls switched
// off, so server/ops/test-controls.ts never enters the deployable Worker's module graph, whatever imports it. Same
// exports as that file (typed from it), with values that do nothing. check-product-build.mjs fails the deployable build
// on any `test-controls` module but this one, or on the canary, so this file must never contain the canary.
type Real = typeof import('./test-controls.ts')

export const TEST_CONTROLS_CANARY: string = ''
const off = () => {
  throw new Error('The test controls are not in this build.')
}
export const runAlarmNow: Real['runAlarmNow'] = off
export const armStopAfterBatch: Real['armStopAfterBatch'] = off
export const seedCursor: Real['seedCursor'] = off
export const setTimings: Real['setTimings'] = off
export const timing: Real['timing'] = (_name, fallback) => fallback
/** The BrandAgent's constructor calls it in every build: nothing to load outside the test build. */
export const loadTestControls: Real['loadTestControls'] = () => {}
export const currentTimings: Real['currentTimings'] = off
export const TIMINGS_FLAG: Real['TIMINGS_FLAG'] = 'test:job_timings'
export const TIMINGS_TTL_MS: Real['TIMINGS_TTL_MS'] = 60 * 60_000
export const isolateId: Real['isolateId'] = off
export const killRunner: Real['killRunner'] = off
export const resetTestControls: Real['resetTestControls'] = () => {}
/** The tick's hook (routines/tick.ts): nothing, so the product build's tick runs as written. */
export const afterTickBatch: Real['afterTickBatch'] = () => {}
