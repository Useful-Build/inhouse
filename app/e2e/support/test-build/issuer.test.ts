// The test issuer's test side under the `ship` workflow's test-build mode (SHIP=1): no key from playwright.config.ts,
// only TEST_ISSUER_PRIVATE_JWK_FILE, BASE_URL and TEST_BUILD_INHOUSE_URL. Ways it could fail: signing with a key other
// than the file's, a wrong iss or aud, a token without the file's kid, origins that ignore the environment.
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose'
import type { JWK } from 'jose'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TEST_ISSUER, appOrigin, signIn, stripJsonc, testAccessConfig } from './issuer.ts'

/** A key pair as ship.yml makes it: the private JWK in a file, with kid and alg. */
function shipKey(extra: Partial<JWK> = {}) {
  const kid = randomUUID()
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const file = join(mkdtempSync(join(tmpdir(), 'issuer-test-')), 'private.jwk.json')
  writeFileSync(file, JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid, alg: 'RS256', ...extra }))
  return { kid, file, publicJwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256' } as JWK }
}

afterEach(() => vi.unstubAllEnvs())

describe('signIn from TEST_ISSUER_PRIVATE_JWK_FILE alone', () => {
  for (const app of ['brand', 'inhouse'] as const) {
    test(`signs for ${app} with the file's key, the test issuer and that app's aud`, async () => {
      const { kid, file, publicJwk } = shipKey()
      vi.stubEnv('INHOUSE_TEST_ISSUER_PRIVATE_JWK', '')
      vi.stubEnv('TEST_ISSUER_PRIVATE_JWK_FILE', file)
      const { 'Cf-Access-Jwt-Assertion': jwt } = await signIn('admin-1', app)
      const aud = testAccessConfig().apps.find(a => a.name === app)!.aud
      const { payload } = await jwtVerify(jwt, await importJWK(publicJwk, 'RS256'), { issuer: TEST_ISSUER, audience: aud })
      expect(payload.email).toBe('admin-1@example.test')
      expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: 'RS256', kid })
    })
  }
  test('refuses a JWK file without a kid', async () => {
    const { file } = shipKey({ kid: undefined })
    vi.stubEnv('TEST_ISSUER_PRIVATE_JWK_FILE', file)
    await expect(signIn('admin-1', 'brand')).rejects.toThrow(/kid/)
  })
})

describe('appOrigin', () => {
  test('takes BASE_URL for brand and TEST_BUILD_INHOUSE_URL for inhouse when set', () => {
    vi.stubEnv('BASE_URL', 'http://brand.localhost:9999/')
    vi.stubEnv('TEST_BUILD_INHOUSE_URL', 'http://inhouse.localhost:9998')
    expect(appOrigin('brand')).toBe('http://brand.localhost:9999')
    expect(appOrigin('inhouse')).toBe('http://inhouse.localhost:9998')
  })
  test("is wrangler.test.jsonc's origin on port 8787 by default", () => {
    vi.stubEnv('BASE_URL', '')
    vi.stubEnv('TEST_BUILD_INHOUSE_URL', '')
    vi.stubEnv('E2E_TEST_BUILD_PORT', undefined)
    expect(appOrigin('brand')).toBe('http://brand.localhost:8787')
    expect(appOrigin('inhouse')).toBe('http://inhouse.localhost:8787')
  })
})

test('stripJsonc keeps // and /* inside strings and drops comments outside them', () => {
  const text = '{\n  // a comment\n  "a": "https://x.test/*not*/", /* block */ "b": "q\\"//"\n}'
  expect(JSON.parse(stripJsonc(text))).toEqual({ a: 'https://x.test/*not*/', b: 'q"//' })
})
