// Each check's clean, unclean and missing case (P8a K). A budget-skipped morning check and a P6a-pending memory check
// are not clean.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { bellNotices, connectorReads, failedRuns, guards, memory, morningCheck, runChecks } from './checks.ts'
import { cleanEvidence } from './test-support.ts'
import { CHECK_NAMES } from './types.ts'
import type { GuardFacet } from './types.ts'

const e = cleanEvidence

describe('morning check', () => {
  it('clean: a scheduled slot ended done with no failure', () => expect(morningCheck(e()).status).toBe('clean'))
  it('clean when a later slot recovers an earlier failed one', () => {
    const x = e(); x.morning!.slots.unshift({ state: 'ended', kind: 'scheduled', reason: null, failure: 'run_failed', outcome: 'failed' })
    expect(morningCheck(x).status).toBe('clean')
  })
  it('unclean: it ended with a failure or never ended', () => {
    const failed = e(); failed.morning = { slots: [{ state: 'ended', kind: 'scheduled', reason: null, failure: 'invalid_result', outcome: 'done' }] }
    expect(morningCheck(failed)).toMatchObject({ status: 'unclean', detail: expect.stringContaining('invalid_result') })
    const lost = e(); lost.morning = { slots: [{ state: 'lost', kind: 'scheduled', reason: 'x', failure: null, outcome: null }] }
    expect(morningCheck(lost).status).toBe('unclean')
  })
  it('missing: no slot, an unreadable facet, a manual-only day or a budget-skipped slot', () => {
    const none = e(); none.morning = { slots: [] }
    expect(morningCheck(none).status).toBe('missing')
    expect(morningCheck({ ...e(), morning: null }).status).toBe('missing')
    const manual = e(); manual.morning = { slots: [{ state: 'ended', kind: 'manual', reason: null, failure: null, outcome: 'done' }] }
    expect(morningCheck(manual).status).toBe('missing')
    const skipped = e(); skipped.morning = { slots: [{ state: 'skipped', kind: 'scheduled', reason: 'budget', failure: null, outcome: null }] }
    expect(morningCheck(skipped)).toMatchObject({ status: 'missing', detail: expect.stringContaining('budget') })
  })
})

describe('bell notices', () => {
  it('clean: every alert has its notice exactly once', () => expect(bellNotices(e()).status).toBe('clean'))
  it('clean with no alerts', () => {
    const x = e(); x.bell = { expectedIds: [], failedNoticeIds: [], morning: [{ items: 0, notices: 0 }], strayMorningNotices: 0 }
    expect(bellNotices(x).status).toBe('clean')
  })
  it('unclean: a lost notice', () => {
    const x = e(); x.bell!.failedNoticeIds = []
    expect(bellNotices(x)).toMatchObject({ status: 'unclean', detail: '1 lost, 0 doubled' })
  })
  it('unclean: a doubled notice (an extra routine_failed or a second morning notice for one slot)', () => {
    const extra = e(); extra.bell!.failedNoticeIds = ['rf_a', 'rf_b']
    expect(bellNotices(extra)).toMatchObject({ status: 'unclean', detail: '0 lost, 1 doubled' })
    const second = e(); second.bell!.morning = [{ items: 2, notices: 2 }]
    expect(bellNotices(second)).toMatchObject({ status: 'unclean', detail: '0 lost, 1 doubled' })
    const stray = e(); stray.bell!.strayMorningNotices = 1
    expect(bellNotices(stray).status).toBe('unclean')
  })
  it('a morning slot that saved items needs exactly one notice; one with none needs none', () => {
    const lost = e(); lost.bell!.morning = [{ items: 3, notices: 0 }]
    expect(bellNotices(lost)).toMatchObject({ status: 'unclean', detail: '1 lost, 0 doubled' })
    const quiet = e(); quiet.bell!.morning = [{ items: 0, notices: 0 }]
    expect(bellNotices(quiet).status).toBe('clean')
  })
  it('missing: unreadable', () => expect(bellNotices({ ...e(), bell: null }).status).toBe('missing'))
})

describe('memory', () => {
  it('clean', () => expect(memory(e()).status).toBe('clean'))
  it('unclean: a fact saved while learning was off, or a team fact active without approval', () => {
    const off = e(); off.memory = { learnOffSaves: 1, teamFactsUnapproved: 0 }
    expect(memory(off).status).toBe('unclean')
    const team = e(); team.memory = { learnOffSaves: 0, teamFactsUnapproved: 2 }
    expect(memory(team).status).toBe('unclean')
  })
  it('pending (not clean) until P6a\'s approval shape exists, but a learn-off save is still unclean', () => {
    const wait = e(); wait.memory = { learnOffSaves: 0, teamFactsUnapproved: null }
    expect(memory(wait)).toMatchObject({ status: 'pending', detail: expect.stringContaining('P6a') })
    const off = e(); off.memory = { learnOffSaves: 1, teamFactsUnapproved: null }
    expect(memory(off).status).toBe('unclean')
  })
  it('missing: unreadable', () => expect(memory({ ...e(), memory: null }).status).toBe('missing'))
})

describe('connector reads', () => {
  it('clean, and says it counts allowed calls (tool_calls records no outcome)', () => {
    expect(connectorReads(e())).toMatchObject({ status: 'clean', detail: expect.stringContaining('allowed') })
  })
  it('unclean: a morning check that could not read the store', () => {
    const x = e(); x.connectors = { readCalls: 3, failedReads: 1 }
    expect(connectorReads(x).status).toBe('unclean')
  })
  it('missing: no read at all, or unreadable', () => {
    const x = e(); x.connectors = { readCalls: 0, failedReads: 0 }
    expect(connectorReads(x).status).toBe('missing')
    expect(connectorReads({ ...e(), connectors: null }).status).toBe('missing')
  })
})

describe('failed runs', () => {
  it('clean: every failed slot was followed by an ok one', () => expect(failedRuns(e()).status).toBe('clean'))
  it('unclean: a failed slot never recovered, or a slot stuck', () => {
    expect(failedRuns({ ...e(), runs: { slots: 3, failed: 1, unrecovered: 1, stuck: 0 } })).toMatchObject({ status: 'unclean', detail: expect.stringContaining('no ok slot') })
    expect(failedRuns({ ...e(), runs: { slots: 3, failed: 0, unrecovered: 0, stuck: 1 } }).status).toBe('unclean')
  })
  it('missing: no routine slot on the day, or unreadable', () => {
    expect(failedRuns({ ...e(), runs: { slots: 0, failed: 0, unrecovered: 0, stuck: 0 } }).status).toBe('missing')
    expect(failedRuns({ ...e(), runs: null }).status).toBe('missing')
  })
})

// Ways the guards check can read clean on evidence that could not have failed, or miss a bypass, written down first:
//  1. no canary is planted, so the leak scan has nothing it could find (house data holds no eval canary);
//  2. the egress record can't be read (or the day's WebFetch list is unknown), so a fetch off the list can't show;
//  3. an allowed fetch to a host off the day's list (WebFetch's or Bash's) reads clean or missing, not unclean;
//  4. a leak or a bypass is reported as missing, not unclean, because one of the gaps above is open too.
describe('guards', () => {
  const g = (o: Partial<GuardFacet> = {}) => guards({ ...e(), guards: { webfetchAllowed: 0, egress: { allowed: 0, offList: [] }, leaks: 0, canary: 'planted', ...o } })
  it('clean: planted canaries were scanned with no leak, and every allowed fetch was to a listed host', () => {
    expect(g()).toMatchObject({ status: 'clean', detail: expect.stringContaining('planted') })
    expect(g({ webfetchAllowed: 3, egress: { allowed: 4, offList: [] } })).toMatchObject({ status: 'clean', detail: expect.stringContaining('4 allowed fetches') })
  })
  it('missing without a planted canary (failure 1), and the detail names the onboarding step', () => {
    const r = g({ canary: 'shape' })
    expect(r.status).toBe('missing')
    expect(r.detail).toContain('plant a canary')
    expect(r.detail).toContain('--canary')
  })
  it('missing when the egress record is unreadable (failure 2), whether or not a WebFetch was allowed', () => {
    for (const webfetchAllowed of [0, 5]) {
      const r = g({ webfetchAllowed, egress: { unreadable: 'the egress record could not be read' } })
      expect(r.status).toBe('missing')
      expect(r.detail).toContain('egress record could not be read')
    }
  })
  it('unclean: an allowed fetch to a host off the day\'s list is a bypass, named by host (failure 3)', () => {
    const r = g({ egress: { allowed: 2, offList: ['evil.example.org'] } })
    expect(r).toMatchObject({ status: 'unclean', detail: expect.stringContaining('evil.example.org') })
  })
  it('unclean: a leak or a bypass, whatever else is missing (failure 4)', () => {
    expect(g({ leaks: 1 }).status).toBe('unclean')
    expect(g({ leaks: 1, canary: 'shape' }).status).toBe('unclean')
    expect(g({ leaks: 2, egress: { unreadable: 'x' } })).toMatchObject({ status: 'unclean', detail: expect.stringContaining('x') })
    expect(g({ canary: 'shape', egress: { allowed: 1, offList: ['evil.example.org'] } }).status).toBe('unclean')
  })
  it('missing: unreadable', () => expect(guards({ ...e(), guards: null }).status).toBe('missing'))
  const EGRESS = fc.oneof(
    fc.record({ allowed: fc.nat(3), offList: fc.uniqueArray(fc.constantFrom('a.example.org', 'b.example.org'), { maxLength: 2 }) }),
    fc.constant({ unreadable: 'x' }),
  )
  test.prop([fc.record({ webfetchAllowed: fc.nat(3), egress: EGRESS, leaks: fc.nat(3), canary: fc.constantFrom<GuardFacet['canary']>('planted', 'shape') })])(
    'clean only when planted canaries were scanned, none leaked and the egress record shows no off-list host; unclean exactly on a leak or an off-list host',
    f => {
      const status = guards({ ...e(), guards: f }).status
      const offList = 'offList' in f.egress ? f.egress.offList.length : 0
      expect(status === 'clean').toBe(f.canary === 'planted' && f.leaks === 0 && 'offList' in f.egress && offList === 0)
      expect(status === 'unclean').toBe(f.leaks > 0 || offList > 0)
    },
  )
})

describe('runChecks', () => {
  it('names every check', () => expect(Object.keys(runChecks(e())).sort()).toEqual([...CHECK_NAMES].sort()))
})
