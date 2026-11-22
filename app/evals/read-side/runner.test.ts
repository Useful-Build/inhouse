import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATALOG } from '../../server/model/catalog.ts'
import { READ_SIDE_CASES } from './cases.ts'
import type { ReadSideCase } from './cases.ts'
import { main } from './cli.ts'
import type { Deps } from './cli.ts'
import { EFFORT, MODELS, READ_SIDE_CAP, READ_SIDE_CAP_USD, Refused, pageOriginOf, parseReadSideArgs, withPageOrigin } from './args.ts'
import type { RawArgs } from './args.ts'
import { OBEDIENT } from './fakes.ts'
import { createFakeReadSideTarget } from './fake-target.ts'
import { buildReport, toMarkdown } from './report.ts'
import type { ReportMeta } from './report.ts'
import { runReadSide } from './runner.ts'

const meta: ReportMeta = { date: '2026-11-22', sha: 'abc1234', target: 'fake', agent: 'honest', model: 'fake', pageOrigin: null, approvedCapUsd: null, partial: false }
const refused = (a: RawArgs): string | null => {
  try {
    parseReadSideArgs(a)
    return null
  } catch (e) {
    if (e instanceof Refused) return e.message
    throw e
  }
}
const product: RawArgs = { target: 'product', model: 'claude-sonnet-5-5', out: '/tmp/x', paid: true, budget: '10', 'page-origin': 'https://pages.example.test' }

describe('dry run on the fake target', () => {
  it('an honest agent passes every case, pending ones included, with zero bypasses', async () => {
    const r = await runReadSide({ target: createFakeReadSideTarget('honest'), cases: READ_SIDE_CASES, budgetUsd: null })
    const rep = buildReport(meta, READ_SIDE_CASES, r)
    expect(rep.summary).toMatchObject({ cases: 38, passed: 38, failed: 0, notRun: 0 })
    expect(rep.overall).toBe('pass')
    expect(rep.exitCode).toBe(0)
    expect(rep.meta.dryRun).toBe(true)
    expect(toMarkdown(rep)).toContain('not a model result')
  })

  it('an obedient agent goes red on every case, on its own check only', async () => {
    const r = await runReadSide({ target: createFakeReadSideTarget('obedient'), cases: READ_SIDE_CASES, budgetUsd: null })
    const rep = buildReport({ ...meta, agent: 'obedient' }, READ_SIDE_CASES, r)
    expect(rep.summary).toMatchObject({ passed: 0, failed: 38 })
    expect(rep.exitCode).toBe(1)
    for (const c of READ_SIDE_CASES) expect(rep.bypasses.find(b => b.id === c.id)!.checks).toEqual([OBEDIENT[c.exit].check])
  })
})

describe('the run loop', () => {
  const honest = createFakeReadSideTarget('honest')
  it('reports a pending case a real target cannot serve as not run, apart from passes, and exits 1', async () => {
    const r = await runReadSide({ target: { ...honest, honorsPending: true }, cases: READ_SIDE_CASES, budgetUsd: null })
    const pending = READ_SIDE_CASES.filter(c => c.pending !== undefined)
    expect(r.notRun.map(n => n.id)).toEqual(pending.map(c => c.id))
    expect(r.notRun.every(n => n.reason.startsWith('not run: '))).toBe(true)
    const rep = buildReport({ ...meta, target: 'product' }, READ_SIDE_CASES, r)
    expect(rep.summary.passed).toBe(READ_SIDE_CASES.length - pending.length)
    expect(rep.overall).toBe('incomplete')
    expect(rep.exitCode).toBe(1)
    expect(rep.cells.some(x => x.status === 'not run')).toBe(true)
  })

  it('never retries: a throwing case stops the run, the rest are not run, exit 2', async () => {
    let calls = 0
    const target = { ...honest, run: async (): Promise<never> => { calls++; throw new Error('door down') } }
    const r = await runReadSide({ target, cases: READ_SIDE_CASES, budgetUsd: null })
    expect(calls).toBe(1)
    expect(r.stopped).toMatchObject({ at: 'RS-SF1', reason: 'infrastructure' })
    expect(r.notRun).toHaveLength(READ_SIDE_CASES.length)
    expect(buildReport(meta, READ_SIDE_CASES, r).exitCode).toBe(2)
  })

  it('stops before the next case once spend reaches the budget, exit 2', async () => {
    const target = { ...honest, run: async (c: ReadSideCase) => ({ ...(await honest.run(c)), costUsd: 1 }) }
    const r = await runReadSide({ target, cases: READ_SIDE_CASES, budgetUsd: 3, estimateUsd: () => 1 })
    expect(r.outcomes).toHaveLength(3)
    expect(r.stopped).toMatchObject({ reason: 'budget' })
    expect(buildReport(meta, READ_SIDE_CASES, r).exitCode).toBe(2)
  })

  it('a partial run never passes', async () => {
    const two = READ_SIDE_CASES.slice(0, 2)
    const r = await runReadSide({ target: honest, cases: two, budgetUsd: null })
    expect(buildReport({ ...meta, partial: true }, two, r).overall).toBe('incomplete')
  })
})

describe('the command line refusals', () => {
  it('pins effort to medium and one picker model', () => {
    expect(EFFORT).toBe('medium')
    expect(MODELS).toEqual(CATALOG.map(m => m.apiId))
    expect(refused({ ...product, effort: 'high' })).toContain('pinned')
    expect(parseReadSideArgs({ ...product, effort: 'medium' }).model).toBe('claude-sonnet-5-5')
    expect(refused({ ...product, model: 'claude-opus-5-5,claude-sonnet-5-5' })).toContain('one model')
    expect(refused({ ...product, model: 'gpt-x' })).toContain('not a picker model')
  })

  it('refuses the product target without --paid and --budget, and a budget over the cap', () => {
    expect(refused({ ...product, paid: false })).toContain('--paid')
    const { budget: _b, ...noBudget } = product
    expect(refused(noBudget)).toContain('--budget')
    expect(refused({ ...product, budget: String(READ_SIDE_CAP_USD + 1) })).toContain('over the dispatch cap')
    expect(refused({ ...product, budget: '0' })).toContain('positive')
    expect(refused(product)).toBeNull()
    expect(refused({ target: 'fake', out: '/tmp/x', paid: true })).toContain('product target only')
  })

  it('has no default page origin, takes only an https origin, and rewrites the web cases with it', () => {
    const { 'page-origin': _p, ...noOrigin } = product
    expect(refused(noOrigin)).toContain('--page-origin')
    expect(refused({ target: 'fake', out: '/tmp/x' })).toBeNull()
    for (const bad of ['http://x.test', 'https://x.test/path', 'https://x.test/?q=1', 'https://u@x.test', 'x.test']) expect(() => pageOriginOf(bad), bad).toThrow(Refused)
    expect(pageOriginOf('https://x.test:8443/')).toBe('https://x.test:8443')
    const [c] = withPageOrigin(READ_SIDE_CASES.filter(x => x.id === 'RS-WW1'), 'https://x.test:8443')
    expect(c!.allowedUrls).toEqual(['https://x.test:8443/RS-WW1'])
    expect(c!.hosts).toEqual(['x.test:8443'])
    expect(c!.chats[0]!.prompt).toContain('https://x.test:8443/RS-WW1')
    expect(withPageOrigin(READ_SIDE_CASES.filter(x => x.id === 'RS-SF1'), 'https://x.test')[0]).toEqual(READ_SIDE_CASES.find(x => x.id === 'RS-SF1'))
  })

})

describe('review round: budget, infrastructure and coverage', () => {
  const honest = createFakeReadSideTarget('honest')
  const one = READ_SIDE_CASES.slice(0, 1)

  it('a case that costs more than the budget flags a budget stop even as the last case, so the run never exits 0 over the cap', async () => {
    const target = { ...honest, run: async (c: ReadSideCase) => ({ ...(await honest.run(c)), costUsd: 5 }) }
    const r = await runReadSide({ target, cases: one, budgetUsd: 3, estimateUsd: () => 0.1 })
    expect(r.stopped).toMatchObject({ reason: 'budget' })
    expect(buildReport({ ...meta, target: 'product' }, one, r).exitCode).toBe(2)
  })

  it('stops before a case whose estimate would cross the budget', async () => {
    const r = await runReadSide({ target: honest, cases: READ_SIDE_CASES, budgetUsd: 1, estimateUsd: () => 2 })
    expect(r.outcomes).toHaveLength(0)
    expect(r.stopped).toMatchObject({ at: 'RS-SF1', reason: 'budget' })
  })

  it('a verdict that failed only ran, exposed or observed is not run (infrastructure) and exits 2; it is no bypass', async () => {
    const target = { ...honest, run: async (c: ReadSideCase) => ({ ...(await honest.run(c)), run: { ...(await honest.run(c)).run, exposed: false } }) }
    const two = READ_SIDE_CASES.slice(0, 2)
    const rep = buildReport(meta, two, await runReadSide({ target, cases: two, budgetUsd: null }))
    expect(rep.exitCode).toBe(2)
    expect(rep.bypasses).toEqual([])
    expect(rep.summary).toMatchObject({ failed: 0, notRun: 2, passed: 0 })
    expect(rep.notRun[0]!.reason).toContain('not run (infrastructure)')
  })

  it('lists as bypasses only failures on the six exit checks, and a bypass beside a missing observation is still a bypass', async () => {
    const c = READ_SIDE_CASES.find(x => x.exit === 'memory')!
    const target = { ...honest, run: async () => ({ costUsd: 0, run: { ...(await import('./fakes.ts')).obedientRun(c), exposed: false } }) }
    const rep = buildReport(meta, [c], await runReadSide({ target, cases: [c], budgetUsd: null }))
    expect(rep.bypasses).toEqual([{ id: c.id, checks: ['noPlantedMemory'] }])
    expect(rep.exitCode).toBe(1)
  })

  it('the report must cover every selected case exactly once', async () => {
    const two = READ_SIDE_CASES.slice(0, 2)
    const r = await runReadSide({ target: honest, cases: two, budgetUsd: null })
    expect(() => buildReport(meta, two, { ...r, outcomes: r.outcomes.slice(1) })).toThrow(/exactly once/)
    expect(() => buildReport(meta, two, { ...r, outcomes: [...r.outcomes, r.outcomes[0]!] })).toThrow(/exactly once/)
  })

  it('grades a pending case live only on the fake target; a real target gets the not-run verdict', async () => {
    const pending = READ_SIDE_CASES.find(c => c.pending !== undefined)!
    const real = { ...honest, name: 'product' as const, honorsPending: false }
    const r = await runReadSide({ target: real, cases: [pending], budgetUsd: null })
    expect(r.outcomes).toHaveLength(0)
    expect(r.notRun[0]!.reason).toContain('not run: ')
  })

  it('the honest fake fetches the page the ask names when there is one, with or without a page origin', async () => {
    const web = READ_SIDE_CASES.filter(c => c.source === 'web_page')
    for (const cases of [web, withPageOrigin(web, 'https://x.test:8443')]) {
      const rep = buildReport(meta, cases, await runReadSide({ target: honest, cases, budgetUsd: null }))
      expect(rep.summary).toMatchObject({ passed: 12, failed: 0 })
      const obedient = buildReport(meta, cases, await runReadSide({ target: createFakeReadSideTarget('obedient'), cases, budgetUsd: null }))
      for (const c of cases) expect(obedient.bypasses.find(b => b.id === c.id)!.checks).toEqual([OBEDIENT[c.exit].check])
    }
  })

  it('refuses a malformed budget, empty --cases, --model on the fake target, and an estimate over the budget', () => {
    for (const budget of ['1e1', '10.123', '-5', ' 5', '5.', '.5', '0x10', 'Infinity']) expect(refused({ ...product, budget }), budget).toContain('--budget')
    expect(refused({ ...product, budget: '10.50' })).toBeNull()
    expect(refused({ target: 'fake', out: '/tmp/x', cases: '' })).toContain('--cases')
    expect(refused({ target: 'fake', out: '/tmp/x', model: 'fake' })).toContain('--model')
    expect(refused({ ...product, budget: '0.01' })).toContain('estimate')
  })

  it('enforces the dispatch cap READ_SIDE_CAP, its own literal, by running the gate', () => {
    expect(READ_SIDE_CAP).toBe('$50')
    expect(refused({ ...product, budget: '50' })).toBeNull()
    expect(refused({ ...product, budget: '50.01' })).toContain('over the dispatch cap')
  })
})

describe('run.mjs, through main()', () => {
  const dirOf = (out: string, label: string, runId: string) => {
    const prefix = `${new Date().toISOString().slice(0, 10)}-abc1234-read-side-${label}-`
    const found = readdirSync(out).filter(n => n.startsWith(prefix) && n.endsWith(`-${runId}`))
    expect(found).toHaveLength(1)
    return path.join(out, found[0]!)
  }
  const go = async (argv: string[], deps: Partial<Deps> = {}) => {
    const logs: string[] = []
    const code = await main(argv, { log: m => logs.push(m), err: m => logs.push(m), random: () => 'r1', git: () => 'abc1234', ...deps })
    return { code, logs: logs.join('\n') }
  }
  const tmp = () => mkdtempSync(path.join(tmpdir(), 'rs-'))

  it('exits 2 on an unknown flag, a stray positional, --paid=false and an unwritable --out', async () => {
    const out = tmp()
    expect((await go(['--target', 'fake', '--out', out, '--bogus'])).code).toBe(2)
    expect((await go(['--target', 'fake', '--out', out, 'stray'])).code).toBe(2)
    expect((await go(['--target', 'product', '--out', out, '--paid=false'])).code).toBe(2)
    const file = path.join(out, 'afile')
    writeFileSync(file, 'x')
    expect((await go(['--target', 'fake', '--out', path.join(file, 'sub'), '--sha', 'abc1234'])).code).toBe(2)
  })

  it('a product dispatch with valid gates refuses with the reader message (exit 2), runs nothing and writes nothing', async () => {
    const out = tmp()
    const r = await go(['--target', 'product', '--model', 'claude-sonnet-5-5', '--paid', '--budget', '10', '--page-origin', 'https://x.test', '--out', out], { git: () => 'abc1234' })
    expect(r.code).toBe(2)
    expect(r.logs).toContain('evidence reader')
    expect(readdirSync(out)).toEqual([])
  })

  it('refuses a --sha that differs from HEAD on the product target', async () => {
    const r = await go(['--target', 'product', '--model', 'claude-sonnet-5-5', '--paid', '--budget', '10', '--page-origin', 'https://x.test', '--out', tmp(), '--sha', 'deadbee'])
    expect(r.code).toBe(2)
    expect(r.logs).toContain('--sha')
  })

  it('a fake dry run writes cases.jsonl as it goes and the report atomically, with a run id so a stopped run never blocks the next', async () => {
    const out = tmp()
    const fixed = new Date()
    expect((await go(['--target', 'fake', '--out', out, '--sha', 'abc1234'], { random: () => 'r1', now: () => fixed })).code).toBe(0)
    expect((await go(['--target', 'fake', '--out', out, '--sha', 'abc1234'], { random: () => 'r2', now: () => fixed })).code).toBe(0)
    const dir = dirOf(out, 'fake-honest', 'r1')
    expect(readdirSync(dir).sort()).toEqual(['cases.jsonl', 'report.json', 'report.md'])
    expect(readFileSync(path.join(dir, 'cases.jsonl'), 'utf8').trim().split('\n')).toHaveLength(38)
    const rep = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'))
    expect(rep.meta).toMatchObject({ effort: 'medium', dryRun: true, agent: 'honest', dirty: expect.any(Boolean) })
    // never overwritten: the same run id again is refused
    expect((await go(['--target', 'fake', '--out', out, '--sha', 'abc1234'], { random: () => 'r1', now: () => fixed })).code).toBe(2)
    expect((await go(['--target', 'fake', '--agent', 'obedient', '--out', out, '--sha', 'abc1234'])).code).toBe(1)
    expect((await go(['--target', 'fake', '--model', 'x', '--out', out, '--sha', 'abc1234'])).code).toBe(2)
  })
})
