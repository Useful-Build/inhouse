// What the chat's job row and result card show (job-status.ts) and their words (job-text.ts). Ways it could break: a
// reload (no events) showing nothing for a running job; a Cancel answered here still showing the row until the event
// comes; an old job's events hiding a newer running one, or its question wait; the card staying after the chat moved
// on; the length said wrong, or a cost shown at all.
import { describe, expect, test } from 'vitest'
import type { ChatMessage, Job } from '../../agent/types'
import { cancelFocus, jobShown, takeStored } from './job-status'
import type { JobShown } from './job-status'
import { durationText, jobFacts } from './job-text'
import type { JobInfo } from './view'

const at = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const T0 = Date.UTC(2026, 10, 26, 9, 0)
const J1 = 'j_Oneaaaaaaaaaaaaaaaaaaa'
const J2 = 'j_Twoaaaaaaaaaaaaaaaaaaa'
const stored = (o: Partial<Job> = {}): Job => ({
  jobId: J1, chatId: 'c1', rootTurnId: 't_Rootaaaaaaaaaaaaaaaaa', state: 'running', outcome: null, startedAt: at(T0), deadlineAt: at(T0 + 8 * 3_600_000),
  endedAt: null, progress: null, cost: null, ...o,
})
const live = (o: Partial<JobInfo> = {}): JobInfo => ({
  jobId: J1, rootTurnId: 't_Rootaaaaaaaaaaaaaaaaa', state: 'running', progress: null, outcome: null, endedAt: null, durationMs: null, cost: null, ...o,
})
const said = (ms: number): ChatMessage => ({ id: 'm', role: 'user', text: 'and now?', at: at(ms) })

describe('jobShown', () => {
  test('nothing when the chat has no job', () => {
    expect(jobShown(null, null, [])).toBeNull()
  })
  test('a reload: the stored job runs (or waits on a question), with its last progress', () => {
    expect(jobShown(null, stored({ progress: { label: 'Reading orders', helpers: 2 } }), [])).toEqual({ kind: 'running', jobId: J1, waiting: false, label: 'Reading orders', helpers: 2 })
    expect(jobShown(null, stored({ state: 'waiting' }), [])).toMatchObject({ kind: 'running', waiting: true, label: null })
  })
  test("this tab's events win for their job", () => {
    expect(jobShown(live({ progress: { label: 'Writing the report', helpers: 0 } }), stored(), [])).toMatchObject({ kind: 'running', label: 'Writing the report' })
    expect(jobShown(live({ state: 'ended', outcome: 'done', endedAt: at(T0 + 10), durationMs: 7_200_000, cost: { minor: 320, currency: 'USD' } }), stored(), []))
      .toEqual({ kind: 'ended', jobId: J1, outcome: 'done', durationMs: 7_200_000 })
  })
  test('a job this tab saw start, now waiting on a question (no event says so): the stored waiting wins', () => {
    expect(jobShown(live({ progress: { label: 'Reading orders', helpers: 1 } }), stored({ state: 'waiting' }), [])).toMatchObject({ kind: 'running', waiting: true })
    // Another job's waiting row doesn't make this one wait.
    expect(jobShown(live(), stored({ jobId: J2, state: 'ended', outcome: 'done', endedAt: at(T0) }), [])).toMatchObject({ kind: 'running', jobId: J1, waiting: false })
  })
  test('a Cancel answered here ends the row before the event comes', () => {
    expect(jobShown(live(), stored({ state: 'ended', outcome: 'cancelled', endedAt: at(T0 + 60_000) }), [])).toMatchObject({ kind: 'ended', outcome: 'cancelled', durationMs: 60_000 })
  })
  test("a newer job the events didn't show wins over an older one's end", () => {
    expect(jobShown(live({ state: 'ended', outcome: 'done', endedAt: at(T0) }), stored({ jobId: J2 }), [])).toMatchObject({ kind: 'running', jobId: J2 })
  })
  test('at the 8-hour cap, an answer part stamped after the end (the live turn winding down) keeps the card; only the person writing again moves the chat on', () => {
    const end = stored({ state: 'ended', outcome: 'time', endedAt: at(T0 + 1000) })
    const windingDown: ChatMessage = { id: 't_x.3', role: 'agent', part: { type: 'text', text: 'Stopping here.' }, trace: 't_x', at: at(T0 + 4000) }
    expect(jobShown(null, end, [windingDown])).toMatchObject({ kind: 'ended', outcome: 'time' })
    expect(jobShown(live({ state: 'ended', outcome: 'time', endedAt: at(T0 + 1000) }), null, [windingDown])).toMatchObject({ kind: 'ended', outcome: 'time' })
    expect(jobShown(null, end, [windingDown, said(T0 + 5000)])).toBeNull()
  })
  test('the card goes once the chat moves on; an earlier message keeps it', () => {
    const end = stored({ state: 'ended', outcome: 'budget', endedAt: at(T0 + 1000) })
    expect(jobShown(null, end, [said(T0 + 500)])).toMatchObject({ kind: 'ended', outcome: 'budget' })
    expect(jobShown(null, end, [said(T0 + 2000)])).toBeNull()
    expect(jobShown(live({ state: 'ended', outcome: 'done', endedAt: at(T0 + 1000) }), null, [said(T0 + 2000)])).toBeNull()
  })
})

describe('job words', () => {
  test.each([[30_000, 'under a minute'], [12 * 60_000, '12 min'], [2 * 3_600_000, '2 h'], [2 * 3_600_000 + 5 * 60_000, '2 h 5 min']])('%d ms is "%s"', (ms, text) => {
    expect(durationText(ms)).toBe(text)
  })
  test('the facts line says how long it ran, never what it cost (DESIGN.md section 1)', () => {
    expect(jobFacts(7_260_000)).toBe('Ran for 2 h 1 min.')
    expect(jobFacts(null)).toBe('')
  })
})

describe('takeStored', () => {
  const run = stored()
  const ended = stored({ state: 'ended', outcome: 'cancelled', endedAt: at(T0 + 60_000) })
  test("a read that left before a Cancel was answered can't bring the row back", () => {
    expect(takeStored({ chatId: 'c1', job: ended }, { chatId: 'c1', job: run })).toEqual({ chatId: 'c1', job: ended })
  })
  test('anything newer is taken: a running job, a new job, another chat, none', () => {
    expect(takeStored({ chatId: 'c1', job: run }, { chatId: 'c1', job: ended })).toEqual({ chatId: 'c1', job: ended })
    expect(takeStored({ chatId: 'c1', job: ended }, { chatId: 'c1', job: stored({ jobId: J2 }) })?.job?.jobId).toBe(J2)
    expect(takeStored({ chatId: 'c1', job: ended }, { chatId: 'c2', job: run })).toEqual({ chatId: 'c2', job: run })
    expect(takeStored(null, { chatId: 'c1', job: null })).toEqual({ chatId: 'c1', job: null })
  })
})

describe('cancelFocus: the card the person cancelled takes the focus, once', () => {
  const wish = { chatId: 'c1', jobId: J1 }
  const row: JobShown = { kind: 'running', jobId: J1, waiting: false, label: null, helpers: 0 }
  const card: JobShown = { kind: 'ended', jobId: J1, outcome: 'cancelled', durationMs: 60_000 }
  /** The component's effect over a sequence of what shows: the wish it keeps and the focus moves it makes. */
  const play = (shows: (JobShown | null)[], chats = shows.map(() => 'c1')) => {
    let w: typeof wish | null = wish
    const focused: number[] = []
    shows.forEach((s, i) => {
      const act = cancelFocus(w, chats[i]!, s)
      if (act === 'wait') return
      w = null
      if (act === 'focus') focused.push(i)
    })
    return focused
  }
  test("the job.ended frame shows the card before the Cancel's answer: it gets the focus", () => {
    // Pressed (row), the frame ends the job (card), then the answer (still the card): one focus, at the frame.
    expect(play([row, card, card])).toEqual([1])
  })
  test('the answer shows the card first: it gets the focus', () => {
    expect(play([row, row, card])).toEqual([2])
  })
  test('a later card (the next job ending) never takes it', () => {
    const next: JobShown = { kind: 'ended', jobId: J2, outcome: 'done', durationMs: 1000 }
    expect(play([row, card, null, { ...row, jobId: J2 }, next])).toEqual([1])
    // Moved to another chat before the card showed: dropped, never focused there or on return.
    expect(play([row, row, card], ['c1', 'c2', 'c1'])).toEqual([])
  })
  test('no wish: nothing to do', () => {
    expect(cancelFocus(null, 'c1', card)).toBe('drop')
  })
})
