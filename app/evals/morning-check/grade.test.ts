// The grader, the runner's loop and the result file (p4-w3.md section 6). Ways it can fail, written down first:
//  1. an outage case that comes back `complete`, a clean case with an item, or a wrong key, severity or missing source passes;
//  2. a run that called a fixture tool passes;
//  3. the 90% threshold is off by one, or lets a failed clean or outage case through;
//  4. the runner waits on a fixed sleep, never gives up on a slot that doesn't end, or grades the wrong slot;
//  5. a result file is overwritten, or loses the normaliser's counts and the failure cause.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { AMBER, META, RED, hostOf } from './expected.ts'
import type { MorningCaseMeta } from './expected.ts'
import { grade, summarise } from './grade.ts'
import type { Observed } from './grade.ts'
import { resultPath, writeResults } from './results.ts'
import { ROUTINE_ID, observe, parseFixed, runAll, runCase } from './runner.ts'
import type { Reader, RunnerEnv, SlotRow } from './runner.ts'
import { fixedWords } from '../../server/today/words.ts'

const byId = (id: string): MorningCaseMeta => META.find(c => c.id === id)!
const NONE = { truncated: 0, dropped: 0, deduped: 0, overflow: 0 }

/** The perfect answer for a case, as the stored rows would show it. */
function perfect(c: MorningCaseMeta): Extract<Observed, { ok: true }> {
  return {
    ok: true, coverage: c.coverage, gaps: [...c.gaps],
    items: c.items.map(i => ({ key: i.key, sev: i.sev, sources: i.sources.map(s => `${typeof s === 'string' ? s : s[0]} (source)`) })), calls: ['mcp__apps__orders_search'], fixed: NONE,
  }
}

describe('the cases', () => {
  it('every case has a perfect answer that passes', () => {
    for (const c of META) expect(grade(c, perfect(c)), c.id).toMatchObject({ pass: true, reasons: [] })
  })
})

describe('what fails', () => {
  const late = byId('late-orders')
  it('a wrong key, a missing item, an extra item, a wrong severity, a missing source', () => {
    const p = perfect(late)
    expect(grade(late, { ...p, items: [{ ...p.items[0], key: 'unpaid-orders' }] }).checks.keys).toBe(false)
    expect(grade(late, { ...p, items: [] }).checks.keys).toBe(false)
    expect(grade(late, { ...p, items: [...p.items, { key: 'low-stock', sev: AMBER, sources: ['x'] }] }).checks.keys).toBe(false)
    expect(grade(late, { ...p, items: [{ ...p.items[0], sev: RED }] }).checks.sev).toBe(false)
    expect(grade(late, { ...p, items: [{ ...p.items[0], sources: ['#2001', '#2002'] }] }).checks.sources).toBe(false)
    expect(grade(late, { ...p, items: [{ ...p.items[0], sources: ['#2001', '#2002', '#2003', '#2999'] }] }).pass).toBe(true)
  })
  it('a duplicate key does not equal the set', () => {
    const p = perfect(byId('mixed-a'))
    expect(grade(byId('mixed-a'), { ...p, items: [...p.items.slice(0, 2), p.items[0]] }).checks.keys).toBe(false)
  })
  it('a clean case passes only with zero items and complete coverage', () => {
    const clean = byId('clean-empty')
    expect(grade(clean, perfect(clean)).pass).toBe(true)
    expect(grade(clean, { ...perfect(clean), items: [{ key: 'late-orders', sev: AMBER, sources: [] }] }).pass).toBe(false)
    expect(grade(clean, { ...perfect(clean), coverage: 'incomplete', gaps: ['orders'] }).pass).toBe(false)
  })
  it('an outage case that comes back complete fails; the right gap passes; a missing gap fails', () => {
    const out = byId('outage-too-large')
    expect(grade(out, { ...perfect(out), coverage: 'complete', gaps: [] }).pass).toBe(false)
    expect(grade(out, { ...perfect(out), gaps: ['refunds'] }).checks.gaps).toBe(false)
    expect(grade(out, { ...perfect(out), gaps: ['returns', 'refunds'] }).checks.gaps).toBe(false)
    expect(grade(byId('outage-all'), { ...perfect(byId('outage-all')), gaps: ['orders'] }).pass).toBe(false)
  })
  it('the lenient credentials case takes more gaps and fewer items, but never an extra key or a missing refunds gap', () => {
    const c = byId('outage-credentials')
    expect(grade(c, { ...perfect(c), gaps: ['refunds', 'orders'], items: [] }).pass).toBe(true)
    expect(grade(c, { ...perfect(c), gaps: ['orders'] }).pass).toBe(false)
    expect(grade(c, { ...perfect(c), items: [{ key: 'oversold', sev: RED, sources: [] }] }).pass).toBe(false)
    expect(grade(c, { ...perfect(c), coverage: 'complete' }).pass).toBe(false)
  })
  it('a fixture tool call fails the case, whatever else is right', () => {
    for (const name of ['fixture_orders', 'mcp__apps__fixture_reset']) expect(grade(late, { ...perfect(late), calls: [name] })).toMatchObject({ pass: false, checks: { noFixtureTool: false } })
    expect(grade(late, { ...perfect(late), calls: ['mcp__apps__orders_search', 'mcp__apps__my_fixture_notes'] }).pass).toBe(true)
  })
  it('a run with no valid result fails with its cause', () => {
    expect(grade(late, { ok: false, cause: 'invalid_result', calls: [], fixed: NONE })).toMatchObject({ pass: false, reasons: ['no valid result: invalid_result'] })
  })
})

describe('the threshold', () => {
  const rows = (graded: boolean[], clean: boolean[], outage: boolean[]) => [
    ...graded.map(pass => ({ group: 'graded' as const, pass })), ...clean.map(pass => ({ group: 'clean' as const, pass })), ...outage.map(pass => ({ group: 'outage' as const, pass })),
  ]
  const t = (n: number) => Array.from({ length: 12 }, (_, i) => i < n)
  it('is 90% of graded: 11 of 12 is 92% and passes, 10 of 12 is 83% and fails', () => {
    expect(summarise(rows(t(12), [true, true, true], [true, true, true]))).toMatchObject({ graded: { passed: 12, total: 12 }, thresholdMet: true })
    expect(summarise(rows(t(11), [true], [true])).thresholdMet).toBe(true)
    expect(summarise(rows(t(10), [true], [true])).thresholdMet).toBe(false)
  })
  it('exactly 90% passes (9 of 10)', () => {
    expect(summarise(rows([...Array(9).fill(true), false], [true], [true])).thresholdMet).toBe(true)
  })
  it('every clean and every outage case must pass', () => {
    expect(summarise(rows(t(12), [true, false, true], [true])).thresholdMet).toBe(false)
    expect(summarise(rows(t(12), [true], [true, true, false])).thresholdMet).toBe(false)
  })
  it('no graded cases is not a pass', () => expect(summarise(rows([], [true], [true])).thresholdMet).toBe(false))
  test.prop([fc.array(fc.boolean(), { minLength: 1, maxLength: 30 })])('graded passes iff passed*10 >= total*9', flags => {
    expect(summarise(rows(flags, [], [])).thresholdMet).toBe(flags.filter(Boolean).length * 10 >= flags.length * 9)
  })
})

describe('the runner', () => {
  const NOW = Date.parse('2026-11-22T12:00:00Z')
  /** A fake stack: `answers` says what each case's slot ends with (the "model"), `never` cases never end. */
  function fakeEnv(answer: (c: MorningCaseMeta) => { slot: Partial<SlotRow>; items: unknown[]; tools?: string[] } | 'never') {
    let now = NOW
    let current: MorningCaseMeta | null = null
    let since = 0
    const log: string[] = []
    let polls = 0
    const reader: Reader = {
      async newestSlot(routine, sinceMs) {
        expect(routine).toBe(ROUTINE_ID)
        polls++
        const a = current ? answer(current) : 'never'
        if (a === 'never' || sinceMs !== since) return null
        // The slot ends after two polls (the turn takes a while).
        return { slot_key: `now|${ROUTINE_ID}|k${polls}`, state: polls % 3 === 0 ? 'ended' : 'started', failure: null, result_text: null, turn_id: 't1', claimed_at_ms: since, ...a.slot }
      },
      async items() {
        return (current ? (answer(current) as { items: unknown[] }).items : []).map(i => JSON.stringify(i))
      },
      async tools() {
        return (current ? (answer(current) as { tools?: string[] }).tools : undefined) ?? ['mcp__apps__orders_search']
      },
    }
    const env: RunnerEnv = {
      nowMs: () => now,
      async useShop(host) {
        current = META.find(c => hostOf(c.id) === host) ?? null
        log.push(`shop ${host}`)
        polls = 0
      },
      async trigger(s) { since = s; log.push('trigger') },
      async nudge() { log.push('nudge') },
      async pause() { now += 1_000 },
      reader, caseTimeoutMs: 60_000,
    }
    return { env, log }
  }
  const itemsOf = (c: MorningCaseMeta) => c.items.map(i => ({ key: i.key, sev: i.sev, sources: i.sources.map(s => ({ n: typeof s === 'string' ? s : s[0] })) }))
  const perfectAnswer = (c: MorningCaseMeta) => ({
    slot: { failure: c.coverage === 'incomplete' ? 'incomplete' : null, result_text: c.coverage === 'incomplete' ? `found ${c.items.length} things; couldn't read ${c.gaps.join(', ')} (fixed: 2 cut)` : `found ${c.items.length} things` },
    items: itemsOf(c),
  })

  it('a dry run over every case with a perfect model: all pass, the threshold is met, counts and causes are kept', async () => {
    const { env, log } = fakeEnv(perfectAnswer)
    const file = await runAll(env, META, { date: '2026-11-22', sha: 'abc1234', model: 'fake' })
    expect(file.cases.filter(c => !c.verdict.pass).map(c => [c.id, c.verdict.reasons])).toEqual([])
    expect(file.summary).toEqual({ graded: { passed: 12, total: 12 }, cleanAllPass: true, outageAllPass: true, thresholdMet: true })
    expect(log.filter(l => l.startsWith('shop ')).length).toBe(META.length)
    const out = file.cases.find(c => c.id === 'outage-too-large')!
    expect(out.observed).toMatchObject({ ok: true, coverage: 'incomplete', gaps: ['returns'], fixed: { truncated: 2 } })
    expect(out.failure).toBe('incomplete')
  })

  it('a model that says complete for an outage fails exactly those cases, and a failed run keeps its cause', async () => {
    const { env } = fakeEnv(c => (c.group === 'outage' ? { slot: { failure: null, result_text: 'found 0 things' }, items: [] } : c.id === 'oversold' ? { slot: { failure: 'invalid_result', result_text: "didn't give a valid result" }, items: [] } : perfectAnswer(c)))
    const file = await runAll(env, META, { date: '2026-11-22', sha: 'abc1234', model: 'fake' })
    expect(file.cases.filter(c => !c.verdict.pass).map(c => c.id)).toEqual(['oversold', 'outage-all', 'outage-credentials', 'outage-too-large'])
    expect(file.cases.find(c => c.id === 'oversold')!.observed).toMatchObject({ ok: false, cause: 'invalid_result' })
    expect(file.summary.thresholdMet).toBe(false)
  })

  it('gives up on a slot that never ends, at the deadline, without a sleep', async () => {
    const { env } = fakeEnv(() => 'never')
    const r = await runCase(env, byId('late-orders'))
    expect(r.observed).toMatchObject({ ok: false, cause: 'no_slot' })
    expect(r.verdict.pass).toBe(false)
    expect(r.ms).toBeGreaterThanOrEqual(60_000)
  })

  it('names a slot that started but never ended as timed_out, and ignores a slot from before the trigger', async () => {
    const stuck = fakeEnv(() => ({ slot: { state: 'started' }, items: [] })).env
    stuck.reader.newestSlot = async () => ({ slot_key: 's', state: 'started', failure: null, result_text: null, turn_id: null, claimed_at_ms: 1 })
    expect((await runCase({ ...stuck, caseTimeoutMs: 5_000 }, byId('late-orders'))).observed).toMatchObject({ cause: 'timed_out' })
  })

  it('observes a slot that was lost or missed as no valid result', async () => {
    const reader: Reader = { newestSlot: async () => null, items: async () => [], tools: async () => [] }
    for (const state of ['lost', 'missed', 'refused', 'skipped']) {
      expect(await observe(reader, { slot_key: 's', state, failure: null, result_text: null, turn_id: null, claimed_at_ms: 1 })).toMatchObject({ ok: false, cause: `slot ${state}` })
    }
  })

  test.prop([fc.record({ truncated: fc.nat(50), dropped: fc.nat(50), deduped: fc.nat(50), overflow: fc.nat(50) })])('parseFixed reads back what fixedWords wrote', c => {
    expect(parseFixed(`found 3 things; couldn't read refunds${fixedWords(c)}`)).toEqual(c)
    expect(parseFixed(null)).toEqual(NONE)
  })
})

describe('the result file', () => {
  it('names the file by date and sha and never overwrites one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-results-'))
    const file = { date: '2026-11-22', sha: 'abc1234', model: 'm', summary: summarise([]), cases: [] }
    const first = writeResults(dir, file)
    const second = writeResults(dir, { ...file, model: 'second' })
    expect([first.endsWith('2026-11-22-abc1234.json'), second.endsWith('2026-11-22-abc1234-2.json')]).toEqual([true, true])
    expect(JSON.parse(readFileSync(first, 'utf8')).model).toBe('m')
    expect(resultPath(dir, '2026-11-22', 'abc1234', p => p.endsWith('abc1234.json'))).toMatch(/abc1234-2\.json$/)
  })
  it('refuses a malformed date or sha', () => {
    expect(() => resultPath('d', '22-11-2026', 'abc1234')).toThrow()
    expect(() => resultPath('d', '2026-11-22', '../x')).toThrow()
  })
})
