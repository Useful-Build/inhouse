// The thread's time and model markers (UI_BASE_V2 decision 7). Ways this can fail, written first: a marker for every message
// (no gap rule); none at a day change under an hour apart; a marker keyed to a message inside an answer's card (it never shows);
// the same marker twice in a row; a switch marked when only a sample answer (no model) sits between two of the same model.
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import type { ChatMessage } from '../../agent/types'
import { daysBefore, fmtMarkerTime, instantOf, type Display } from '../../lib/format'
import { MARKER_GAP_MS, threadMarkers, type ThreadMarker } from './markers'

const D: Display = { timeZone: 'America/New_York', locale: 'en-US' }
const MIN = 60_000
// 2026-11-20 09:00 in New York.
const T0 = Date.UTC(2026, 10, 20, 14, 0)
const user = (id: string, ms?: number): ChatMessage => ({ id, role: 'user', text: id, ...(ms === undefined ? {} : { at: instantOf(ms) }) })
const agent = (id: string, ms?: number, model?: string): ChatMessage => ({ id, role: 'agent', trace: 't', part: { type: 'text', text: id }, ...(ms === undefined ? {} : { at: instantOf(ms) }), ...(model ? { model } : {}) })
const note = (id: string): ChatMessage => ({ id, role: 'event', text: id })
const list = (msgs: ChatMessage[]) => Object.fromEntries(threadMarkers(msgs, D))

describe('time markers', () => {
  test('before the first message, then only after an hour or more', () => {
    expect(list([user('q1', T0), agent('a1', T0 + MIN), user('q2', T0 + 59 * MIN), agent('a2', T0 + 60 * MIN), user('q3', T0 + 120 * MIN)])).toEqual({
      q1: [{ kind: 'time', at: T0 }],
      q3: [{ kind: 'time', at: T0 + 120 * MIN }],
    })
  })
  test('the gap counts from the last timed message, the answer included', () => {
    // 59 minutes after the answer, though 61 after the question.
    expect(list([user('q1', T0), agent('a1', T0 + 2 * MIN), user('q2', T0 + 61 * MIN)])).toEqual({ q1: [{ kind: 'time', at: T0 }] })
  })
  test('a day change under an hour apart still gets one', () => {
    // 23:50 and 00:10 in New York.
    const late = Date.UTC(2026, 10, 21, 4, 50)
    expect(list([user('q1', late), agent('a1', late + MIN), user('q2', late + 20 * MIN)])).toEqual({
      q1: [{ kind: 'time', at: late }],
      q2: [{ kind: 'time', at: late + 20 * MIN }],
    })
  })
  test('messages without a time neither mark nor move the clock; the first timed block gets the first marker', () => {
    expect(list([user('q1'), agent('a1'), note('n1'), user('q2', T0), agent('a2', T0 + MIN)])).toEqual({ q2: [{ kind: 'time', at: T0 }] })
  })
  test('a time inside an answer card is never a marker of its own', () => {
    expect(list([user('q1', T0), agent('a1', T0 + MIN), agent('a2', T0 + 3 * 60 * MIN)])).toEqual({ q1: [{ kind: 'time', at: T0 }] })
  })
})

describe('model markers', () => {
  test('"Switched to" when an answer turn opens with another model than the answer before', () => {
    expect(list([user('q1'), agent('a1', undefined, 'opus'), user('q2'), agent('a2', undefined, 'opus'), user('q3'), agent('a3', undefined, 'sonnet'), agent('a3b', undefined, 'sonnet')])).toEqual({
      a3: [{ kind: 'model', model: 'sonnet' }],
    })
  })
  test('the first answer, and answers with no model, mark nothing', () => {
    expect(list([agent('a1', undefined, 'opus'), user('q2'), agent('a2'), user('q3'), agent('a3', undefined, 'opus')])).toEqual({})
  })
  test('a turn with no question before it carries both, the time first', () => {
    expect(list([agent('a1', T0, 'opus'), note('n'), agent('a2', T0 + 2 * 60 * MIN, 'sonnet')])).toEqual({
      a1: [{ kind: 'time', at: T0 }],
      a2: [{ kind: 'time', at: T0 + 2 * 60 * MIN }, { kind: 'model', model: 'sonnet' }],
    })
  })
})

describe('fmtMarkerTime', () => {
  test('today, yesterday, this week and earlier', () => {
    const now = T0 + 30 * MIN
    expect(fmtMarkerTime(T0, now, D)).toBe('Today 9:00\u00a0AM')
    expect(fmtMarkerTime(T0 - 24 * 60 * MIN, now, D)).toBe('Yesterday 9:00\u00a0AM')
    expect(fmtMarkerTime(T0 - 3 * 24 * 60 * MIN, now, D)).toBe('Tue, Nov 17, 9:00\u00a0AM')
    expect(fmtMarkerTime(T0 - 20 * 24 * 60 * MIN, now, D)).toBe('Oct 31, 10:00\u00a0AM') // still summer time there
  })
})

describe('properties', () => {
  // A thread: messages in time order, some without a time or a model, as the app can show them.
  const thread = fc.array(fc.record({
    role: fc.constantFrom('user', 'agent', 'agent', 'event'),
    step: fc.integer({ min: 0, max: 30 * 60 * MIN }),
    timed: fc.boolean(),
    model: fc.option(fc.constantFrom('opus', 'sonnet', 'haiku'), { nil: undefined }),
  }), { maxLength: 40 }).map(rows => {
    let t = T0
    return rows.map((r, i): ChatMessage => {
      t += r.step
      const id = `m${i}`
      if (r.role === 'event') return note(id)
      return r.role === 'user' ? user(id, r.timed ? t : undefined) : agent(id, r.timed ? t : undefined, r.model)
    })
  })

  /** The thread as it reads: each block's markers, then the block. */
  const flat = (msgs: ChatMessage[]): (ThreadMarker | { kind: 'block' })[] => {
    const m = threadMarkers(msgs, D)
    const out: (ThreadMarker | { kind: 'block' })[] = []
    msgs.forEach((x, i) => {
      const starts = x.role !== 'agent' || msgs[i - 1]?.role !== 'agent'
      if (!starts) return
      out.push(...(m.get(x.id) ?? []), { kind: 'block' })
    })
    return out
  }

  test('markers sit only before a block, and never repeat back to back', () => {
    fc.assert(fc.property(thread, msgs => {
      const starts = new Set(msgs.filter((x, i) => x.role !== 'agent' || msgs[i - 1]?.role !== 'agent').map(x => x.id))
      for (const id of threadMarkers(msgs, D).keys()) expect(starts.has(id)).toBe(true)
      const seq = flat(msgs)
      for (let i = 1; i < seq.length; i++) if (seq[i].kind !== 'block') expect(seq[i]).not.toEqual(seq[i - 1])
    }))
  })

  test('a block that starts on another day, or an hour or more after the last time, always gets a time marker; nothing else does', () => {
    fc.assert(fc.property(thread, msgs => {
      const m = threadMarkers(msgs, D)
      let last: number | undefined
      msgs.forEach((x, i) => {
        const at = x.role === 'event' || x.at === undefined ? undefined : x.at.ms
        const starts = x.role !== 'agent' || msgs[i - 1]?.role !== 'agent'
        const timeMarker = (m.get(x.id) ?? []).find(k => k.kind === 'time')
        if (starts && at !== undefined) {
          const due = last === undefined || at - last >= MARKER_GAP_MS || daysBefore(last, at, D) !== 0
          expect(timeMarker).toEqual(due ? { kind: 'time', at } : undefined)
        } else expect(timeMarker).toBeUndefined()
        if (at !== undefined) last = at
      })
    }))
  })
})
