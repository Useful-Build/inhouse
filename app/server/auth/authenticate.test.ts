// Sign-in's failure modes (p2-design sections 1 and 2), in the Workers runtime with a local key set (no network).
// Properties: no token outside the configured issuer, aud, host and RS256 yields a principal; a brand-host token never
// yields Inhouse; a service token never yields a person or Inhouse and never works on the Inhouse host; a request other
// than GET and HEAD without the exact Origin is refused. Then the unit cases the brief lists.
import { fc, test } from '@fast-check/vitest'
import { SignJWT, UnsecuredJWT, createLocalJWKSet, importJWK } from 'jose'
import type { JWTVerifyGetKey } from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { authenticate, checkOrigin, remoteKeys, testAssertion, testIssuerBranch } from './authenticate.ts'
import * as issuerOff from './issuer-off.ts'
import type { AuthOutcome } from './authenticate.ts'
import { TEST_ISSUER, mintPerson, mintService } from './test-issuer-mint.ts'
import { BRAND, INHOUSE, MONITOR_ID, RELEASE_ID, SMOKE_ID, SMOKE_MEMBER, TEAM, authEnv, config, fakeStores, issuer, req } from '../testing/auth-fixtures.ts'
import type { Issuer } from '../testing/auth-fixtures.ts'

const NOW = Date.parse('2026-11-20T10:00:00.000Z')
let good: Issuer
let other: Issuer
/** good's public key with no `alg`: jose's local set then offers it for any RSA alg, so only `algorithms` refuses one. */
let algless: JWTVerifyGetKey
beforeAll(async () => {
  good = await issuer()
  other = await issuer()
  const { alg: _alg, ...pub } = good.key.jwks.keys[0]
  algless = createLocalJWKSet({ keys: [pub] })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const person = (o: Partial<Parameters<typeof mintPerson>[0]> = {}) =>
  mintPerson({ key: good.key.privateJwk, aud: BRAND.aud, iss: TEAM, sub: 'sub-1', email: 'Person@Example.test ', nowMs: NOW, ...o })
const service = (clientId: string, o: Partial<Parameters<typeof mintService>[0]> = {}) =>
  mintService({ key: good.key.privateJwk, aud: BRAND.aud, iss: TEAM, clientId, nowMs: NOW, ...o })
const people = { 'sub-1': { role: 'admin' as const }, 'sub-gone': 'removed' as const, 'sub-ih': 'wrong_kind' as const }

async function run(token: string | null, origin: string = BRAND.origin, o: { now?: number; stores?: ReturnType<typeof fakeStores>; env?: object; keys?: Issuer['keys'] | null; testBuild?: boolean } = {}) {
  const s = o.stores ?? fakeStores({ people })
  const headers: Record<string, string> = token === null ? {} : { 'Cf-Access-Jwt-Assertion': token }
  // `keys: null`: no override, so authenticate picks the key set itself.
  const keys = o.keys === null ? undefined : (o.keys ?? good.keys)
  const out = await authenticate(req(origin, headers), (o.env ?? authEnv()) as never, s.stores, o.now ?? NOW, 'req-1', keys, o.testBuild)
  return { out, calls: s.calls }
}
const principalOf = (out: AuthOutcome) => ('principal' in out ? out.principal : null)

describe('properties', () => {
  // Each axis has one right value and several wrong ones; any wrong axis must refuse.
  const ISSUERS = [{ ok: true, v: TEAM }, { ok: false, v: 'https://other-team.cloudflareaccess.com' }, { ok: false, v: 'https://test-issuer.invalid' }]
  const AUDS = [{ ok: true, v: BRAND.aud }, { ok: false, v: INHOUSE.aud }, { ok: false, v: 'c3'.repeat(32) }]
  const HOSTS = [{ ok: true, v: BRAND.origin }, { ok: false, v: 'https://elsewhere.example.test' }, { ok: false, v: 'https://brand.example.test:8443' }]
  const ALGS = ['RS256', 'RS384', 'PS256', 'HS256', 'none', 'other-key']

  // Exhaustive over the 162 combinations (too few to leave to sampling).
  it('no token outside the issuer, aud, host and RS256 yields a principal', async () => {
    for (const iss of ISSUERS) for (const aud of AUDS) for (const host of HOSTS) for (const alg of ALGS) {
      await oneCase(iss, aud, host, alg)
    }
  })
  async function oneCase(iss: { ok: boolean; v: string }, aud: { ok: boolean; v: string }, host: { ok: boolean; v: string }, alg: string) {
    let token: string
    if (alg === 'none') token = new UnsecuredJWT({ email: 'a@example.test' }).setIssuer(iss.v).setAudience(aud.v).setSubject('sub-1').setIssuedAt(NOW / 1000).setExpirationTime(NOW / 1000 + 600).encode() + 'c2ln'
    else if (alg === 'HS256') {
      const secret = new TextEncoder().encode(JSON.stringify(good.key.jwks.keys[0]))
      token = await new SignJWT({ email: 'a@example.test' }).setProtectedHeader({ alg: 'HS256', kid: good.key.privateJwk.kid }).setIssuer(iss.v).setAudience(aud.v).setSubject('sub-1').setIssuedAt(NOW / 1000).setExpirationTime(NOW / 1000 + 600).sign(secret)
    } else if (alg === 'other-key') token = await person({ key: other.key.privateJwk, iss: iss.v, aud: aud.v })
    else if (alg === 'RS256') token = await person({ iss: iss.v, aud: aud.v })
    else {
      const key = await importJWK({ ...good.key.privateJwk, alg }, alg)
      token = await new SignJWT({ email: 'a@example.test' }).setProtectedHeader({ alg, kid: good.key.privateJwk.kid }).setIssuer(iss.v).setAudience(aud.v).setSubject('sub-1').setIssuedAt(NOW / 1000).setExpirationTime(NOW / 1000 + 600).sign(key)
    }
    const allRight = iss.ok && aud.ok && host.ok && alg === 'RS256'
    // RS384 and PS256 against the alg-less key: the key would verify them, so only `algorithms` refuses them.
    const { out } = await run(token, host.v, alg === 'RS384' || alg === 'PS256' ? { keys: algless } : {})
    if (allRight) expect(principalOf(out)?.kind).toBe('person')
    else expect(out, `${iss.v} ${aud.v} ${host.v} ${alg}`).toEqual({ refused: 'unauthorized' })
  }

  test.prop([fc.string({ minLength: 1 }), fc.emailAddress(), fc.boolean()])('a brand-host token never yields Inhouse', async (sub, email, known) => {
    const s = fakeStores({ people: known ? { [sub]: { role: 'member' } } : {} })
    const { out, calls } = await run(await person({ sub, email }), BRAND.origin, { stores: s })
    expect(principalOf(out)?.kind).not.toBe('inhouse')
    expect(calls.resolveInhouse).toHaveLength(0)
  })

  test.prop([fc.constantFrom(MONITOR_ID, SMOKE_ID, 'unknown.access', '__proto__', 'constructor'), fc.constantFrom(BRAND, INHOUSE)])(
    'a service token never yields a person or Inhouse, and never works on the Inhouse host', async (clientId, app) => {
      const { out, calls } = await run(await service(clientId, { aud: app.aud }), app.origin)
      const p = principalOf(out)
      if (p) expect(p.kind).toBe('service')
      if (app === INHOUSE || !(clientId === MONITOR_ID || clientId === SMOKE_ID)) expect(out).toEqual({ refused: 'unauthorized' })
      expect(calls.resolvePerson).toHaveLength(0)
      expect(calls.resolveInhouse).toHaveLength(0)
    })

  test.prop([fc.constantFrom('POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'), fc.option(fc.oneof(fc.webUrl(), fc.string(), fc.constantFrom(`${BRAND.origin}/`, BRAND.origin.toUpperCase(), INHOUSE.origin, 'null')), { nil: undefined })])(
    'a request other than GET and HEAD without the exact Origin is always refused', (method, origin) => {
      fc.pre(origin !== BRAND.origin)
      const headers: Record<string, string> = origin === undefined ? {} : { Origin: origin }
      expect(checkOrigin(new Request(`${BRAND.origin}/api/x`, { method, headers }), authEnv())).toBe('bad_origin')
    })
})

describe('the token', () => {
  it('signs a person in on the brand app, with the email trimmed and lower-cased', async () => {
    const { out, calls } = await run(await person())
    // expMs: the token's exp (minted at NOW with a 10-minute life), written out, never computed from the token.
    expect(principalOf(out)).toEqual({ kind: 'person', memberId: 'm_sub-1', role: 'admin', subject: 'sub-1', requestId: 'req-1', expMs: Date.parse('2026-11-20T10:10:00.000Z') })
    expect(calls.resolvePerson[0]).toMatchObject({ subject: 'sub-1', email: 'person@example.test', nowMs: NOW })
  })
  it('is read only from Cf-Access-Jwt-Assertion: missing, empty or not three parts is 401', async () => {
    expect((await run(null)).out).toEqual({ refused: 'unauthorized' })
    expect((await run('')).out).toEqual({ refused: 'unauthorized' })
    expect((await run('a.b')).out).toEqual({ refused: 'unauthorized' })
    const cookie = new Request(`${BRAND.origin}/api/me`, { headers: { Cookie: `CF_Authorization=${await person()}` } })
    expect(await authenticate(cookie, authEnv() as never, fakeStores({ people }).stores, NOW, 'r', good.keys)).toEqual({ refused: 'unauthorized' })
  })
  it('refuses an expired token beyond the 30 s tolerance and takes one inside it', async () => {
    const t = await person({ lifetimeS: 600 })
    expect(principalOf((await run(t, BRAND.origin, { now: NOW + 600_000 + 29_000 })).out)).not.toBeNull()
    expect((await run(t, BRAND.origin, { now: NOW + 600_000 + 31_000 })).out).toEqual({ refused: 'unauthorized' })
  })
  it('refuses nbf in the future beyond the tolerance', async () => {
    expect((await run(await person({ nbfMs: NOW + 31_000 }))).out).toEqual({ refused: 'unauthorized' })
    expect(principalOf((await run(await person({ nbfMs: NOW + 29_000 }))).out)).not.toBeNull()
  })
  it('refuses a token without iat or exp', async () => {
    const key = await importJWK(good.key.privateJwk, 'RS256')
    const noIat = await new SignJWT({ email: 'a@example.test' }).setProtectedHeader({ alg: 'RS256', kid: good.key.privateJwk.kid }).setIssuer(TEAM).setAudience(BRAND.aud).setSubject('sub-1').setExpirationTime(NOW / 1000 + 600).sign(key)
    const noExp = await new SignJWT({ email: 'a@example.test' }).setProtectedHeader({ alg: 'RS256', kid: good.key.privateJwk.kid }).setIssuer(TEAM).setAudience(BRAND.aud).setSubject('sub-1').setIssuedAt(NOW / 1000).sign(key)
    expect((await run(noIat)).out).toEqual({ refused: 'unauthorized' })
    expect((await run(noExp)).out).toEqual({ refused: 'unauthorized' })
  })
  it('refuses an unknown kid', async () => {
    expect((await run(await person({ key: { ...other.key.privateJwk, kid: 'not-in-the-set' } }))).out).toEqual({ refused: 'unauthorized' })
  })
  it("refuses the other app's valid token on this host", async () => {
    expect((await run(await person({ aud: INHOUSE.aud }), BRAND.origin)).out).toEqual({ refused: 'unauthorized' })
    expect((await run(await person({ aud: BRAND.aud }), INHOUSE.origin)).out).toEqual({ refused: 'unauthorized' })
  })
  it('refuses a token with both common_name and email, or neither shape', async () => {
    expect((await run(await person({ extra: { common_name: SMOKE_ID } }))).out).toEqual({ refused: 'unauthorized' })
    expect((await run(await service(SMOKE_ID, { extra: { email: 'a@example.test' } }))).out).toEqual({ refused: 'unauthorized' })
    expect((await run(await person({ sub: '' }))).out).toEqual({ refused: 'unauthorized' })
    expect((await run(await person({ email: '  ' }))).out).toEqual({ refused: 'unauthorized' })
  })
  it('logs one line per refusal with no token, sub, email or claims', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = await person({ aud: INHOUSE.aud, sub: 'secret-sub', email: 'secret@example.test' })
    await run(t)
    expect(warn).toHaveBeenCalledTimes(1)
    const line = JSON.stringify(warn.mock.calls[0])
    expect(line).toContain('auth_refused')
    for (const s of [t, 'secret-sub', 'secret@example.test', t.split('.')[1]]) expect(line).not.toContain(s)
  })
})

describe('the host picks the app', () => {
  it('signs an Inhouse person in only through resolveInhouse, with the live grant', async () => {
    const grant = { id: 'g_1', endsAtMs: NOW + 3_600_000 }
    const s = fakeStores({ grant })
    const { out, calls } = await run(await person({ aud: INHOUSE.aud }), INHOUSE.origin, { stores: s })
    expect(principalOf(out)).toEqual({ kind: 'inhouse', memberId: 'm_ih_sub-1', subject: 'sub-1', grant, requestId: 'req-1', expMs: Date.parse('2026-11-20T10:10:00.000Z') })
    expect(calls.resolvePerson).toHaveLength(0)
    expect(calls.active).toEqual([{ nowMs: NOW, requestId: 'req-1' }])
  })
  it('refuses a host that is no app (401)', async () => {
    expect((await run(await person(), 'https://other.example.test')).out).toEqual({ refused: 'unauthorized' })
  })
})

describe('service tokens', () => {
  it('maps monitor (no member row) and smoke (its member row) on the brand app', async () => {
    expect(principalOf((await run(await service(MONITOR_ID))).out)).toEqual({ kind: 'service', name: 'monitor', requestId: 'req-1' })
    expect(principalOf((await run(await service(SMOKE_ID))).out)).toEqual({ kind: 'service', name: 'smoke', memberId: SMOKE_MEMBER, requestId: 'req-1' })
  })
  it('refuses an unknown client id and any service token on the Inhouse host', async () => {
    expect((await run(await service('unknown.access'))).out).toEqual({ refused: 'unauthorized' })
    expect((await run(await service(SMOKE_ID, { aud: INHOUSE.aud }), INHOUSE.origin)).out).toEqual({ refused: 'unauthorized' })
    expect((await run(await service(RELEASE_ID, { aud: INHOUSE.aud }), INHOUSE.origin)).out).toEqual({ refused: 'unauthorized' })
  })
  it('maps release (P3) to its own principal: no member row, no store call, no expMs', async () => {
    const { out, calls } = await run(await service(RELEASE_ID))
    expect(principalOf(out)).toEqual({ kind: 'service', name: 'release', requestId: 'req-1' })
    expect(calls).toEqual({ resolvePerson: [], resolveInhouse: [], active: [], supportAccess: [] })
  })
})

describe('expMs (P3): the sign-in window ends at the token\'s exp', () => {
  it('carries exp exactly for a person and an Inhouse member, whatever the token\'s life', async () => {
    const short = await run(await person({ lifetimeS: 60 }))
    expect(principalOf(short.out)).toMatchObject({ kind: 'person', expMs: Date.parse('2026-11-20T10:01:00.000Z') })
    const long = await run(await person({ lifetimeS: 86_400 }))
    expect(principalOf(long.out)).toMatchObject({ kind: 'person', expMs: Date.parse('2026-11-21T10:00:00.000Z') })
    const ih = await run(await person({ aud: INHOUSE.aud, lifetimeS: 3600 }), INHOUSE.origin)
    expect(principalOf(ih.out)).toMatchObject({ kind: 'inhouse', expMs: Date.parse('2026-11-20T11:00:00.000Z') })
  })
  it('closes the window: past exp (beyond the 30 s tolerance) the same token signs nobody in', async () => {
    const token = await person({ lifetimeS: 60 })
    expect(principalOf((await run(token, BRAND.origin, { now: Date.parse('2026-11-20T10:01:29.000Z') })).out)).toMatchObject({ expMs: Date.parse('2026-11-20T10:01:00.000Z') })
    expect((await run(token, BRAND.origin, { now: Date.parse('2026-11-20T10:01:30.000Z') })).out).toEqual({ refused: 'unauthorized' })
  })
})

describe('binding (through in-memory stores)', () => {
  it('answers not_invited, removed and wrong_kind with 403 and their reason, never a principal', async () => {
    expect((await run(await person({ sub: 'sub-new' }))).out).toEqual({ refused: 'forbidden', reason: 'not_invited' })
    expect((await run(await person({ sub: 'sub-gone' }))).out).toEqual({ refused: 'forbidden', reason: 'removed' })
    // P8a P-auth: an Inhouse team identity on the brand app is told apart from an ended session (401), so the client can
    // show a final screen instead of "Sign in again" (a reload loop). The answer is the reason alone: no member id or name.
    expect((await run(await person({ sub: 'sub-ih' }))).out).toEqual({ refused: 'forbidden', reason: 'wrong_kind' })
  })
  it('answers 503 with no principal when the stores fail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await run(await person(), BRAND.origin, { stores: fakeStores({ fail: true }) })).out).toEqual({ refused: 'unavailable' })
  })
})

describe('RS256 only', () => {
  it('the alg-less key verifies an RS256 token (so the RS384 and PS256 refusals above are the algorithms list)', async () => {
    expect(principalOf((await run(await person(), BRAND.origin, { keys: algless })).out)?.kind).toBe('person')
  })
})

describe('the test-issuer gate (the compiled-in flag through the seam; vitest defines it false)', () => {
  const testEnv = (jwks?: object) => ({ ...authEnv(), INHOUSE_TEST_BUILD: '1', ...(jwks ? { TEST_ISSUER_JWKS: JSON.stringify(jwks) } : {}) })
  const testToken = () => person({ iss: TEST_ISSUER })

  it('flag off (the default here): a test-issuer token is refused even with INHOUSE_TEST_BUILD=1 and the JWKS var', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The keys are the token's own, so only the issuer refuses it: the team domain's stays in force.
    expect((await run(await testToken(), BRAND.origin, { env: testEnv(good.key.jwks), keys: good.keys })).out).toEqual({ refused: 'unauthorized' })
    expect(principalOf((await run(await person(), BRAND.origin, { env: testEnv(good.key.jwks), keys: good.keys })).out)?.kind).toBe('person')
  })
  it('flag on and INHOUSE_TEST_BUILD=1: the issuer swaps to the test issuer, verified from TEST_ISSUER_JWKS', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env = testEnv(good.key.jwks)
    expect(principalOf((await run(await testToken(), BRAND.origin, { env, keys: null, testBuild: true })).out)?.kind).toBe('person')
    expect((await run(await person(), BRAND.origin, { env, keys: null, testBuild: true })).out).toEqual({ refused: 'unauthorized' })
  })
  it('flag on without the JWKS var: 503, never a principal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await run(await testToken(), BRAND.origin, { env: testEnv(), keys: null, testBuild: true })).out).toEqual({ refused: 'unavailable' })
    expect(warn.mock.calls).toEqual([[{ event: 'auth_refused', class: 'keys_unavailable', requestId: 'req-1' }]])
  })
  it('issuer off (every build but the test build): no branch at all, even with a key set given and the JWKS var', async () => {
    expect(testIssuerBranch(testEnv(good.key.jwks), good.keys, issuerOff)).toBeNull()
    expect(testIssuerBranch(testEnv(good.key.jwks), undefined, issuerOff)).toBeNull()
    // The real module still swaps (so the null above is the off issuer, not the seam).
    expect(testIssuerBranch(testEnv(good.key.jwks), good.keys)).toEqual({ issuer: TEST_ISSUER, keySet: good.keys })
  })
  it('flag on but INHOUSE_TEST_BUILD unset: the team domain stays the issuer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await run(await testToken(), BRAND.origin, { env: authEnv(), keys: good.keys, testBuild: true })).out).toEqual({ refused: 'unauthorized' })
    expect(principalOf((await run(await person(), BRAND.origin, { env: authEnv(), keys: good.keys, testBuild: true })).out)?.kind).toBe('person')
  })
})

describe('the access config', () => {
  const bad = [
    'not json', '', JSON.stringify({}),
    JSON.stringify({ ...config, apps: [config.apps[0]] }),
    JSON.stringify({ ...config, apps: [config.apps[0], { ...config.apps[1], origin: config.apps[0].origin }] }),
    JSON.stringify({ ...config, apps: [config.apps[0], { ...config.apps[1], aud: config.apps[0].aud }] }),
    JSON.stringify({ ...config, teamDomain: 'http://example-team.cloudflareaccess.com' }),
    JSON.stringify({ ...config, serviceTokens: { x: 'admin' } }),
  ]
  for (const raw of bad) {
    it(`an invalid INHOUSE_ACCESS (${raw.slice(0, 40) || 'empty'}) is 503 even with a valid token`, async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect((await run(await person(), BRAND.origin, { env: authEnv(raw) })).out).toEqual({ refused: 'unavailable' })
      expect(checkOrigin(req(BRAND.origin, { Origin: BRAND.origin }, { method: 'POST' }), authEnv(raw))).toBe('bad_origin')
      expect(error.mock.calls.length).toBeLessThanOrEqual(1)
    })
  }
})

describe('the remote key set (fetch injected, no network)', () => {
  const jwksResponse = (keys: object[]) => new Response(JSON.stringify({ keys }), { headers: { 'Content-Type': 'application/json' } })

  it('fetches <team domain>/cdn-cgi/access/certs and verifies against it', async () => {
    const urls: string[] = []
    const keys = remoteKeys(TEAM, async (url: RequestInfo | URL) => { urls.push(String(url)); return jwksResponse(good.key.jwks.keys) })
    expect(principalOf((await run(await person(), BRAND.origin, { keys })).out)).not.toBeNull()
    expect(urls).toEqual([`${TEAM}/cdn-cgi/access/certs`])
  })
  it('answers 503 with no principal when the fetch fails or answers non-200', async () => {
    const failing = remoteKeys(TEAM, async () => { throw new TypeError('network down') })
    expect((await run(await person(), BRAND.origin, { keys: failing })).out).toEqual({ refused: 'unavailable' })
    const non200 = remoteKeys(TEAM, async () => new Response('nope', { status: 500 }))
    expect((await run(await person(), BRAND.origin, { keys: non200 })).out).toEqual({ refused: 'unavailable' })
    const junk = remoteKeys(TEAM, async () => new Response('{"keys": 5}'))
    expect((await run(await person(), BRAND.origin, { keys: junk })).out).toEqual({ refused: 'unavailable' })
  })
  it('answers 503 with no principal when the fetch times out (3 s)', async () => {
    const hanging = remoteKeys(TEAM, (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    }))
    expect((await run(await person(), BRAND.origin, { keys: hanging })).out).toEqual({ refused: 'unavailable' })
  }, 10_000)
  it('picks up a rotated key (a new kid) once the 30 s cooldown has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    let served = good.key.jwks.keys
    const keys = remoteKeys(TEAM, async () => jwksResponse(served))
    expect(principalOf((await run(await person(), BRAND.origin, { keys })).out)).not.toBeNull()
    served = [...good.key.jwks.keys, ...other.key.jwks.keys]
    const rotated = await person({ key: other.key.privateJwk })
    // Inside the cooldown jose doesn't refetch: the new kid is still unknown.
    expect((await run(rotated, BRAND.origin, { keys })).out).toEqual({ refused: 'unauthorized' })
    vi.setSystemTime(NOW + 31_000)
    expect(principalOf((await run(rotated, BRAND.origin, { keys })).out)).not.toBeNull()
  })
})

// The test issuer's own header (eval behind Access, Wasim's E-5 second lock): Access in front sends its own token in
// Cf-Access-Jwt-Assertion, so test and eval builds read the test issuer's JWT from X-Inhouse-Test-Assertion first. Ways
// it could fail, written down first:
//  1. a test or eval build behind Access refuses the eval person (it reads only Access's own token);
//  2. the product build, or a test build without INHOUSE_TEST_BUILD=1, reads the new header at all;
//  3. a bad token in the new header falls back to Cf-Access-Jwt-Assertion (fails open), or the new header skips any of
//     the issuer, key or aud checks;
//  4. per-PR test builds and the existing specs, which send Cf-Access-Jwt-Assertion only, stop working.
describe('X-Inhouse-Test-Assertion (test and eval builds behind Access)', () => {
  const HEADER = 'X-Inhouse-Test-Assertion'
  const testEnv = () => ({ ...authEnv(), INHOUSE_TEST_BUILD: '1', TEST_ISSUER_JWKS: JSON.stringify(good.key.jwks) })
  const testToken = (o: Partial<Parameters<typeof mintPerson>[0]> = {}) => person({ iss: TEST_ISSUER, ...o })
  /** Access's own token for the eval CI service token: the team domain's issuer and another key, as Access sends it. */
  const accessToken = () => mintService({ key: other.key.privateJwk, aud: BRAND.aud, iss: TEAM, clientId: 'eval-ci.access', nowMs: NOW })
  async function runWith(headers: Record<string, string>, o: { env?: object; testBuild?: boolean } = {}) {
    const s = fakeStores({ people })
    return authenticate(req(BRAND.origin, headers), (o.env ?? testEnv()) as never, s.stores, NOW, 'req-1', undefined, o.testBuild)
  }
  it('test build: the test issuer\'s token in its own header signs the person in, beside Access\'s token (1)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await runWith({ [HEADER]: await testToken(), 'Cf-Access-Jwt-Assertion': await accessToken() }, { testBuild: true })
    expect(principalOf(out)?.kind).toBe('person')
  })
  it('test build: with no new header, Cf-Access-Jwt-Assertion works as before (4)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(principalOf(await runWith({ 'Cf-Access-Jwt-Assertion': await testToken() }, { testBuild: true }))?.kind).toBe('person')
  })
  it('test build: a bad token in the new header is refused, never replaced by Cf-Access-Jwt-Assertion (3)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const good2 = await testToken()
    for (const bad of ['not-a-jwt', await testToken({ iss: TEAM }), await testToken({ aud: INHOUSE.aud }), await mintPerson({ key: other.key.privateJwk, aud: BRAND.aud, iss: TEST_ISSUER, sub: 'sub-1', email: 'p@example.test', nowMs: NOW })]) {
      expect(await runWith({ [HEADER]: bad, 'Cf-Access-Jwt-Assertion': good2 }, { testBuild: true }), bad.slice(0, 12)).toEqual({ refused: 'unauthorized' })
    }
  })
  // #278 reviews (O-N3, S-nit1): an empty value counts as present (refused no_token, no fallback), and a duplicated one
  // (Headers joins the two values) is refused as malformed.
  it('test build: an empty new header is refused, never replaced by Cf-Access-Jwt-Assertion (3)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await runWith({ [HEADER]: '', 'Cf-Access-Jwt-Assertion': await testToken() }, { testBuild: true })).toEqual({ refused: 'unauthorized' })
    expect(warn.mock.calls.at(-1)).toEqual([{ event: 'auth_refused', class: 'no_token', requestId: 'req-1' }])
  })
  it('test build: the new header given twice is refused as malformed, even when both values are good (3)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tok = await testToken()
    const r = req(BRAND.origin, { [HEADER]: tok, 'Cf-Access-Jwt-Assertion': tok })
    r.headers.append(HEADER, tok)
    expect(r.headers.get(HEADER)).toBe(`${tok}, ${tok}`)
    const s = fakeStores({ people })
    expect(await authenticate(r, testEnv() as never, s.stores, NOW, 'req-1', undefined, true)).toEqual({ refused: 'unauthorized' })
    expect(warn.mock.calls.at(-1)).toEqual([{ event: 'auth_refused', class: 'malformed_token', requestId: 'req-1' }])
  })
  it('product build (flag off): the new header is ignored, even with INHOUSE_TEST_BUILD=1 (2)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await runWith({ [HEADER]: await testToken() }, { testBuild: false })).toEqual({ refused: 'unauthorized' })
    expect(warn.mock.calls.at(-1)).toEqual([{ event: 'auth_refused', class: 'no_token', requestId: 'req-1' }])
    // The team domain's own person token in the new header is ignored too.
    expect(await runWith({ [HEADER]: await person() }, { env: authEnv(), testBuild: false })).toEqual({ refused: 'unauthorized' })
    expect(warn.mock.calls.at(-1)).toEqual([{ event: 'auth_refused', class: 'no_token', requestId: 'req-1' }])
  })
  it('flag on but INHOUSE_TEST_BUILD unset: the new header is ignored (2)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await runWith({ [HEADER]: await testToken() }, { env: authEnv(), testBuild: true })).toEqual({ refused: 'unauthorized' })
    expect(warn.mock.calls.at(-1)).toEqual([{ event: 'auth_refused', class: 'no_token', requestId: 'req-1' }])
  })
  it('issuer off (every build but test and eval): no header name to read at all (2)', () => {
    expect(issuerOff.TEST_ASSERTION_HEADER).toBe('')
    const r = req(BRAND.origin, { [HEADER]: 'x.y.z' })
    expect(testAssertion(r, issuerOff)).toBeNull()
    expect(testAssertion(r)).toBe('x.y.z')
  })
})
