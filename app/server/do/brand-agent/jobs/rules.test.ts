// The job rules (M1-B) as tables written from N3's "after each job turn" table and the spike's recover rule (N4,
// variant A). Ways they can fail: an end in N3's table maps to the wrong verdict; a timeout with no cut is retried
// (inactivity must fail); a person's stop that raced the cut carries on; the recover rule keeps a mirror error, a
// non-job turn, a fresh session or a changed checkpoint resumable, or refuses either crash path.
import { describe, expect, it } from 'vitest'
import { idle, judge, promotable, recoverable } from './rules.ts'
import type { TurnEnd } from './rules.ts'

const end = (o: Partial<TurnEnd>): TurnEnd => ({
  outcome: null, failure: null, cancel_why: null, cut_cause: null, person_stop: 0, abandoned: null, steps_n: 1, parts_n: 1, ...o,
})

describe('judge: N3\'s table', () => {
  const cases: [string, Partial<TurnEnd>, ReturnType<typeof judge>][] = [
    ['done', { outcome: 'done' }, 'done'],
    ['max_turns', { outcome: 'failed', failure: 'max_turns' }, 'carry'],
    ['turn_budget', { outcome: 'failed', failure: 'turn_budget' }, 'carry'],
    ['the cut', { outcome: 'interrupted', cut_cause: 'job_cut' }, 'carry'],
    ['a person\'s now message', { outcome: 'interrupted', cut_cause: 'message' }, 'carry'],
    ['the cap\'s cut', { outcome: 'interrupted', cut_cause: 'job_deadline' }, { end: 'time' }],
    ['a person\'s interrupt', { outcome: 'interrupted' }, { end: 'cancelled' }],
    ['the cut, raced by a person\'s stop', { outcome: 'interrupted', cut_cause: 'job_cut', person_stop: 1 }, { end: 'cancelled' }],
    ['max_turns, then a person\'s stop', { outcome: 'failed', failure: 'max_turns', person_stop: 1 }, { end: 'cancelled' }],
    ['timeout after a cut', { outcome: 'failed', failure: 'timeout', cut_cause: 'job_cut' }, 'retry'],
    ['timeout with no cut (inactivity)', { outcome: 'failed', failure: 'timeout' }, { end: 'failed' }],
    ['session_crashed', { outcome: 'failed', failure: 'session_crashed' }, 'retry'],
    ['protocol', { outcome: 'failed', failure: 'protocol' }, 'retry'],
    ['store', { outcome: 'failed', failure: 'store' }, 'retry'],
    ['unknown', { outcome: 'failed', failure: 'unknown' }, 'retry'],
    ['sdk_error', { outcome: 'failed', failure: 'sdk_error' }, { end: 'failed' }],
    ['model_off', { outcome: 'failed', failure: 'model_off' }, { end: 'failed' }],
    ['structured_output', { outcome: 'failed', failure: 'structured_output' }, { end: 'failed' }],
    ['files', { outcome: 'failed', failure: 'files' }, { end: 'failed' }],
    ['cap_reached failed (the monthly cap)', { outcome: 'failed', failure: 'cap_reached' }, { end: 'budget', cause: 'month_cap' }],
    ['job_budget failed (the gate)', { outcome: 'failed', failure: 'job_budget' }, { end: 'budget' }],
    ['budget_busy (never ran)', { outcome: 'failed', failure: 'budget_busy' }, 'again'],
    ['cancelled cap_reached (the monthly cap)', { cancel_why: 'cap_reached' }, { end: 'budget', cause: 'month_cap' }],
    ['cancelled job_budget', { cancel_why: 'job_budget' }, { end: 'budget' }],
    ['cancelled pool_full', { cancel_why: 'pool_full' }, 'again'],
    ['cancelled session_unusable', { cancel_why: 'session_unusable' }, { end: 'failed' }],
    ['cancelled paused', { cancel_why: 'paused' }, { end: 'cancelled' }],
    ['cancelled removed', { cancel_why: 'removed' }, { end: 'cancelled' }],
    ['cancelled deleted', { cancel_why: 'deleted' }, { end: 'cancelled' }],
    ['stopped', { outcome: 'stopped' }, { end: 'cancelled' }],
    ['a wait given up', { outcome: 'done', abandoned: 'session_damaged' }, { end: 'cancelled' }],
  ]
  for (const [name, o, want] of cases) it(name, () => expect(judge(end(o))).toEqual(want))
})

describe('promotable', () => {
  const facts = { textsWired: true, session: 'resumable', personQueued: false, jobLive: false, paused: false }
  const person = { ...end({ outcome: 'failed', failure: 'max_turns' }), source: 'person', job_id: null }
  it('a person\'s turn at max_turns, turn_budget or the cut', () => {
    expect(promotable(person, facts)).toBe(true)
    expect(promotable({ ...person, failure: 'turn_budget' }, facts)).toBe(true)
    expect(promotable({ ...person, outcome: 'interrupted', failure: null, cut_cause: 'job_cut' }, facts)).toBe(true)
  })
  it('never without the texts, a resumable session, or with a person queued or a job alive; never a job\'s, a resume\'s or a routine\'s turn', () => {
    expect(promotable(person, { ...facts, textsWired: false })).toBe(false)
    expect(promotable(person, { ...facts, session: 'damaged' })).toBe(false)
    expect(promotable(person, { ...facts, session: 'waiting' })).toBe(false)
    expect(promotable(person, { ...facts, personQueued: true })).toBe(false)
    expect(promotable(person, { ...facts, jobLive: true })).toBe(false)
    expect(promotable(person, { ...facts, paused: true })).toBe(false)
    // Fenced by a pause, a removal or a delete while ending: the outcome stays, `cancel_why` says it was stopped.
    expect(promotable({ ...person, cancel_why: 'paused' }, facts)).toBe(false)
    expect(promotable({ ...person, cancel_why: 'removed' }, facts)).toBe(false)
    expect(promotable({ ...person, source: 'job' }, facts)).toBe(false)
    expect(promotable({ ...person, source: 'question' }, facts)).toBe(false)
    expect(promotable({ ...person, source: 'task' }, facts)).toBe(false)
    expect(promotable({ ...person, source: null }, facts)).toBe(false)
    expect(promotable({ ...person, job_id: 'j_x' }, facts)).toBe(false)
    expect(promotable({ ...person, person_stop: 1 }, facts)).toBe(false)
    expect(promotable({ ...person, outcome: 'interrupted', failure: null }, facts)).toBe(false)
    expect(promotable({ ...person, outcome: 'done', failure: null }, facts)).toBe(false)
  })
})

describe('recoverable (N4, variant A)', () => {
  const t = { job_id: 'j_x', session_id: 's1', query_ran: 1, saw_checkpoint: 0, mirror_error: 0, outcome: 'failed', failure: 'session_crashed', cut_cause: null }
  const f = { expect: { mainEntries: 27 }, session: 'resumable', sessionId: 's1', checkpointMainEntries: 27, tokensClosed: true }
  it('either crash path, a release with no terminal event, a timeout after a cut', () => {
    expect(recoverable(t, f)).toBe(true)
    expect(recoverable({ ...t, outcome: null, failure: null }, f)).toBe(true)
    expect(recoverable({ ...t, failure: 'timeout', cut_cause: 'job_cut' }, f)).toBe(true)
    expect(recoverable({ ...t, failure: 'store' }, f)).toBe(true)
  })
  it('damaged otherwise', () => {
    expect(recoverable({ ...t, mirror_error: 1 }, f)).toBe(false)
    expect(recoverable({ ...t, job_id: null }, f)).toBe(false)
    expect(recoverable({ ...t, saw_checkpoint: 1 }, f)).toBe(false)
    expect(recoverable({ ...t, query_ran: 0 }, f)).toBe(false)
    expect(recoverable(t, { ...f, expect: null })).toBe(false)
    expect(recoverable(t, { ...f, expect: { mainEntries: 0 } })).toBe(false)
    expect(recoverable(t, { ...f, session: 'damaged' })).toBe(false)
    expect(recoverable(t, { ...f, sessionId: 's2' })).toBe(false)
    expect(recoverable(t, { ...f, checkpointMainEntries: 30 })).toBe(false)
    expect(recoverable(t, { ...f, tokensClosed: false })).toBe(false)
    expect(recoverable({ ...t, failure: 'timeout' }, f)).toBe(false)
    expect(recoverable({ ...t, failure: 'sdk_error' }, f)).toBe(false)
    expect(recoverable({ ...t, outcome: 'stopped', failure: null }, f)).toBe(false)
  })
})

describe('the no-progress guard', () => {
  it('a turn with no step and no part is idle; one cut by a person\'s now message never counts either way', () => {
    expect(idle(end({ steps_n: 0, parts_n: 0 }))).toBe(true)
    expect(idle(end({ steps_n: 1, parts_n: 0 }))).toBe(false)
    expect(idle(end({ steps_n: 0, parts_n: 0, cut_cause: 'message' }))).toBeNull()
    expect(idle(end({ steps_n: 0, parts_n: 0, cut_cause: 'job_cut' }))).toBe(true)
  })
})
