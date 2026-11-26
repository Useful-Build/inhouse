// What the chat's job row and result card show (job-status.ts) and their words (job-text.ts). Ways it could break: a
// reload (no events) showing nothing for a running job; a Cancel answered here still showing the row until the event
// comes; an old job's events hiding a newer running one; the card staying after the chat moved on; the length or cost
// said wrong.
import { describe, expect, test } from 'vitest'
import type { ChatMessage, Job } from '../../agent/types'
import { jobShown } from './job-status'
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
      .toEqual({ kind: 'ended', jobId: J1, outcome: 'done', durationMs: 7_200_000, cost: { minor: 320, currency: 'USD' } })
  })
  test('a Cancel answered here ends the row before the event comes', () => {
    expect(jobShown(live(), stored({ state: 'ended', outcome: 'cancelled', endedAt: at(T0 + 60_000) }), [])).toMatchObject({ kind: 'ended', outcome: 'cancelled', durationMs: 60_000 })
  })
  test("a newer job the events didn't show wins over an older one's end", () => {
    expect(jobShown(live({ state: 'ended', outcome: 'done', endedAt: at(T0) }), stored({ jobId: J2 }), [])).toMatchObject({ kind: 'running', jobId: J2 })
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
  test('the facts line says what it knows', () => {
    expect(jobFacts(7_260_000, '$3.20')).toBe('Ran for 2 h 1 min, cost $3.20.')
    expect(jobFacts(null, null)).toBe('')
  })
})
