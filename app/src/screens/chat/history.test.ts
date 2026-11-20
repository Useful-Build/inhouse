// What a reopened chat shows: stored history by position, then this tab's own messages. Ways it could fail, written first:
//  - a message the history and the live stream both carry shows twice, or at the live place instead of the stored one;
//  - the stored order is changed (a reload must keep it, even where the live stream showed another order);
//  - a message only this tab has (the history hasn't flushed it yet) is dropped.
// The expected lists are written out here, not produced by `mergeHistory`.
import { describe, expect, test } from 'vitest'
import type { ChatMessage } from '../../agent/types'
import { mergeHistory } from './notes'

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
