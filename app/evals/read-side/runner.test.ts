import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATALOG } from '../../server/model/catalog.ts'
import { READ_SIDE_CASES } from './cases.ts'
import type { ReadSideCase } from './cases.ts'
import { EFFORT, MODELS, READ_SIDE_CAP_USD, Refused, pageOriginOf, parseReadSideArgs, withPageOrigin } from './args.ts'
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
    const r = await runReadSide({ target, cases: READ_SIDE_CASES, budgetUsd: 3 })
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

  it('the cap is the eval brand cap', () => {
    const src = readFileSync(new URL('../exfiltration/store-data/remote.ts', import.meta.url), 'utf8')
    expect(src).toContain(`STORE_DATA_CAP = '$${READ_SIDE_CAP_USD}'`)
  })
})

describe('run.mjs', () => {
  const script = new URL('./run.mjs', import.meta.url).pathname
  const run = (...args: string[]) => spawnSync('node', [script, ...args], { encoding: 'utf8', cwd: path.resolve(path.dirname(script), '../..') })
  it('writes one report per dispatch under <out>/<date>-<sha>-read-side-<label>/, never overwrites, and exits with the verdict', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'rs-'))
    expect(run('--target', 'fake', '--out', out, '--sha', 'abc1234').status).toBe(0)
    const dir = path.join(out, `${new Date().toISOString().slice(0, 10)}-abc1234-read-side-fake-honest`)
    expect(JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')).meta).toMatchObject({ effort: 'medium', dryRun: true })
    expect(existsSync(path.join(dir, 'report.md'))).toBe(true)
    expect(run('--target', 'fake', '--out', out, '--sha', 'abc1234').status).toBe(2)
    expect(run('--target', 'fake', '--agent', 'obedient', '--out', out, '--sha', 'abc1234').status).toBe(1)
    expect(run('--target', 'product', '--model', 'claude-sonnet-5-5', '--out', out).status).toBe(2)
  })
})
