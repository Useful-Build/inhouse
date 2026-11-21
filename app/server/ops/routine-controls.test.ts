// Route 67's routine controls (p4-w6.md section 3 and OC 2): stop a routine tick after its batch, and seed a routine's
// `checked_until_ms`, through the whole /api/* path (server/api.ts) with the real route table, access matrix, sign-in and
// BrandAgent; the tick itself on the routines test kit (a real D1, the reference fake of `runs.submit`). Ways it can
// fail, written down first:
//  1. outside the test build (compiled out, or compiled in but not switched on) a control answers anything but 404, or
//     acts: the switch arms, or a cursor moves;
//  2. inside it, an armed tick still submits in the same pass, or never stops, or stops twice (not one-shot), or the slot
//     row isn't committed before the stop, so the next pass runs the slot twice or never;
//  3. the seed writes another routine, a deleted one, or a future instant; a bad body passes;
//  4. `pokeTick` doesn't make the BrandAgent's own tick run (the hook isn't wired into the real object's pass);
//  5. the off stand-in arms or seeds instead of refusing, or its tick hook throws.
// Expected bodies and statuses are literals here.
import { env as baseEnv } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import { routes } from '../routes.ts'
import type { Route } from '../routes.ts'
import { alarmNowHandler } from './alarm-now.ts'
import * as off from './test-controls-off.ts'
import { accessMatrix } from '../access-matrix.ts'
import { authenticate, checkAccess, checkOrigin } from '../auth/index.ts'
import { mintService } from '../auth/test-issuer-mint.ts'
import { BRAND, RELEASE_ID, TEAM, authEnv, fakeStores, issuer } from '../testing/auth-fixtures.ts'
import type { Issuer } from '../testing/auth-fixtures.ts'
import { MIN, addPerson, db, fresh, harness, insertRoutine, routine, setStage, setZone, slotsOf } from '../routines/test-kit.ts'

let good: Issuer
const CREATOR = 'm_test_controls_creator'
beforeAll(async () => {
  good = await issuer()
  await addPerson(CREATOR)
})
beforeEach(async () => {
  await fresh()
  await setZone('UTC')
  await setStage('Act')
})
afterEach(() => { vi.restoreAllMocks() })
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext

/** As alarm-now.test.ts: `compiled` stands in for `__INHOUSE_TEST_BUILD__`, `flag` for the `INHOUSE_TEST_BUILD` var. */
function setup(mode?: { compiled: boolean; flag: string | undefined }) {
  const s = fakeStores({ people: {}, grant: null })
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
  return async (body: unknown) => {
    const headers = {
      'Cf-Access-Jwt-Assertion': await mintService({ key: good.key.privateJwk, iss: TEAM, aud: BRAND.aud, clientId: RELEASE_ID }),
      Origin: BRAND.origin, 'Content-Type': 'application/json',
    }
    const res = await api(parts, new Request(`${BRAND.origin}/api/ops/alarm`, { method: 'POST', headers, body: JSON.stringify(body) }), env, ctx, 'req-1')
    return { status: res.status, body: JSON.parse(await res.text()) as unknown }
  }
}
const testBuild = () => setup({ compiled: true, flag: '1' })

let errors: { mock: { calls: unknown[][] } }
/** Silences the logs and returns the `test_control` lines written so far (the object's reach the test's console too). */
const controlLines = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  return () => log.mock.calls.map(([e]) => e as { event?: unknown; control?: unknown }).filter(e => e?.event === 'test_control').map(e => e.control)
}

/** A routine due a minute ago at 06:00 UTC on 2026-06-01, its cursor just before it: a pass at `NOW` claims and runs it. */
const SIX = Date.parse('2026-06-01T06:00:00Z')
const NOW = SIX + MIN
const dueRoutine = () => insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: SIX - 10 * MIN }))
const cursorOf = async (id: string) => (await db.prepare('SELECT checked_until_ms AS c FROM routines WHERE id = ?').bind(id).first<{ c: number }>())?.c

describe('outside the test build (failure 1)', () => {
  const bodies = [{ action: 'stopAfterBatch' }, { action: 'seedCursor', routineId: 'rt_aaaaaaaaaaaaaaaaaaaaaa', checkedUntilMs: 1 }]
  for (const [name, mode] of [
    ['product build (compiled out)', undefined],
    ['compiled in, no INHOUSE_TEST_BUILD', { compiled: true, flag: undefined }],
    ['compiled in, INHOUSE_TEST_BUILD "0"', { compiled: true, flag: '0' }],
  ] as const) {
    it(`${name}: 404 not_found to each control, and nothing armed or seeded`, async () => {
      const lines = controlLines()
      const r = await dueRoutine()
      const call = setup(mode)
      for (const body of [...bodies, { action: 'seedCursor', routineId: r.id, checkedUntilMs: SIX - 120 * MIN }]) {
        expect(await call(body), JSON.stringify(body)).toEqual({ status: 404, body: { error: { code: 'not_found' } } })
      }
      expect(lines()).toEqual([])
      expect(await cursorOf(r.id)).toBe(SIX - 10 * MIN)
      // Not armed: the next pass runs the slot.
      const h = harness()
      await h.tick(NOW)
      expect((await slotsOf(r.id)).map(s => s.state)).toEqual(['started'])
      expect(h.runs.turns.size).toBe(1)
    })
  }
})

describe('stopAfterBatch in the test build (failure 2)', () => {
  it('arms once: the next pass commits the slot row and stops before the run; the pass after runs it exactly once', async () => {
    const lines = controlLines()
    const r = await dueRoutine()
    expect(await testBuild()({ action: 'stopAfterBatch' })).toEqual({ status: 200, body: { armed: true } })
    const h = harness()
    await h.tick(NOW)
    // The batch committed (cursor moved, slot claimed); nothing was submitted.
    expect((await slotsOf(r.id)).map(s => [s.state, s.run_id])).toEqual([['claimed', null]])
    expect(await cursorOf(r.id)).toBe(NOW)
    expect(h.runs.calls).toBe(0)
    expect(errors).toHaveBeenCalledWith({ event: 'routine_tick_failed', id: 'routine-tick', error: 'Error: test control: the tick stopped after its batch' })
    // One-shot: the next pass runs the claimed row, once.
    await h.tick(NOW + MIN)
    await h.tick(NOW + 2 * MIN)
    expect((await slotsOf(r.id)).map(s => s.state)).toEqual(['started'])
    expect(h.runs.turns.size).toBe(1)
    expect(lines()).toEqual(['stop_after_batch', 'stopped_after_batch'])
  })

  it('the alarm action with pokeTick runs the BrandAgent\'s own tick, which reaches the hook; without it the switch waits', async () => {
    const lines = controlLines()
    const call = testBuild()
    // Any heartbeat already due runs here, so the next plain pass has no tick to run.
    expect(await call({ action: 'alarm' })).toEqual({ status: 200, body: { ran: true } })
    expect(await call({ action: 'stopAfterBatch' })).toEqual({ status: 200, body: { armed: true } })
    expect(await call({})).toEqual({ status: 200, body: { ran: true } })
    expect(lines()).toEqual(['alarm_now', 'stop_after_batch', 'alarm_now'])
    expect(await call({ action: 'alarm', pokeTick: true })).toEqual({ status: 200, body: { ran: true } })
    expect(lines()).toEqual(['alarm_now', 'stop_after_batch', 'alarm_now', 'alarm_now', 'stopped_after_batch'])
  })
})

describe('seedCursor in the test build (failure 3)', () => {
  it('sets that live routine\'s cursor to a past instant, and only that routine\'s', async () => {
    const lines = controlLines()
    const r = await dueRoutine()
    const other = await dueRoutine()
    const back = Date.now() - 120 * MIN
    expect(await testBuild()({ action: 'seedCursor', routineId: r.id, checkedUntilMs: back })).toEqual({ status: 200, body: { seeded: true } })
    expect(await cursorOf(r.id)).toBe(back)
    expect(await cursorOf(other.id)).toBe(SIX - 10 * MIN)
    expect(lines()).toEqual(['seed_cursor'])
  })

  it('a missing or deleted routine is 404 not_found, reason routine; a future instant or a bad body is 400', async () => {
    controlLines()
    const call = testBuild()
    const gone = await insertRoutine(routine({ creator_id: CREATOR, checked_until_ms: SIX, deleted_at_ms: SIX }))
    const past = Date.now() - MIN
    for (const routineId of ['rt_aaaaaaaaaaaaaaaaaaaaaa', gone.id]) {
      expect(await call({ action: 'seedCursor', routineId, checkedUntilMs: past })).toEqual({ status: 404, body: { error: { code: 'not_found', reason: 'routine' } } })
    }
    expect(await cursorOf(gone.id)).toBe(SIX)
    const r = await dueRoutine()
    expect(await call({ action: 'seedCursor', routineId: r.id, checkedUntilMs: Date.now() + 60 * MIN })).toEqual({ status: 400, body: { error: { code: 'invalid', reason: 'not_past' } } })
    for (const body of [
      { action: 'seedCursor', routineId: 'not-a-routine', checkedUntilMs: past },
      { action: 'seedCursor', routineId: r.id, checkedUntilMs: 1.5 },
      { action: 'seedCursor', routineId: r.id },
      { action: 'stopAfterBatch', extra: 1 },
      { action: 'alarm', pokeTick: false },
      { action: 'nope' },
    ]) {
      expect(await call(body), JSON.stringify(body)).toEqual({ status: 400, body: { error: { code: 'invalid' } } })
    }
    expect(await cursorOf(r.id)).toBe(SIX - 10 * MIN)
  })
})

describe('the off stand-in (failure 5)', () => {
  it('refuses to arm or seed, and its tick hook does nothing', async () => {
    expect(() => off.armStopAfterBatch()).toThrow('The test controls are not in this build.')
    expect(() => off.seedCursor(db, 'rt_aaaaaaaaaaaaaaaaaaaaaa', 1)).toThrow('The test controls are not in this build.')
    expect(off.afterTickBatch()).toBeUndefined()
  })
})
