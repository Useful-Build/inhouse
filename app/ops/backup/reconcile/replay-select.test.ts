// Which deletions a replay applies again (P8a R, step 5), as a property over random deletion logs and points. Ways it
// can fail, written down first:
//  1. a run with an entry at or after the watermark is missed, or one wholly before it is read;
//  2. a run reaches a store whose own point is after the run's last entry (C1 review M2), or misses one at or before it;
//  3. a refused run is replayed.
// The oracle is written from the entries themselves, not from the keys or the code under test.
import { fc, test } from '@fast-check/vitest'
import { expect } from 'vitest'
import { deletionLogKey } from '../../../server/db/r2-keys.ts'
import type { DeletionLogEntry } from '../../delete/log.ts'
import { groupRuns, storesReached, watermarkStart } from './replay.ts'

const STORES = ['members', 'settings', 'photos/', 'BrandAgent'] as const
const T = 1_800_000_000_000

const runArb = fc.record({
  runId: fc.stringMatching(/^[0-9a-f]{16}$/),
  times: fc.array(fc.integer({ min: 0, max: 60 }), { minLength: 1, maxLength: 4 }),
  refused: fc.boolean(),
  member: fc.stringMatching(/^m_[a-z]{4}$/),
})
const caseArb = fc.record({
  runs: fc.uniqueArray(runArb, { selector: r => r.runId, maxLength: 12 }),
  points: fc.record(Object.fromEntries(STORES.map(s => [s, fc.integer({ min: 0, max: 60 })])) as Record<(typeof STORES)[number], fc.Arbitrary<number>>),
})

test.prop([caseArb])('replays exactly the runs past the watermark, each to exactly the stores at or before its last entry', ({ runs, points }) => {
  const pointOf = (s: string) => T + points[s as (typeof STORES)[number]]
  const watermark = Math.min(...STORES.map(pointOf))
  const entries: { key: string; entry: DeletionLogEntry }[] = []
  for (const r of runs) {
    const times = [...r.times].sort((a, b) => a - b).map(t => T + t)
    times.forEach((atMs, step) => {
      const phase = r.refused && step === times.length - 1 ? 'refused' : step === 0 ? 'start' : 'done'
      const entry: DeletionLogEntry = { format: 1, runId: r.runId, step, phase, kind: 'person', atMs, actorId: 'm_system', memberId: r.member }
      entries.push({ key: deletionLogKey(atMs, r.runId, step, phase), entry })
    })
  }
  entries.sort((a, b) => (a.key < b.key ? -1 : 1))
  const start = watermarkStart(watermark)
  const listed = entries.filter(e => start === undefined || e.key > start)

  const got = groupRuns(listed).filter(r => !r.refused).map(r => [r.runId, storesReached(r, STORES, pointOf)])
  const oracle = runs
    .filter(r => !r.refused && Math.max(...r.times) + T >= watermark)
    .map(r => [r.runId, STORES.filter(s => pointOf(s) <= T + Math.max(...r.times))])
  const byId = (a: (string | string[])[], b: (string | string[])[]) => (a[0] < b[0] ? -1 : 1)
  expect(got.sort(byId)).toEqual(oracle.sort(byId))
  // The listing is exactly the entries at or after the watermark.
  expect(listed.map(e => e.key)).toEqual(entries.filter(e => e.entry.atMs >= watermark).map(e => e.key))
})
