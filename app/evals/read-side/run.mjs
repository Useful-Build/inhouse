#!/usr/bin/env node
// The read-side set's command line: one dispatch is one model, one report.
//
//   node evals/read-side/run.mjs --target fake|product --model <api id> --out <dir> [--page-origin <https origin>] [--paid --budget <usd>]
//     [--agent honest|obedient] [--cases RS-SF1,RS-LW1] [--sha <git sha>]
//
// Effort is pinned to medium for every model: --effort is accepted only as `medium`, and the report records it. The product target
// refuses without --paid and --budget (the dispatch's approved max_usd, at most READ_SIDE_CAP_USD), prints its estimate first
// (as evals/run.ts), and never retries a case. --page-origin has no default. Results go to
// `<out>/<date>-<sha>-read-side-<model>/{report.json,report.md}` and are never deleted or overwritten.
// Exit: 0 every required cell ran and passed with zero bypasses; 1 a graded case failed, or required cells did not run (listed
// apart, never counted as passed); 2 invalid invocation, a budget or cap stop, or an infrastructure error.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { estimateUsd } from '../runner.ts'
import { Refused, parseReadSideArgs } from './args.ts'
import { createFakeReadSideTarget } from './fake-target.ts'
import { buildReport, toMarkdown } from './report.ts'
import { runReadSide } from './runner.ts'

const { values } = parseArgs({
  options: {
    target: { type: 'string' }, model: { type: 'string' }, out: { type: 'string' }, 'page-origin': { type: 'string' }, paid: { type: 'boolean' },
    budget: { type: 'string' }, agent: { type: 'string' }, cases: { type: 'string' }, sha: { type: 'string' }, effort: { type: 'string' },
  },
})
const die = (msg) => {
  console.error(msg)
  process.exit(2)
}

let args
try {
  args = parseReadSideArgs(values)
} catch (e) {
  if (e instanceof Refused) die(`refused: ${e.message}`)
  throw e
}
const sha = args.sha ?? spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
if (!/^[0-9a-f]{7,40}$/.test(sha)) die('refused: no git sha (pass --sha)')
const date = new Date().toISOString().slice(0, 10)
const label = args.target === 'fake' ? `fake-${args.agent}` : args.model
const dir = path.resolve(args.out, `${date}-${sha}-read-side-${label}`)
if (existsSync(dir)) die(`refused: ${dir} exists. Results are never deleted or overwritten`)

console.log(`target ${args.target}, model ${args.model}, effort medium: ${args.cases.length} cases x 1 run, estimate $${args.target === 'product' ? estimateUsd(args.cases, 1).toFixed(2) : '0.00'}${args.budgetUsd !== null ? `, budget $${args.budgetUsd}` : ''}`)
if (args.target === 'product') {
  // The product evidence path (planting in the store fixtures, Slack and pages, the rows and files the run made, the run's
  // transcript) needs the eval deployment and is not built yet: refuse rather than report a run that observed nothing.
  die('refused: the product target\'s evidence reader is not wired in this build, so no case could be graded. Use --target fake for the dry run')
}

let result
const target = createFakeReadSideTarget(args.agent)
try {
  result = await runReadSide({ target, cases: args.cases, budgetUsd: args.budgetUsd })
} finally {
  await target.close?.()
}
const report = buildReport(
  { date, sha, target: args.target, agent: args.agent, model: args.model, pageOrigin: args.pageOrigin, approvedCapUsd: args.budgetUsd, partial: args.partial },
  args.cases, result,
)
mkdirSync(args.out, { recursive: true })
mkdirSync(dir)
writeFileSync(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
writeFileSync(path.join(dir, 'report.md'), `${toMarkdown(report)}\n`)
console.log(`${report.overall}: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.notRun} not run of ${report.summary.cases}. Report: ${dir}`)
process.exit(report.exitCode)
