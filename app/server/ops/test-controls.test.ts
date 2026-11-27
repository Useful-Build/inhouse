import { afterEach, expect, it, vi } from 'vitest'
import { killRunner, resetTestControls, setTimings, timing, TIMINGS_FLAG, TIMINGS_TTL_MS } from '@test-controls'
import { testControlsOn } from './test-switch.ts'
import * as off from './test-controls-off.ts'
import type { JobTimingName } from './job-timings.ts'

afterEach(resetTestControls)

it('looks up overrides by name and replaces or clears the whole set', () => {
  expect(timing('JOB_CUT_MS', 1_500)).toBe(1_500)
  setTimings({ JOB_CUT_MS: 100, JOB_DEADLINE_MS: 900 })
  expect(timing('JOB_CUT_MS', 1_500)).toBe(100)
  expect(timing('JOB_DEADLINE_MS', 5_000)).toBe(900)
  // An inherited Object key never reads as an override (the route allows only job-timings.ts names anyway).
  expect(timing('toString' as JobTimingName, 10)).toBe(10)
  setTimings({ JOB_DEADLINE_MS: 800 })
  expect(timing('JOB_CUT_MS', 1_500)).toBe(1_500)
  resetTestControls()
  expect(timing('JOB_DEADLINE_MS', 5_000)).toBe(5_000)
})

it('destroys only a running container and surfaces a failed destroy', async () => {
  const destroy = vi.fn(async () => {})
  await expect(killRunner(undefined)).resolves.toEqual({ killed: false })
  await expect(killRunner({ running: false, destroy })).resolves.toEqual({ killed: false })
  expect(destroy).not.toHaveBeenCalled()
  await expect(killRunner({ running: true, destroy })).resolves.toEqual({ killed: true })
  expect(destroy).toHaveBeenCalledOnce()
  destroy.mockRejectedValueOnce(new Error('destroy failed'))
  await expect(killRunner({ running: true, destroy })).rejects.toThrow('destroy failed')
})

it('deployable stand-ins do not change timings or kill a runner', () => {
  const destroy = vi.fn(async () => {})
  expect(() => off.setTimings({ JOB_CUT_MS: 100 })).toThrow('The test controls are not in this build.')
  expect(off.timing('JOB_CUT_MS', 1_500)).toBe(1_500)
  expect(() => off.killRunner({ running: true, destroy })).toThrow('The test controls are not in this build.')
  expect(destroy).not.toHaveBeenCalled()
})

// #460 review (Neon): the off module's new exports, and the run-time switch the constructor and `testObserve` read.
it('the off module: no load, no timings, no isolate; the same flag key and expiry', () => {
  const sql = { exec: vi.fn() } as unknown as SqlStorage
  expect(off.loadTestControls(sql)).toBeUndefined()
  expect(sql.exec).not.toHaveBeenCalled()
  expect(() => off.currentTimings()).toThrow('The test controls are not in this build.')
  expect(() => off.isolateId()).toThrow('The test controls are not in this build.')
  expect([off.TIMINGS_FLAG, off.TIMINGS_TTL_MS]).toEqual([TIMINGS_FLAG, TIMINGS_TTL_MS])
})

it('the controls are on only with INHOUSE_TEST_BUILD "1", and never in the eval build', () => {
  expect(testControlsOn({ INHOUSE_TEST_BUILD: '1' }, false)).toBe(true)
  for (const flag of [undefined, '0', 'true', 1]) expect(testControlsOn({ INHOUSE_TEST_BUILD: flag }, false), String(flag)).toBe(false)
  expect(testControlsOn({}, false)).toBe(false)
  expect(testControlsOn({ INHOUSE_TEST_BUILD: '1' }, true)).toBe(false)
})
