// The write-injection set's CLI (Stage 1 M3-E, N31). From app/:
//   node evals/injection/run.ts --target fake --out <dir> [--plant <kind> | --self-check]
//   node evals/injection/run.ts --target product --paid --budget <usd> --out <dir> [--cases W01,P01|all] [--reps 3] [--model claude-sonnet-5-5]
//     [--waive <ids>]   (cases the target can't run or serve fail the gate unless waived here by name; on the eval
//                        deployment: PRODUCT_SURFACE_WAIVERS, whose attacks the W31 to W37 twins run. The Slack cases run
//                        with INHOUSE_EVAL_INHOUSE_ORIGIN and INHOUSE_EVAL_INHOUSE_AUD set; without them they need a waiver)
// `--self-check` (the dry run as a grader check, fake target only): the clean set must pass the gate with every control;
// a planted bypass of each kind in every repeat must be caught as that kind and fail the gate; a repeat whose evidence
// can't be read, or whose turn never ends, must fail the gate. Its results are what the dry run commits.
// The product target spends money: it refuses without --paid and --budget, and the paid run is the orchestrator's (run 3).
import { CANCEL_SIGNALS } from '../signals.ts'
import { shieldWranglerCalls } from '../targets/door.ts'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { INJECTION_CASES } from './cases.ts'
import { createFakeInjectionTarget, FAKE_PLANTS, type FakePlant } from './fake.ts'
import { gateOf, runInjection, type InjectionRow, type InjectionRunOutput, type InjectionTarget } from './runner.ts'
import { appendRow, gateLine, startRows, writeInjectionResults, type ReportMeta } from './report.ts'
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
  // #606: an empty --topic (an unset workflow input) is no topic.
  const topic = v.topic && v.topic.trim() !== '' ? v.topic : path.basename(out)

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
  // Cases the run leaves out on purpose, by name (Fable's #550 review): printed in the report and the gate line.
  const waive = v.waive ? v.waive.split(',').filter((x) => x !== '') : []
  for (const id of waive) if (!INJECTION_CASES.some((c) => c.id === id)) fail(`unknown case in --waive: ${id}`)
  const meta = { topic, target: target.name, model: v.target === 'fake' ? 'none' : v.model!, reps }
  const soFar: InjectionRow[] = []
  // One close, however many paths ask for it (#612: the run's end, a SIGINT, a SIGTERM).
  const closing = onceClose(target)
  const cancel = new AbortController()
  // A cancel or a job timeout (Neon's #602 and #618 reviews): the running turn is aborted and no repeat starts after it,
  // the rows so far are written, the target closes once (on the product: a Slack connect in flight waited for, the turns
  // stopped, Slack disconnected first, the workspace emptied, the eval lease back), then a non-zero exit. One cancel
  // whatever arrives: a second SIGINT or a SIGTERM after it is noted, never a second close or an exit mid-disconnect.
  const handle = cancelHandler(closing, out, soFar, cancel, (code) => process.exit(code))
  listenForCancel(handle)
  const s = await runAndWrite({ target: closing, cases, reps, waive, out, meta, soFar, stop: () => cancel.signal.aborted, signal: cancel.signal, ...(budgetUsd !== undefined ? { budgetUsd } : {}) })
  console.log(`gate ${gateLine(s)}; ${s.repeats.pass}/${s.repeats.ran} repeats pass, ${s.bypasses.total} bypasses, cost $${s.soft.costUsd.toFixed(4)}`)
  if (!s.gate.pass) process.exitCode = 1
}

/** The target with a close that runs once: every later call gets the first call's promise (#612). */
export function onceClose<T extends Pick<InjectionTarget, 'close'>>(target: T): T {
  let closing: Promise<void> | undefined
  // Through then(): a close that throws at once still becomes the one promise every caller gets (Neon, #618).
  return { ...target, close: () => (closing ??= Promise.resolve().then(() => target.close?.())) }
}

/**
 * The signal handler (Neon's #618 review): the first signal aborts the run and starts the one cancel (the rows so far,
 * the close, then `exit` with the signal's code, or 1 if either failed); every later signal is only noted.
 */
export function cancelHandler(target: Pick<InjectionTarget, 'close'>, out: string, soFar: readonly InjectionRow[], cancel: AbortController, exit: (code: number) => void): (signal: string, code: number) => void {
  let cancelling = false
  return (signal, code) => {
    if (cancelling) {
      console.error(`${signal}: the cancel is already closing the target; waiting for it`)
      return
    }
    cancelling = true
    // The close's own wrangler calls (the lease release above all) run out of reach of a second signal (#716).
    shieldWranglerCalls()
    console.error(`${signal}: aborting the running turn, writing the rows so far and closing the target before exiting`)
    cancel.abort()
    void onCancel(target, out, soFar).then((ok) => exit(ok ? code : 1))
  }
}

/**
 * On a cancel: every finished row to rows.json (rows.jsonl has them already), then the target's close. Resolves false when
 * either failed (printed), so the exit says so.
 */
export async function onCancel(target: Pick<InjectionTarget, 'close'>, out: string, soFar: readonly InjectionRow[]): Promise<boolean> {
  let ok = true
  try {
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, 'rows.json'), JSON.stringify(soFar, null, 1))
  } catch (e) {
    ok = false
    console.error(`the rows so far could not be written: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    await target.close?.()
  } catch (e) {
    ok = false
    console.error(`the target could not close (Slack, the eval lease): ${e instanceof Error ? e.message : String(e)}`)
  }
  return ok
}

/**
 * Runs the set and writes its results before the target's close (#605: the close reaches the deployment, and on the
 * product it disconnects Slack; a failed call there must never cost the rows). A close that fails is recorded on the run
 * (`closeErr`), fails the gate, and the results are written again with it.
 */
export { CANCEL_SIGNALS }

/** Sends each cancel signal to `handle` (the one cancel, cancelHandler) instead of its default action. */
export function listenForCancel(handle: (signal: string, code: number) => void, proc: Pick<NodeJS.Process, 'on'> = process): void {
  for (const [signal, code] of CANCEL_SIGNALS) proc.on(signal, () => handle(signal, code))
}

export async function runAndWrite(o: { target: InjectionTarget; cases: InjectionCase[]; reps: number; waive: string[]; out: string; meta: ReportMeta; budgetUsd?: number; soFar?: InjectionRow[]; stop?: () => boolean; signal?: AbortSignal }): Promise<ReturnType<typeof writeInjectionResults>> {
  let result: InjectionRunOutput
  // Each graded row goes to rows.jsonl as its repeat ends (ops #49): a job timeout, a cancel or a crash keeps every
  // finished row; the report is written at the end from the run's rows.
  startRows(o.out)
  try {
    result = await runInjection({ target: o.target, cases: o.cases, reps: o.reps, waive: o.waive, setSize: INJECTION_CASES.length, onRow: (row) => { o.soFar?.push(row); appendRow(o.out, row) }, ...(o.stop ? { stop: o.stop } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd } : {}) })
  } catch (e) {
    // No rows to keep: give back what the target holds, and say so if that fails too.
    try {
      await o.target.close?.()
    } catch (closeErr) {
      throw new AggregateError([e, closeErr], 'the run failed, and the target\'s close failed too')
    }
    throw e
  }
  let s = writeInjectionResults(o.out, result, o.meta)
  try {
    await o.target.close?.()
  } catch (e) {
    result.closeErr = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.replace(/\bhttps?:\/\/\S+/gi, '[url]').slice(0, 300)
    s = writeInjectionResults(o.out, result, o.meta)
  }
  return s
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
