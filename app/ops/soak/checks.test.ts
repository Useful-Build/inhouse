// Each check's clean, unclean and missing case (P8a K). A budget-skipped morning check and a P6a-pending memory check
// are not clean.
import { describe, expect, it } from 'vitest'
import { bellNotices, connectorReads, failedRuns, guards, memory, morningCheck, runChecks } from './checks.ts'
import { cleanEvidence } from './test-support.ts'
import { CHECK_NAMES } from './types.ts'

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
    const x = e(); x.bell = { expectedIds: [], failedNoticeIds: [], morningNotices: 0, morningEnded: 1 }
    expect(bellNotices(x).status).toBe('clean')
  })
  it('unclean: a lost notice', () => {
    const x = e(); x.bell!.failedNoticeIds = []
    expect(bellNotices(x)).toMatchObject({ status: 'unclean', detail: '1 lost, 0 doubled' })
  })
  it('unclean: a doubled notice (an extra routine_failed or a second morning notice for one slot)', () => {
    const extra = e(); extra.bell!.failedNoticeIds = ['rf_a', 'rf_b']
    expect(bellNotices(extra)).toMatchObject({ status: 'unclean', detail: '0 lost, 1 doubled' })
    const second = e(); second.bell!.morningNotices = 2
    expect(bellNotices(second).status).toBe('unclean')
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
  it('clean', () => expect(connectorReads(e()).status).toBe('clean'))
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
  it('clean', () => expect(failedRuns(e()).status).toBe('clean'))
  it('unclean: a slot stuck past its deadline', () => expect(failedRuns({ ...e(), runs: { stuck: 1 } }).status).toBe('unclean'))
  it('missing: unreadable', () => expect(failedRuns({ ...e(), runs: null }).status).toBe('missing'))
})

describe('guards', () => {
  it('clean', () => expect(guards(e()).status).toBe('clean'))
  it('unclean: an unlisted fetch or a canary-like leak', () => {
    expect(guards({ ...e(), guards: { webfetchBypass: 1, leaks: 0 } }).status).toBe('unclean')
    expect(guards({ ...e(), guards: { webfetchBypass: 0, leaks: 1 } }).status).toBe('unclean')
  })
  it('missing: unreadable', () => expect(guards({ ...e(), guards: null }).status).toBe('missing'))
})

describe('runChecks', () => {
  it('names every check', () => expect(Object.keys(runChecks(e())).sort()).toEqual([...CHECK_NAMES].sort()))
})
