// The test build's issuer, test side (p2-design section 10). One RS256 key pair per Playwright run, made when
// playwright.config.ts loads in the main process and handed to the worker processes through the environment (they
// inherit it), so the Worker under `wrangler dev` (given only the public JWKS, as a --var) and every spec agree on it.
// The private key never leaves the test runner. The token itself comes from server/auth/test-issuer-mint.ts (W1), the
// one minting helper the seed and the unit tests use too, so every test token has the same claims.
// The `ship` workflow's test-build mode (SHIP=1) starts the test build itself: it makes the key pair and passes the
// private JWK as a file (TEST_ISSUER_PRIVATE_JWK_FILE) and the origins as BASE_URL (brand) and TEST_BUILD_INHOUSE_URL
// (inhouse). Those win when set, so `signIn` works there with no key from playwright.config.ts.
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { JWK } from 'jose'
import { TEST_ISSUER, mintPerson } from '../../../server/auth/test-issuer-mint.ts'

/** The issuer the Worker trusts in the test build only. */
export { TEST_ISSUER }
/** Where the test build's Worker config lands (`npm run build:product-test`), relative to app/. */
export const TEST_BUILD_WORKER_CONFIG = 'dist-product-test/inhouse_product/wrangler.json'
/**
 * P4 wave 4: the connector hub's test config, relative to app/. The test build runs it beside the product Worker in one
 * multi-config `wrangler dev` (the product's config first, so it's the primary Worker on the port; one --persist-to for
 * both), so the product's HUB binding reaches the hub's ReadGateway. The hub's packages come from app/hub/ (`npm ci` there).
 * https://developers.cloudflare.com/workers/development-testing/multi-workers/ (read 2026-11-21)
 */
export const TEST_BUILD_HUB_CONFIG = 'wrangler.hub.test.jsonc'
/** The test build's port: its origins (`http://brand.localhost:<port>`) carry it. 8787 by default, as in wrangler.test.jsonc. */
export const testBuildPort = () => Number(process.env.E2E_TEST_BUILD_PORT ?? 8787)

const PRIVATE_ENV = 'INHOUSE_TEST_ISSUER_PRIVATE_JWK'
/** A file holding this run's private JWK (with `kid` and `alg`), made by whoever started the test build (`ship.yml`). */
const PRIVATE_FILE_ENV = 'TEST_ISSUER_PRIVATE_JWK_FILE'
/** Each app's origin, when the test build runs somewhere this process didn't configure (`ship.yml`). */
const ORIGIN_ENV: Record<AppName, string> = { brand: 'BASE_URL', inhouse: 'TEST_BUILD_INHOUSE_URL' }
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

/** The test build's config source, relative to app/. The build copies its vars into TEST_BUILD_WORKER_CONFIG unchanged. */
export const TEST_BUILD_CONFIG_SOURCE = 'wrangler.test.jsonc'

/** JSONC to JSON: drops comments outside strings. A trailing comma stays, so JSON.parse fails loud on one. */
export function stripJsonc(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) throw new Error('Unterminated /* comment in JSONC.')
      i = end + 1
    } else out += c
  }
  return out
}

/**
 * INHOUSE_ACCESS for this run: the test build's own (from wrangler.test.jsonc, so it needs no build), with each origin
 * on the port the run uses.
 */
export function testAccessConfig(): AccessConfig {
  const source = readFileSync(new URL(`../../../${TEST_BUILD_CONFIG_SOURCE}`, import.meta.url), 'utf8')
  const config = JSON.parse(stripJsonc(source)) as { vars?: Record<string, unknown> }
  const raw = config.vars?.INHOUSE_ACCESS
  if (typeof raw !== 'string' || !raw) throw new Error(`${TEST_BUILD_CONFIG_SOURCE} has no INHOUSE_ACCESS var.`)
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

/** The app's origin in this run, e.g. `http://brand.localhost:8787`: BASE_URL (brand) or TEST_BUILD_INHOUSE_URL (inhouse) when set. */
export const appOrigin = (name: AppName) => {
  const given = process.env[ORIGIN_ENV[name]]
  return given ? new URL(given).origin : app(name).origin
}

/** This run's private key: TEST_ISSUER_PRIVATE_JWK_FILE when set, else the one playwright.config.ts made. */
function privateJwk(): JWK {
  const file = process.env[PRIVATE_FILE_ENV]
  const text = file ? readFileSync(file, 'utf8') : process.env[PRIVATE_ENV]
  if (!text) throw new Error(`No test issuer key in this process: set ${PRIVATE_FILE_ENV}, or run with E2E_TEST_BUILD=1 (playwright.config.ts makes one).`)
  const jwk = JSON.parse(text) as JWK
  if (!jwk.kid || jwk.alg !== 'RS256') throw new Error(`The test issuer's private JWK${file ? ` in ${file}` : ''} needs a kid and alg RS256.`)
  return jwk
}

/**
 * The header Access would set for this person on this app: `Cf-Access-Jwt-Assertion` with a JWT from the test issuer.
 * `memberKey` is the seeded person's subject (W2's seed names them; its email is `<memberKey>@example.test`).
 */
export async function signIn(memberKey: string, appName: AppName): Promise<Record<string, string>> {
  const jwk = privateJwk()
  const jwt = await mintPerson({ key: jwk, aud: app(appName).aud, sub: memberKey, email: `${memberKey}@example.test` })
  return { 'Cf-Access-Jwt-Assertion': jwt }
}
