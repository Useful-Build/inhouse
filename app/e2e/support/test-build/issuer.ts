// The test build's issuer, test side (p2-design section 10). One RS256 key pair per Playwright run, made when
// playwright.config.ts loads in the main process and handed to the worker processes through the environment (they
// inherit it), so the Worker under `wrangler dev` (given only the public JWKS, as a --var) and every spec agree on it.
// The private key never leaves the test runner. W1's server/auth/test-issuer-mint.ts replaces `mint` once it lands.
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SignJWT, importJWK } from 'jose'
import type { JWK } from 'jose'

/** The issuer the Worker trusts in the test build only. */
export const TEST_ISSUER = 'https://test-issuer.invalid'
/** Where the test build's Worker config lands (`npm run build:product-test`), relative to app/. */
export const TEST_BUILD_WORKER_CONFIG = 'dist-product-test/inhouse_product/wrangler.json'
/** The test build's port: its origins (`http://brand.localhost:<port>`) carry it. */
export const testBuildPort = () => Number(process.env.E2E_TEST_BUILD_PORT ?? 5195)

const PRIVATE_ENV = 'INHOUSE_TEST_ISSUER_PRIVATE_JWK'
const JWKS_ENV = 'INHOUSE_TEST_ISSUER_JWKS'

/** The public JWKS (JSON text) for this run, making the key pair on the first call in the main process. */
export function testIssuerJwks(): string {
  if (!process.env[PRIVATE_ENV] || !process.env[JWKS_ENV]) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const kid = randomBytes(8).toString('hex')
    const pub = { ...(publicKey.export({ format: 'jwk' }) as JWK), kid, alg: 'RS256', use: 'sig' }
    const priv = { ...(privateKey.export({ format: 'jwk' }) as JWK), kid, alg: 'RS256' }
    process.env[PRIVATE_ENV] = JSON.stringify(priv)
    process.env[JWKS_ENV] = JSON.stringify({ keys: [pub] })
  }
  return process.env[JWKS_ENV]!
}

export type AppName = 'brand' | 'inhouse'
type AccessConfig = { teamDomain: string; apps: { name: AppName; origin: string; aud: string }[]; serviceTokens: Record<string, string> }

/** INHOUSE_ACCESS for this run: the test build's own, with each origin on the port the run uses. */
export function testAccessConfig(): AccessConfig {
  const config = JSON.parse(readFileSync(new URL(`../../../${TEST_BUILD_WORKER_CONFIG}`, import.meta.url), 'utf8')) as { vars?: Record<string, unknown> }
  const raw = config.vars?.INHOUSE_ACCESS
  if (typeof raw !== 'string' || !raw) throw new Error(`${TEST_BUILD_WORKER_CONFIG} has no INHOUSE_ACCESS var. Is it the test build's config?`)
  const access = JSON.parse(raw) as AccessConfig
  const port = String(testBuildPort())
  for (const app of access.apps) {
    const url = new URL(app.origin)
    url.port = port
    app.origin = url.origin
  }
  return access
}

const app = (name: AppName) => {
  const found = testAccessConfig().apps.find(a => a.name === name)
  if (!found) throw new Error(`The test build's INHOUSE_ACCESS has no "${name}" app.`)
  return found
}

/** The app's origin in this run, e.g. `http://brand.localhost:5195`. */
export const appOrigin = (name: AppName) => app(name).origin

/**
 * The header Access would set for this person on this app: `Cf-Access-Jwt-Assertion` with a JWT from the test issuer.
 * `memberKey` is the seeded person's subject (W2's seed names them; its email is `<memberKey>@example.test`).
 */
export async function signIn(memberKey: string, appName: AppName): Promise<Record<string, string>> {
  const priv = process.env[PRIVATE_ENV]
  if (!priv) throw new Error('No test issuer key in this process: playwright.config.ts makes it when E2E_TEST_BUILD=1.')
  const jwk = JSON.parse(priv) as JWK
  const key = await importJWK(jwk, 'RS256')
  const jwt = await new SignJWT({ email: `${memberKey}@example.test`, type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(TEST_ISSUER)
    .setAudience([app(appName).aud])
    .setSubject(memberKey)
    .setIssuedAt()
    .setNotBefore('0s')
    .setExpirationTime('10m')
    .sign(key)
  return { 'Cf-Access-Jwt-Assertion': jwt }
}
