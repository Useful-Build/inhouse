// The notices and outcomes a chat shows, against the words written out here (a literal table, not the code's own constants).
// Ways this can fail, written first: a budget_busy turn shown as failed while it waits; the spending notice lost; a notice
// that stays after the turn starts; a turn that ended before it started never showing what was asked; a damaged session
// that clears on its own.
import { describe, expect, test } from 'vitest'
import type { ChatEvent } from '../../../shared/contract/runs'
import { emptyView, filesOfTurns, reduce } from './view'
import type { ChatView } from './view'

const AT = { iso: '2026-11-20T10:00:00.000Z', ms: Date.UTC(2026, 10, 20, 10, 0, 0) }
const T = 't_Aaaaaaaaaaaaaaaaaaaaaa'
const queued: ChatEvent = { type: 'turn.queued', turnId: T, messageId: `${T}.u`, text: 'How many?', attachments: [], priority: 'next', by: 'm_sam' }
const run = (...events: ChatEvent[]): ChatView => events.reduce((v, e) => reduce(v, e, AT, 'r_Rrrrrrrrrrrrrrrrrrrrrr'), emptyView())
const lastText = (v: ChatView) => { const m = v.messages.at(-1); return m?.role === 'agent' && m.part.type === 'error' ? m.part.text : undefined }

describe('turn outcomes, each with its own words', () => {
  const CASES: [Extract<ChatEvent, { type: 'turn.finished' }>['reason'], string][] = [
    ['turn_budget', 'This answer reached the spending limit for one answer, so it stopped.'],
    ['cap_reached', "Your team has reached its spending cap, so this answer didn't run."],
    ['budget_busy', "This answer waited for others to finish and didn't get its turn. Try again in a minute."],
    ['max_turns', 'This answer needed more steps than your team allows, so it stopped. Ask again, or raise the limit in Settings.'],
    ['pool_full', 'Your Inhouse agent is busy right now. Try again in a moment.'],
    ['timeout', 'This answer took too long, so your Inhouse agent stopped it. Nothing was changed.'],
  ]
  test.each(CASES)('%s', (reason, text) => {
    const v = run(queued, { type: 'turn.started', turnId: T, model: 'sonnet' }, { type: 'turn.finished', turnId: T, outcome: 'failed', reason })
    expect(lastText(v)).toBe(text)
    expect(v.turns[T].state).toBe('failed')
  })
  test('a turn that fails before it starts still shows what was asked', () => {
    const v = run(queued, { type: 'turn.finished', turnId: T, outcome: 'failed', reason: 'cap_reached' })
    expect(v.messages.map(m => m.id)).toEqual([`${T}.u`, `${T}.f`])
  })
})

describe('budget_busy waits, it does not fail', () => {
  const busy: ChatEvent = { type: 'notice', code: 'budget_busy' }
  test('the notice says why and the turn is waiting, not failed', () => {
    const v = run(queued, busy)
    expect(v.budgetWait).toBe(true)
    expect(v.notice?.text).toBe("You're close to your spending cap, so this answer is waiting for others to finish")
    expect(v.turns[T].state).toBe('queued')
    expect(v.messages).toEqual([])
  })
  test('it stops waiting when the turn starts', () => {
    const v = run(queued, busy, { type: 'turn.started', turnId: T, model: 'sonnet' })
    expect(v.budgetWait).toBe(false)
    expect(v.notice).toBeNull()
  })
  test('it stops waiting when the turn fails', () => {
    const v = run(queued, busy, { type: 'turn.finished', turnId: T, outcome: 'failed', reason: 'budget_busy' })
    expect(v.budgetWait).toBe(false)
  })
})

describe('notices', () => {
  test('cap_reached and paused say what they are', () => {
    expect(run({ type: 'notice', code: 'cap_reached' }).notice?.text).toBe('Your team has reached its spending cap.')
    expect(run({ type: 'notice', code: 'paused' }).notice?.text).toBe("Your Inhouse agent is paused, so it can't answer questions until an Admin resumes it.")
  })
  test('a damaged session stays damaged through the run ending and keeps its notice', () => {
    for (const code of ['session_damaged', 'mirror_error'] as const) {
      const v = run({ type: 'notice', code }, { type: 'run.finished', runId: 'r_Rrrrrrrrrrrrrrrrrrrrrr', turns: 1, durationMs: 1, cost: { minor: 0, currency: 'USD' } })
      expect(v.damaged).toBe(true)
      expect(v.notice?.text).toBe("This chat's memory couldn't be saved, so it can't go on. Start it fresh to keep asking.")
    }
  })
  test('an ordinary notice goes with the run', () => {
    const v = run({ type: 'notice', code: 'pool_busy' }, { type: 'run.finished', runId: 'r_Rrrrrrrrrrrrrrrrrrrrrr', turns: 0, durationMs: 1, cost: { minor: 0, currency: 'USD' } })
    expect(v.notice).toBeNull()
  })
})

describe('a turn ends once', () => {
  test('a second turn.finished for it changes nothing: no second line, the outcome stays', () => {
    const fin = (outcome: 'done' | 'failed', reason?: 'max_turns'): ChatEvent => ({ type: 'turn.finished', turnId: T, outcome, ...(reason ? { reason } : {}) })
    const once = run(queued, { type: 'turn.started', turnId: T, model: 'sonnet' }, fin('failed', 'max_turns'))
    const twice = [fin('failed', 'max_turns'), fin('done')].reduce((v, e) => reduce(v, e, AT), once)
    expect(twice).toBe(once)
    expect(twice.messages.filter(m => m.id === `${T}.f`)).toHaveLength(1)
    expect(twice.turns[T].state).toBe('failed')
  })
})

describe('saved files (the `file` event)', () => {
  const T2 = 't_Bbbbbbbbbbbbbbbbbbbbbb'
  const file = (turnId: string, fileId: string, name = 'a.csv'): ChatEvent => ({ type: 'file', turnId, fileId, name, bytes: 10, contentType: 'text/csv' })
  const F1 = 'f_Aaaaaaaaaaaaaaaaaaaaaa'
  const F2 = 'f_Bbbbbbbbbbbbbbbbbbbbbb'

  test('a file event adds the file under its turn, once, however often it is sent', () => {
    const v = run(queued, file(T, F1), file(T, F1), file(T, F2, 'b.pdf'))
    expect(v.files).toEqual([
      { turnId: T, fileId: F1, name: 'a.csv', bytes: 10, contentType: 'text/csv' },
      { turnId: T, fileId: F2, name: 'b.pdf', bytes: 10, contentType: 'text/csv' },
    ])
  })

  test('filesOfTurns gives each turn its own files, and a block of two turns gets both', () => {
    const v = run(queued, file(T, F1), file(T2, F2, 'b.pdf'))
    expect(filesOfTurns(v, new Set([T])).map(f => f.fileId)).toEqual([F1])
    expect(filesOfTurns(v, new Set([T2])).map(f => f.fileId)).toEqual([F2])
    expect(filesOfTurns(v, new Set([T, T2])).map(f => f.fileId)).toEqual([F1, F2])
    expect(filesOfTurns(v, new Set(['t_Cccccccccccccccccccccc']))).toEqual([])
    expect(filesOfTurns(undefined, new Set([T]))).toEqual([])
  })
})

describe('files the agent made but could not save, and earlier files left out', () => {
  const started: ChatEvent = { type: 'turn.started', turnId: T, model: 'sonnet' }
  const refused = (name: string, reason: Extract<ChatEvent, { type: 'file.refused' }>['reason']): ChatEvent => ({ type: 'file.refused', turnId: T, name, reason })
  const notes = (v: ChatView) => v.messages.filter(m => m.role === 'event').map(m => [m.id, m.role === 'event' ? m.text : ''])

  const REFUSED: [Extract<ChatEvent, { type: 'file.refused' }>['reason'], string][] = [
    ['too_large', "Your Inhouse agent made report.pdf, but it wasn't saved because it's too big."],
    ['too_many', "Your Inhouse agent made report.pdf, but it wasn't saved because this answer made too many files."],
    ['type_not_allowed', "Your Inhouse agent made report.pdf, but it wasn't saved because your team doesn't allow that type of file."],
    ['save_failed', "Your Inhouse agent made report.pdf, but it couldn't be saved. Ask again to try once more."],
    ['bad_name', "Your Inhouse agent made report.pdf, but it wasn't saved because its name can't be used."],
  ]
  test.each(REFUSED)('a refused file (%s) shows a note with its name and why', (reason, text) => {
    expect(notes(run(queued, started, refused('report.pdf', reason)))).toEqual([[`${T}.r.report.pdf`, text]])
  })

  test('the same refusal sent twice shows once; two files show two notes', () => {
    const v = run(queued, started, refused('a.pdf', 'too_large'), refused('a.pdf', 'too_large'), refused('b.csv', 'save_failed'))
    expect(notes(v).map(([id]) => id)).toEqual([`${T}.r.a.pdf`, `${T}.r.b.csv`])
  })

  test('files left out of the restore are named, without their folder', () => {
    const v = run(queued, started, { type: 'files.restored', turnId: T, restored: 2, leftOut: ['inputs/big.pdf', 'outputs/old.csv'] })
    expect(notes(v)).toEqual([[`${T}.l`, "Some of this chat's earlier files were too big to bring back together, so your Inhouse agent can't use these in this answer: big.pdf and old.csv."]])
  })

  test('past five left-out files, the rest are counted', () => {
    const leftOut = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(n => `inputs/${n}.pdf`)
    const v = run(queued, started, { type: 'files.restored', turnId: T, restored: 0, leftOut })
    expect(notes(v)).toEqual([[`${T}.l`, "Some of this chat's earlier files were too big to bring back together, so your Inhouse agent can't use these in this answer: a.pdf, b.pdf, c.pdf, d.pdf, e.pdf and 2 more."]])
  })

  test('a restore with nothing left out shows nothing', () => {
    const before = run(queued, started)
    const after = reduce(before, { type: 'files.restored', turnId: T, restored: 3, leftOut: [] }, AT)
    expect(after).toBe(before)
  })
})

describe('a live turn cancelled (a pause stops the answer being written)', () => {
  const live = [queued, { type: 'turn.started', turnId: T, model: 'sonnet' }] as const
  test('it gets its cancel note, the turn is over and the thinking line is gone', () => {
    const v = run(...live, { type: 'turn.cancelled', turnId: T, why: 'paused' })
    expect(v.messages.at(-1)).toEqual({ id: `${T}.x`, role: 'event', text: 'Your Inhouse agent was paused, so this question was not asked.' })
    expect(v.turns[T].state).toBe('cancelled')
    expect(v.live).toBeNull()
    expect(v.thinking).toBeNull()
  })
  test('a cancel with nothing to say (the person removed it) adds no note', () => {
    const v = run(...live, { type: 'turn.cancelled', turnId: T, why: 'removed' })
    expect(v.messages.map(m => m.id)).toEqual([`${T}.u`])
    expect(v.turns[T].state).toBe('cancelled')
  })
  test('a finish that follows the cancel changes nothing', () => {
    const cancelled = run(...live, { type: 'turn.cancelled', turnId: T, why: 'paused' })
    expect(reduce(cancelled, { type: 'turn.finished', turnId: T, outcome: 'stopped' }, AT)).toBe(cancelled)
  })
  test('a turn that already finished is not cancelled afterwards', () => {
    const done = run(...live, { type: 'turn.finished', turnId: T, outcome: 'done' })
    expect(reduce(done, { type: 'turn.cancelled', turnId: T, why: 'paused' }, AT)).toBe(done)
  })
})
