// Sign-in (p2-design sections 1 and 2): the Access JWT from `Cf-Access-Jwt-Assertion`, verified here (RS256 against the
// team domain's certs, `iss`, `aud`, `exp`, `nbf`, `iat`), the request's host picking the Access application, then the
// principal read fresh from D1. Fails closed everywhere: no fallback, no decode-only path, a key-set outage is 503 and
// never a principal. Logs one line per refusal, `{ event: 'auth_refused', class, requestId }`: never the token, `sub`,
// email or claims.
// Docs (2026-11-20): Access "Validate JWTs" (header over cookie, `<team>/cdn-cgi/access/certs`, RS256, iss/aud/exp/nbf)
// and "Application token" (a user token's `type` is "app" too, so `type` doesn't tell a person from a service token).
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose'
import type { JWTPayload, JWTVerifyGetKey } from 'jose'
import { TEST_ISSUER, testIssuerKeys } from '@test-issuer'
import { loadAccessConfig } from './config.ts'
import type { AccessApp, AccessConfig } from './config.ts'
import type { Principal } from './principal.ts'
import type { AuthStores } from './stores.ts'

/** What sign-in answers: a principal, or the refusal the API sends (the 401 body never says why). */
export type AuthOutcome =
  | { principal: Principal }
  | { refused: 'unauthorized' }
  | { refused: 'forbidden'; reason: 'not_invited' | 'removed' | 'bad_origin' }
  | { refused: 'unavailable' }

/** Compile-time: true only in `vite build --mode product-test` (server/build-flags.d.ts; declared here too so the
 * server tests' tsconfig, which doesn't include that file, types it). */
declare const __INHOUSE_TEST_BUILD__: boolean

/** Vars the test build adds (wrangler.test.jsonc and the test runner's `--var`); absent from the product's Env. */
type AuthEnv = Pick<Env, 'INHOUSE_ACCESS'> & { INHOUSE_TEST_BUILD?: string; TEST_ISSUER_JWKS?: string }

const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/** The remote key set's options (jose's cache: refetch on an unknown `kid` at most every 30 s, and every 10 min). */
export const REMOTE_JWKS_OPTIONS = { timeoutDuration: 3000, cooldownDuration: 30_000, cacheMaxAge: 600_000 } as const

const remote = new Map<string, JWTVerifyGetKey>()

/** The team domain's key set, made once per isolate per team domain. `fetchImpl` is for tests (no network). */
export function remoteKeys(teamDomain: string, fetchImpl?: typeof fetch): JWTVerifyGetKey {
  if (fetchImpl) return createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain), { ...REMOTE_JWKS_OPTIONS, [customFetch]: fetchImpl })
  let keys = remote.get(teamDomain)
  if (!keys) {
    keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain), REMOTE_JWKS_OPTIONS)
    remote.set(teamDomain, keys)
  }
  return keys
}

function refuse<T extends Exclude<AuthOutcome, { principal: Principal }>>(outcome: T, cls: string, requestId: string): T {
  console.warn({ event: 'auth_refused', class: cls, requestId })
  return outcome
}

/** The Access application this request's host belongs to, or null (401). */
export function appForRequest(config: AccessConfig, request: Request): AccessApp | null {
  const host = new URL(request.url).host
  const found = config.apps.filter(a => new URL(a.origin).host === host)
  return found.length === 1 ? found[0] : null
}

/** A key-set problem (outage, timeout, bad JWKS): 503. Everything else jose throws is a bad token: 401. */
function isKeySetFailure(err: unknown): boolean {
  if (err instanceof errors.JWKSTimeout || err instanceof errors.JWKSInvalid) return true
  if (err instanceof errors.JWKSNoMatchingKey || err instanceof errors.JWKSMultipleMatchingKeys) return false
  if (err instanceof errors.JOSEError) return err.code === 'ERR_JOSE_GENERIC'
  // Not jose's own error: the fetch itself failed.
  return true
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** `@test-issuer`'s exports, as `testIssuerBranch` reads them. */
export interface TestIssuerModule {
  TEST_ISSUER: string
  testIssuerKeys: (env: { TEST_ISSUER_JWKS?: string }) => JWTVerifyGetKey
}

/**
 * The test branch's issuer and key set (`keys` overrides the set), or null when the test issuer is off (issuer-off.ts:
 * an empty `TEST_ISSUER`). Null answers 503 before any verify, so the off build relies neither on jose's handling of
 * an empty `iss` (it checks `issuer !== undefined`, so `''` would demand `iss === ''`) nor on the off key set throwing.
 */
export function testIssuerBranch(env: AuthEnv, keys: JWTVerifyGetKey | undefined, mod: TestIssuerModule = { TEST_ISSUER, testIssuerKeys }): { issuer: string; keySet: JWTVerifyGetKey } | null {
  if (mod.TEST_ISSUER === '') return null
  return { issuer: mod.TEST_ISSUER, keySet: keys ?? mod.testIssuerKeys(env) }
}

/**
 * The request's principal or its refusal. `keys` replaces the key set (tests: a local one, no network). Test build
 * only (compiled in AND `INHOUSE_TEST_BUILD === '1'`): the test issuer's iss and keys instead of the team domain's.
 * `compiledTestBuild` is a seam for the unit tests (vitest defines the flag false): the API passes nothing, so it's the
 * compile-time flag; and outside the test build `@test-issuer` is issuer-off.ts, so even `true` here trusts nothing:
 * `testIssuerBranch` answers 503 before any verify.
 */
export async function authenticate(request: Request, env: AuthEnv, stores: AuthStores, nowMs: number, requestId: string, keys?: JWTVerifyGetKey, compiledTestBuild: boolean = __INHOUSE_TEST_BUILD__): Promise<AuthOutcome> {
  const config = loadAccessConfig(env.INHOUSE_ACCESS)
  if (!config) return refuse({ refused: 'unavailable' }, 'config_invalid', requestId)

  const token = request.headers.get('Cf-Access-Jwt-Assertion') ?? ''
  if (!TOKEN.test(token)) return refuse({ refused: 'unauthorized' }, token ? 'malformed_token' : 'no_token', requestId)

  const app = appForRequest(config, request)
  if (!app) return refuse({ refused: 'unauthorized' }, 'unknown_host', requestId)

  let issuer = config.teamDomain
  let keySet = keys
  try {
    if (compiledTestBuild && env.INHOUSE_TEST_BUILD === '1') {
      const test = testIssuerBranch(env, keys)
      if (!test) return refuse({ refused: 'unavailable' }, 'test_issuer_off', requestId)
      ;({ issuer, keySet } = test)
    }
    keySet ??= remoteKeys(config.teamDomain)
  } catch {
    return refuse({ refused: 'unavailable' }, 'keys_unavailable', requestId)
  }

  let payload: JWTPayload
  try {
    ;({ payload } = await jwtVerify(token, keySet, {
      algorithms: ['RS256'], issuer, audience: app.aud, clockTolerance: 30, requiredClaims: ['exp', 'iat'],
      currentDate: new Date(nowMs),
    }))
  } catch (err) {
    if (isKeySetFailure(err)) return refuse({ refused: 'unavailable' }, 'keys_unavailable', requestId)
    return refuse({ refused: 'unauthorized' }, 'bad_token', requestId)
  }

  const { sub, email } = payload
  const commonName = (payload as { common_name?: unknown }).common_name
  try {
    // A service token: `sub` empty, a client id in `common_name`, no email. Brand app only.
    if (sub === '' && nonEmpty(commonName) && email === undefined) {
      if (app.name !== 'brand') return refuse({ refused: 'unauthorized' }, 'service_on_inhouse', requestId)
      const name = config.serviceTokens.get(commonName)
      if (name === 'monitor') return { principal: { kind: 'service', name: 'monitor', requestId } }
      if (name === 'smoke') return { principal: { kind: 'service', name: 'smoke', memberId: await stores.members.serviceMember('smoke'), requestId } }
      return refuse({ refused: 'unauthorized' }, 'unknown_service', requestId)
    }
    // A person: a `sub`, an email and no `common_name`. Anything else is refused.
    if (!nonEmpty(sub) || typeof email !== 'string' || email.trim() === '' || commonName !== undefined) {
      return refuse({ refused: 'unauthorized' }, 'bad_claims', requestId)
    }
    const signIn = { subject: sub, email: email.trim().toLowerCase(), requestId, nowMs }
    if (app.name === 'inhouse') {
      // The one caller of `grants.active`: the grant is read fresh on every Inhouse request.
      const member = await stores.members.resolveInhouse(signIn)
      const grant = await stores.grants.active({ nowMs, requestId })
      return { principal: { ...member, kind: 'inhouse', grant } }
    }
    const found = await stores.members.resolvePerson(signIn)
    if ('ok' in found) return { principal: found.ok }
    if (found.refused === 'wrong_kind') return refuse({ refused: 'unauthorized' }, 'wrong_kind', requestId)
    return refuse({ refused: 'forbidden', reason: found.refused }, found.refused, requestId)
  } catch (err) {
    console.error({ event: 'auth_store_failed', requestId, error: err instanceof Error ? err.name : 'unknown' })
    return { refused: 'unavailable' }
  }
}

/**
 * Null when the request may go on, else `bad_origin` (403). Every method but GET and HEAD, and a WebSocket upgrade,
 * needs `Origin` exactly equal to the app's origin (missing is refused) and, when sent, `Sec-Fetch-Site: same-origin`.
 */
export function checkOrigin(request: Request, env: Pick<Env, 'INHOUSE_ACCESS'>): 'bad_origin' | null {
  const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
  if (!upgrade && (request.method === 'GET' || request.method === 'HEAD')) return null
  const config = loadAccessConfig(env.INHOUSE_ACCESS)
  const app = config && appForRequest(config, request)
  if (!app || request.headers.get('Origin') !== app.origin) return 'bad_origin'
  const site = request.headers.get('Sec-Fetch-Site')
  if (site !== null && site !== 'same-origin') return 'bad_origin'
  return null
}

/** Sign-in for a WebSocket upgrade (P3): `authenticate`, then the `Origin` match on the GET upgrade itself. */
export async function authenticateUpgrade(request: Request, env: AuthEnv, stores: AuthStores, nowMs: number, requestId: string, keys?: JWTVerifyGetKey): Promise<AuthOutcome> {
  const outcome = await authenticate(request, env, stores, nowMs, requestId, keys)
  if (!('principal' in outcome)) return outcome
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return refuse({ refused: 'unauthorized' }, 'not_an_upgrade', requestId)
  }
  if (checkOrigin(request, env)) return refuse({ refused: 'forbidden', reason: 'bad_origin' }, 'bad_origin', requestId)
  return outcome
}
