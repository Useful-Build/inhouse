// The nightly's eval step: runs the harness on the product target with the budget it's given, then applies decide.mjs.
//   node scripts/nightly/evals.mjs --max-usd <usd> [--reps 3] [--cases all] [--out <dir>] [--baseline evals/baseline.json]
//   node scripts/nightly/evals.mjs --from-report <report.json> [--baseline <file>]   (grade an existing run, no model)
// Env for a live run (names only; the harness refuses without them): INHOUSE_EVAL_BRAND=1, INHOUSE_EVAL_ORIGIN (the eval deployment's
// origin), INHOUSE_EVAL_ISSUER_JWK_FILE and INHOUSE_EVAL_AUD (the test issuer's private key file and the brand app's aud: how the eval
// people sign in), INHOUSE_EVAL_D1_NAME (an inhouse-sbx-* database) and INHOUSE_EVAL_WRANGLER_CONFIG (the sandbox config that binds it),
// CF_SANDBOX_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (wrangler's door to that D1: it seeds and reads memory). The target also refuses a brand
// with any member off example.test.
// Exit 1 on any bypass, failed chats above 10%, or recall or tool choice more than 5 points under the baseline.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { decide } from './decide.mjs'

const appDir = path.resolve(import.meta.dirname, '../..')
const { values: v } = parseArgs({
  options: {
    'max-usd': { type: 'string' }, reps: { type: 'string', default: '3' }, cases: { type: 'string', default: 'all' },
    out: { type: 'string' }, baseline: { type: 'string', default: path.join(appDir, 'evals/baseline.json') }, 'from-report': { type: 'string' },
    concurrency: { type: 'string', default: '4' },
  },
})

let reportPath = v['from-report']
if (!reportPath) {
  const max = Number(v['max-usd'])
  if (v['max-usd'] === undefined || !Number.isFinite(max) || !(max > 0)) {
    console.error('refusing: a live run needs --max-usd <usd>, a finite number above zero (the hard budget)')
    process.exit(2)
  }
  const out = path.resolve(v.out ?? path.join(appDir, 'evals/results', `${new Date().toISOString().slice(0, 10)}-nightly`))
  const run = spawnSync(process.execPath, ['evals/run.ts', '--target', 'product', '--paid', '--budget', v['max-usd'], '--reps', v.reps, '--cases', v.cases, '--concurrency', v.concurrency, '--out', out], { cwd: appDir, stdio: 'inherit' })
  if (run.status !== 0) {
    console.error(`the harness exited ${run.status}`)
    process.exit(1)
  }
  reportPath = path.join(out, 'report.json')
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
const baseline = fs.existsSync(v.baseline) ? JSON.parse(fs.readFileSync(v.baseline, 'utf8')) : null
const { code, reasons } = decide(report, baseline)
for (const r of reasons) console.log(r)
console.log(code === 0 ? 'nightly evals: PASS' : 'nightly evals: FAIL')
process.exit(code)
