// The task registry (p3-design section 6; obligation 12 of the PR 2 handoff). Every P3 kind has its owner's handler
// (the `notBuilt` stub is gone: nothing used it). Ways it can fail: a kind drops out of the registry (a task of that
// kind would never run); `ensureSeeds()` seeds a kind with no handler.
import { describe, expect, it } from 'vitest'
import { taskHandlers } from './index.ts'
import { inAgent, settle } from '../../../testing/brand-agent/core-harness.ts'

describe('the registry (obligation 12)', () => {
  it('holds exactly the P3 kinds, each a handler', () => {
    expect(Object.keys(taskHandlers).sort()).toEqual([
      'audit-copy', 'authority-sweep', 'backup', 'call-lease', 'chat-file-sweep', 'deferred-hook', 'deferred-resume', 'flush-turn',
      'grant-expiry', 'outbox-send', 'outbox-sweep', 'pool-retry', 'question-expiry', 'retention', 'routine-end', 'routine-tick', 'run-advance',
      'turn-watch', 'usage-sweep',
    ])
    for (const [kind, handler] of Object.entries(taskHandlers)) expect(typeof handler, kind).toBe('function')
  })

  it('ensureSeeds() ensures only kinds the registry handles', () => inAgent(async h => {
    await h.submit('c1', 'key-seed1')
    await settle()
    const h2 = h.restart()
    const kinds = h2.sql.exec<{ kind: string }>('SELECT DISTINCT kind FROM due_tasks').toArray().map(r => r.kind)
    expect(kinds.length).toBeGreaterThan(0)
    for (const kind of kinds) expect(Object.keys(taskHandlers), kind).toContain(kind)
  }))
})
