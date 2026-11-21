// The test build's issuer, Worker side (p2-design section 10). Import it only as `@test-issuer`: `vite build --mode
// product-test` resolves that to this file, every other build to issuer-off.ts, so this never enters the deployable
// Worker (scripts/check-product-build.mjs scans for the canary below). Trusted only inside
// `if (__INHOUSE_TEST_BUILD__ && env.INHOUSE_TEST_BUILD === '1')` (authenticate.ts). The Worker gets the public JWKS
// alone, as the `TEST_ISSUER_JWKS` var; the private key stays with the test runner (test-issuer-mint.ts). No mint route.
import { createLocalJWKSet } from 'jose'
import type { JSONWebKeySet, JWTVerifyGetKey } from 'jose'

/** The bundle-scan canary: it must be in the test build's Worker and never in the deployable one. */
export const TEST_ISSUER_CANARY = 'INHOUSE_TEST_ISSUER_CANARY_7f3c'

/** The test issuer's `iss`, a reserved `.invalid` name nothing real can serve. */
export const TEST_ISSUER = 'https://test-issuer.invalid'

let cached: { raw: string; keys: JWTVerifyGetKey } | undefined

/** The key set from `TEST_ISSUER_JWKS`. Throws when the var is missing or not a JWKS (the caller answers 503). */
export function testIssuerKeys(env: { TEST_ISSUER_JWKS?: string }): JWTVerifyGetKey {
  const raw = env.TEST_ISSUER_JWKS
  if (!raw) throw new Error(`${TEST_ISSUER_CANARY}: the test build has no TEST_ISSUER_JWKS var`)
  if (cached?.raw !== raw) cached = { raw, keys: createLocalJWKSet(JSON.parse(raw) as JSONWebKeySet) }
  return cached.keys
}
