// W4's usage tasks wired to the BrandAgent (#154's asks for W1): the registered `usage-sweep` handler settles a stranded
// turn in D1 from the BrandAgent's own `model_calls` (the reader), and `ensureSeeds()` ensures the sweep and today's
// audit copy. Expected values are the script's literals. Ways it can fail: the handler still has no reader (settles
// nothing), it settles a turn that may still run, or a start leaves the usage tasks unseeded.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { SendTurnResult } from '../../../shared/contract/runs.ts'
import type { DueTask, TaskContext } from './scheduler.ts'
import type { Refusal } from './ports.ts'
import { usageSweep } from '../../usage/sweep.ts'
import { createUsageLedger } from '../../usage/ledger.ts'
import { resetUsage, turnIn, turnRow } from '../../usage/test-fixtures.ts'
import { MIN, T0, fullAnswer, inAgent, settle } from '../../testing/brand-agent/core-harness.ts'

const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}
const usage = (micro: number) => ({ inputTokens: 1, outputTokens: 1, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, webSearches: 0, micro })
const SWEEP: DueTask = { id: 'usage-sweep', kind: 'usage-sweep', gen: 1, dueAtMs: 0, payload: null, attempts: 0 } as unknown as DueTask

describe("W4's usage tasks on the BrandAgent", () => {
  it('the registered sweep settles an ended turn from its model calls, and leaves a live one alone', () => inAgent(async h => {
    await resetUsage('$100')
    const ledger = createUsageLedger({ db: env.DB })
    const a = ok(await h.submit('c1', 'key-wire1'))
    const b = ok(await h.submit('c2', 'key-wire2'))
    await settle()
    // Their D1 reservations (the harness's own ledger is a fake: these stay open, as if the BrandAgent's settle was lost).
    await ledger.reserve(turnIn(a.turnId, { nowMs: T0 }))
    await ledger.reserve(turnIn(b.turnId, { nowMs: T0 }))
    void h.core.admitModelCall(a.turnId, 'c1', { model: 'claude-sonnet-5-5', inputTokens: 1, maxTokens: 1, modifiers: {}, micro: 100_000 })
    await settle()
    h.core.renewModelCall(a.turnId, 'c1', usage(0))
    h.core.releaseModelCall(a.turnId, 'c1', { usage: usage(40_000), cut: false })
    h.push(a.turnId, ...fullAnswer('done', 2))
    await settle()
    expect(h.turn(a.turnId).state).toBe('ended')
    // Both turns' tokens ended long ago by then (a's revoked at its end; b's expired at 45 minutes); b is still live here.
    h.clock.now = T0 + 120 * MIN
    expect(h.turn(b.turnId).state).toBe('live')
    await usageSweep(SWEEP, { nowMs: h.clock.now, env, sql: h.sql, scheduler: h.sched } as unknown as TaskContext)
    expect(await turnRow(a.turnId)).toMatchObject({ final: 1, settled_micro: 40_000 })
    expect(await turnRow(b.turnId)).toMatchObject({ final: 0 })
  }))

  it('a start ensures the hourly sweep and today\'s audit copy', () => inAgent(async h => {
    const h2 = h.restart()
    const ids = h2.dueTasks().map(t => t.id)
    // T0 is 2100-01-01T00:00Z: the sweep an hour on, today's copy at 02:00 UTC.
    expect(h2.dueTasks().filter(t => ids.includes(t.id) && (t.id === 'usage-sweep' || t.id.startsWith('audit-copy:')))).toEqual([
      { id: 'audit-copy:2100-01-01', due_at_ms: T0 + 2 * 60 * MIN },
      { id: 'usage-sweep', due_at_ms: T0 + 60 * MIN },
    ])
  }))
})
