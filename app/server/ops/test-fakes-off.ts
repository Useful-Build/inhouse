// What `@test-fakes` resolves to in every build but the test build (vite.config.ts), the eval build included: the
// test-fakes hook switched off, so server/ops/test-fakes.ts (and the impersonating `notify` and run-scoped `hub` ops
// in it) never enters a deployable Worker's module graph, whatever imports it. Same exports as that file (typed from
// it), doing nothing. check-product-build.mjs part 8 fails a deployable build on that module or its canary, so this
// file must never contain the canary.
type Real = typeof import('./test-fakes.ts')

export const TEST_FAKES_CANARY: string = ''
export const HUB_OPS: Real['HUB_OPS'] = [] as unknown as Real['HUB_OPS']
export const installLogCapture: Real['installLogCapture'] = () => {
  throw new Error('The test-fakes hook is not in this build.')
}
export const productLogs: Real['productLogs'] = () => {
  throw new Error('The test-fakes hook is not in this build.')
}
export const runTestFakes: Real['runTestFakes'] = () => {
  throw new Error('The test-fakes hook is not in this build.')
}
