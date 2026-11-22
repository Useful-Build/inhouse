// The morning-check set's remote run on the scripted model (P4 acceptance 2's plumbing): the same remote logic run.mjs
// --target drives (evals/morning-check/remote.ts, door.ts, runner.ts) and the same grader (grade.ts), on the per-PR test
// deployment, where each turn gets its container. Two cases:
//  - outage-all: the door sets the test shop override to that case's shop, whose recorded upstream answers every request
//    503. The build's egress passes it to the hub (server/egress/test-shop.ts), the hub reads that shop
//    (hub/index/test-shop.ts), the scripted read fails, and the scenario's `read-failed` branch answers the outage result
//    (test/scripted-model/scenarios.ts). The deployment's own shop never fails a read, so a pass proves the override
//    reached the hub. Graded unchanged: it must pass.
//  - late-orders: a shop whose reads go through: the scripted one-item result comes back (the scripted model's answer is
//    fixed, so this case is checked by what it observed, not by its verdict).
// The override is cleared before, between and after the cases (runAll) and read back each time (door.ts).
// Needs a container (E2E_TEST_BUILD_REMOTE) and the door's settings: INHOUSE_EVAL_D1_NAME (this deployment's
// inhouse-sbx-pr<N>-db), INHOUSE_EVAL_WRANGLER_CONFIG (the sandbox config that binds it), CF_SANDBOX_ACCOUNT_ID and the
// token wrangler reads itself. Without them it skips, saying which are missing.
import { expect, test } from '@playwright/test'
import { wranglerRunner } from '../../evals/targets/door.ts'
import { createMorningDoor } from '../../evals/morning-check/door.ts'
import { AMBER, META } from '../../evals/morning-check/expected.ts'
import { remoteEnv } from '../../evals/morning-check/remote.ts'
import { ROUTINE_ID, runAll } from '../../evals/morning-check/runner.ts'
import { needsContainer } from './chat-kit.ts'
import { actor, call } from './kit.ts'
import { alarmControl, skipLoudly } from './watch-kit.ts'

const leo = actor('memberB')
const DOOR_ENV = ['INHOUSE_EVAL_D1_NAME', 'INHOUSE_EVAL_WRANGLER_CONFIG', 'CF_SANDBOX_ACCOUNT_ID'] as const

test('the morning-check set runs remotely: the outage shop passes graded, a working shop reads through, no override is left', async ({ request }) => {
  needsContainer()
  const missing = DOOR_ENV.filter(k => !process.env[k])
  skipLoudly(missing.length > 0, `the door needs ${missing.join(', ')} (the deployment's D1, read with wrangler)`)
  test.setTimeout(1_500_000)
  const door = createMorningDoor(wranglerRunner({ database: process.env.INHOUSE_EVAL_D1_NAME!, config: process.env.INHOUSE_EVAL_WRANGLER_CONFIG!, env: process.env }))
  const env = remoteEnv({
    door,
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
    caseTimeoutMs: 600_000,
    settleMs: 120_000,
  })
  const cases = ['outage-all', 'late-orders'].map(id => META.find(c => c.id === id)!)
  const file = await runAll(env, cases, { date: new Date().toISOString().slice(0, 10), sha: 'e2e0000', model: 'scripted' })

  const [outage, working] = file.cases
  expect(outage!.verdict, JSON.stringify(outage!.observed)).toMatchObject({ pass: true })
  expect(outage!.observed).toMatchObject({ ok: true, coverage: 'incomplete', items: [] })
  expect(outage!.observed.calls).toContain('mcp__apps__orders_search')
  expect(working!.observed, JSON.stringify(working!.observed)).toMatchObject({ ok: true, coverage: 'complete', gaps: [], items: [{ key: 'late-orders', sev: AMBER, sources: ['#1001'] }] })
  expect(file.stopped).toBeUndefined()
})
