// What a reopened chat shows: stored history by position, then this tab's own messages. Ways it could fail, written first:
//  - a message the history and the live stream both carry shows twice, or at the live place instead of the stored one;
//  - the stored order is changed (a reload must keep it, even where the live stream showed another order);
//  - a message only this tab has (the history hasn't flushed it yet) is dropped;
//  - a failed or never-run turn's stored end row shows nothing after a reload (the silence Q2 saw), shows other words
//    than the live stream did, or shows twice beside the live message.
// The expected lists are written out here, not produced by `mergeHistory`.
import { describe, expect, test } from 'vitest'
import type { ChatMessage } from '../../agent/types'
import type { StoredMessage } from '../../../shared/contract/chats'
import type { ChatEvent } from '../../../shared/contract/runs'
import { historyWanted, mergeHistory } from './notes'
import { historyMessages } from './turn-text'
import { emptyView, reduce } from './view'

const T1 = 't_AAAAAAAAAAAAAAAAAAAAAA'
const T2 = 't_BBBBBBBBBBBBBBBBBBBBBB'
const user = (turn: string, text: string): ChatMessage => ({ id: `${turn}.u`, role: 'user', text })
const part = (turn: string, n: number, text: string): ChatMessage => ({ id: `${turn}.${n}`, role: 'agent', trace: '', part: { type: 'text', text } })
const ids = (l: ChatMessage[]) => l.map(m => m.id)

describe('mergeHistory', () => {
  test('stored messages come first in their stored order, then what only this tab has', () => {
    const stored = [user(T1, 'a'), part(T1, 0, 'b'), user(T2, 'c')]
    const live = [part(T2, 0, 'd')]
    expect(ids(mergeHistory(stored, [], live))).toEqual([`${T1}.u`, `${T1}.0`, `${T2}.u`, `${T2}.0`])
  })

  test('a message both carry shows once, at its stored place, even when the live stream showed another order', () => {
    const stored = [user(T1, 'a'), part(T1, 0, 'b'), part(T1, 1, 'c')]
    // The live stream showed the second part first (a reconnect delivered it early), then the question.
    const live = [part(T1, 1, 'c'), user(T1, 'a')]
    expect(ids(mergeHistory(stored, [], live))).toEqual([`${T1}.u`, `${T1}.0`, `${T1}.1`])
  })

  test('with no history the live messages show as they are, and the sample turns of a demo chat come before them', () => {
    expect(ids(mergeHistory(undefined, [], [user(T1, 'a')]))).toEqual([`${T1}.u`])
    expect(ids(mergeHistory([], [user(T1, 'a')], [part(T2, 0, 'z')]))).toEqual([`${T1}.u`, `${T2}.0`])
  })

  test('nothing is changed in the lists it was given', () => {
    const stored = [user(T1, 'a')]
    const live = [part(T1, 0, 'b')]
    mergeHistory(stored, [], live)
    expect(stored).toHaveLength(1)
    expect(live).toHaveLength(1)
  })
})

describe('historyWanted', () => {
  const chats = [{ id: 'kept', turns: [] }, { id: 'sample', turns: [{}] }]
  test('only a chat the agent has, with no sample turns, reads its history', () => {
    expect(historyWanted(chats, 'kept')).toBe(true)
    expect(historyWanted(chats, 'sample')).toBe(false)
  })
  test('an unknown chat (a stale link) reads nothing, so its failed read can\'t raise a second notice beside the app\'s own', () => {
    expect(historyWanted(chats, 'no-such-chat')).toBe(false)
    expect(historyWanted(chats, null)).toBe(false)
    expect(historyWanted([], 'kept')).toBe(false)
  })
})

describe('historyMessages: a stored end row in the live words', () => {
  const AT = { iso: '2026-11-20T10:00:00.000Z', ms: Date.UTC(2026, 10, 20, 10, 0, 0) }
  const R = 'r_Rrrrrrrrrrrrrrrrrrrrrr'
  const at = (turn: string, pos: number) => ({ turnId: turn, runId: R, pos, at: AT })
  const storedUser = (turn: string, pos: number, text: string): StoredMessage => ({ id: `${turn}.u`, role: 'user', text, ...at(turn, pos) })
  const end = (turn: string, kind: 'f' | 'x', pos: number, e: Extract<StoredMessage, { role: 'event' }>['end']): StoredMessage =>
    ({ id: `${turn}.${kind}`, role: 'event', text: '', end: e, ...at(turn, pos) })
  const live = (...events: ChatEvent[]) => events.reduce((v, e) => reduce(v, e, AT, R), emptyView()).messages
  const queued = (turn: string, text: string): ChatEvent => ({ type: 'turn.queued', turnId: turn, messageId: `${turn}.u`, text, attachments: [], priority: 'next', by: 'm_sam' })

  test('a failed turn reads as the live failure: same id, words and question to ask again, shown once', () => {
    const page = [storedUser(T1, 0, 'How many?'), end(T1, 'f', 1, { failure: 'protocol', retryQuestion: 'How many?' })]
    const shown = historyMessages(page)
    expect(shown[1]).toEqual({
      id: `${T1}.f`, role: 'agent', trace: T1, at: AT,
      part: { type: 'error', text: "Your Inhouse agent couldn't finish this answer. Nothing was changed.", retryQuestion: 'How many?' },
    })
    const liveMessages = live(queued(T1, 'How many?'), { type: 'turn.finished', turnId: T1, outcome: 'failed', reason: 'protocol' })
    expect(liveMessages.find(m => m.id === `${T1}.f`)).toEqual(shown[1])
    expect(ids(mergeHistory(shown, [], liveMessages))).toEqual([`${T1}.u`, `${T1}.f`])
  })

  test('a stopped turn and a question paused during its start read as their live notes, each shown once after a reload', () => {
    const page = [
      storedUser(T1, 0, 'a'), end(T1, 'x', 1, { outcome: 'stopped' }),
      storedUser(T2, 2, 'b'), end(T2, 'x', 3, { why: 'paused' }),
    ]
    const shown = historyMessages(page)
    expect(shown).toEqual([
      page[0], { id: `${T1}.x`, role: 'event', text: 'You stopped your Inhouse agent. Nothing was changed.' },
      page[2], { id: `${T2}.x`, role: 'event', text: 'Your Inhouse agent was paused, so this question was not asked.' },
    ])
    const liveMessages = live(
      queued(T1, 'a'), { type: 'turn.started', turnId: T1, model: 'sonnet' }, { type: 'turn.finished', turnId: T1, outcome: 'stopped' },
      queued(T2, 'b'), { type: 'turn.cancelled', turnId: T2, why: 'paused' },
    )
    expect(liveMessages.filter(m => m.role === 'event')).toEqual([shown[1], shown[3]])
    expect(ids(mergeHistory(shown, [], liveMessages))).toEqual([`${T1}.u`, `${T1}.x`, `${T2}.u`, `${T2}.x`])
  })

  test('a question that never ran reads as its live note; one with nothing to say is left out; other messages stay as they are', () => {
    const page = [
      storedUser(T1, 0, 'a'), end(T1, 'x', 1, { why: 'pool_full' }),
      storedUser(T2, 2, 'b'), end(T2, 'x', 3, { why: 'removed' }),
    ]
    expect(historyMessages(page)).toEqual([
      page[0], { id: `${T1}.x`, role: 'event', text: 'Your Inhouse agent is busy right now. Try again in a moment.' }, page[2],
    ])
    const liveMessages = live(queued(T1, 'a'), { type: 'turn.cancelled', turnId: T1, why: 'pool_full' })
    expect(liveMessages.find(m => m.id === `${T1}.x`)).toEqual(historyMessages(page)[1])
  })
})
