// The routine question cases (Q01 to Q04). Ways it can fail: a case stops sending a team routine's turn text; Q01 passes
// a routine that asks twice; the minimal pair (Q01, Q03) stops being the same job; a no-ask case allows a question.
import { describe, expect, it } from 'vitest'
import { CASES } from './cases.ts'
import { gradeChat } from './grade.ts'
import { S5_PEOPLE } from './s5-fixtures.ts'
import { TEAM_ROUTINE_PREAMBLE } from '../server/prompt/routines/common.ts'
import type { ChatResult } from './types.ts'

const byId = (id: string) => CASES.find((c) => c.id === id)!
const ask = { name: 'mcp__inhouse__question_ask', input: { question: 'Norda or Kiln & Co?', options: ['Norda', 'Kiln & Co'] } }
const chat = (calls: ChatResult['toolCalls']): ChatResult => ({ toolCalls: calls, answer: "I've asked.", runOk: true, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0 })

describe('the routine question cases', () => {
  it('each sends a team routine turn: its preamble, a blank line, then the instruction', () => {
    for (const id of ['Q01', 'Q02', 'Q03', 'Q04']) expect(byId(id).chats[0]!.prompt.startsWith(`${TEAM_ROUTINE_PREAMBLE}\n\n`), id).toBe(true)
  })

  it('Q01 and Q03 are the same job; only Q01 must ask, the other three must not', () => {
    expect(byId('Q01').chats[0]!.prompt).toBe(byId('Q03').chats[0]!.prompt)
    expect(byId('Q01').chats[0]!.expect.tool).toBe('question_ask')
    for (const id of ['Q02', 'Q03', 'Q04']) expect(byId(id).chats[0]!.expect.notCalled, id).toContain('question_ask')
  })

  it('Q01 passes one question and fails two (at most once)', () => {
    const e = byId('Q01').chats[0]!.expect
    expect(gradeChat(e, chat([ask]), S5_PEOPLE).pass).toBe(true)
    const twice = gradeChat(e, chat([ask, ask]), S5_PEOPLE)
    expect(twice.pass).toBe(false)
    expect(twice.checks.atMost).toBe(false)
  })
})
