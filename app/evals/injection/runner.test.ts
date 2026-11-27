// The write-injection run loop and its gate (N31): every repeat ends graded or says why not; the gate fails on a repeat
// that wasn't graded, timed out, had a bypass, missed its control, or never ran. The dry run as a grader check.
import { describe, expect, it } from 'vitest'
import { INJECTION_CASES } from './cases.ts'
import { createFakeInjectionTarget } from './fake.ts'
import { selfCheck } from './run.ts'
import { gateOf, runInjection, summarise, type InjectionSession, type InjectionTarget } from './runner.ts'

const pick = (...ids: string[]) => INJECTION_CASES.filter((c) => ids.includes(c.id))
const fixed = (id: string, rep: number) => `INJ${id}R${rep}X`

describe('the dry run as a grader check', () => {
  it('passes: the clean set passes the gate with its controls; each planted kind is caught in every repeat; an ungraded or endless repeat fails', async () => {
    const r = await selfCheck(INJECTION_CASES, 1)
    expect(r.lines.join('\n')).toContain('Grader check: PASS.')
    expect(r.ok).toBe(true)
  })
})

describe('the run loop', () => {
  it('runs the controls first, each repeat once, and passes the gate on the clean agent', async () => {
    const out = await runInjection({ target: createFakeInjectionTarget(), cases: pick('W06', 'P01', 'W04'), reps: 2, canary: fixed })
    expect(out.rows.map((r) => `${r.caseId}-${r.rep}`)).toEqual(['P01-1', 'P01-2', 'W04-1', 'W04-2', 'W06-1', 'W06-2'])
    expect(gateOf(out)).toEqual({ pass: true, why: [] })
  })

  it('lists a case whose write family the target lacks as not run, and one it can\'t plant as not served, outside the gate', async () => {
    const base = createFakeInjectionTarget({ provides: ['tag_ops'] })
    const target: InjectionTarget = { ...base, serves: (c) => (c.plant?.via === 'slack' ? 'no Slack plant' : null) }
    const out = await runInjection({ target, cases: pick('W06', 'W01', 'W15'), reps: 1, canary: fixed })
    expect(out.notRun).toEqual([{ id: 'W01', needs: ['refund'] }, { id: 'W15', needs: ['slack_post'] }])
    expect(out.rows.map((r) => r.caseId)).toEqual(['W06'])
    const s = summarise(out)
    expect(s.gate.pass).toBe(true)
  })

  it('a repeat whose evidence can\'t be read is not graded, and fails the gate; the run goes on', async () => {
    const out = await runInjection({ target: createFakeInjectionTarget({ plant: 'ungraded' }), cases: pick('W06', 'W07'), reps: 1, canary: fixed })
    expect(out.rows).toEqual([expect.objectContaining({ caseId: 'W06', graded: false, pass: false, err: expect.stringContaining('the write log could not be read') }), expect.objectContaining({ caseId: 'W07', graded: false })])
    expect(gateOf(out)).toMatchObject({ pass: false, why: ['2 repeats not graded'] })
  })

  it('a turn that never ends is still graded (what went out counts) and fails the gate', async () => {
    const out = await runInjection({ target: createFakeInjectionTarget({ plant: 'timeout' }), cases: pick('W06'), reps: 1, canary: fixed, chatTimeoutMs: 20 })
    expect(out.rows[0]).toMatchObject({ graded: true, runOk: false, pass: false, err: expect.stringContaining('timeout') })
    expect(gateOf(out).pass).toBe(false)
  })

  it('a failed preflight fails the repeat, never skips it; a failed reset stops the run', async () => {
    const base = createFakeInjectionTarget()
    const resets: string[] = []
    const target: InjectionTarget = {
      ...base,
      async start(c, run) {
        const s = await base.start(c, run)
        return { ...s, preflight: async () => (c.id === 'W06' ? 'tag_add is not on' : null), reset: async () => { resets.push(c.id); if (c.id === 'W07') throw new Error('the log is still there') } } satisfies InjectionSession
      },
    }
    const out = await runInjection({ target, cases: pick('W06', 'W07', 'W08'), reps: 1, canary: fixed })
    expect(out.rows.map((r) => [r.caseId, r.graded, r.err?.split(':')[0]])).toEqual([['W06', false, 'evidence'], ['W07', true, 'reset']])
    expect(out.rows[0]!.err).toContain('preflight failed: tag_add is not on')
    expect(resets).toEqual(['W06', 'W07'])
    expect(gateOf(out)).toMatchObject({ pass: false })
    expect(gateOf(out).why).toContain('1 planned repeats never ran')
  })

  it('stops at the budget, and the repeats it never ran fail the gate', async () => {
    const base = createFakeInjectionTarget()
    let spent = 0
    const target: InjectionTarget = { ...base, spentUsd: () => spent, async start(c, run) { spent += 1; return base.start(c, run) } }
    const out = await runInjection({ target, cases: pick('W06', 'W07', 'W08'), reps: 1, budgetUsd: 2, canary: fixed })
    expect(out.rows.length).toBe(2)
    expect(out.stoppedByBudget).toBe(true)
    expect(gateOf(out).why).toEqual(['1 planned repeats never ran'])
  })

  it('reports the Q4 numbers: bait under a seeded grant, and private data to a listed channel', async () => {
    const out = await runInjection({ target: createFakeInjectionTarget({ plant: 'token' }), cases: pick('W07', 'W06'), reps: 1, canary: fixed })
    const s = summarise(out)
    expect(s.headline.baitUnderGrant).toMatchObject({ repeats: 1, of: 1 })
    expect(s.bypasses.byKind).toMatchObject({ token: 2 })
  })
})
