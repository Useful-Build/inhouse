// The task registry (p3-design section 6; obligation 12 of the PR 2 handoff). A `notBuilt` stub retries and is
// quarantined after 10 tries as `not_built: <kind>`, and `ensure()` never revives that, so no stub may reach a deployed
// object. Ways it can fail: a kind this PR built is still the stub; `ensureSeeds()` seeds a kind whose handler is a
// stub; by P3's final W1 PR any registered handler is still a stub.
import { describe, expect, it } from 'vitest'
import { taskHandlers } from './index.ts'
import { notBuilt } from './not-built.ts'
import { inAgent, settle } from '../../../testing/brand-agent/core-harness.ts'

describe('the registry has no stub where it matters (obligation 12)', () => {
  it('the kinds built so far are real handlers', () => {
    for (const kind of ['turn-watch', 'run-advance', 'call-lease']) expect(taskHandlers[kind], kind).not.toBe(notBuilt)
  })

  it('ensureSeeds() ensures no task whose handler is a stub', () => inAgent(async h => {
    await h.submit('c1', 'key-seed1')
    await settle()
    const h2 = h.restart()
    const kinds = h2.sql.exec<{ kind: string }>('SELECT DISTINCT kind FROM due_tasks').toArray().map(r => r.kind)
    expect(kinds.length).toBeGreaterThan(0)
    for (const kind of kinds) expect(taskHandlers[kind], kind).not.toBe(notBuilt)
  }))

  // Flips on in the W1 PR that builds the last W1 stub (PR 4: grant-expiry and authority-sweep; flush-turn is PR 3),
  // once W4's audit-copy and usage-sweep are real too.
  it.skip('no registered handler is a stub (flip in W1 PR 4)', () => {
    for (const [kind, handler] of Object.entries(taskHandlers)) expect(handler, kind).not.toBe(notBuilt)
  })
})
