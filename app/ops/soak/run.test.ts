// The driver and the release markers (P8a K): catch-up days, no gaps, the record is appended and never rewritten.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inline, main, recordDays } from './run.ts'
import type { SoakRecordFile } from './run.ts'
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

// A db that answers every query as a clean day would, except the morning slots when `broken` has the day.
const cleanDb: SoakDb = async sql => {
  if (sql.includes('FROM routine_slots WHERE routine_id = ? AND due_at_ms')) return [{ state: 'ended', kind: 'scheduled', reason: null, failure: null, outcome: 'done' }]
  if (sql.includes('COUNT(*)')) return [{ c: sql.includes('tool_calls') ? 4 : 1 }]
  if (sql.includes('FROM settings')) return []
  return []
}
const markers = [{ appSha: 'a'.repeat(40), atMs: dayStartMs('2026-11-30'), behaviour: true, live: ['P4', 'P5', 'P6a', 'P8a'] }]

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

describe('main: the releases file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soak-'))
  const file = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); return p }
  const base = ['--db', 'x', '--record', join(dir, 'record.json')]
  it('a missing --releases flag is a usage error', async () => {
    expect(await main(base)).toBe(2)
  })
  it('a missing, unreadable or invalid releases file exits 2 and writes no record', async () => {
    for (const p of [join(dir, 'none.json'), file('bad.json', '[{"at":"nope"}]'), file('obj.json', '{}')]) {
      expect(await main([...base, '--releases', p, '--from', '2026-12-01'])).toBe(2)
    }
    expect(existsSync(join(dir, 'record.json'))).toBe(false)
  })
})
