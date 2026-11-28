// Eval CLI. Usage (from app/):
//   node evals/run.ts --target fake|fixture|product --out <dir> [--cases R01,T02|all] [--reps 3] [--concurrency 4]
//     [--model claude-sonnet-5-5] [--effort medium] [--budget <usd>] [--paid] [--topic <title>]
// The product target refuses without --paid and --budget. A failed chat is recorded as runOk: false, never retried.
import path from 'node:path'
import { parseArgs } from 'node:util'
import { CASES } from './cases.ts'
import { giveBackOnSignals } from './run-cancel.ts'
import { buildReport } from './report.ts'
import { estimateUsd, runEvals } from './runner.ts'
import { createFakeTarget } from './targets/fake.ts'
import { createFixtureTarget } from './targets/fixture.ts'
import { createProductTarget } from './targets/product.ts'
import { openSchemaTools } from './served-schema.ts'
import { rawWriter, writeResults } from './write.ts'
import type { Target } from './types.ts'

const { values: v } = parseArgs({
  options: {
    target: { type: 'string' }, out: { type: 'string' }, cases: { type: 'string', default: 'all' }, reps: { type: 'string', default: '3' },
    concurrency: { type: 'string', default: '4' }, model: { type: 'string', default: 'claude-sonnet-5-5' }, effort: { type: 'string', default: 'medium' },
    budget: { type: 'string' }, 'max-usd': { type: 'string' }, paid: { type: 'boolean', default: false }, topic: { type: 'string' },
  },
})

const fail = (msg: string): never => {
  console.error(msg)
  process.exit(2)
}

const targetName = v.target
if (targetName !== 'fake' && targetName !== 'fixture' && targetName !== 'product') fail('--target must be fake, fixture or product')
if (!v.out) fail('--out <dir> is required')
const budgetRaw = v.budget ?? v['max-usd']
const budgetUsd = budgetRaw === undefined ? undefined : Number(budgetRaw)
if (budgetUsd !== undefined && !(budgetUsd >= 0)) fail('--budget must be a number')

let target: Target
try {
  target = targetName === 'fake' ? createFakeTarget() : targetName === 'fixture' ? createFixtureTarget() : createProductTarget({ paid: v.paid, budgetUsd, env: process.env, model: v.model, openSchema: await openSchemaTools() })
} catch (e) {
  fail(`refused: ${e instanceof Error ? e.message : String(e)}`)
  throw e
}

const wanted = v.cases === 'all' ? null : new Set(v.cases!.split(','))
const cases = wanted ? CASES.filter((c) => wanted.has(c.id)) : CASES
if (wanted && cases.length !== wanted.size) fail(`unknown case in --cases: ${[...wanted].filter((id) => !CASES.some((c) => c.id === id)).join(',')}`)
const reps = Number(v.reps)
const out = path.resolve(v.out!)

const estimate = estimateUsd(cases, reps)
console.log(`target ${target.name}: ${cases.length} cases x ${reps} reps, estimate $${targetName === 'product' ? estimate.toFixed(2) : '0.00'}${budgetUsd !== undefined ? `, budget $${budgetUsd}` : ''}`)

// What the target holds on the deployment (the product target's eval lease) is given back on exit, and on SIGINT or SIGTERM
// before exiting 130 or 143; a give-back that fails is printed and fails the run.
const close = async (): Promise<boolean> => {
  try {
    await target.close?.()
    return true
  } catch (e) {
    console.error(`the target could not give back what it holds (the eval lease): ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}
giveBackOnSignals(close)
let result: Awaited<ReturnType<typeof runEvals>>
try {
  result = await runEvals({
    target, cases, reps, concurrency: Number(v.concurrency), budgetUsd,
    // Kept forever in a public repo: every target's files are reduced for disk (redact.ts, p3-eval-observability rev 2 rec 6).
    onChat: rawWriter(out),
  })
} finally {
  if (!(await close())) process.exitCode = 1
}

const report = buildReport(CASES, result.rows, { target: target.name, model: v.model!, effort: v.effort!, reps, notRun: result.notRun, notGraded: result.notGraded })
writeResults(out, result, report, v.topic ?? path.basename(out))
console.log(`${report.summary.all!.pass}/${report.summary.all!.runs} case-repeats pass, ${report.exfiltration.bypasses.length} exfiltration bypasses, ${result.notRun.length} cases not run, ${result.notGraded.length} not graded, cost $${report.totalCostUsd.toFixed(4)}${result.harnessStop ? ` (STOPPED: a harness failure at ${result.harnessStop.caseId} r${result.harnessStop.rep}, ${result.harnessStop.stage}: ${result.harnessStop.detail})` : result.stoppedByBudget ? ' (stopped at the budget)' : ''}${result.costUnknown ? ' (STOPPED: a chat\'s cost could not be read)' : ''}`)
