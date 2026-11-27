// Route 67, `POST /api/ops/alarm`, the test build's alarm-now control (P4 wave 4, p4-w6.md OC 2), through the whole
// /api/* path (server/api.ts) with the real route table, the real access matrix, the real sign-in and the real
// BrandAgent. Ways it can fail, written down first:
//  1. it answers anything but 404 outside the test build (compiled out, or compiled in but not switched on), or runs a
//     pass there;
//  2. inside the test build it doesn't run a scheduler pass (a due task stays as it was), or answers something else
//     than `{ ran: true }`;
//  3. the guard moved: a person (member or admin) reaches it, or the release token's POST passes without the brand Origin;
//  4. the off stand-in (`@test-controls` outside the test build) runs the pass instead of refusing.
// Expected bodies and statuses are literals here.
import { env as baseEnv } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import { routes } from '../routes.ts'
import type { Route } from '../routes.ts'
import { alarmNowHandler } from './alarm-now.ts'
import { runAlarmNow as offRunAlarmNow, TEST_CONTROLS_CANARY as OFF_CANARY } from './test-controls-off.ts'
import { loadTestControls, resetTestControls, setTimings, timing, TIMINGS_FLAG, TIMINGS_TTL_MS } from '@test-controls'
import { accessMatrix } from '../access-matrix.ts'
import { authenticate, checkAccess, checkOrigin } from '../auth/index.ts'
import { mintPerson, mintService } from '../auth/test-issuer-mint.ts'
import { BRAND, RELEASE_ID, TEAM, authEnv, fakeStores, issuer } from '../testing/auth-fixtures.ts'
import type { Issuer } from '../testing/auth-fixtures.ts'

let good: Issuer
beforeAll(async () => { good = await issuer() })
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext

/**
 * As drain.test.ts: `compiled` stands in for `__INHOUSE_TEST_BUILD__`, `flag` for the `INHOUSE_TEST_BUILD` var, `eval`
 * for `__INHOUSE_EVAL_BUILD__`.
 */
function setup(mode?: { compiled: boolean; flag: string | undefined; eval?: boolean }) {
  const s = fakeStores({ people: { member: { role: 'member' }, admin: { role: 'admin' } }, grant: null })
  const table: readonly Route[] = mode === undefined ? routes
    : routes.map(r => (r.method === 'POST' && r.pattern === '/api/ops/alarm' ? { ...r, handler: alarmNowHandler(mode.compiled, mode.eval ?? false) } : r))
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

it('gates and validates job controls before dispatching them', async () => {
  const headers = await release()
  const post = (call: ReturnType<typeof setup>, body: unknown, h = headers) =>
    call('/api/ops/alarm', { method: 'POST', headers: h, body: JSON.stringify(body) })
  const timing = { action: 'setTimings', overrides: { JOB_CUT_MS: 150 } }
  const kill = { action: 'killRunner', runner: 'runner-0' }
  const gen = { action: 'runnerGen', runner: 'runner-0' }
  const enabled = setup({ compiled: true, flag: '1' })
  for (const body of [timing, kill, gen]) {
    expect((await post(setup(), body)).status).toBe(404)
    expect((await post(setup({ compiled: true, flag: '0' }), body)).status).toBe(404)
    expect((await post(enabled, body, await person('admin'))).status).toBe(403)
  }
  for (const body of [
    { action: 'setTimings', overrides: { JOB_CUT_MS: -1 } },
    { action: 'setTimings', overrides: { JOB_CUT_MS: 1.5 } },
    { action: 'setTimings', overrides: { invalidName: 10 } },
    // Well-formed but not in job-timings.ts: refused, never silently ignored.
    { action: 'setTimings', overrides: { JOB_UNKNOWN_MS: 10 } },
    { action: 'setTimings', overrides: { JOB_CUT_MS: 100, JOB_UNKNOWN_MS: 10 } },
    { action: 'killRunner', runner: 'arbitrary-name' },
    { action: 'runnerGen', runner: 'arbitrary-name' },
  ]) expect((await post(enabled, body)).status).toBe(400)
  // In the runner name's format but outside the pool (the test config's RUNNER_POOL is 2).
  expect(baseEnv.RUNNER_POOL).toBe('2')
  for (const runner of ['runner-2', 'runner-9']) {
    for (const action of ['killRunner', 'runnerGen']) {
      const r = await post(enabled, { action, runner })
      expect(r.status, `${action} ${runner}`).toBe(404)
      expect(await bodyOf(r)).toEqual({ error: { code: 'not_found', reason: 'runner' } })
    }
  }
  try {
    expect(await bodyOf(await post(enabled, timing))).toEqual({ set: true })
    expect(await bodyOf(await post(enabled, { action: 'setTimings', overrides: { JOB_CUT_MS: 100, JOB_DEADLINE_MS: 900 } }))).toEqual({ set: true })
    // The in-process test pool has no containers. The hook must not boot one.
    expect(await bodyOf(await post(enabled, kill))).toEqual({ killed: false })
    expect(await bodyOf(await post(enabled, { action: 'killRunner', runner: 'runner-1' }))).toEqual({ killed: false })
    // No container ever started in the test pool: generation 0, read from the Runner's storage without booting one.
    expect(await bodyOf(await post(enabled, gen))).toEqual({ gen: 0 })
  } finally {
    expect((await post(enabled, { action: 'setTimings', overrides: {} })).status).toBe(200)
  }
})

it('eval build (compiled in and switched on, the eval build too): 404 for every control, before the object is reached', async () => {
  const headers = await release()
  const call = setup({ compiled: true, flag: '1', eval: true })
  const agent = vi.spyOn(baseEnv.BRAND_AGENT, 'getByName')
  const runner = vi.spyOn(baseEnv.RUNNER, 'getByName')
  try {
    for (const body of [
      {},
      { action: 'alarm', pokeTick: true },
      { action: 'stopAfterBatch' },
      { action: 'setTimings', overrides: { JOB_CUT_MS: 150 } },
      { action: 'killRunner', runner: 'runner-0' },
      { action: 'runnerGen', runner: 'runner-0' },
    ]) {
      const r = await call('/api/ops/alarm', { method: 'POST', headers, body: JSON.stringify(body) })
      expect(r.status, JSON.stringify(body)).toBe(404)
      expect(await bodyOf(r)).toEqual({ error: { code: 'not_found' } })
    }
    expect(agent).not.toHaveBeenCalled()
    expect(runner).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
  }
})

/**
 * A due task the pass can see: a row of a kind no handler knows, due a moment ago, written straight into the brand's
 * object with its alarm moved an hour out first, so only a pass this test starts can reach it (the runtime's alarm
 * can't fire in between). A pass quarantines an unknown kind, so its state tells whether a pass ran.
 */
let probes = 0
const brand = () => baseEnv.BRAND_AGENT.getByName('brand')
async function dueProbe(): Promise<string> {
  const id = `alarm-now-probe-${++probes}`
  await runInDurableObject(brand(), async (_i, state) => {
    await state.storage.setAlarm(Date.now() + 3_600_000)
    state.storage.sql.exec(
      "INSERT INTO due_tasks (id, kind, gen, due_at_ms, payload_json, attempts, state) VALUES (?, 'alarm-now-probe', 1, ?, NULL, 0, 'ready')", id, Date.now() - 1,
    )
  })
  return id
}
const probeState = (id: string) => runInDurableObject(brand(), (_i, state) =>
  state.storage.sql.exec<{ state: string; last_error: string | null }>('SELECT state, last_error FROM due_tasks WHERE id = ?', id).toArray())
const dropProbe = (id: string) => runInDurableObject(brand(), (_i, state) => { state.storage.sql.exec('DELETE FROM due_tasks WHERE id = ?', id) })
/** Runs `fn` with a due probe and always removes the probe, so a failed assertion leaves no row behind. */
async function withProbe(fn: (id: string) => Promise<void>): Promise<void> {
  const id = await dueProbe()
  try {
    await fn(id)
  } finally {
    await dropProbe(id)
  }
}
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
    await withProbe(async probe => {
      const res = await setup()('/api/ops/alarm', { method: 'POST', headers: await release() })
      expect(res.status).toBe(404)
      expect(await bodyOf(res)).toEqual({ error: { code: 'not_found' } })
      expect(lines()).toEqual([])
      expect(await probeState(probe)).toEqual([{ state: 'ready', last_error: null }])
    })
    vi.restoreAllMocks()
  })

  it('compiled in but not switched on (no INHOUSE_TEST_BUILD, or not "1"): 404, no pass', async () => {
    const lines = controlLines()
    await withProbe(async probe => {
      for (const flag of [undefined, '0', 'true']) {
        const res = await setup({ compiled: true, flag })('/api/ops/alarm', { method: 'POST', headers: await release() })
        expect(res.status, String(flag)).toBe(404)
      }
      expect(lines()).toEqual([])
      expect(await probeState(probe)).toEqual([{ state: 'ready', last_error: null }])
    })
    vi.restoreAllMocks()
  })
})

describe('route 67 in the test build (failures 2 and 3)', () => {
  it('runs one scheduler pass on the BrandAgent and answers { ran: true }; still release only, with the brand Origin', async () => {
    const lines = controlLines()
    const call = setup({ compiled: true, flag: '1' })
    const h = await release()
    await withProbe(async probe => {
      expect(await probeState(probe)).toEqual([{ state: 'ready', last_error: null }])
      const res = await call('/api/ops/alarm', { method: 'POST', headers: h })
      expect(res.status).toBe(200)
      expect(await bodyOf(res)).toEqual({ ran: true })
      // The pass reached the due task: an unknown kind is quarantined (scheduler.ts), so the state changed in this pass.
      expect(await probeState(probe)).toEqual([{ state: 'quarantined', last_error: 'unknown kind alarm-now-probe' }])
    })
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

// The job timings kept across an eviction, and the observe control (2026-11-27: jobs.spec.ts failed on #454 and #455
// because an override set in the BrandAgent's memory was gone by the time the turn's cut was due). Ways it can fail,
// written first: the overrides live in memory only, so a new instance reads the defaults; a load brings back a name or a
// value the route refuses; observe writes anything, answers outside the test build, or leaves out the turn's cut facts.
describe('the job timings kept in the object, and the observe control', () => {
  const post = async (body: unknown) => setup({ compiled: true, flag: '1' })('/api/ops/alarm', { method: 'POST', headers: await release(), body: JSON.stringify(body) })

  it('setTimings keeps the overrides in the object\'s SQLite; a new instance (memory cleared, then loaded) reads them back', async () => {
    const lines = controlLines()
    try {
      expect(await bodyOf(await post({ action: 'setTimings', overrides: { JOB_CUT_MS: 150_000 } }))).toEqual({ set: true })
      const stored = await runInDurableObject(brand(), (_i, state) =>
        state.storage.sql.exec<{ value: string }>('SELECT value FROM flags WHERE key = ?', TIMINGS_FLAG).toArray())
      expect(stored.map(r => JSON.parse(r.value))).toEqual([{ setAtMs: expect.any(Number), overrides: { JOB_CUT_MS: 150_000 } }])
      // An eviction: this isolate's memory is gone (the module copy), and the constructor loads from the object's SQLite.
      resetTestControls()
      expect(timing('JOB_CUT_MS', 1_500_000)).toBe(1_500_000)
      await runInDurableObject(brand(), (_i, state) => { loadTestControls(state.storage.sql) })
      expect(timing('JOB_CUT_MS', 1_500_000)).toBe(150_000)
      expect((await bodyOf(await post({ action: 'observe' }))).timings).toEqual({ JOB_CUT_MS: 150_000 })
      // A stored name or value the route would refuse is never loaded.
      await runInDurableObject(brand(), (_i, state) => {
        state.storage.sql.exec('UPDATE flags SET value = ? WHERE key = ?', JSON.stringify({ setAtMs: Date.now(), overrides: { JOB_CUT_MS: -5, JOB_UNKNOWN_MS: 10, JOB_RETRY_MS: 2_000 } }), TIMINGS_FLAG)
        loadTestControls(state.storage.sql)
      })
      expect([timing('JOB_CUT_MS', 7), timing('JOB_RETRY_MS', 7)]).toEqual([7, 2_000])
    } finally {
      expect((await post({ action: 'setTimings', overrides: {} })).status).toBe(200)
      vi.restoreAllMocks()
    }
    // Cleared: kept as none, so a new instance loads the defaults.
    await runInDurableObject(brand(), (_i, state) => { loadTestControls(state.storage.sql) })
    expect(timing('JOB_CUT_MS', 1_500_000)).toBe(1_500_000)
    expect(lines().length).toBeGreaterThan(0)
  })

  // #460 review (Fable): the constructor's load is what the fix is, so it's proven on a second instance really built
  // over the same storage; and a bad row must never throw there (a throw would reset the object on every construction).
  it('a second BrandAgent built over the same storage reads the kept timings (memory gone in between)', async () => {
    controlLines()
    const name = `timings-reload-${Math.random()}`
    try {
      const first = baseEnv.BRAND_AGENT.getByName(name)
      expect(await first.testSetTimings({ JOB_CUT_MS: 150_000 })).toEqual({ set: true })
      const before = await runInDurableObject(first, i => i)
      await runInDurableObject(first, (_i, state) => { state.abort('a new instance, as after an eviction') }).catch(() => {})
      resetTestControls()
      const second = baseEnv.BRAND_AGENT.getByName(name)
      const o = await second.testObserve(null)
      expect(await runInDurableObject(second, i => i)).not.toBe(before)
      expect(o.timings).toEqual({ JOB_CUT_MS: 150_000 })
      expect(timing('JOB_CUT_MS', 1_500_000)).toBe(150_000)
    } finally {
      resetTestControls()
      vi.restoreAllMocks()
    }
  })

  it('a kept row it can\'t read is logged and loads none, never throws; an expired one loads none; no row leaves memory alone', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await runInDurableObject(brand(), (_i, state) => {
        const sql = state.storage.sql
        const put = (v: unknown) => sql.exec('INSERT INTO flags (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', TIMINGS_FLAG, v as string)
        for (const bad of ['not json', null, 'null', '[1,2]', '{"overrides":{"JOB_CUT_MS":1}}', '{"setAtMs":1,"overrides":null}', '{"setAtMs":1,"overrides":[1]}', '7']) {
          setTimings({ JOB_CUT_MS: 99 })
          put(bad)
          expect(() => loadTestControls(sql), String(bad)).not.toThrow()
          expect(timing('JOB_CUT_MS', 1_500_000), String(bad)).toBe(1_500_000)
        }
        expect(errors.mock.calls.map(([e]) => (e as { event?: string }).event)).toEqual(Array(8).fill('test_controls_bad_row'))
        // Expired (set more than an hour before this load): none, without a log.
        errors.mockClear()
        put(JSON.stringify({ setAtMs: 1_000, overrides: { JOB_CUT_MS: 150_000 } }))
        loadTestControls(sql, 1_000 + TIMINGS_TTL_MS + 1)
        expect(timing('JOB_CUT_MS', 1_500_000)).toBe(1_500_000)
        loadTestControls(sql, 1_000 + TIMINGS_TTL_MS)
        expect(timing('JOB_CUT_MS', 1_500_000)).toBe(150_000)
        expect(errors).not.toHaveBeenCalled()
        // No row: a unit test's in-memory overrides survive an object being built.
        sql.exec('DELETE FROM flags WHERE key = ?', TIMINGS_FLAG)
        setTimings({ JOB_CUT_MS: 42 })
        loadTestControls(sql)
        expect(timing('JOB_CUT_MS', 1_500_000)).toBe(42)
      })
      expect(errors).not.toHaveBeenCalled()
    } finally {
      resetTestControls()
      vi.restoreAllMocks()
    }
  })

  it('observe answers the isolate, the instance, the timings and a turn\'s cut facts, writing nothing; a bad id is a 400', async () => {
    controlLines()
    try {
      const before = await runInDurableObject(brand(), (_i, state) => state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM due_tasks').one().n)
      const o = await bodyOf(await post({ action: 'observe' }))
      expect(o).toEqual({
        isolateId: expect.stringMatching(/^[0-9a-f-]{36}$/), constructedAtMs: expect.any(Number), nowMs: expect.any(Number),
        timings: {}, turn: null, turnWatch: null, quarantined: expect.any(Number),
      })
      expect(o.constructedAtMs).toBeLessThanOrEqual(o.nowMs)
      // The same isolate answers twice with the same id.
      expect((await bodyOf(await post({ action: 'observe' }))).isolateId).toBe(o.isolateId)
      expect(await bodyOf(await post({ action: 'observe', turnId: 't_AAAAAAAAAAAAAAAAAAAAAA' }))).toMatchObject({ turn: null, turnWatch: null })
      for (const bad of [{ action: 'observe', turnId: 'nope' }, { action: 'observe', extra: 1 }]) expect((await post(bad)).status).toBe(400)
      const after = await runInDurableObject(brand(), (_i, state) => state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM due_tasks').one().n)
      expect(after).toBe(before)
      // Outside the test build, and in the eval build: 404, as every control.
      const h = await release()
      expect((await setup()('/api/ops/alarm', { method: 'POST', headers: h, body: JSON.stringify({ action: 'observe' }) })).status).toBe(404)
      expect((await setup({ compiled: true, flag: '1', eval: true })('/api/ops/alarm', { method: 'POST', headers: h, body: JSON.stringify({ action: 'observe' }) })).status).toBe(404)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
