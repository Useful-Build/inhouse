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
import type { ReadSideTarget } from './runner.ts'
import { wireEval, type Wired } from './product/setup.ts'

export interface Deps {
  log: (m: string) => void
  err: (m: string) => void
  now: () => Date
  random: () => string
  /** `git <args>` in the checkout; throws when it fails. */
  git: (args: string[]) => string
  /** Writes a file; `flag` 'wx' refuses to overwrite. */
  writeFile: (path: string, text: string, flag?: string) => void
  env: Record<string, string | undefined>
  /** Wires the product target to the eval deployment, its preflight and the effort pin included (product/setup.ts). */
  wire: typeof wireEval
  /** Registers the stop handlers: on SIGINT or SIGTERM `stop` gives everything back, then the process exits 130 or 143. */
  onSignals: (stop: () => Promise<void>) => void
}

const defaults: Deps = {
  writeFile: (p, text, flag) => writeFileSync(p, text, flag ? { flag } : undefined),
  log: m => console.log(m),
  err: m => console.error(m),
  now: () => new Date(),
  random: () => randomBytes(3).toString('hex'),
  git: (args) => {
    const r = spawnSync('git', args, { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed`)
    return r.stdout.trim()
  },
  env: process.env,
  wire: wireEval,
  onSignals: (stop) => {
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
      process.once(signal, () => {
        console.error(`read-side: ${signal}: giving back the routines' deletes, the effort, the shop override and the eval lease before exiting`)
        void stop().finally(() => process.exit(code))
      })
    }
  },
}

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
    // git is called only when needed: on the product target (the sha must be HEAD, and the checkout's state is recorded) or when
    // there is no --sha. A fake dry run with --sha works outside a checkout; its `dirty` is then unknown (null).
    const head = args.target === 'product' || args.sha === null ? d.git(['rev-parse', '--short', 'HEAD']) : null
    if (args.target === 'product' && args.sha !== null && args.sha !== head) throw new Refused(`--sha ${args.sha} is not this checkout's HEAD (${head}): a product result is recorded against the code it ran`)
    const sha = args.sha ?? head!
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Refused('no git sha (pass --sha)')
    const dirty = head === null ? null : d.git(['status', '--porcelain']).trim() !== ''
    const now = d.now()
    const date = now.toISOString().slice(0, 10)
    const label = args.target === 'fake' ? `fake-${args.agent}` : args.model
    const runId = `${now.toISOString().slice(11, 19).replace(/:/g, '')}-${d.random()}`
    const dir = path.resolve(args.out, `${date}-${sha}-read-side-${label}-${runId}`)

    d.log(`target ${args.target}, model ${args.model}, effort medium: ${args.cases.length} cases x 1 run, estimate $${args.target === 'product' ? estimateUsd(args.cases.filter(c => c.pending === undefined), 1).toFixed(2) : '0.00'}${args.budgetUsd !== null ? `, budget $${args.budgetUsd}` : ''}`)
    // The product target's preflight runs here, before the results directory exists and before any spend: a refusal is exit 2.
    let wired: Wired | null = null
    let target: ReadSideTarget
    if (args.target === 'product') {
      const w = await d.wire({ env: d.env, model: args.model, budgetUsd: args.budgetUsd!, cases: args.cases, pageOrigin: args.pageOrigin, note: d.log })
      wired = w
      d.onSignals(async () => { for (const e of await w.close()) d.err(`read-side: ${e}`) })
      target = w.target
    } else {
      target = createFakeReadSideTarget(args.agent)
    }
    // Never deleted or overwritten: mkdir fails if the directory exists. Each case is appended as the run goes.
    mkdirSync(args.out, { recursive: true })
    mkdirSync(dir)
    const jsonl = path.join(dir, 'cases.jsonl')
    d.writeFile(jsonl, '', 'wx')
    let result
    try {
      result = await runReadSide({ target, cases: args.cases, budgetUsd: args.budgetUsd, onCase: e => appendFileSync(jsonl, `${JSON.stringify(e)}\n`) })
    } finally {
      await target.close?.()
      const left = wired ? await wired.close() : []
      for (const e of left) d.err(`read-side: ${e}`)
      if (left.length > 0) d.err('read-side: the run did not give everything back (above): clear it through the door before the next run')
    }
    const report = buildReport(
      { date, sha, target: args.target, ...(args.target === 'fake' ? { agent: args.agent } : {}), ...(wired ? { teamRequests: wired.teamRequests } : {}), model: args.model, pageOrigin: args.pageOrigin, approvedCapUsd: args.budgetUsd, partial: args.partial, dirty },
      args.cases, result,
    )
    // Both files are written beside their final names, then both renamed into place: a failed write leaves no report in the dir.
    const files = [['report.json', `${JSON.stringify(report, null, 2)}\n`], ['report.md', `${toMarkdown(report)}\n`]] as const
    for (const [name, text] of files) d.writeFile(path.join(dir, `.${name}.tmp`), text, 'wx')
    for (const [name] of files) renameSync(path.join(dir, `.${name}.tmp`), path.join(dir, name))
    d.log(`${report.overall}: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.notRun} not run of ${report.summary.cases}. Report: ${dir}`)
    return report.exitCode
  } catch (e) {
    d.err(`${e instanceof Refused ? 'refused' : 'error'}: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
}
