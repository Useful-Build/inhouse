// The grader, the runner's loop and the result file (p4-w3.md section 6). Ways it can fail, written down first:
//  1. an outage case that comes back `complete`, a clean case with an item, or a wrong key, severity or missing source passes;
//  2. a run that called a fixture tool passes;
//  3. the 90% threshold is off by one, or lets a failed clean or outage case through;
//  4. the runner waits on a fixed sleep, never gives up on a slot that doesn't end, or grades the wrong slot;
//  5. a result file is overwritten, or loses the normaliser's counts and the failure cause.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { AMBER, META, RED, hostOf } from './expected.ts'
import type { MorningCaseMeta } from './expected.ts'
import { grade, showsName, summarise } from './grade.ts'
import type { Observed } from './grade.ts'
import { openResults, resultPath, writeResults } from './results.ts'
import { ROUTINE_ID, observe, parseFixed, runAll, runCase } from './runner.ts'
import type { ResultFile } from './results.ts'
import type { Reader, RunnerEnv, SlotRow } from './runner.ts'
import { fixedWords } from '../../server/today/words.ts'

const byId = (id: string): MorningCaseMeta => META.find(c => c.id === id)!
const NONE = { truncated: 0, dropped: 0, deduped: 0, overflow: 0, costsRemoved: 0 }

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
  it('a source name must be shown whole: "#2001" is in "Order #2001" but not in "#20011", and a sku is not a prefix of another', () => {
    expect(showsName('#2001', '#2001')).toBe(true)
    expect(showsName('Order #2001 (shipped)', '#2001')).toBe(true)
    expect(showsName('#20011', '#2001')).toBe(false)
    expect(showsName('#2001-R1', '#2001')).toBe(false)
    expect(showsName('X#2001', '#2001')).toBe(false)
    expect(showsName('MC-LOW-2', 'MC-LOW')).toBe(false)
    expect(showsName('wool socks (MC-LOW)', 'MC-LOW')).toBe(true)
    expect(showsName('Trail Rain Jacket', 'Trail Rain Jacket')).toBe(true)
    expect(showsName('anything (a+b)', 'a+b')).toBe(true)
    const late = byId('late-orders')
    const p = perfect(late)
    expect(grade(late, { ...p, items: [{ ...p.items[0]!, sources: ['#20011', '#2002', '#2003'] }] }).checks.sources).toBe(false)
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
  /** Rows for the first `g` graded, `c` clean and `o` outage cases of the set, each passing or not as given. */
  const rows = (graded: boolean[], clean: boolean[], outage: boolean[]) => [
    ...META.filter(m => m.group === 'graded').slice(0, graded.length).map((m, i) => ({ id: m.id, group: m.group, pass: graded[i]! })),
    ...META.filter(m => m.group === 'clean').slice(0, clean.length).map((m, i) => ({ id: m.id, group: m.group, pass: clean[i]! })),
    ...META.filter(m => m.group === 'outage').slice(0, outage.length).map((m, i) => ({ id: m.id, group: m.group, pass: outage[i]! })),
  ]
  const t = (n: number) => Array.from({ length: 12 }, (_, i) => i < n)
  const yes3 = [true, true, true]
  it('is 90% of graded: 12 of 12 passes, 11 of 12 is 92% and passes, 10 of 12 is 83% and fails', () => {
    expect(summarise(rows(t(12), yes3, yes3), META)).toMatchObject({ graded: { passed: 12, total: 12 }, partial: false, thresholdMet: true })
    expect(summarise(rows(t(11), yes3, yes3), META).thresholdMet).toBe(true)
    expect(summarise(rows(t(10), yes3, yes3), META).thresholdMet).toBe(false)
  })
  it('every clean and every outage case must pass', () => {
    expect(summarise(rows(t(12), [true, false, true], yes3), META).thresholdMet).toBe(false)
    expect(summarise(rows(t(12), yes3, [true, true, false]), META).thresholdMet).toBe(false)
  })
  it('a case that did not run is not a pass: a missing clean or outage case, and a missing graded case, fail the threshold', () => {
    expect(summarise(rows(t(12), yes3, [true, true]), META)).toMatchObject({ outageAllPass: false, partial: true, thresholdMet: false })
    expect(summarise(rows(t(12), [true, true], yes3), META)).toMatchObject({ cleanAllPass: false, partial: true, thresholdMet: false })
    // 11 graded cases run and all pass: 11 of the set's 12, but the run is partial, so never a pass.
    expect(summarise(rows(t(11), yes3, yes3).slice(0, 11).concat(rows([], yes3, yes3).slice(0, 6)), META)).toMatchObject({ graded: { passed: 11, total: 12 }, partial: true, thresholdMet: false })
  })
  it('an empty run is not a pass', () => expect(summarise([], META)).toMatchObject({ partial: true, thresholdMet: false }))
  test.prop([fc.array(fc.boolean(), { minLength: 12, maxLength: 12 })])('over the whole set, graded passes iff passed*10 >= 12*9', flags => {
    expect(summarise(rows(flags, yes3, yes3), META).thresholdMet).toBe(flags.filter(Boolean).length * 10 >= 12 * 9)
  })
})

describe('the runner', () => {
  const NOW = Date.parse('2026-11-22T12:00:00Z')
  /**
   * A fake stack: Run now makes a slot under the key it was given (as route 54 does), the slot ends after two polls, and
   * `answer` says what it ends with (the "model"). `never` cases never get a slot.
   */
  function fakeEnv(answer: (c: MorningCaseMeta) => { slot: Partial<SlotRow>; items: unknown[]; tools?: string[] } | 'never') {
    let now = NOW
    let current: MorningCaseMeta | null = null
    let keys = 0
    const made = new Map<string, { c: MorningCaseMeta; polls: number }>()
    const log: string[] = []
    const reader: Reader = {
      async slot(slotKey) {
        const m = made.get(slotKey)
        if (!m) return null
        m.polls++
        const a = answer(m.c)
        if (a === 'never') return null
        return { slot_key: slotKey, state: m.polls >= 3 ? 'ended' : 'started', failure: null, result_text: null, turn_id: `t-${slotKey}`, claimed_at_ms: NOW, ...a.slot }
      },
      async items(slotKey) {
        const m = made.get(slotKey)
        const a = m ? answer(m.c) : 'never'
        return a === 'never' ? [] : a.items.map(i => JSON.stringify(i))
      },
      async tools(turnId) {
        const m = [...made.entries()].find(([k]) => `t-${k}` === turnId)
        const a = m ? answer(m[1].c) : 'never'
        return (a === 'never' ? undefined : a.tools) ?? ['mcp__apps__orders_search']
      },
    }
    const env: RunnerEnv = {
      nowMs: () => now,
      async useShop(host) {
        current = META.find(c => hostOf(c.id) === host) ?? null
        log.push(`shop ${host}`)
      },
      newKey: () => `${String(++keys).padStart(32, '0')}`,
      async trigger(key) {
        expect(key).toMatch(/^[0-9a-f]{32}$|^0{20,}\d+$/)
        log.push(`trigger ${key}`)
        if (current && answer(current) !== 'never') made.set(`now|${ROUTINE_ID}|${key}`, { c: current, polls: 0 })
      },
      async nudge() { log.push('nudge') },
      async pause() { now += 1_000 },
      reader, caseTimeoutMs: 60_000, settleMs: 10_000,
    }
    return { env, log, made }
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
    expect(file.summary).toEqual({ graded: { passed: 12, total: 12 }, cleanAllPass: true, outageAllPass: true, partial: false, thresholdMet: true })
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

  it('two cases on the same day each get their own slot, found by their own key', async () => {
    const { env, made } = fakeEnv(perfectAnswer)
    const first = await runCase(env, byId('late-orders'))
    const second = await runCase(env, byId('clean-empty'))
    expect(first.slotKey).not.toBe(second.slotKey)
    expect([...made.keys()]).toEqual([first.slotKey, second.slotKey])
    expect(first.slotKey).toMatch(/^now\|routine-morning-check\|/)
    expect([first.verdict.pass, second.verdict.pass]).toEqual([true, true])
    // The second case reads its own slot, not the first's: its items are none.
    expect(second.observed).toMatchObject({ ok: true, items: [] })
  })

  it('a refused Run now (an earlier slot still open) fails that case with the text and the run goes on', async () => {
    const { env } = fakeEnv(perfectAnswer)
    const real = env.trigger
    let n = 0
    env.trigger = async k => { if (++n === 1) throw new Error('POST run answered 409: run_open'); return real(k) }
    const file = await runAll(env, META.slice(0, 2), { date: '2026-11-22', sha: 'abc1234', model: 'fake' })
    expect(file.cases[0]).toMatchObject({ verdict: { pass: false }, observed: { ok: false, cause: 'trigger: POST run answered 409: run_open' } })
    expect(file.cases[1]!.verdict.pass).toBe(true)
  })

  it('a shop that can\'t be switched or confirmed refuses that case without a Run now, and the run goes on', async () => {
    const { env, log } = fakeEnv(perfectAnswer)
    const real = env.useShop
    let n = 0
    env.useShop = async h => { if (++n === 1) throw new Error('the build showing SHOPIFY_SHOP example-mc-late-orders: not within 120 s'); return real(h) }
    const file = await runAll(env, META.slice(0, 2), { date: '2026-11-22', sha: 'abc1234', model: 'fake' })
    expect(file.cases[0]).toMatchObject({ verdict: { pass: false }, slotKey: null, observed: { ok: false, cause: expect.stringMatching(/^shop: the build showing SHOPIFY_SHOP/) } })
    expect(file.cases[1]!.verdict.pass).toBe(true)
    expect(log.filter(l => l.startsWith('trigger'))).toHaveLength(1)
  })

  it('after a timeout it waits, with a deadline, for the case\'s slot to settle before the next Run now; if it does, the cascade is not recorded', async () => {
    const { env } = fakeEnv(() => ({ slot: {}, items: [] }))
    let polls = 0
    env.reader.slot = async key => ({ slot_key: key, state: ++polls > 8 ? 'lost' : 'started', failure: null, result_text: null, turn_id: null, claimed_at_ms: 1 })
    const r = await runCase({ ...env, caseTimeoutMs: 3_000, settleMs: 20_000 }, byId('late-orders'))
    expect(r.observed).toMatchObject({ cause: 'timed_out' })
    expect(r.settled).toBe(true)
  })

  it('stops the run when a timed-out case\'s slot does not settle: the rest are not run, the file says why and is partial', async () => {
    const { env } = fakeEnv(() => ({ slot: {}, items: [] }))
    env.reader.slot = async key => ({ slot_key: key, state: 'started', failure: null, result_text: null, turn_id: null, claimed_at_ms: 1 })
    const writes: ResultFile[] = []
    const some = META.slice(0, 4)
    const file = await runAll({ ...env, caseTimeoutMs: 3_000, settleMs: 4_000 }, some, { date: '2026-11-22', sha: 'abc1234', model: 'fake' }, f => writes.push(f))
    expect(file.cases.map(c => c.id)).toEqual([some[0]!.id])
    expect(file.notRun).toEqual(some.slice(1).map(c => c.id))
    expect(file.stopped).toMatchObject({ at: some[0]!.id })
    expect(file.stopped!.reason).toMatch(/still open: every later Run now would answer run_open/)
    expect(file.summary).toMatchObject({ partial: true, thresholdMet: false })
    expect(writes).toHaveLength(1)
  })

  it('goes on when nothing is left open, and lists nothing as not run', async () => {
    const { env } = fakeEnv(perfectAnswer)
    const file = await runAll(env, META.slice(0, 2), { date: '2026-11-22', sha: 'abc1234', model: 'fake' })
    expect(file.notRun).toEqual([])
    expect(file.stopped).toBeUndefined()
  })

  it('gives up on a slot that never appears, at the deadline, without a sleep', async () => {
    const { env } = fakeEnv(() => 'never')
    const r = await runCase(env, byId('late-orders'))
    expect(r.observed).toMatchObject({ ok: false, cause: 'no_slot' })
    expect(r.verdict.pass).toBe(false)
    expect(r.ms).toBeGreaterThanOrEqual(60_000)
  })

  it('names a slot that started but never ended as timed_out', async () => {
    const { env } = fakeEnv(() => ({ slot: { state: 'started' }, items: [] }))
    env.reader.slot = async key => ({ slot_key: key, state: 'started', failure: null, result_text: null, turn_id: null, claimed_at_ms: 1 })
    expect((await runCase({ ...env, caseTimeoutMs: 5_000 }, byId('late-orders'))).observed).toMatchObject({ cause: 'timed_out' })
  })

  it('writes the file after each case, so a crash keeps the finished ones; a run of some cases is partial and never a pass', async () => {
    const { env } = fakeEnv(perfectAnswer)
    const writes: { cases: number; partial: boolean; met: boolean }[] = []
    const some = META.slice(0, 3)
    const file = await runAll(env, some, { date: '2026-11-22', sha: 'abc1234', model: 'fake' }, f => writes.push({ cases: f.cases.length, partial: f.summary.partial, met: f.summary.thresholdMet }))
    expect(writes).toEqual([{ cases: 1, partial: true, met: false }, { cases: 2, partial: true, met: false }, { cases: 3, partial: true, met: false }])
    expect(file.summary).toMatchObject({ partial: true, thresholdMet: false })
    // A crash at the third case: the first two were already written.
    const crashing = fakeEnv(perfectAnswer)
    let n = 0
    const seen: number[] = []
    crashing.env.newKey = () => { if (++n === 3) throw new Error('the runner crashed'); return `${'0'.repeat(31)}${n}` }
    await expect(runAll(crashing.env, some, { date: '2026-11-22', sha: 'abc1234', model: 'fake' }, f => seen.push(f.cases.length))).rejects.toThrow('the runner crashed')
    expect(seen).toEqual([1, 2])
  })

  it('observes a slot that was lost or missed as no valid result', async () => {
    const reader: Reader = { slot: async () => null, items: async () => [], tools: async () => [] }
    for (const state of ['lost', 'missed', 'refused', 'skipped']) {
      expect(await observe(reader, { slot_key: 's', state, failure: null, result_text: null, turn_id: null, claimed_at_ms: 1 })).toMatchObject({ ok: false, cause: `slot ${state}` })
    }
  })

  test.prop([fc.record({ truncated: fc.nat(50), dropped: fc.nat(50), deduped: fc.nat(50), overflow: fc.nat(50), costsRemoved: fc.nat(50) })])('parseFixed reads back what fixedWords wrote', c => {
    expect(parseFixed(`found 3 things; couldn't read refunds${fixedWords(c)}`)).toEqual(c)
    expect(parseFixed(null)).toEqual(NONE)
  })
})

describe('the result file', () => {
  it('names the file by date and sha and never overwrites one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-results-'))
    const file = { date: '2026-11-22', sha: 'abc1234', model: 'm', summary: summarise([], META), cases: [], notRun: [] }
    const first = writeResults(dir, file)
    const second = writeResults(dir, { ...file, model: 'second' })
    expect([first.endsWith('2026-11-22-abc1234.json'), second.endsWith('2026-11-22-abc1234-2.json')]).toEqual([true, true])
    expect(JSON.parse(readFileSync(first, 'utf8')).model).toBe('m')
    expect(resultPath(dir, '2026-11-22', 'abc1234', p => p.endsWith('abc1234.json'))).toMatch(/abc1234-2\.json$/)
  })
  it('a run\'s file is created once and rewritten after each case, never over another run\'s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-open-'))
    const base = { date: '2026-11-22', sha: 'abc1234', model: 'm', summary: summarise([], META), cases: [], notRun: [] }
    const other = writeResults(dir, base)
    const mine = openResults(dir, '2026-11-22', 'abc1234')
    expect(mine.path).not.toBe(other)
    mine.write({ ...base, model: 'one' })
    mine.write({ ...base, model: 'two' })
    expect(JSON.parse(readFileSync(mine.path, 'utf8')).model).toBe('two')
    expect(JSON.parse(readFileSync(other, 'utf8')).model).toBe('m')
  })
  it('never overwrites a file another run made at the same path, even one made after the path was chosen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-wx-'))
    const base = { date: '2026-11-22', sha: 'abc1234', model: 'mine', summary: summarise([], META), cases: [], notRun: [] }
    const mine = openResults(dir, '2026-11-22', 'abc1234')
    writeFileSync(mine.path, 'another run\n')
    expect(() => mine.write(base)).toThrow(/EEXIST/)
    expect(readFileSync(mine.path, 'utf8')).toBe('another run\n')
  })
  it('refuses a malformed date or sha', () => {
    expect(() => resultPath('d', '22-11-2026', 'abc1234')).toThrow()
    expect(() => resultPath('d', '2026-11-22', '../x')).toThrow()
  })
})
