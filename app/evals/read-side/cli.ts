// The read-side command line, as a function that never throws: every way out is an exit code (2 for anything wrong with the
// invocation, the checkout, the disk or the target). run.mjs only calls it.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { estimateUsd } from '../runner.ts'
import { Refused, parseReadSideArgs } from './args.ts'
import { createFakeReadSideTarget } from './fake-target.ts'
import { buildReport, toMarkdown } from './report.ts'
import { runReadSide } from './runner.ts'

export interface Deps {
  log: (m: string) => void
  err: (m: string) => void
  now: () => Date
  random: () => string
  /** `git <args>` in the checkout; throws when it fails. */
  git: (args: string[]) => string
}

const defaults: Deps = {
  log: m => console.log(m),
  err: m => console.error(m),
  now: () => new Date(),
  random: () => randomBytes(3).toString('hex'),
  git: (args) => {
    const r = spawnSync('git', args, { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed`)
    return r.stdout.trim()
  },
}

export const REFUSED_PRODUCT = 'the product target\'s evidence reader is not wired in this build, so no case could be graded. Use --target fake for the dry run'

export async function main(argv: string[], over: Partial<Deps> = {}): Promise<number> {
  const d = { ...defaults, ...over }
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        target: { type: 'string' }, model: { type: 'string' }, out: { type: 'string' }, 'page-origin': { type: 'string' }, paid: { type: 'boolean' },
        budget: { type: 'string' }, agent: { type: 'string' }, cases: { type: 'string' }, sha: { type: 'string' }, effort: { type: 'string' },
      },
    })
    const args = parseReadSideArgs(values)
    const head = d.git(['rev-parse', '--short', 'HEAD'])
    if (args.target === 'product' && args.sha !== null && args.sha !== head) throw new Refused(`--sha ${args.sha} is not this checkout's HEAD (${head}): a product result is recorded against the code it ran`)
    const sha = args.sha ?? head
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Refused('no git sha (pass --sha)')
    const dirty = d.git(['status', '--porcelain']).trim() !== ''
    const now = d.now()
    const date = now.toISOString().slice(0, 10)
    const label = args.target === 'fake' ? `fake-${args.agent}` : args.model
    const runId = `${now.toISOString().slice(11, 19).replace(/:/g, '')}-${d.random()}`
    const dir = path.resolve(args.out, `${date}-${sha}-read-side-${label}-${runId}`)

    d.log(`target ${args.target}, model ${args.model}, effort medium: ${args.cases.length} cases x 1 run, estimate $${args.target === 'product' ? estimateUsd([...args.cases], 1).toFixed(2) : '0.00'}${args.budgetUsd !== null ? `, budget $${args.budgetUsd}` : ''}`)
    if (args.target === 'product') {
      // Never a fall-through to the fake: the product path's evidence (planting, rows, files, the run's transcript) needs the eval deployment.
      throw new Refused(REFUSED_PRODUCT)
    }
    const target = createFakeReadSideTarget(args.agent)
    // Never deleted or overwritten: mkdir fails if the directory exists. Each case is appended as the run goes.
    mkdirSync(args.out, { recursive: true })
    mkdirSync(dir)
    const jsonl = path.join(dir, 'cases.jsonl')
    writeFileSync(jsonl, '', { flag: 'wx' })
    let result
    try {
      result = await runReadSide({ target, cases: args.cases, budgetUsd: args.budgetUsd, onCase: e => appendFileSync(jsonl, `${JSON.stringify(e)}\n`) })
    } finally {
      await target.close?.()
    }
    const report = buildReport(
      { date, sha, target: args.target, ...(args.target === 'fake' ? { agent: args.agent } : {}), model: args.model, pageOrigin: args.pageOrigin, approvedCapUsd: args.budgetUsd, partial: args.partial, dirty },
      args.cases, result,
    )
    // The report is written beside its final name and renamed into place, so a reader never sees half of it.
    for (const [name, text] of [['report.json', `${JSON.stringify(report, null, 2)}\n`], ['report.md', `${toMarkdown(report)}\n`]] as const) {
      const tmp = path.join(dir, `.${name}.tmp`)
      writeFileSync(tmp, text, { flag: 'wx' })
      renameSync(tmp, path.join(dir, name))
    }
    d.log(`${report.overall}: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.notRun} not run of ${report.summary.cases}. Report: ${dir}`)
    return report.exitCode
  } catch (e) {
    d.err(`${e instanceof Refused ? 'refused' : 'error'}: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
}
