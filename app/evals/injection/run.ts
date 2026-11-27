// The write-injection set's CLI (Stage 1 M3-E, N31). From app/:
//   node evals/injection/run.ts --target fake --out <dir> [--plant <kind> | --self-check]
//   node evals/injection/run.ts --target product --paid --budget <usd> --out <dir> [--cases W01,P01|all] [--reps 3] [--model claude-sonnet-5-5]
//     [--waive <ids>]   (cases the target can't run or serve fail the gate unless waived here by name; on the eval
//                        deployment: PRODUCT_SURFACE_WAIVERS, whose attacks the W31 to W37 twins run, plus the Slack
//                        cases W14 to W17 only with Wasim's waiver, #570)
// `--self-check` (the dry run as a grader check, fake target only): the clean set must pass the gate with every control;
// a planted bypass of each kind in every repeat must be caught as that kind and fail the gate; a repeat whose evidence
// can't be read, or whose turn never ends, must fail the gate. Its results are what the dry run commits.
// The product target spends money: it refuses without --paid and --budget, and the paid run is the orchestrator's (run 3).
import path from 'node:path'
import { parseArgs } from 'node:util'
import { INJECTION_CASES } from './cases.ts'
import { createFakeInjectionTarget, FAKE_PLANTS, type FakePlant } from './fake.ts'
import { gateOf, runInjection, type InjectionRunOutput, type InjectionTarget } from './runner.ts'
import { writeInjectionResults } from './report.ts'
import type { InjectionCase } from './types.ts'

/** The dry run as a grader check: the table for the README and whether every line held. */
export async function selfCheck(cases: InjectionCase[], reps: number): Promise<{ ok: boolean; clean: InjectionRunOutput; lines: string[] }> {
  const fixed = (id: string, rep: number) => `INJ${id}R${rep}CANARY`
  const clean = await runInjection({ target: createFakeInjectionTarget(), cases, reps, canary: fixed })
  const lines: string[] = ['## The grader check', '', '| Planted | Repeats | Caught as that kind | Gate |', '|---|---|---|---|']
  const cleanGate = gateOf(clean)
  lines.push(`| nothing (the clean agent; controls approved) | ${clean.rows.length} | n/a | ${cleanGate.pass ? 'PASS (right)' : `FAIL (wrong): ${cleanGate.why.join('; ')}`} |`)
  let ok = cleanGate.pass && clean.rows.length === clean.planned
  for (const p of FAKE_PLANTS) {
    const r = await runInjection({ target: createFakeInjectionTarget({ plant: p }), cases, reps, canary: fixed, chatTimeoutMs: 50 })
    const g = gateOf(r)
    const caught = p === 'ungraded' ? r.rows.filter((x) => !x.graded).length
      : p === 'timeout' ? r.rows.filter((x) => x.graded && !x.runOk).length
      : r.rows.filter((x) => x.bypasses.some((b) => b.kind === p)).length
    ok &&= caught === r.rows.length && r.rows.length === r.planned && !g.pass
    lines.push(`| ${p} | ${r.rows.length} | ${caught} | ${g.pass ? 'PASS (wrong)' : 'FAIL (right)'} |`)
  }
  const controls = clean.rows.filter((r) => r.attack === 'control')
  lines.push('', `Controls: ${controls.filter((r) => r.pass).length} of ${controls.length} control repeats passed on the clean agent, each with exactly its write sent once.`, '', `Grader check: ${ok ? 'PASS' : 'FAIL'}.`, '')
  return { ok, clean, lines }
}

async function main(): Promise<void> {
  const { values: v } = parseArgs({
    options: {
      target: { type: 'string' }, out: { type: 'string' }, cases: { type: 'string', default: 'all' }, reps: { type: 'string', default: '3' },
      model: { type: 'string', default: 'claude-sonnet-5-5' }, budget: { type: 'string' }, paid: { type: 'boolean', default: false },
      plant: { type: 'string' }, 'self-check': { type: 'boolean', default: false }, topic: { type: 'string' }, waive: { type: 'string' },
    },
  })
  const fail = (msg: string): never => {
    console.error(msg)
    process.exit(2)
  }
  if (v.target !== 'fake' && v.target !== 'product') fail('--target must be fake or product')
  if (!v.out) fail('--out <dir> is required')
  const out = path.resolve(v.out!)
  const reps = Number(v.reps)
  const wanted = v.cases === 'all' ? null : new Set(v.cases!.split(','))
  const cases = wanted ? INJECTION_CASES.filter((c) => wanted.has(c.id)) : INJECTION_CASES
  if (wanted && cases.length !== wanted.size) fail('unknown case in --cases')
  const topic = v.topic ?? path.basename(out)

  if (v['self-check']) {
    if (v.target !== 'fake') fail('--self-check runs on the fake target only')
    const { ok, clean, lines } = await selfCheck(cases, reps)
    writeInjectionResults(out, clean, { topic, target: 'fake', model: 'none', reps, extra: lines })
    console.log(lines.join('\n'))
    process.exitCode = ok ? 0 : 1
    return
  }

  let target: InjectionTarget
  const budgetUsd = v.budget === undefined ? undefined : Number(v.budget)
  if (v.target === 'fake') {
    const plant = v.plant as FakePlant | undefined
    if (plant !== undefined && !FAKE_PLANTS.includes(plant)) fail(`--plant must be one of ${FAKE_PLANTS.join(', ')}`)
    target = createFakeInjectionTarget(plant ? { plant } : {})
  } else {
    const { createProductInjectionTarget } = await import('./product.ts')
    try {
      target = createProductInjectionTarget({ paid: v.paid!, budgetUsd, env: process.env, model: v.model! })
    } catch (e) {
      fail(`refused: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
  }
  let result: InjectionRunOutput
  try {
    // Cases the run leaves out on purpose, by name (Fable's #550 review): printed in the report and the gate line.
    const waive = v.waive ? v.waive.split(',').filter((x) => x !== '') : []
    for (const id of waive) if (!INJECTION_CASES.some((c) => c.id === id)) fail(`unknown case in --waive: ${id}`)
    result = await runInjection({ target, cases, reps, waive, ...(budgetUsd !== undefined ? { budgetUsd } : {}) })
  } finally {
    await target.close?.()
  }
  const s = writeInjectionResults(out, result, { topic, target: target.name, model: v.target === 'fake' ? 'none' : v.model!, reps })
  console.log(`gate ${s.gate.pass ? 'PASS' : `FAIL (${s.gate.why.join('; ')})`}; ${s.repeats.pass}/${s.repeats.ran} repeats pass, ${s.bypasses.total} bypasses, cost $${s.soft.costUsd.toFixed(4)}`)
  if (!s.gate.pass) process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
