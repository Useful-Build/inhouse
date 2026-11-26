import { describe, expect, it } from 'vitest'
import { gradeChat } from '../grade.ts'
import { runEvals } from '../runner.ts'
import { S5_PEOPLE } from '../s5-fixtures.ts'
import { createFakeTarget } from '../targets/fake.ts'
import { CAPABILITY_CASES } from './cases.ts'
import { CAPABILITY_FAIL_FIXTURES, CAPABILITY_PASS_FIXTURES } from './fixtures.ts'
import { gradeCapabilityEndState } from './grade.ts'

describe('capability eval graders (M1-H)', () => {
  it('passes all three capability cases on the passing fake target', async () => {
    const out = await runEvals({ target: createFakeTarget(), cases: CAPABILITY_CASES, reps: 1, concurrency: 3 })
    expect(out.notRun).toEqual([])
    expect(out.rows).toHaveLength(3)
    for (const row of out.rows) {
      expect(row.pass, `${row.caseId} should pass`).toBe(true)
    }
  })

  it('fails every capability case on its negative fixture (never passes on "Done.")', async () => {
    const out = await runEvals({ target: createFakeTarget({ capability: 'fail' }), cases: CAPABILITY_CASES, reps: 1, concurrency: 3 })
    expect(out.notRun).toEqual([])
    expect(out.rows).toHaveLength(3)
    for (const row of out.rows) {
      expect(row.pass, `${row.caseId} must fail its negative fixture`).toBe(false)
    }
  })

  it.each(CAPABILITY_CASES.map((c) => [c.id, c] as const))('%s: gradeChat and gradeCapabilityEndState pass positive and fail negative fixture', (id, c) => {
    const passChat = CAPABILITY_PASS_FIXTURES[id]!.chats[0]!
    const failChat = CAPABILITY_FAIL_FIXTURES[id]!.chats[0]!
    const toResult = (ch: typeof passChat) => ({
      toolCalls: (ch.calls ?? []).map(([name, input, result]) => ({ name, input, ...(result !== undefined ? { result } : {}) })),
      answer: ch.answer,
      runOk: true,
      usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      costUsd: 0,
    })

    const pos = toResult(passChat)
    const neg = toResult(failChat)

    expect(gradeChat(c.chats[0]!.expect, pos, S5_PEOPLE).pass).toBe(true)
    expect(gradeCapabilityEndState(id, pos)).toEqual({ pass: true })

    expect(gradeChat(c.chats[0]!.expect, neg, S5_PEOPLE).pass).toBe(false)
    expect(gradeCapabilityEndState(id, neg).pass).toBe(false)
  })
})
