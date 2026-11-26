import { describe, expect, it } from 'vitest'
import { gradeChat } from '../grade.ts'
import { runEvals } from '../runner.ts'
import { S5_PEOPLE } from '../s5-fixtures.ts'
import { createFakeTarget } from '../targets/fake.ts'
import { createProductTarget } from '../targets/product.ts'
import { CAPABILITY_CASES } from './cases.ts'
import { CAPABILITY_EXTRA_FAIL_FIXTURES, CAPABILITY_FAIL_FIXTURES, CAPABILITY_PASS_FIXTURES } from './fixtures.ts'
import { gradeCapabilityEndState } from './grade.ts'

const toResult = (ch: { calls?: [string, Record<string, unknown>, string?][]; answer: string }) => ({
  toolCalls: (ch.calls ?? []).map(([name, input, result]) => ({ name, input, ...(result !== undefined ? { result } : {}) })),
  answer: ch.answer,
  runOk: true,
  usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
  costUsd: 0,
})

describe('capability eval graders (M1-H)', () => {
  it('passes all three capability cases on the passing fake target', async () => {
    const out = await runEvals({ target: createFakeTarget(), cases: CAPABILITY_CASES, reps: 1, concurrency: 3 })
    expect(out.notRun).toEqual([])
    expect(out.rows).toHaveLength(3)
    for (const row of out.rows) {
      expect(row.pass, `${row.caseId} should pass`).toBe(true)
      expect(row.checks.capability).toBe(true)
    }
  })

  it('fails every capability case on its near-miss negative fixture through runEvals', async () => {
    const out = await runEvals({ target: createFakeTarget({ capability: 'fail' }), cases: CAPABILITY_CASES, reps: 1, concurrency: 3 })
    expect(out.notRun).toEqual([])
    expect(out.rows).toHaveLength(3)
    for (const row of out.rows) {
      expect(row.pass, `${row.caseId} must fail its negative fixture`).toBe(false)
      expect(row.checks.capability, `${row.caseId} capability check must fail`).toBe(false)
    }
  })

  it('the product target reports CAP-01..03 as not run (needs capability) with zero network calls', async () => {
    let calls = 0
    const target = createProductTarget({
      paid: true,
      budgetUsd: 2,
      env: {
        INHOUSE_EVAL_RUN: '7-1',
        INHOUSE_EVAL_BRAND: '1',
        INHOUSE_EVAL_ORIGIN: 'https://eval.example.test',
        INHOUSE_EVAL_ACCESS_CLIENT_ID: 'id.access',
        INHOUSE_EVAL_ACCESS_CLIENT_SECRET: 's',
      },
      fetch: (() => {
        calls++
        throw new Error('network')
      }) as unknown as typeof fetch,
    })
    const out = await runEvals({ target, cases: CAPABILITY_CASES, reps: 1, concurrency: 1 })
    expect(out.rows).toEqual([])
    expect(out.notRun).toEqual([
      { id: 'CAP-01', needs: ['capability'] },
      { id: 'CAP-02', needs: ['capability'] },
      { id: 'CAP-03', needs: ['capability'] },
    ])
    expect(calls).toBe(0)
  })

  it.each(CAPABILITY_CASES.map((c) => [c.id, c] as const))('%s: passes positive fixture and fails near-miss negative fixture', (id, c) => {
    const pos = toResult(CAPABILITY_PASS_FIXTURES[id]!.chats[0]!)
    const neg = toResult(CAPABILITY_FAIL_FIXTURES[id]!.chats[0]!)

    expect(gradeChat(c.chats[0]!.expect, pos, S5_PEOPLE).pass).toBe(true)
    expect(gradeCapabilityEndState(id, pos)).toEqual({ pass: true })

    expect(gradeCapabilityEndState(id, neg).pass).toBe(false)
  })

  it.each(CAPABILITY_EXTRA_FAIL_FIXTURES)('rejects $name for $expectedReason', ({ caseId, expectedReason, canned }) => {
    const neg = toResult(canned.chats[0]!)
    const verdict = gradeCapabilityEndState(caseId, neg)
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toBe(expectedReason)
  })
})
