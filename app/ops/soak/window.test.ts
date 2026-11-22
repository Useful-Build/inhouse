// The restart rules and the property (P8a K). Ways it can fail, written down first:
//  1. a day counts with a missing, pending, unclean or budget-skipped check;
//  2. a bypass or a lost or doubled notice leaves the count standing;
//  3. a behaviour release doesn't restart the window, or a release that changes nothing does;
//  4. a day counts before P4, P5, P6a and P8a are all live;
//  5. the gate opens early, or stays shut after 3 clean days.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { runChecks } from './checks.ts'
import { cleanEvidence } from './test-support.ts'
import { CHECK_NAMES, REQUIRED_PHASES } from './types.ts'
import type { Checks, CheckStatus, DayEvidence, ReleaseMarker } from './types.ts'
import { GATE_DAYS, dayStartMs, nextDay, nextRecord } from './window.ts'

const ALL = [...REQUIRED_PHASES]
const sha = (c: string) => c.repeat(40)
const base: ReleaseMarker = { appSha: sha('a'), atMs: dayStartMs('2026-12-01') - 1, behaviour: true, live: ALL }
const run = (day: string, e: DayEvidence, markers: ReleaseMarker[], prev: { count: number } | null) => nextRecord(day, runChecks({ ...e, day }), markers, prev)

describe('the rules', () => {
  it('three clean days in a row pass the gate, not two', () => {
    const d1 = run('2026-12-01', cleanEvidence(), [base], null)
    const d2 = run('2026-12-02', cleanEvidence(), [base], d1)
    const d3 = run('2026-12-03', cleanEvidence(), [base], d2)
    expect([d1.count, d2.count, d3.count]).toEqual([1, 2, 3])
    expect([d1.passed, d2.passed, d3.passed]).toEqual([false, false, true])
    expect(GATE_DAYS).toBe(3)
  })
  it('a missing check restarts the count', () => {
    const x = cleanEvidence(); x.morning = { slots: [{ state: 'skipped', kind: 'scheduled', reason: 'budget', failure: null, outcome: null }] }
    const r = run('2026-12-03', x, [base], { count: 2 })
    expect(r).toMatchObject({ verdict: 'not_clean', count: 0, reasons: ['check'] })
  })
  it('a pending memory check (no P6a shape) is not clean', () => {
    const x = cleanEvidence(); x.memory = { learnOffSaves: 0, teamFactsUnapproved: null }
    expect(run('2026-12-03', x, [base], { count: 2 })).toMatchObject({ verdict: 'not_clean', count: 0 })
  })
  it('a bypass restarts the count and says so', () => {
    const x = cleanEvidence(); x.guards = { webfetchBypass: 1, leaks: 0 }
    expect(run('2026-12-03', x, [base], { count: 2 })).toMatchObject({ count: 0, reasons: ['bypass', 'check'] })
  })
  it('a lost or doubled notice restarts the count and says so', () => {
    const lost = cleanEvidence(); lost.bell!.failedNoticeIds = []
    expect(run('2026-12-03', lost, [base], { count: 2 })).toMatchObject({ count: 0, reasons: ['notice', 'check'] })
    const doubled = cleanEvidence(); doubled.bell!.morningNotices = 2
    expect(run('2026-12-03', doubled, [base], { count: 2 })).toMatchObject({ count: 0, reasons: ['notice', 'check'] })
  })
  it('a release that changes behaviour restarts the window: its day doesn\'t count, the next can', () => {
    const rel: ReleaseMarker = { appSha: sha('b'), atMs: dayStartMs('2026-12-03') + 3_600_000, behaviour: true, live: ALL }
    const d3 = run('2026-12-03', cleanEvidence(), [base, rel], { count: 2 })
    expect(d3).toMatchObject({ verdict: 'not_clean', count: 0, reasons: ['release'], releases: [sha('b')] })
    expect(run('2026-12-04', cleanEvidence(), [base, rel], d3)).toMatchObject({ verdict: 'clean', count: 1 })
  })
  it('a release that changes no behaviour leaves the count', () => {
    const rel: ReleaseMarker = { appSha: sha('b'), atMs: dayStartMs('2026-12-03') + 1, behaviour: false, live: ALL }
    expect(run('2026-12-03', cleanEvidence(), [base, rel], { count: 2 })).toMatchObject({ verdict: 'clean', count: 3, passed: true })
  })
  it('a day before all four phases are live doesn\'t count', () => {
    const early: ReleaseMarker = { ...base, live: ['P4', 'P5'] }
    expect(run('2026-12-01', cleanEvidence(), [early], null)).toMatchObject({ verdict: 'not_clean', count: 0, reasons: ['phases_not_live'] })
    expect(run('2026-12-01', cleanEvidence(), [], null).reasons).toContain('phases_not_live')
  })
  it('the live set is the latest release at or before the day\'s start, not a union', () => {
    const a: ReleaseMarker = { appSha: sha('a'), atMs: dayStartMs('2026-12-01') - 9, behaviour: false, live: ['P4', 'P5'] }
    const b: ReleaseMarker = { appSha: sha('b'), atMs: dayStartMs('2026-12-01') - 5, behaviour: false, live: ['P6a', 'P8a'] }
    expect(run('2026-12-01', cleanEvidence(), [a, b], null).reasons).toContain('phases_not_live')
    const c: ReleaseMarker = { appSha: sha('c'), atMs: dayStartMs('2026-12-01') - 1, behaviour: false, live: ALL }
    expect(run('2026-12-01', cleanEvidence(), [a, b, c], null).verdict).toBe('clean')
  })
  it('a release at the day\'s start counts for that day; one later in the day does not', () => {
    const at: ReleaseMarker = { appSha: sha('a'), atMs: dayStartMs('2026-12-01'), behaviour: false, live: ALL }
    expect(run('2026-12-01', cleanEvidence(), [at], null).verdict).toBe('clean')
    const later: ReleaseMarker = { appSha: sha('a'), atMs: dayStartMs('2026-12-01') + 1, behaviour: false, live: ALL }
    expect(run('2026-12-01', cleanEvidence(), [later], null).reasons).toContain('phases_not_live')
  })
  it('a day is bound to UTC', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
    expect(() => dayStartMs('2026-13-01')).toThrow()
  })
})

const status = fc.constantFrom<CheckStatus>('clean', 'clean', 'clean', 'unclean', 'missing', 'pending')
const dayArb = fc.record({
  statuses: fc.tuple(status, status, status, status, status, status),
  release: fc.boolean(),
  behaviour: fc.boolean(),
})

/** Evidence whose checks come out as the given statuses, by overriding the judged result. */
const withStatuses = (s: readonly CheckStatus[]): Checks => {
  const checks = runChecks(cleanEvidence())
  CHECK_NAMES.forEach((n, i) => { checks[n] = { status: s[i]!, detail: '' } })
  return checks
}

describe('property: the count', () => {
  test.prop([fc.array(dayArb, { minLength: 1, maxLength: 25 })], { numRuns: 400 })('a day is clean only when every check is present and clean, and the count resets on any other day or behaviour release', days => {
    let day = '2026-12-01'
    let prev: { count: number } | null = null
    let model = 0
    const markers: ReleaseMarker[] = [base]
    days.forEach((d, i) => {
      if (i > 0) day = nextDay(day)
      if (d.release) markers.push({ appSha: sha('d'), atMs: dayStartMs(day) + 1000, behaviour: d.behaviour, live: ALL })
      const rec = nextRecord(day, withStatuses(d.statuses), markers, prev)
      const allClean = d.statuses.every(x => x === 'clean')
      const restarted = d.release && d.behaviour
      const clean = allClean && !restarted
      expect(rec.verdict).toBe(clean ? 'clean' : 'not_clean')
      model = clean ? model + 1 : 0
      expect(rec.count).toBe(model)
      expect(rec.passed).toBe(clean && model >= GATE_DAYS)
      if (!clean) expect(rec.reasons.length).toBeGreaterThan(0)
      prev = { count: rec.count }
    })
  })
})
