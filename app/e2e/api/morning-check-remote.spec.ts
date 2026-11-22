// The morning-check set's remote run on the scripted model (P4 acceptance 2's plumbing): the same remote logic run.mjs
// --target drives (evals/morning-check/remote.ts, door.ts, runner.ts) and the same grader (grade.ts), on the per-PR test
// deployment, where each turn gets its container. The proof is the pair:
//  - outage-all: the door sets the test shop override to that case's shop, whose recorded upstream answers every request
//    503. The build's egress passes it to the hub (server/egress/test-shop.ts), the hub reads that shop
//    (hub/index/test-shop.ts), the read comes back `upstream_unavailable`, and only then does the scenario's `read-failed`
//    branch answer the outage result (test/scripted-model/scenarios.ts; any other error misses). Graded unchanged: it must
//    pass.
//  - late-orders: the override set to a shop whose reads go through: the read succeeds and the scripted one-item result
//    comes back (the answer is fixed, so this case is checked by what it observed, not by its verdict).
// Together they show the case's shop decides the read: the same scenario fails one read and not the other.
// The override is cleared before, between and after the cases (runAll, read back each time by door.ts), again in a finally
// and once more after all; one runner per deployment.
// Needs a container (E2E_TEST_BUILD_REMOTE) and the door's settings: INHOUSE_EVAL_D1_NAME (this deployment's
// inhouse-sbx-pr<N>-db), INHOUSE_EVAL_WRANGLER_CONFIG (the sandbox config that binds it), CF_SANDBOX_ACCOUNT_ID and the
// token wrangler reads itself. Without them it skips, saying which are missing.
import { expect, test } from '@playwright/test'
import { wranglerRunner } from '../../evals/targets/door.ts'
import { createMorningDoor, type MorningDoor } from '../../evals/morning-check/door.ts'
import { AMBER, META } from '../../evals/morning-check/expected.ts'
import { ensureDefaultModel, remoteEnv } from '../../evals/morning-check/remote.ts'
import { ROUTINE_ID, runAll } from '../../evals/morning-check/runner.ts'
import { needsContainer } from './chat-kit.ts'
import { actor, call } from './kit.ts'
import { alarmControl, skipLoudly } from './watch-kit.ts'

const leo = actor('memberB')
const DOOR_ENV = ['INHOUSE_EVAL_D1_NAME', 'INHOUSE_EVAL_WRANGLER_CONFIG', 'CF_SANDBOX_ACCOUNT_ID'] as const
/** Two cases at most CASE_MS + SETTLE_MS each (runner.ts), well inside the test's timeout with the door's wrangler calls. */
const CASE_MS = 300_000
const SETTLE_MS = 60_000
const TIMEOUT_MS = 1_500_000

let door: MorningDoor | null = null
// Routine turns run on the brand's Default model (Opus when unset) and the scripted model answers only Fast: set it, as the
// Admin, and read it back, before any Run now (evals/morning-check/remote.ts ensureDefaultModel; run.mjs --model-setting).
test.beforeAll(async ({ request }) => {
  if (!process.env.E2E_TEST_BUILD_REMOTE || DOOR_ENV.some(k => !process.env[k])) return
  const admin = actor('admin')
  await ensureDefaultModel({
    get: async path => { const r = await call(request, admin, 'GET', path); return { status: r.status, json: r.json } },
    put: async (path, body) => { const r = await call(request, admin, 'PUT', path, { json: body }); return { status: r.status, json: r.json } },
  }, 'Fast')
})
test.afterAll(async () => {
  await door?.clearShop()
})

test('the morning-check set runs remotely: the outage shop passes graded, a working shop reads through, no override is left', async ({ request }) => {
  needsContainer()
  const missing = DOOR_ENV.filter(k => !process.env[k])
  skipLoudly(missing.length > 0, `the door needs ${missing.join(', ')} (the deployment's D1, read with wrangler)`)
  test.setTimeout(TIMEOUT_MS)
  expect(2 * (CASE_MS + SETTLE_MS), 'the budget leaves at least 10 minutes for the door\'s calls').toBeLessThanOrEqual(TIMEOUT_MS - 600_000)
  const d = createMorningDoor(wranglerRunner({ database: process.env.INHOUSE_EVAL_D1_NAME!, config: process.env.INHOUSE_EVAL_WRANGLER_CONFIG!, env: process.env }))
  door = d
  const env = remoteEnv({
    door: d,
    async runNow(clientKey) {
      const r = await call(request, leo, 'POST', `/api/routines/${ROUTINE_ID}/run`, { json: { clientKey } })
      if (r.status !== 200) throw new Error(`POST run answered ${r.status}: ${r.text}`)
    },
    async alarm(body) {
      const r = await alarmControl(request, body)
      if (r.status !== 200) throw new Error(`POST /api/ops/alarm answered ${r.status}: ${r.text}`)
    },
    // No wait between polls: each poll is a wrangler d1 execute (seconds), which paces the loop on its own.
    pause: async () => {},
    nowMs: () => Date.now(),
    caseTimeoutMs: CASE_MS,
    settleMs: SETTLE_MS,
  })
  const cases = ['outage-all', 'late-orders'].map(id => META.find(c => c.id === id)!)
  let file
  let leftover: string | null = null
  try {
    file = await runAll(env, cases, { date: new Date().toISOString().slice(0, 10), sha: 'e2e0000', model: 'scripted' })
  } catch (runError) {
    // The run failed: clear anyway, and if that fails too, report both (the clear's error never hides the run's).
    try {
      await d.clearShop()
    } catch (clearError) {
      throw new Error(`the run failed: ${String(runError)}; and the test shop override could not be cleared: ${String(clearError)}`, { cause: runError })
    }
    throw runError
  }
  leftover = await d.clearShop()
  expect(leftover, 'runAll left no override').toBeNull()

  expect(file.stopped).toBeUndefined()
  const [outage, working] = file.cases
  expect(outage!.verdict, JSON.stringify(outage!.observed)).toMatchObject({ pass: true })
  expect(outage!.observed).toMatchObject({ ok: true, coverage: 'incomplete', items: [] })
  expect(outage!.observed.calls).toContain('mcp__apps__orders_search')
  expect(working!.observed, JSON.stringify(working!.observed)).toMatchObject({ ok: true, coverage: 'complete', gaps: [], items: [{ key: 'late-orders', sev: AMBER, sources: ['#1001'] }] })
})
