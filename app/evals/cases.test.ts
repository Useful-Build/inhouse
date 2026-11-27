// The routine question cases (Q01, Q02). Way it can fail: the eval's routine turn drifts from the text a scheduled team
// routine is really sent, so the cases grade a prompt no routine runs with.
import { describe, expect, it } from 'vitest'
import { CASES, routineTurn } from './cases.ts'
import { routinePrompt } from '../server/routines/prompts.ts'

describe('the routine question cases', () => {
  it('send the exact turn text a team routine renders', () => {
    const instruction = 'Check stock and say what is low.'
    expect(routineTurn(instruction)).toBe(routinePrompt({ origin: 'team', kind: 'agent', instruction, prompt_ref: null }))
  })

  it('one must ask with question_ask, one must finish without asking', () => {
    const q01 = CASES.find((c) => c.id === 'Q01')!
    const q02 = CASES.find((c) => c.id === 'Q02')!
    expect(q01.chats[0]!.prompt.startsWith(routineTurn(''))).toBe(true)
    expect(q02.chats[0]!.prompt.startsWith(routineTurn(''))).toBe(true)
    expect(q01.chats[0]!.expect.tool).toBe('question_ask')
    expect(q02.chats[0]!.expect.notCalled).toContain('question_ask')
  })
})
