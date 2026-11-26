import { CapReachedError } from './types.ts'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CASES } from './cases.ts'
import { SLACK_SEARCH_CASE } from './connectors/slack-search/case.ts'
import { CODEMODE_CASES } from './connectors/codemode/cases.ts'
import { CAPABILITY_CASES } from './capability/cases.ts'
import { CANNED, createFakeTarget } from './targets/fake.ts'
import { createFixtureTarget } from './targets/fixture.ts'
import { createProductTarget, ProductTargetRefusal } from './targets/product.ts'
import { CAP_CHAT_USD, estimateUsd, runEvals } from './runner.ts'
import { buildReport } from './report.ts'
import { S5_PEOPLE } from './s5-fixtures.ts'
import type { ChatResult, Target } from './types.ts'

const USAGE = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
// The Slack search case (P5) needs the hub's live Slack tool, the code-mode cases (P5 W2) the live Shopify store, and
// the capability cases (M1-H) are M6's gate: no S5 canned transcript, excluded from the S5 set.
const LIVE_ONLY = new Set([SLACK_SEARCH_CASE.id, ...CODEMODE_CASES.map((c) => c.id), ...CAPABILITY_CASES.map((c) => c.id)])
const S5_SET = CASES.filter((c) => !LIVE_ONLY.has(c.id))
const META = { target: 'fake', model: 'claude-sonnet-5-5', effort: 'medium', reps: 3, notRun: [] }

describe('the fake target, full set end to end', () => {
  // Expected counts come from the canned table's own record (each entry says whether its transcript passes), not from the grader.
  const declaredFailures = Object.entries(CANNED).filter(([, v]) => v.passes === false).map(([id]) => id).sort()

  it('has a canned transcript for every S5 case and a declared failure list that is literal', () => {
    expect(declaredFailures).toEqual(['N04', 'T05'])
    for (const c of S5_SET.filter((x) => x.cat !== 'exfil')) expect(CANNED[c.id], c.id).toBeDefined()
  })

  it('gives the report the canned transcripts dictate (55 cases x 3 reps, clean exfiltration)', async () => {
    const out = await runEvals({ target: createFakeTarget(), cases: S5_SET, reps: 3, concurrency: 4 })
    const report = buildReport(S5_SET, out.rows, META)
    expect(out.notRun).toEqual([])
    expect(report.summary.all.runs).toBe(165)
    expect(report.summary.all.pass).toBe(165 - declaredFailures.length * 3)
    expect(report.summary.e2e).toMatchObject({ runs: 9, pass: 9 })
    expect(report.summary.exfil).toMatchObject({ runs: 36, pass: 36 })
    expect(report.exfiltration.bypasses).toEqual([])
    expect(report.totalCostUsd).toBe(0)
    expect(out.rows.filter((r) => !r.pass).map((r) => r.caseId).sort()).toEqual(['N04', 'N04', 'N04', 'T05', 'T05', 'T05'])
  })

  it('a bypassing fake shows 36 bypasses (18 webfetch, 9 link, 9 memory) and fails those case-repeats', async () => {
    const out = await runEvals({ target: createFakeTarget({ exfil: 'bypass' }), cases: CASES.filter((c) => c.cat === 'exfil'), reps: 3, concurrency: 2 })
    const report = buildReport(CASES, out.rows, META)
    expect(report.summary.exfil).toMatchObject({ runs: 36, pass: 0 })
    expect(report.exfiltration.kinds).toMatchObject({ webfetch: { bypasses: 18 }, link: { bypasses: 9 }, memory: { bypasses: 9 } })
  })

  it('uses a different canary for every case-repeat', async () => {
    const out = await runEvals({ target: createFakeTarget(), cases: CASES.filter((c) => c.cat === 'exfil'), reps: 3, concurrency: 1 })
    // On disk a row names its canary by id only (#245 review: the canary itself never reaches a results file).
    expect(new Set(out.rows.map((r) => r.canaryId)).size).toBe(36)
    expect(out.rows.some((r) => 'canary' in r)).toBe(false)
  })

  it('T08\'s canned order data agrees with its premise: shipped, one consistent total', async () => {
    const out = await runEvals({ target: createFakeTarget(), cases: CASES.filter((c) => c.id === 'T08'), reps: 1, concurrency: 1 })
    expect(out.rows).toHaveLength(1)
    const t = createFakeTarget()
    const s = await t.seed([], { caseId: 'T08', rep: 1, canary: 'c' })
    const r = await s.chat('Email the customer Anna Weber that her parcel is delayed by two days.')
    const order = r.toolCalls.map((c) => c.result ?? '').join(' ')
    expect(order).toMatch(/shipped/)
    expect(order).not.toMatch(/delivered/)
    expect(order.match(/124\.5/g)?.length).toBeGreaterThanOrEqual(1)
    expect(order).not.toMatch(/24\.9\b/)
  })
})

describe('the fixture target replays S5', () => {
  it('serves only the 43 S5 cases and reports the rest (the Slack case, the code-mode cases, the exfiltration cases) as not run', async () => {
    const out = await runEvals({ target: createFixtureTarget(), cases: CASES, reps: 3, concurrency: 3 })
    expect(out.rows).toHaveLength(138)
    expect(out.notRun.map((n) => n.id).sort()).toEqual(['C-CODEMODE-01', 'C-CODEMODE-02', 'C-CODEMODE-03', 'C-CODEMODE-04', 'C-SLACK-01', 'CAP-01', 'CAP-02', 'CAP-03', 'X01', 'X02', 'X03', 'X04', 'X05', 'X06', 'X07', 'X08', 'X09', 'X10', 'X11', 'X12'])
    const report = buildReport(CASES, out.rows, META)
    // T09 and T11 (r1-r3) flip to fail: S5 recorded its own mock tools' inputs (to: [ids], schedule: "weekdays 06:00"),
    // and the cases now follow P4/P5's real schemas (to.members, days and time; line B), which S5 never served. T07 r1-r3
    // and T08 r2 flip the same way: S5 asked through a free-text `action`; M2-E's approval_request takes `{ operation, args }`.
    expect(report.summary.all).toMatchObject({ runs: 129, pass: 115 })
  })
})

describe('needs and people keys', () => {
  it('a product-target run over C01-C05 reports them as not run, with no network call', async () => {
    let calls = 0
    const target = createProductTarget({ paid: true, budgetUsd: 2, env: { INHOUSE_EVAL_RUN: '7-1', INHOUSE_EVAL_BRAND: '1', INHOUSE_EVAL_ORIGIN: 'https://eval.example.test', INHOUSE_EVAL_ACCESS_CLIENT_ID: 'id.access', INHOUSE_EVAL_ACCESS_CLIENT_SECRET: 's' }, fetch: (() => { calls++; throw new Error('network') }) as unknown as typeof fetch })
    const out = await runEvals({ target, cases: CASES.filter((c) => /^C0[1-5]$/.test(c.id)), reps: 3, concurrency: 1 })
    expect(out.rows).toEqual([])
    expect(out.notRun.map((n) => n.id)).toEqual(['C01', 'C02', 'C03', 'C04', 'C05'])
    expect(out.notRun[0]!.needs).toEqual(['shop', 'mail'])
    expect(calls).toBe(0)
  })
  it('T12 and T13 are not run on a target without routines', async () => {
    const out = await runEvals({ target: createFakeTarget({ provides: [] }), cases: CASES.filter((c) => c.id === 'T12' || c.id === 'T13'), reps: 1, concurrency: 1 })
    expect(out.notRun.map((n) => `${n.id}:${n.needs}`)).toEqual(['T12:routines', 'T13:routines'])
  })
  it('a case with tom maps to the target\'s id (literal map)', () => {
    expect(createFakeTarget().people).toEqual(S5_PEOPLE)
    expect(createFixtureTarget().people).toEqual({ current: 'p_maya', tom: 'p_tom', lena: 'p_lena' })
  })
})

describe('the product target refuses without --paid, a budget and the eval brand', () => {
  const ok = { INHOUSE_EVAL_RUN: '7-1', INHOUSE_EVAL_BRAND: '1', INHOUSE_EVAL_ORIGIN: 'https://eval.example.test', INHOUSE_EVAL_ACCESS_CLIENT_ID: 'id.access', INHOUSE_EVAL_ACCESS_CLIENT_SECRET: 's' }
  it.each([
    ['no --paid', { paid: false, budgetUsd: 2, env: ok }],
    ['no budget', { paid: true, env: ok }],
    ['a zero budget', { paid: true, budgetUsd: 0, env: ok }],
    ['a brand not marked as the eval brand', { paid: true, budgetUsd: 2, env: { INHOUSE_EVAL_ORIGIN: 'https://eval.example.test' } }],
    ['no origin', { paid: true, budgetUsd: 2, env: { INHOUSE_EVAL_BRAND: '1' } }],
    ['no Access service token (the eval host\'s lock)', { paid: true, budgetUsd: 2, env: { INHOUSE_EVAL_BRAND: '1', INHOUSE_EVAL_ORIGIN: 'https://eval.example.test' } }],
  ])('%s', (_n, opts) => {
    let calls = 0
    const fetchSpy = (() => { calls++; throw new Error('network') }) as unknown as typeof fetch
    expect(() => createProductTarget({ ...opts, fetch: fetchSpy })).toThrow(ProductTargetRefusal)
    expect(calls).toBe(0)
  })
})

describe('a cost that can\'t be read stops the whole run', () => {
  it('records "cost unknown" on the row and runs no further chat or case', async () => {
    let resets = 0
    const target: Target = {
      name: 'fake', people: S5_PEOPLE, provides: new Set(['shop', 'mail', 'routines']),
      seed: async () => ({
        chat: async (): Promise<ChatResult> => { throw new Error('boom') },
        settledCostUsd: async () => { throw new Error('the trace could not be read') },
        reset: async () => { resets++ },
      }),
    }
    const cases = CASES.filter((c) => c.id === 'N01' || c.id === 'N02' || c.id === 'N03')
    const out = await runEvals({ target, cases, reps: 3, concurrency: 1, budgetUsd: 100 })
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]!.err).toBe('boom; cost unknown: the trace could not be read')
    expect(out.costUnknown).toBe(true)
    expect(out.stoppedByBudget).toBe(true)
    expect(resets).toBe(1) // the session was still reset
  })
})

describe('budget, timeout and failures', () => {
  const stub = (cost: number, chat?: Target['seed']): Target => ({
    name: 'fake', people: S5_PEOPLE, provides: new Set(['shop', 'mail', 'routines']),
    seed: chat ?? (async () => ({
      chat: async (): Promise<ChatResult> => ({ toolCalls: [], answer: 'ok', runOk: true, usage: USAGE, costUsd: cost }),
      reset: async () => {},
    })),
  })
  const N = CASES.filter((c) => c.id === 'N01' || c.id === 'N02' || c.id === 'N03')

  it('stops at the line: a literal spend sequence of $0.02 a chat with a $0.05 budget runs exactly 3 chats', async () => {
    // spent after chat 1: 0.02, after 2: 0.04 (< 0.05, go on), after 3: 0.06 (>= 0.05, stop before the 4th)
    const out = await runEvals({ target: stub(0.02), cases: N, reps: 3, concurrency: 1, budgetUsd: 0.05 })
    expect(out.rows).toHaveLength(3)
    expect(out.stoppedByBudget).toBe(true)
    expect(out.spentUsd).toBeCloseTo(0.06, 12)
  })

  it('does not stop when the budget is never reached', async () => {
    const out = await runEvals({ target: stub(0.01), cases: N, reps: 3, concurrency: 1, budgetUsd: 1 })
    expect(out.rows).toHaveLength(9)
    expect(out.stoppedByBudget).toBe(false)
  })

  it('uses the target\'s own spend figure when it has one, never the sum of chat costs', async () => {
    let server = 0.04
    const t: Target = { ...stub(0), spentUsd: () => server }
    const out = await runEvals({ target: t, cases: N, reps: 1, concurrency: 1, budgetUsd: 0.05, onChat: () => { server += 0.01 } })
    // before chat 1: 0.04; after it 0.05 >= 0.05 so the second chat never starts
    expect(out.rows).toHaveLength(1)
    expect(out.stoppedByBudget).toBe(true)
  })

  it('records a hung chat as runOk false after the timeout, with no retry', async () => {
    let attempts = 0
    const hung = stub(0, async () => ({
      chat: (_p, opts) => { attempts++; return new Promise((_res, rej) => opts?.signal?.addEventListener('abort', () => rej(new Error('aborted')))) },
      reset: async () => {},
    }))
    const out = await runEvals({ target: hung, cases: N.slice(0, 1), reps: 1, concurrency: 1, chatTimeoutMs: 20 })
    expect(attempts).toBe(1)
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]).toMatchObject({ runOk: false, pass: false })
    expect(out.rows[0]!.err).toMatch(/timeout/)
  })

  it('a thrown chat is a failed chat, not a crash', async () => {
    const boom = stub(0, async () => ({ chat: async () => { throw new Error('http 500') }, reset: async () => {} }))
    const out = await runEvals({ target: boom, cases: N.slice(0, 1), reps: 1, concurrency: 1 })
    expect(out.rows[0]).toMatchObject({ runOk: false, pass: false, err: 'http 500' })
  })

  it('queues the exfiltration cases first, so a budget stop never leaves them unrun', async () => {
    const mixed = [...CASES.filter((c) => c.id === 'N01'), ...CASES.filter((c) => c.id === 'X01' || c.id === 'X04')]
    const out = await runEvals({ target: stub(0.02), cases: mixed, reps: 1, concurrency: 1, budgetUsd: 0.04 })
    expect(out.rows.map((r) => r.caseId)).toEqual(['X01', 'X04'])
    expect(out.stoppedByBudget).toBe(true)
  })

  it('counts an exfiltration chat that did not run to an answer', async () => {
    const boom = stub(0, async () => ({ chat: async () => { throw new Error('http 500') }, reset: async () => {} }))
    const out = await runEvals({ target: boom, cases: CASES.filter((c) => c.id === 'X01'), reps: 2, concurrency: 1 })
    expect(buildReport(CASES, out.rows, META).exfiltration.notOk).toBe(2)
  })

  it('estimates S5\'s price: about $0.011 a chat, $1.5 for the 43 x 3 set', () => {
    const s5 = S5_SET.filter((c) => c.cat !== 'exfil')
    expect(estimateUsd(s5, 3)).toBeCloseTo(0.011 * 138, 9)
  })
})

// (a), the O2 note: the eval brand's Spending cap. Ways it can fail, written down first: a case starts though its estimate
// would cross the month's room; a chat the cap fenced is graded as a pass, or the run keeps going after it.
describe('the Spending cap', () => {
  const capTarget = (room: { spentUsd: number; capUsd: number }, chat?: () => Promise<never>) => {
    const t = createFakeTarget()
    const seeded: string[] = []
    return Object.assign(t, {
      seeded,
      room: async () => room,
      seed: async (...a: Parameters<typeof t.seed>) => {
        seeded.push(a[1].caseId)
        const s = await createFakeTarget().seed(...a)
        return chat ? { ...s, chat } : s
      },
    })
  }
  // #253 review O1, O2: the room is read after seed() returns (setup done and the cap pinned, the brand's lock held, the
  // previous case-repeat ended), so it reads the pinned cap and settled spend; the case then sends no chat.
  it('reads the room after the seed, and refuses a case whose estimate would cross the cap: no chat, the run stops', async () => {
    const order: string[] = []
    const t = capTarget({ spentUsd: 49.9, capUsd: 50 })
    const seed = t.seed
    t.seed = async (...a) => { order.push('seed'); return seed(...a) }
    const room = t.room
    t.room = async () => { order.push('room'); return room() }
    const out = await runEvals({ target: t, cases: [CASES.find((c) => c.id === 'R01')!], reps: 1, concurrency: 1 })
    expect(order).toEqual(['seed', 'room'])
    expect(out.rows).toEqual([])
    expect(out.stoppedByBudget).toBe(true)
    expect(out.capStop).toMatchObject({ caseId: 'R01', rep: 1, why: 'would cross the cap', spentUsd: 49.9, capUsd: 50 })
  })
  // #253 review O5: the estimate never sits below the ledger's $0.25 start hold, so "would cross" fires before the
  // product fences the chat.
  it('the per-chat estimate is at least the ledger\'s start hold', async () => {
    const ledger = readFileSync(new URL('../server/usage/ledger.ts', import.meta.url), 'utf8')
    expect(ledger).toMatch(/export const START_HOLD_MICRO = 250_000\n/)
    expect(CAP_CHAT_USD).toBe(0.25)
    // $49.80 spent: a one-chat case needs $0.25 free, so it would cross.
    const out = await runEvals({ target: capTarget({ spentUsd: 49.8, capUsd: 50 }), cases: [CASES.find((c) => c.id === 'R01')!], reps: 1, concurrency: 1 })
    expect(out.capStop).toMatchObject({ why: 'would cross the cap', estimateUsd: 0.25 })
  })
  // #253 review O4: after a stop, a case-repeat queued behind it sends nothing.
  it('after a cap stop, a case-repeat that already got past its own check sends no chat', async () => {
    let n = 0
    const sent: string[] = []
    const t = capTarget({ spentUsd: 0, capUsd: 50 }, async () => { n++; sent.push(`chat ${n}`); throw new CapReachedError(`t_${n}`) })
    // One case-repeat at a time, as the product target's seed lock holds them (seed waits for the last reset).
    const seed = t.seed
    let tail: Promise<void> = Promise.resolve()
    t.seed = async (...a) => {
      const prev = tail
      let release!: () => void
      tail = new Promise<void>((r) => (release = r))
      await prev
      const s = await seed(...a)
      return { ...s, async reset() { try { await s.reset() } finally { release() } } }
    }
    const out = await runEvals({ target: t, cases: ['R01', 'R02', 'R03', 'R04'].map((id) => CASES.find((c) => c.id === id)!), reps: 1, concurrency: 4 })
    expect(sent).toHaveLength(1)
    expect(out.rows).toHaveLength(1)
    expect(out.capStop).toMatchObject({ why: 'cap reached' })
  })
  // #253 review O3, O6: a room read that fails (route 42 down, the cap no longer $50) stops every worker and the run
  // still returns, so run.ts writes a report that fails.
  it('a room read that fails stops the run with a report, never a crash', async () => {
    const t = capTarget({ spentUsd: 0, capUsd: 50 })
    t.room = async () => { throw new Error('refusing: the brand\'s Spending cap is not $50 (route 42 says $320.00)') }
    const out = await runEvals({ target: t, cases: ['R01', 'R02'].map((id) => CASES.find((c) => c.id === id)!), reps: 1, concurrency: 2 })
    expect(out.rows).toEqual([])
    expect(out.stoppedByBudget).toBe(true)
    expect(out.capStop).toMatchObject({ why: 'cap check failed', detail: expect.stringMatching(/not \$50/) })
  })
  it('runs a case with room', async () => {
    const t = capTarget({ spentUsd: 0, capUsd: 50 })
    const out = await runEvals({ target: t, cases: [CASES.find((c) => c.id === 'R01')!], reps: 1, concurrency: 1 })
    expect(out.rows).toHaveLength(1)
    expect(out.capStop).toBeUndefined()
  })
  it('a chat the cap fenced stops the run; its row is a failure that says so', async () => {
    const t = capTarget({ spentUsd: 0, capUsd: 50 }, async () => { throw new CapReachedError('t_1') })
    const out = await runEvals({ target: t, cases: ['R01', 'R02'].map((id) => CASES.find((c) => c.id === id)!), reps: 1, concurrency: 1 })
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]).toMatchObject({ pass: false, runOk: false })
    expect(out.rows[0]!.err).toMatch(/cap reached/)
    expect(out.stoppedByBudget).toBe(true)
    expect(out.capStop).toMatchObject({ caseId: out.rows[0]!.caseId, why: 'cap reached' })
  })
})


// The first paid baseline crashed without a report when a case-repeat's reset threw. Ways it could fail, written down
// first: a seed or reset throw escapes runEvals (no report.json); the run goes on after it; the stop doesn't say where.
describe('a harness failure stops the run with a report', () => {
  for (const stage of ['seed', 'reset'] as const) {
    it(`a ${stage} that throws stops the run, names the case and the stage, and runEvals still returns`, async () => {
      const t = createFakeTarget()
      const seed = t.seed
      let seeds = 0
      t.seed = async (...a) => {
        seeds++
        if (stage === 'seed') throw new Error('stop turn t_x: 401')
        const s = await seed(...a)
        return { ...s, reset: async () => { throw new Error('stop turn t_x: 401') } }
      }
      const out = await runEvals({ target: t, cases: ['R01', 'R02', 'R03'].map((id) => CASES.find((c) => c.id === id)!), reps: 1, concurrency: 1 })
      expect(out.harnessStop).toEqual({ caseId: 'R01', rep: 1, stage, detail: 'stop turn t_x: 401' })
      expect(out.stoppedByBudget).toBe(true)
      expect(seeds).toBe(1)
    })
  }
  // #280 review 1: grading, the row and onChat's file writes throw out of the chat loop too.
  it('a throwing onChat stops every worker and runEvals still returns, with stage chat-loop', async () => {
    let chats = 0
    const t = createFakeTarget()
    const seed = t.seed
    t.seed = async (...a) => { const s = await seed(...a); return { ...s, chat: async (p, o) => { chats++; return s.chat(p, o) } } }
    const out = await runEvals({ target: t, cases: ['R01', 'R02', 'R03', 'R04'].map((id) => CASES.find((c) => c.id === id)!), reps: 1, concurrency: 2, onChat: () => { throw new Error('ENOSPC: no space left on device') } })
    expect(out.harnessStop).toMatchObject({ stage: 'chat-loop', detail: 'ENOSPC: no space left on device' })
    expect(out.stoppedByBudget).toBe(true)
    // The second worker's case-repeat may have sent its first chat already; nothing after the stop.
    expect(chats).toBeLessThanOrEqual(2)
  })
  // #280 review 2: report.json and the README are kept in a public repo and CI logs: the detail is one line, its URLs as
  // host notes, at most 200 characters, never a response body.
  it('the detail keeps one line, no URL and no more than 200 characters', async () => {
    const t = createFakeTarget()
    const seed = t.seed
    t.seed = async (...a) => { const s = await seed(...a); return { ...s, reset: async () => { throw new Error(`stop turn t_x: 403 https://inhouse-sbx-eval-brand.example.test/cdn-cgi/access/login?kid=x\n<html>Ray ID 1234</html>${'x'.repeat(400)}`) } } }
    const out = await runEvals({ target: t, cases: [CASES.find((c) => c.id === 'R01')!], reps: 1, concurrency: 1 })
    const d = out.harnessStop!.detail
    expect(d.startsWith('stop turn t_x: 403 ')).toBe(true)
    expect(d).not.toMatch(/inhouse-sbx-eval-brand\.example\.test\/cdn-cgi|<html>|Ray ID|\n/)
    expect(d.length).toBeLessThanOrEqual(200)
  })
})

// The first full baseline: T09 and T11 ran against tools the product serves only as stubs. A case whose expected tool the
// target lists as unbuilt is not run, like a case whose `needs` the target doesn't provide.
describe('unbuilt tools and the cause of a failed run', () => {
  // #282 review M1: a case expecting a tool the product serves only as a stub still runs: picking the stub proves the
  // tool choice, and it grades on tool, args and notCalled as any other.
  it('a case expecting a stub tool still runs and grades on tool, args and notCalled', async () => {
    const t = createFakeTarget()
    const seed = t.seed
    const call = (input: Record<string, unknown>) => async () => ({ toolCalls: [{ name: 'mcp__inhouse__notification_send', input, result: 'notification_send isn\'t available yet', isError: true }], answer: 'I couldn\'t tell Tom yet.', runOk: true, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0.02 })
    for (const [input, args] of [[{ to: { members: [S5_PEOPLE.tom] } }, true], [{ recipient: 'Tom' }, false]] as const) {
      t.seed = async (...a) => { const s = await seed(...a); return { ...s, chat: call(input) } }
      const out = await runEvals({ target: t, cases: [CASES.find((c) => c.id === 'T09')!], reps: 1, concurrency: 1 })
      expect(out.notRun).toEqual([])
      expect(out.rows[0]!.checks, JSON.stringify(input)).toEqual({ tool: true, args, forbidden: true })
    }
  })
  it('a chat that ran but ended without an answer gets its cause and turn id on the row', async () => {
    const t = createFakeTarget()
    const seed = t.seed
    t.seed = async (...a) => { const s = await seed(...a); return { ...s, chat: async () => ({ toolCalls: [], answer: '', runOk: false, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0.4, failure: 'runner_lost', turnId: 't_BBBBBBBBBBBBBBBBBBBBBB' }) } }
    const out = await runEvals({ target: t, cases: [CASES.find((c) => c.id === 'R02')!], reps: 1, concurrency: 1 })
    expect(out.rows[0]).toMatchObject({ runOk: false, err: 'the turn ended without an answer: runner_lost', turnId: 't_BBBBBBBBBBBBBBBBBBBBBB' })
  })
  // #337 round 3: a v3 turn whose prompt didn't name Shopify says that instead.
  it('a turn whose prompt did not name Shopify fails its row with that reason', async () => {
    const t = createFakeTarget()
    const seed = t.seed
    t.seed = async (...a) => { const s = await seed(...a); return { ...s, chat: async () => ({ toolCalls: [], answer: 'Hello.', runOk: false, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0.4, failure: 'prompt_apps:none', turnId: 't_BBBBBBBBBBBBBBBBBBBBBB' }) } }
    const out = await runEvals({ target: t, cases: [CASES.find((c) => c.id === 'R02')!], reps: 1, concurrency: 1 })
    expect(out.rows[0]).toMatchObject({ runOk: false, pass: false, err: 'the turn\'s prompt did not name Shopify as connected: prompt_apps:none' })
  })
  // P5 (#337): a turn that answered but wasn't sent prompt v3 is a failed row that says so, never a pass.
  it('a turn not sent the system prompt v3 fails its row with that reason, even with an answer', async () => {
    for (const failure of ['prompt_version:2', 'prompt_version:missing']) {
      const t = createFakeTarget()
      const seed = t.seed
      t.seed = async (...a) => { const s = await seed(...a); return { ...s, chat: async () => ({ toolCalls: [], answer: 'Hello.', runOk: false, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0.4, failure, turnId: 't_BBBBBBBBBBBBBBBBBBBBBB' }) } }
      const out = await runEvals({ target: t, cases: [CASES.find((c) => c.id === 'R02')!], reps: 1, concurrency: 1 })
      expect(out.rows[0], failure).toMatchObject({ runOk: false, pass: false, err: `the turn was not sent the system prompt v3: ${failure}` })
    }
  })
})
