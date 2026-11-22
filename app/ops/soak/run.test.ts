// The driver and the release markers (P8a K): catch-up days, no gaps, the record is appended and never rewritten.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inline, main, recordDays, verifyRecord } from './run.ts'
import type { SoakRecordFile } from './run.ts'
import type { SoakDb } from './collect.ts'
import { cleanEvidence } from './test-support.ts'
import { dayStartMs } from './window.ts'
import type { DayRecord, ReleaseMarker } from './types.ts'

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

// A db that answers every query as a clean day would, except the morning slots when `broken` has the day.
const cleanDb: SoakDb = async sql => {
  if (sql.includes('FROM routine_slots WHERE routine_id = ? AND due_at_ms')) return [{ state: 'ended', kind: 'scheduled', reason: null, failure: null, outcome: 'done' }]
  if (sql.includes('COUNT(*)')) return [{ c: sql.includes('tool_calls') ? 4 : 1 }]
  if (sql.includes('FROM settings')) return []
  return []
}
const markers = [{ appSha: 'a'.repeat(40), atMs: dayStartMs('2026-11-30'), behaviour: true, live: ['P4', 'P5', 'P6a', 'P8a'] }]

const ALL = ['P4', 'P5', 'P6a', 'P8a']
const NOW = dayStartMs('2026-12-20')
const clean = { collect: async (_db: SoakDb, day: string) => cleanEvidence(day), pending: async () => null }

describe('recordDays', () => {
  it('needs --from on an empty record', async () => {
    await expect(recordDays(cleanDb, { records: [] }, markers, { until: '2026-12-02', nowMs: NOW })).rejects.toThrow(/--from/)
  })
  it('records each day after the last through until (real collector: memory is pending until P6a, so the gate stays shut)', async () => {
    const added = await recordDays(cleanDb, { records: [] }, markers, { from: '2026-12-01', until: '2026-12-03', nowMs: NOW, pending: async () => null })
    expect(added.map(r => r.day)).toEqual(['2026-12-01', '2026-12-02', '2026-12-03'])
    expect(added.every(r => r.count === 0 && !r.passed && r.checks.memory.status === 'pending')).toBe(true)
  })
  it('the count carries across runs: a second run continues from the first run\'s last record', async () => {
    const file: SoakRecordFile = { records: [] }
    const first = await recordDays(cleanDb, file, markers, { from: '2026-12-01', until: '2026-12-02', nowMs: NOW, ...clean })
    expect(first.map(r => r.count)).toEqual([1, 2])
    file.records.push(...first)
    const second = await recordDays(cleanDb, file, markers, { until: '2026-12-04', nowMs: NOW, ...clean })
    expect(second.map(r => [r.day, r.count, r.passed])).toEqual([['2026-12-03', 3, true], ['2026-12-04', 4, true]])
    expect(file.records).toHaveLength(2)
  })
  it('a not clean day in a later run resets the carried count', async () => {
    const file: SoakRecordFile = { records: await recordDays(cleanDb, { records: [] }, markers, { from: '2026-12-01', until: '2026-12-02', nowMs: NOW, ...clean }) }
    const bad = { ...clean, collect: async (_d: SoakDb, day: string) => ({ ...cleanEvidence(day), runs: null }) }
    const next = await recordDays(cleanDb, file, markers, { until: '2026-12-03', nowMs: NOW, ...bad })
    expect(next[0]).toMatchObject({ verdict: 'not_clean', count: 0 })
  })
  it('nothing after until is recorded', async () => {
    const file: SoakRecordFile = { records: [{ day: '2026-12-01', checks: {} as never, verdict: 'clean', reasons: [], live: ALL, count: 2, releases: [], passed: false }] }
    expect(await recordDays(cleanDb, file, markers, { until: '2026-12-01', nowMs: NOW, ...clean })).toEqual([])
  })
  it('catch-up boundary: 14 days is allowed, 15 is refused', async () => {
    expect(await recordDays(cleanDb, { records: [] }, markers, { from: '2026-12-01', until: '2026-12-14', nowMs: NOW, ...clean })).toHaveLength(14)
    await expect(recordDays(cleanDb, { records: [] }, markers, { from: '2026-12-01', until: '2026-12-15', nowMs: NOW, ...clean })).rejects.toThrow(/catch up/)
  })
  it('refuses an until later than the UTC day before now', async () => {
    const now = dayStartMs('2026-12-05') + 3_600_000
    await expect(recordDays(cleanDb, { records: [] }, markers, { from: '2026-12-01', until: '2026-12-05', nowMs: now, ...clean })).rejects.toThrow(/until/)
    expect(await recordDays(cleanDb, { records: [] }, markers, { from: '2026-12-04', until: '2026-12-04', nowMs: now, ...clean })).toHaveLength(1)
  })
  it('defers a day still in flight, and every day after it (no gap)', async () => {
    const pending = async (_db: SoakDb, day: string) => (day === '2026-12-02' ? 'a slot is still inside its window' : null)
    const added = await recordDays(cleanDb, { records: [] }, markers, { from: '2026-12-01', until: '2026-12-04', nowMs: NOW, ...clean, pending })
    expect(added.map(r => r.day)).toEqual(['2026-12-01'])
  })
})

describe('verifyRecord', () => {
  const rel: ReleaseMarker = { appSha: 'b'.repeat(40), atMs: dayStartMs('2026-12-02') + 3_600_000, behaviour: true, live: ALL }
  const base: ReleaseMarker = { appSha: 'a'.repeat(40), atMs: dayStartMs('2026-12-01') - 1, behaviour: true, live: ALL }
  const rec = (day: string, o: Partial<DayRecord> = {}): DayRecord => ({ day, checks: {} as never, verdict: 'not_clean', reasons: [], live: ALL, count: 0, releases: [], passed: false, ...o })
  it('passes when every recorded behaviour release is in its day\'s record and the live sets agree', () => {
    expect(verifyRecord({ records: [rec('2026-12-01'), rec('2026-12-02', { releases: [rel.appSha] }), rec('2026-12-03')] }, [base, rel])).toBeNull()
  })
  it('names a behaviour release missing from its recorded day', () => {
    expect(verifyRecord({ records: [rec('2026-12-01'), rec('2026-12-02')] }, [base, rel])).toContain(rel.appSha)
  })
  it('a release whose day is not recorded yet is fine; a non-behaviour one needs no entry', () => {
    expect(verifyRecord({ records: [rec('2026-12-01')] }, [base, rel])).toBeNull()
    expect(verifyRecord({ records: [rec('2026-12-01'), rec('2026-12-02')] }, [base, { ...rel, behaviour: false }])).toBeNull()
  })
  it('names a recorded day whose live set disagrees with the markers', () => {
    expect(verifyRecord({ records: [rec('2026-12-01', { live: ['P4'] })] }, [base])).toContain('2026-12-01')
  })
})

describe('main: the releases file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soak-'))
  const file = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); return p }
  const base = ['--db', 'x', '--record', join(dir, 'record.json')]
  it('a missing --releases flag is a usage error', async () => {
    expect(await main(base)).toBe(2)
  })
  it('--until later than yesterday (UTC) exits 2', async () => {
    const p = file('ok.json', '[]')
    const today = new Date().toISOString().slice(0, 10)
    expect(await main([...base, '--releases', p, '--from', '2026-12-01', '--until', today])).toBe(2)
  })
  it('a record that disagrees with the markers exits 2, naming the marker, and writes nothing', async () => {
    const rec = join(dir, 'disagree.json')
    writeFileSync(rec, JSON.stringify({ records: [{ day: '2026-12-02', checks: {}, verdict: 'not_clean', reasons: [], live: [], count: 0, releases: [], passed: false }] }))
    const rel = file('rel.json', JSON.stringify([{ at: '2026-12-02T01:00:00Z', app_sha: 'b'.repeat(40), live: ['P4'], behaviour: true }]))
    expect(await main(['--db', 'x', '--record', rec, '--releases', rel])).toBe(2)
  })
  it('a missing, unreadable or invalid releases file exits 2 and writes no record', async () => {
    for (const p of [join(dir, 'none.json'), file('bad.json', '[{"at":"nope"}]'), file('obj.json', '{}')]) {
      expect(await main([...base, '--releases', p, '--from', '2026-12-01'])).toBe(2)
    }
    expect(existsSync(join(dir, 'record.json'))).toBe(false)
  })
})
