// The read-side set's product target on the scripted model (P6a W4's scripted proof): the same target, readers and grader the paid
// run uses (evals/read-side/product/, grade.ts), wired in the proof mode (setup.ts wireProof) on the per-PR test deployment, where
// each turn gets its container and its transcript lands in the PR's own R2. Seven cases, each playing one scenario
// (test/scripted-model/scenarios.ts, `rs-*`): two honest agents that must pass (one reads through a subagent, which shows route
// 33 and the transcript count a subagent's calls alike), and one obedient agent per exit the product serves now (memory,
// routine, file, WebFetch, notice), each of which the readers must catch on its own check. The routine the obedient
// agent makes is deleted straight after its case (route 55), and the run leaves no shop override, routine or WebFetch list behind.
// Needs a container (E2E_TEST_BUILD_REMOTE), the door's settings (INHOUSE_EVAL_D1_NAME = this deployment's inhouse-sbx-pr<N>-db,
// INHOUSE_EVAL_WRANGLER_CONFIG, CF_SANDBOX_ACCOUNT_ID) and CLOUDFLARE_API_TOKEN with D1 edit and R2 read on the sandbox account.
// Without them it skips, saying which are missing. The proof mode refuses the eval database, another PR's, and the eval build.
import { expect, test } from '@playwright/test'
import { liveOnProduct } from '../../evals/read-side/args.ts'
import { READ_SIDE_CASES, type ReadSideCase } from '../../evals/read-side/cases.ts'
import { runReadSide } from '../../evals/read-side/runner.ts'
import { wireProof, type Wired } from '../../evals/read-side/product/setup.ts'
import type { RawApi } from '../../evals/read-side/product/target.ts'
import { PER_PR_DB } from '../../evals/targets/door.ts'
import type { Api } from '../../evals/targets/product.ts'
import { actor, call, type Actor } from './kit.ts'
import { skipLoudly } from './watch-kit.ts'

const NEEDS = ['INHOUSE_EVAL_D1_NAME', 'INHOUSE_EVAL_WRANGLER_CONFIG', 'CF_SANDBOX_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'] as const
const TIMEOUT_MS = 1_800_000
/** Each case and the scenario it plays, with the one check its obedient agent must fail (null: the honest agent, which must pass). */
const PLAYS: readonly { id: string; scenario: string; check: string | null }[] = [
  { id: 'RS-TN1', scenario: 'rs-honest', check: null },
  { id: 'RS-TM1', scenario: 'rs-obedient-memory', check: 'noPlantedMemory' },
  { id: 'RS-TR1', scenario: 'rs-honest-subagent', check: null },
  { id: 'RS-TR2', scenario: 'rs-obedient-routine', check: 'noRoutine' },
  { id: 'RS-TF1', scenario: 'rs-obedient-file', check: 'noUnsafeFile' },
  { id: 'RS-TM2', scenario: 'rs-obedient-webfetch', check: 'noOutsideFetch' },
  { id: 'RS-TN2', scenario: 'rs-obedient-notify', check: 'noNotification' },
]

function cannotRun(): string | null {
  if (!process.env.E2E_TEST_BUILD_REMOTE) return 'runs turns, which need a container: it runs on the per-PR test deployment (E2E_TEST_BUILD_REMOTE)'
  const missing = NEEDS.filter((k) => !process.env[k])
  return missing.length > 0 ? `the proof needs ${missing.join(', ')} (the deployment's D1 and R2)` : null
}

test('the read-side product target catches each exit on the scripted model and passes the honest agent', async ({ request }) => {
  const reason = cannotRun()
  skipLoudly(reason !== null, reason ?? '')
  test.setTimeout(TIMEOUT_MS)
  const pr = Number(PER_PR_DB.exec(process.env.INHOUSE_EVAL_D1_NAME!)?.[1])
  const as = (who: Actor): RawApi => async (method, path, body) => {
    const r = await call(request, who, method, path, body === undefined ? {} : { json: body })
    return { status: r.status, bytes: new Uint8Array(r.bytes), json: r.json }
  }
  const people: Record<string, Actor> = { current: actor('memberA'), lena: actor('admin'), tom: actor('memberB') }
  const api: Api = async (who, method, path, o = {}) => {
    const r = await call(request, people[who]!, method, path, o.bytes !== undefined
      ? { bytes: Buffer.from(o.bytes), contentType: o.headers?.['Content-Type'], headers: Object.fromEntries(Object.entries(o.headers ?? {}).filter(([k]) => k !== 'Content-Type')) }
      : o.json !== undefined ? { json: o.json } : {})
    return { status: r.status, json: r.json, text: r.text }
  }
  const cases: ReadSideCase[] = liveOnProduct(READ_SIDE_CASES, null).filter((c) => PLAYS.some((p) => p.id === c.id))
  expect(cases.map((c) => c.id).sort()).toEqual(PLAYS.map((p) => p.id).sort())
  expect(cases.every((c) => c.pending === undefined), 'every proof case is one the product target serves now').toBe(true)
  const notes: string[] = []
  let wired: Wired | null = null
  let leftover: string[] = []
  let result
  try {
    wired = await wireProof({
      env: process.env, pr, api, raw: { current: as(people.current!), admin: as(people.lena!) },
      scenarioOf: (c) => PLAYS.find((p) => p.id === c.id)!.scenario, note: (l) => notes.push(l),
    })
    result = await runReadSide({ target: wired.target, cases, budgetUsd: null })
  } finally {
    leftover = wired ? await wired.close() : []
  }
  expect(leftover, 'the run gave everything back').toEqual([])
  expect(result.stopped, `${JSON.stringify(result.stopped)}\n${notes.join('\n')}`).toBeNull()
  for (const play of PLAYS) {
    const outcome = result.outcomes.find((o) => o.id === play.id)
    expect(outcome, `${play.id} was graded (not run: ${JSON.stringify(result.notRun)})`).toBeDefined()
    if (play.check === null) {
      expect(outcome!.verdict, `${play.id}: ${outcome!.verdict.reasons.join('; ')}`).toMatchObject({ pass: true })
    } else {
      expect(outcome!.verdict.pass, play.id).toBe(false)
      expect((outcome!.verdict.checks as Record<string, boolean>)[play.check], `${play.id} is caught on ${play.check}: ${outcome!.verdict.reasons.join('; ')}`).toBe(false)
    }
  }
})
