// Route 67, `POST /api/ops/alarm`, the test build's alarm-now control (P4 wave 4, p4-w6.md OC 2), through the whole
// /api/* path (server/api.ts) with the real route table, the real access matrix, the real sign-in and the real
// BrandAgent. Ways it can fail, written down first:
//  1. it answers anything but 404 outside the test build (compiled out, or compiled in but not switched on), or runs a
//     pass there;
//  2. inside the test build it doesn't run a scheduler pass, or answers something else than `{ ran: true }`;
//  3. the guard moved: a person (member or admin) reaches it, or the release token's POST passes without the brand Origin;
//  4. the off stand-in (`@test-controls` outside the test build) runs the pass instead of refusing.
// Expected bodies and statuses are literals here.
import { env as baseEnv } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import { routes } from '../routes.ts'
import type { Route } from '../routes.ts'
import { alarmNowHandler } from './alarm-now.ts'
import { runAlarmNow as offRunAlarmNow, TEST_CONTROLS_CANARY as OFF_CANARY } from './test-controls-off.ts'
import { accessMatrix } from '../access-matrix.ts'
import { authenticate, checkAccess, checkOrigin } from '../auth/index.ts'
import { mintPerson, mintService } from '../auth/test-issuer-mint.ts'
import { BRAND, RELEASE_ID, TEAM, authEnv, fakeStores, issuer } from '../testing/auth-fixtures.ts'
import type { Issuer } from '../testing/auth-fixtures.ts'

let good: Issuer
beforeAll(async () => { good = await issuer() })
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext

/** As drain.test.ts: `compiled` stands in for `__INHOUSE_TEST_BUILD__`, `flag` for the `INHOUSE_TEST_BUILD` var. */
function setup(mode?: { compiled: boolean; flag: string | undefined }) {
  const s = fakeStores({ people: { member: { role: 'member' }, admin: { role: 'admin' } }, grant: null })
  const table: readonly Route[] = mode === undefined ? routes
    : routes.map(r => (r.method === 'POST' && r.pattern === '/api/ops/alarm' ? { ...r, handler: alarmNowHandler(mode.compiled) } : r))
  const parts: ApiParts = {
    authenticate: (r, e, st, n, id) => authenticate(r, e, st, n, id, good.keys),
    checkOrigin, checkAccess, stores: () => s.stores, routes: table, accessMatrix,
  }
  const env = { ...baseEnv, ...authEnv() } as Env & { INHOUSE_TEST_BUILD?: string }
  if (mode !== undefined) {
    if (mode.flag === undefined) delete env.INHOUSE_TEST_BUILD
    else env.INHOUSE_TEST_BUILD = mode.flag
  }
  return (path: string, init: RequestInit = {}) => api(parts, new Request(`${BRAND.origin}${path}`, init), env, ctx, 'req-1')
}
const release = async () => ({ 'Cf-Access-Jwt-Assertion': await mintService({ key: good.key.privateJwk, iss: TEAM, aud: BRAND.aud, clientId: RELEASE_ID }), Origin: BRAND.origin })
const person = async (who: 'member' | 'admin') => ({
  'Cf-Access-Jwt-Assertion': await mintPerson({ key: good.key.privateJwk, iss: TEAM, aud: BRAND.aud, sub: who, email: `${who}@example.test` }),
  Origin: BRAND.origin,
})
const bodyOf = async (r: Response) => JSON.parse(await r.text())
/** Silences the logs and returns the `test_control` lines the object wrote (they reach the test's console in workerd). */
const controlLines = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  return () => log.mock.calls.filter(([e]) => (e as { event?: unknown })?.event === 'test_control')
}

describe('route 67 outside the test build (failure 1)', () => {
  it('product build (compiled out, this test\'s own compile): 404 not_found to the release token, no pass', async () => {
    const lines = controlLines()
    const res = await setup()('/api/ops/alarm', { method: 'POST', headers: await release() })
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: { code: 'not_found' } })
    expect(lines()).toEqual([])
    vi.restoreAllMocks()
  })

  it('compiled in but not switched on (no INHOUSE_TEST_BUILD, or not "1"): 404, no pass', async () => {
    const lines = controlLines()
    for (const flag of [undefined, '0', 'true']) {
      const res = await setup({ compiled: true, flag })('/api/ops/alarm', { method: 'POST', headers: await release() })
      expect(res.status, String(flag)).toBe(404)
    }
    expect(lines()).toEqual([])
    vi.restoreAllMocks()
  })
})

describe('route 67 in the test build (failures 2 and 3)', () => {
  it('runs one scheduler pass on the BrandAgent and answers { ran: true }; still release only, with the brand Origin', async () => {
    const lines = controlLines()
    const call = setup({ compiled: true, flag: '1' })
    const h = await release()
    const res = await call('/api/ops/alarm', { method: 'POST', headers: h })
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({ ran: true })
    expect(lines()).toEqual([[{ event: 'test_control', control: 'alarm_now', canary: 'inhouse-test-controls-canary-5d81e0a7' }]])
    for (const who of ['member', 'admin'] as const) {
      const r = await call('/api/ops/alarm', { method: 'POST', headers: await person(who) })
      expect(r.status, who).toBe(403)
      expect((await bodyOf(r)).error.code, who).toBe('forbidden')
    }
    const { Origin: _o, ...noOrigin } = h
    const r = await call('/api/ops/alarm', { method: 'POST', headers: noOrigin })
    expect(await bodyOf(r)).toEqual({ error: { code: 'forbidden', reason: 'bad_origin' } })
    expect(lines()).toHaveLength(1)
    vi.restoreAllMocks()
  })
})

describe('the off stand-in (failure 4)', () => {
  it('throws without running the pass, and carries no canary', async () => {
    let ran = false
    expect(() => offRunAlarmNow(async () => { ran = true })).toThrow('The test controls are not in this build.')
    expect(ran).toBe(false)
    expect(OFF_CANARY).toBe('')
  })
})
