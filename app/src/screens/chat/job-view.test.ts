// The live view of a long job and of every turn the server wrote (Stage 1 M1-D, from #441's review). Ways it could
// break, written first:
//  - a job's continuation (its text is the server's carry-on note) shows in the person's bubble or as a queued chip;
//  - Try again on a failed server turn sends the server's note as the person's own message;
//  - a promoted root still shows failed with Try again while its job runs, or an interrupted one says "You stopped";
//  - a continuation that hit its limit, or failed and is retried, shows as a failure instead of carrying on;
//  - the server's own cut says "You stopped", or a person's stop (or their new message) says nothing;
//  - a turn that hit a limit and did NOT become a job loses its failure;
//  - an event between a promoted root's end and its `job.started` (a saved file after its confirm, a notice, an
//    action's update, a progress line) shows the root's failure anyway, live or in a reload's replay (#451 review);
//  - a message queued `next` plus the server's cut reads as "You stopped" (only a `now` message cuts the turn);
//  - the job's progress or end is lost, or a second `job.ended` changes the view.
import { fc, test as fcTest } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import type { ChatEvent } from '../../../shared/contract/runs'
import type { ChatMessage } from '../../agent/types'
import { emptyView, reduce } from './view'
import { mergeHistory } from './notes'
import type { ChatView } from './view'

const AT = { iso: '2026-11-20T10:00:00.000Z', ms: Date.UTC(2026, 10, 20, 10, 0, 0) }
const RUN = 'r_Rrrrrrrrrrrrrrrrrrrrrr'
const ROOT = 't_Rootaaaaaaaaaaaaaaaaa'
const C1 = 't_Contaaaaaaaaaaaaaaaaa'
const P2 = 't_Persaaaaaaaaaaaaaaaaa'
const JOB = 'j_Jobaaaaaaaaaaaaaaaaaaa'
// The words, written out (not the code's constants).
const CARRIED = 'Your Inhouse agent carried on with this task by itself.'
const ACTION = 'Your Inhouse agent went on once the action was settled.'
const STOPPED = 'You stopped your Inhouse agent. Nothing was changed.'
const NOTE = 'Carry on with the task. This is an automatic note from Inhouse, not a message from the person.'

const run = (...events: ChatEvent[]): ChatView => events.reduce((v, e) => reduce(v, e, AT, RUN), emptyView())
const queued = (turnId: string, text: string, source?: 'job' | 'action'): ChatEvent =>
  ({ type: 'turn.queued', turnId, messageId: `${turnId}.u`, text, attachments: [], priority: 'next', by: 'm_sam', ...(source ? { source } : {}) })
const started = (turnId: string): ChatEvent => ({ type: 'turn.started', turnId, model: 'sonnet' })
const failed = (turnId: string, reason: Extract<ChatEvent, { type: 'turn.finished' }>['reason']): ChatEvent => ({ type: 'turn.finished', turnId, outcome: 'failed', reason })
const ended = (turnId: string, outcome: 'interrupted' | 'stopped' | 'done'): ChatEvent => ({ type: 'turn.finished', turnId, outcome })
const jobStarted: ChatEvent = { type: 'job.started', jobId: JOB, rootTurnId: ROOT }
const jobEnded = (outcome: 'done' | 'cancelled' | 'time'): ChatEvent => ({ type: 'job.ended', jobId: JOB, outcome, durationMs: 7_200_000, cost: { minor: 320, currency: 'USD' } })
const runFinished: ChatEvent = { type: 'run.finished', runId: RUN, turns: 2, durationMs: 1, cost: { minor: 0, currency: 'USD' } }
const root = [queued(ROOT, 'Count every order this year'), started(ROOT)]
const byId = (v: ChatView, id: string) => v.messages.find(m => m.id === id)
const errors = (v: ChatView) => v.messages.filter((m): m is Extract<ChatMessage, { role: 'agent' }> => m.role === 'agent' && m.part.type === 'error')

describe('a server-written turn is never the person\'s message', () => {
  test("a job's continuation shows the carry-on note, not its text, and never waits as the person's queued message", () => {
    const q = run(...root, failed(ROOT, 'max_turns'), jobStarted, queued(C1, NOTE, 'job'))
    expect(q.queued).toEqual([])
    const v = reduce(q, started(C1), AT, RUN)
    expect(byId(v, `${C1}.u`)).toEqual({ id: `${C1}.u`, role: 'event', text: CARRIED })
    expect(v.messages.some(m => m.role === 'user' && m.text === NOTE)).toBe(false)
    expect(v.thinking).toBe('Carrying on with this task…')
  })
  test("an action's resume shows the server's note; a question's resume (no text) shows nothing", () => {
    const a = run(queued(C1, 'The action was approved and sent.', 'action'), started(C1))
    expect(byId(a, `${C1}.u`)).toEqual({ id: `${C1}.u`, role: 'event', text: ACTION })
    const q = run(queued(C1, ''), started(C1))
    expect(q.queued).toEqual([])
    expect(byId(q, `${C1}.u`)).toBeUndefined()
  })
  test("a failed action's resume offers no Try again with the server's text", () => {
    const v = run(queued(C1, 'The action was approved and sent.', 'action'), started(C1), failed(C1, 'timeout'))
    expect(errors(v).map(m => m.part.type === 'error' && m.part.retryQuestion)).toEqual([''])
  })
})

describe('a turn that hits a limit', () => {
  test('promoted: no failure and no Try again; the job runs', () => {
    const v = run(...root, failed(ROOT, 'max_turns'), jobStarted)
    expect(errors(v)).toEqual([])
    expect(v.pendingEnd).toBeNull()
    expect(v.job).toMatchObject({ jobId: JOB, rootTurnId: ROOT, state: 'running' })
    // Its next event changes nothing about the root.
    expect(errors(reduce(v, queued(C1, NOTE, 'job'), AT, RUN))).toEqual([])
  })
  test('promoted after the server cut it: no "You stopped"', () => {
    const v = run(...root, ended(ROOT, 'interrupted'), jobStarted)
    expect(byId(v, `${ROOT}.x`)).toBeUndefined()
  })
  test('not promoted: the failure shows once the next turn starts or the run ends, with Try again asking the person\'s question', () => {
    for (const next of [runFinished, started(P2)]) {
      const v = run(...root, failed(ROOT, 'turn_budget'), next)
      expect(errors(v).map(m => m.part.type === 'error' && m.part.retryQuestion)).toEqual(['Count every order this year'])
      expect(v.pendingEnd).toBeNull()
    }
  })
  // The server sends `turn.finished` at the runner's terminal event and `job.started` only at its release; a saved file's
  // event comes after its awaited confirm, so it can land between them (core.ts). Nothing in between settles the hold.
  const between: ChatEvent[] = [
    { type: 'file', turnId: ROOT, fileId: 'f_Fileaaaaaaaaaaaaaaaaaa', name: 'job-run.txt', bytes: 7, contentType: 'text/plain' },
    { type: 'file.refused', turnId: ROOT, name: 'big.bin', reason: 'too_large' } as ChatEvent,
    { type: 'notice', code: 'pool_busy' },
    { type: 'action.updated', actionId: 'ac_Actaaaaaaaaaaaaaaaaaaa', rev: 2 } as ChatEvent,
    queued(P2, 'And the refunds?'),
  ]
  test.each(['max_turns', 'interrupted'] as const)('promoted (%s) with a saved file and other events before its job.started: still no failure or "You stopped"', end => {
    const v = run(...root, end === 'interrupted' ? ended(ROOT, 'interrupted') : failed(ROOT, end), ...between, jobStarted)
    expect(errors(v)).toEqual([])
    expect(byId(v, `${ROOT}.x`)).toBeUndefined()
    expect(v.pendingEnd).toBeNull()
    expect(v.files.map(f => f.name)).toEqual(['job-run.txt'])
  })
  test('the same events not promoted: the failure shows when the run ends', () => {
    const v = run(...root, failed(ROOT, 'max_turns'), ...between)
    expect(errors(v)).toEqual([])
    expect(errors(reduce(v, runFinished, AT, RUN))).toHaveLength(1)
  })
  test('a reload during the job: the stored history has no end row for the root, and the replay adds none', () => {
    // What route 24 gives for a promoted root (projection.ts keeps no end row for it), then the run's frames replayed.
    const history: ChatMessage[] = [
      { id: `${ROOT}.u`, role: 'user', text: 'Count every order this year', at: AT },
      { id: `${ROOT}.0`, role: 'agent', part: { type: 'text', text: 'Working on step 1.' }, trace: ROOT, at: AT },
    ]
    const replay = run(...root, { type: 'part', turnId: ROOT, messageId: `${ROOT}.0`, part: { type: 'text', text: 'Working on step 1.' }, model: 'sonnet', at: AT },
      failed(ROOT, 'max_turns'), ...between.slice(0, 1), jobStarted, queued(C1, NOTE, 'job'), started(C1))
    const shown = mergeHistory(history, [], replay.messages)
    expect(shown.map(m => m.id)).toEqual([`${ROOT}.u`, `${ROOT}.0`, `${C1}.u`])
    expect(shown.some(m => m.id === `${ROOT}.f` || m.id === `${ROOT}.x`)).toBe(false)
  })
  test("a person's stop that wasn't promoted still says so", () => {
    expect(byId(run(...root, ended(ROOT, 'interrupted'), runFinished), `${ROOT}.x`)).toEqual({ id: `${ROOT}.x`, role: 'event', text: STOPPED })
  })
  test('another job starting is not this turn\'s: its end still shows', () => {
    const other: ChatEvent = { type: 'job.started', jobId: JOB, rootTurnId: P2 }
    expect(errors(run(...root, failed(ROOT, 'max_turns'), other))).toHaveLength(1)
  })
})

describe("a job's own turns", () => {
  const live = [...root, failed(ROOT, 'max_turns'), jobStarted, queued(C1, NOTE, 'job'), started(C1)]
  test.each(['max_turns', 'turn_budget', 'session_crashed', 'protocol', 'store', 'unknown', 'timeout', 'cap_reached', 'job_budget', 'budget_busy', 'pool_full'] as const)(
    'failed %s: nothing in the thread (the job carries on, retries or ends for its budget, and its card says so)', reason => {
      const v = run(...live, failed(C1, reason))
      expect(errors(v)).toEqual([])
      expect(byId(v, `${C1}.f`)).toBeUndefined()
    })
  test.each(['sdk_error', 'model_off', 'structured_output', 'files'] as const)('failed %s (it ends the job): shown, Try again asks the person\'s question', reason => {
    const v = run(...live, failed(C1, reason))
    expect(errors(v).map(m => m.part.type === 'error' && m.part.retryQuestion)).toEqual(['Count every order this year'])
  })
  test("the server's cut carries on silently", () => {
    expect(byId(run(...live, ended(C1, 'interrupted')), `${C1}.x`)).toBeUndefined()
  })
  test('at the deadline (the job ended first, not cancelled) nothing says "You stopped"', () => {
    expect(byId(run(...live, jobEnded('time'), ended(C1, 'interrupted')), `${C1}.x`)).toBeUndefined()
  })
  test("a person's interrupt (the job was cancelled first), a Stop or Cancel, or their new message says they stopped it", () => {
    expect(byId(run(...live, jobEnded('cancelled'), ended(C1, 'interrupted')), `${C1}.x`)).toMatchObject({ text: STOPPED })
    expect(byId(run(...live, ended(C1, 'stopped')), `${C1}.x`)).toMatchObject({ text: STOPPED })
    expect(byId(run(...live, { ...queued(P2, 'Actually, stop'), priority: 'now' } as ChatEvent, ended(C1, 'interrupted')), `${C1}.x`)).toMatchObject({ text: STOPPED })
  })
  test("a message queued `next` or `later`, then the server's cut: nothing says \"You stopped\" (a reload agrees)", () => {
    for (const priority of ['next', 'later'] as const) {
      expect(byId(run(...live, { ...queued(P2, 'And the refunds?'), priority } as ChatEvent, ended(C1, 'interrupted')), `${C1}.x`)).toBeUndefined()
    }
  })
})

describe("a job's question resume (the job's parked turn taken over)", () => {
  const resumed = [...root, failed(ROOT, 'max_turns'), jobStarted, queued(C1, NOTE, 'job'), started(C1), ended(C1, 'done'), queued(P2, ''), started(P2)]
  test('its limit, retry or the server\'s cut say nothing (a reload agrees: it is a job turn there too)', () => {
    expect(errors(run(...resumed, failed(P2, 'max_turns')))).toEqual([])
    expect(byId(run(...resumed, ended(P2, 'interrupted')), `${P2}.x`)).toBeUndefined()
  })
  test("a failure that ends the job shows, and Try again asks the person's question", () => {
    expect(errors(run(...resumed, failed(P2, 'sdk_error'))).map(m => m.part.type === 'error' && m.part.retryQuestion)).toEqual(['Count every order this year'])
  })
  test('outside a running job, a question resume ends as any turn', () => {
    const v = run(queued(P2, ''), started(P2), failed(P2, 'timeout'))
    expect(errors(v).map(m => m.part.type === 'error' && m.part.retryQuestion)).toEqual([''])
  })
})

describe("the job's life", () => {
  test('a resumed run with no job.started: its progress still shows the running job (a reload replays the same)', () => {
    const v = run({ type: 'job.progress', jobId: JOB, label: 'Reading orders', helpers: 1 })
    expect(v.job).toMatchObject({ jobId: JOB, state: 'running', progress: { label: 'Reading orders', helpers: 1 } })
  })
  test('progress, then one end with its length and cost; a second end changes nothing', () => {
    const p = run(...root, failed(ROOT, 'max_turns'), jobStarted, { type: 'job.progress', jobId: JOB, label: 'Reading orders', helpers: 2 })
    expect(p.job?.progress).toEqual({ label: 'Reading orders', helpers: 2 })
    const e = reduce(p, jobEnded('done'), AT, RUN)
    expect(e.job).toMatchObject({ state: 'ended', outcome: 'done', durationMs: 7_200_000, cost: { minor: 320, currency: 'USD' }, endedAt: AT })
    expect(reduce(e, jobEnded('cancelled'), AT, RUN)).toBe(e)
  })
  test("another job's progress is ignored", () => {
    const v = run(...root, failed(ROOT, 'max_turns'), jobStarted)
    expect(reduce(v, { type: 'job.progress', jobId: 'j_Otheraaaaaaaaaaaaaaaaa', label: 'x', helpers: 1 }, AT, RUN)).toBe(v)
  })
})

// Over any order of these events: a server-written turn's text never shows as a person's message, and Try again only
// ever asks what the person typed.
const PERSON = 'Count every order this year'
const SERVER_TEXTS = [NOTE, 'The action was approved and sent.']
const T_IDS = [ROOT, C1, P2, 't_Fourthaaaaaaaaaaaaaaa'] as const
const eventArb: fc.Arbitrary<ChatEvent> = fc.oneof(
  fc.constantFrom(...T_IDS).map(t => queued(t, PERSON)),
  fc.tuple(fc.constantFrom(...T_IDS), fc.constantFrom(...SERVER_TEXTS), fc.constantFrom('job' as const, 'action' as const)).map(([t, text, s]) => queued(t, text, s)),
  fc.constantFrom(...T_IDS).map(t => queued(t, '')),
  fc.constantFrom(...T_IDS).map(started),
  fc.tuple(fc.constantFrom(...T_IDS), fc.constantFrom('max_turns', 'turn_budget', 'session_crashed', 'timeout', 'unknown') as fc.Arbitrary<'max_turns'>).map(([t, r]) => failed(t, r)),
  fc.tuple(fc.constantFrom(...T_IDS), fc.constantFrom('interrupted' as const, 'stopped' as const, 'done' as const)).map(([t, o]) => ended(t, o)),
  fc.constantFrom(...T_IDS).map((t): ChatEvent => ({ type: 'job.started', jobId: JOB, rootTurnId: t })),
  fc.constantFrom(jobEnded('done'), jobEnded('cancelled'), jobEnded('time'), runFinished),
  fc.constantFrom(...T_IDS).map((t): ChatEvent => ({ type: 'turn.cancelled', turnId: t, why: 'paused' })),
  fc.constantFrom(...T_IDS).map((t): ChatEvent => ({ type: 'file', turnId: t, fileId: 'f_Fileaaaaaaaaaaaaaaaaaa', name: 'a.txt', bytes: 1, contentType: 'text/plain' })),
  fc.constant<ChatEvent>({ type: 'notice', code: 'pool_busy' }),
)
fcTest.prop([fc.array(eventArb, { maxLength: 30 })])('no server text is ever the person\'s message or their Try again', events => {
  const v = run(...events, runFinished)
  for (const m of v.messages) {
    if (m.role === 'user') expect(SERVER_TEXTS).not.toContain(m.text)
    if (m.role === 'user') expect(m.text).not.toBe('')
    if (m.role === 'agent' && m.part.type === 'error') expect(SERVER_TEXTS).not.toContain(m.part.retryQuestion)
  }
  for (const q of v.queued) expect(q.text).toBe(PERSON)
  expect(v.pendingEnd).toBeNull()
})

// A promoted root: whatever non-settling events land between its end and its `job.started` (files, notices, action
// updates, another person's message queued), and whatever follows, it never shows a failure or "You stopped".
const unsettling: fc.Arbitrary<ChatEvent> = fc.oneof(
  fc.constant<ChatEvent>({ type: 'file', turnId: ROOT, fileId: 'f_Fileaaaaaaaaaaaaaaaaaa', name: 'a.txt', bytes: 1, contentType: 'text/plain' }),
  fc.constant<ChatEvent>({ type: 'notice', code: 'pool_busy' }),
  fc.constant<ChatEvent>({ type: 'notice', code: 'budget_busy' }),
  fc.constant({ type: 'action.updated', actionId: 'ac_Actaaaaaaaaaaaaaaaaaaa', rev: 1 } as ChatEvent),
  fc.constant(queued(P2, PERSON)),
)
fcTest.prop([
  fc.constantFrom<ChatEvent>(failed(ROOT, 'max_turns'), failed(ROOT, 'turn_budget'), ended(ROOT, 'interrupted')),
  fc.array(unsettling, { maxLength: 8 }), fc.array(eventArb, { maxLength: 15 }),
])('a promoted root never shows a failure or "You stopped", whatever lands before its job.started', (end, before, after) => {
  const v = run(...root, end, ...before, jobStarted, ...after.filter(e => !('turnId' in e) || e.turnId !== ROOT), runFinished)
  expect(v.messages.filter(m => m.id === `${ROOT}.f` || m.id === `${ROOT}.x`)).toEqual([])
})
