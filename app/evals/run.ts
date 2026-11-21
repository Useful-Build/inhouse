// Eval CLI. Usage (from app/):
//   node evals/run.ts --target fake|fixture|product --out <dir> [--cases R01,T02|all] [--reps 3] [--concurrency 4]
//     [--model claude-sonnet-5-5] [--effort medium] [--budget <usd>] [--paid] [--topic <title>]
// The product target refuses without --paid and --budget. A failed chat is recorded as runOk: false, never retried.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { CASES } from './cases.ts'
import { buildReport, renderReadme } from './report.ts'
import { estimateUsd, runEvals } from './runner.ts'
import { createFakeTarget } from './targets/fake.ts'
import { createFixtureTarget } from './targets/fixture.ts'
import { createProductTarget } from './targets/product.ts'
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
  target = targetName === 'fake' ? createFakeTarget() : targetName === 'fixture' ? createFixtureTarget() : createProductTarget({ paid: v.paid, budgetUsd, env: process.env, model: v.model })
} catch (e) {
  fail(`refused: ${e instanceof Error ? e.message : String(e)}`)
  throw e
}

const wanted = v.cases === 'all' ? null : new Set(v.cases!.split(','))
const cases = wanted ? CASES.filter((c) => wanted.has(c.id)) : CASES
if (wanted && cases.length !== wanted.size) fail(`unknown case in --cases: ${[...wanted].filter((id) => !CASES.some((c) => c.id === id)).join(',')}`)
const reps = Number(v.reps)
const out = path.resolve(v.out!)
fs.mkdirSync(path.join(out, 'raw'), { recursive: true })

const estimate = estimateUsd(cases, reps)
console.log(`target ${target.name}: ${cases.length} cases x ${reps} reps, estimate $${targetName === 'product' ? estimate.toFixed(2) : '0.00'}${budgetUsd !== undefined ? `, budget $${budgetUsd}` : ''}`)

const result = await runEvals({
  target, cases, reps, concurrency: Number(v.concurrency), budgetUsd,
  onChat: (row, res) => {
    fs.writeFileSync(path.join(out, 'raw', `${row.caseId}-r${row.rep}-c${row.chat}.json`), JSON.stringify({ row, result: res }, null, 1))
  },
})

const report = buildReport(CASES, result.rows, { target: target.name, model: v.model!, effort: v.effort!, reps, notRun: result.notRun, notGraded: result.notGraded })
const full = { ...report, stoppedByBudget: result.stoppedByBudget, spentUsd: result.spentUsd, ...(result.capStop ? { capStop: result.capStop } : {}) }
fs.writeFileSync(path.join(out, 'graded.json'), JSON.stringify(result.rows, null, 1))
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(full, null, 1))
fs.writeFileSync(path.join(out, 'README.md'), renderReadme(report, v.topic ?? path.basename(out)))
console.log(`${report.summary.all!.pass}/${report.summary.all!.runs} case-repeats pass, ${report.exfiltration.bypasses.length} exfiltration bypasses, ${result.notRun.length} cases not run, ${result.notGraded.length} not graded, cost $${report.totalCostUsd.toFixed(4)}${result.stoppedByBudget ? ' (stopped at the budget)' : ''}${result.costUnknown ? ' (STOPPED: a chat\'s cost could not be read)' : ''}`)
