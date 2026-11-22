// The driver and the release markers (P8a K): catch-up days, no gaps, the record is appended and never rewritten.
import { describe, expect, it } from 'vitest'
import { inline, recordDays } from './run.ts'
import type { SoakRecordFile } from './run.ts'
import { parseMarkers } from './releases.ts'
import type { SoakDb } from './collect.ts'
import { dayStartMs } from './window.ts'

describe('inline', () => {
  it('fills numbers and quotes strings', () => {
    expect(inline('SELECT ? AS a, ? AS b', [3, "o'k"])).toBe("SELECT 3 AS a, 'o''k' AS b")
  })
  it('refuses a missing, extra or non-finite parameter', () => {
    expect(() => inline('SELECT ?', [])).toThrow()
    expect(() => inline('SELECT 1', [1])).toThrow()
    expect(() => inline('SELECT ?', [Infinity])).toThrow()
  })
})

describe('parseMarkers', () => {
  const at = Math.floor(dayStartMs('2026-12-01') / 1000)
  it('reads house tags only, oldest first', () => {
    const m = parseMarkers([`house-20261202-1\t${at + 10}\tlive=P6a,P8a behaviour=no`, `v2026.11.22.9\t${at}\tx`, `house-20261201-1\t${at}\tlive=P4,P5 behaviour=yes`])
    expect(m.map(x => x.tag)).toEqual(['house-20261201-1', 'house-20261202-1'])
    expect(m[0]).toMatchObject({ behaviour: true, live: ['P4', 'P5'] })
    expect(m[1]).toMatchObject({ behaviour: false, live: ['P6a', 'P8a'], atMs: (at + 10) * 1000 })
  })
  it('an unreadable subject is a behaviour change with no phases', () => {
    expect(parseMarkers([`house-20261201-1\t${at}\twhatever`])[0]).toMatchObject({ behaviour: true, live: [] })
  })
  it('a tag with no time is an error', () => {
    expect(() => parseMarkers(['house-20261201-1\t\tx'])).toThrow()
  })
})

// A db that answers every query as a clean day would, except the morning slots when `broken` has the day.
const cleanDb: SoakDb = async sql => {
  if (sql.includes('FROM routine_slots WHERE routine_id = ? AND due_at_ms')) return [{ state: 'ended', kind: 'scheduled', reason: null, failure: null, outcome: 'done' }]
  if (sql.includes('COUNT(*)')) return [{ c: sql.includes('tool_calls') ? 4 : 1 }]
  if (sql.includes('FROM settings')) return []
  return []
}
const markers = [{ tag: 'house-20261130-1', atMs: dayStartMs('2026-11-30'), behaviour: true, live: ['P4', 'P5', 'P6a', 'P8a'] }]

describe('recordDays', () => {
  it('needs --from on an empty record', async () => {
    await expect(recordDays(cleanDb, { records: [] }, markers, { until: '2026-12-02', nowMs: 0 })).rejects.toThrow(/--from/)
  })
  it('records each day after the last through until, carrying the count', async () => {
    const added = await recordDays(cleanDb, { records: [] }, markers, { from: '2026-12-01', until: '2026-12-03', nowMs: dayStartMs('2026-12-05') })
    expect(added.map(r => r.day)).toEqual(['2026-12-01', '2026-12-02', '2026-12-03'])
    // memory stays pending until P6a, so no day is clean yet: the count stays 0 and the gate stays shut.
    expect(added.every(r => r.count === 0 && !r.passed && r.checks.memory.status === 'pending')).toBe(true)
  })
  it('continues from the last record with no gap, and never rewrites it', async () => {
    const file: SoakRecordFile = { records: [{ day: '2026-12-01', checks: {} as never, verdict: 'clean', reasons: [], count: 2, releases: [], passed: false }] }
    const added = await recordDays(cleanDb, file, markers, { until: '2026-12-02', nowMs: dayStartMs('2026-12-05') })
    expect(added.map(r => r.day)).toEqual(['2026-12-02'])
    expect(file.records).toHaveLength(1)
    expect(await recordDays(cleanDb, file, markers, { until: '2026-12-01', nowMs: 0 })).toEqual([])
  })
  it('refuses a long catch-up', async () => {
    await expect(recordDays(cleanDb, { records: [] }, markers, { from: '2026-11-01', until: '2026-12-01', nowMs: 0 })).rejects.toThrow(/catch up/)
  })
})
