// The test issuer: the Worker side trusts only the public JWKS from TEST_ISSUER_JWKS, the off switch trusts nothing,
// and the mint (test side) and the Worker side agree on the issuer. (authenticate.ts enters the test branch only when
// the build flag is compiled in; vitest defines it false, so that gate is the product build check's to prove.)
import { jwtVerify } from 'jose'
import { describe, expect, it } from 'vitest'
import * as real from '@test-issuer'
import * as off from './issuer-off.ts'
import { TEST_ISSUER as MINT_ISSUER, mintPerson, newTestIssuerKey } from './test-issuer-mint.ts'

describe('the test issuer', () => {
  it('verifies a minted token from the TEST_ISSUER_JWKS var alone', async () => {
    const key = await newTestIssuerKey()
    expect(key.jwks.keys[0]).not.toHaveProperty('d')
    const token = await mintPerson({ key: key.privateJwk, aud: 'a1'.repeat(32), sub: 's', email: 'e@example.test' })
    const keys = real.testIssuerKeys({ TEST_ISSUER_JWKS: JSON.stringify(key.jwks) })
    const { payload } = await jwtVerify(token, keys, { issuer: real.TEST_ISSUER, algorithms: ['RS256'] })
    expect(payload).toMatchObject({ sub: 's', email: 'e@example.test', type: 'app' })
  })
  it('throws without the var (authenticate answers 503)', () => {
    expect(() => real.testIssuerKeys({})).toThrow()
  })
  it('agrees with the mint on the issuer and carries the canary', () => {
    expect(real.TEST_ISSUER).toBe(MINT_ISSUER)
    expect(real.TEST_ISSUER_CANARY).toBe('INHOUSE_TEST_ISSUER_CANARY_' + '7f3c')
  })
  it('is off in every other build: no issuer, no canary, no keys', () => {
    expect(off.TEST_ISSUER).toBe('')
    expect(off.TEST_ISSUER_CANARY).toBe('')
    expect(() => off.testIssuerKeys({ TEST_ISSUER_JWKS: '{"keys":[]}' })).toThrow()
  })
})
