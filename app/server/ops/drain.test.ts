// Routes 46-48 (drain, its state, warm-up) through the whole /api/* path (server/api.ts) with the real route table, the
// real access matrix, the real sign-in and the real BrandAgent (its pool on the object's SQLite). The test pool has no
// containers, so warm-up can't prove a runner here: it answers the pool's refusal (503 `unavailable`, no reason), which
// is still the built handler's answer, not PR0's `not_built`. Ways it can fail, written down first:
//  1. a route still answers PR0's 503 `not_built`;
//  2. drain doesn't start a drain (no expiry), or the state route doesn't report the same drain;
//  3. warm-up clears the drain although no runner was proven;
//  4. the guard moved: a person (member or admin) reaches these routes, or the release token's write passes without
//     the brand `Origin`.
// Expected bodies and statuses are literals here.
import { env as baseEnv } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import { routes } from '../routes.ts'
import { accessMatrix } from '../access-matrix.ts'
import { authenticate, checkAccess, checkOrigin } from '../auth/index.ts'
import { mintPerson, mintService } from '../auth/test-issuer-mint.ts'
import { BRAND, RELEASE_ID, TEAM, authEnv, fakeStores, issuer } from '../testing/auth-fixtures.ts'
import type { Issuer } from '../testing/auth-fixtures.ts'

let good: Issuer
beforeAll(async () => { good = await issuer() })
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext

function setup() {
  const s = fakeStores({ people: { member: { role: 'member' }, admin: { role: 'admin' } }, grant: null })
  const parts: ApiParts = {
    authenticate: (r, e, st, n, id) => authenticate(r, e, st, n, id, good.keys),
    checkOrigin, checkAccess, stores: () => s.stores, routes, accessMatrix,
  }
  const env = { ...baseEnv, ...authEnv() } as Env
  return (path: string, init: RequestInit = {}) => api(parts, new Request(`${BRAND.origin}${path}`, init), env, ctx, 'req-1')
}
const release = async () => ({ 'Cf-Access-Jwt-Assertion': await mintService({ key: good.key.privateJwk, iss: TEAM, aud: BRAND.aud, clientId: RELEASE_ID }), Origin: BRAND.origin })
const person = async (who: 'member' | 'admin') => ({
  'Cf-Access-Jwt-Assertion': await mintPerson({ key: good.key.privateJwk, iss: TEAM, aud: BRAND.aud, sub: who, email: `${who}@example.test` }),
  Origin: BRAND.origin,
})
const bodyOf = async (r: Response) => JSON.parse(await r.text())
const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
}

describe('routes 46-48 answer the built handlers', () => {
  it('drain starts a 30-minute drain, its state reports it, warm-up with no provable runner refuses and keeps it', async () => {
    quiet()
    const call = setup()
    const h = await release()
    const before = Date.now()
    const drained = await call('/api/ops/drain', { method: 'POST', headers: h })
    const after = Date.now()
    expect(drained.status).toBe(200)
    const d = await bodyOf(drained)
    expect(d).toEqual({ live: 0, starting: 0, ending: 0, queued: 0, drainingUntilMs: expect.any(Number) })
    expect(d.drainingUntilMs).toBeGreaterThanOrEqual(before + 1_800_000)
    expect(d.drainingUntilMs).toBeLessThanOrEqual(after + 1_800_000)

    const state = await call('/api/ops/drain', { headers: { 'Cf-Access-Jwt-Assertion': h['Cf-Access-Jwt-Assertion'] } })
    expect(state.status).toBe(200)
    expect(await bodyOf(state)).toEqual(d)

    const warm = await call('/api/ops/warmup', { method: 'POST', headers: h })
    expect(warm.status).toBe(503)
    expect(await bodyOf(warm)).toEqual({ error: { code: 'unavailable' } })
    expect(await bodyOf(await call('/api/ops/drain', { headers: h }))).toEqual(d)
    vi.restoreAllMocks()
  })
})

describe('the guard is unchanged', () => {
  it('a member or an admin gets 403 on each of 46-48; the release token without the brand Origin gets 403 bad_origin', async () => {
    quiet()
    const call = setup()
    for (const who of ['member', 'admin'] as const) {
      const h = await person(who)
      for (const [method, path] of [['POST', '/api/ops/drain'], ['GET', '/api/ops/drain'], ['POST', '/api/ops/warmup']] as const) {
        const res = await call(path, { method, headers: h })
        expect(res.status, `${who} ${method} ${path}`).toBe(403)
        expect((await bodyOf(res)).error.code, `${who} ${method} ${path}`).toBe('forbidden')
      }
    }
    const { Origin: _origin, ...noOrigin } = await release()
    for (const path of ['/api/ops/drain', '/api/ops/warmup']) {
      const res = await call(path, { method: 'POST', headers: noOrigin })
      expect(res.status, path).toBe(403)
      expect(await bodyOf(res), path).toEqual({ error: { code: 'forbidden', reason: 'bad_origin' } })
    }
    vi.restoreAllMocks()
  })
})
