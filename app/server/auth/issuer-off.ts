// What `@test-issuer` resolves to in every build but the test build (vite.config.ts): the test issuer switched off, so
// server/auth/test-issuer.ts never enters the deployable Worker's module graph, whatever imports it. Same exports as
// that file (the `satisfies` checks keep them in step), with values that trust nothing. check-product-build.mjs fails
// the deployable build on any `test-issuer` module or the canary, so this file must never contain the canary.
type Real = typeof import('./test-issuer.ts')

export const TEST_ISSUER_CANARY: string = ''
/** No issuer: authenticate.ts never reaches the test branch in this build, and an empty `iss` matches no token. */
export const TEST_ISSUER: string = ''
export const testIssuerKeys: Real['testIssuerKeys'] = () => {
  throw new Error('The test issuer is not in this build.')
}
