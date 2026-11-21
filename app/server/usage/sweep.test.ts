// The hourly usage sweep and the usage_stranded signal, on literal fixtures inside a BrandAgent's SQLite (run_tokens)
// and D1. Ways it can fail:
//  1. it settles a turn whose token ended less than 15 minutes ago, or one still live, or one already final;
//  2. it settles from anything but the reader (a guess while the reader is unwired, or for a turn the reader doesn't know);
//  3. it runs silently while budget stays held: no log line, the signal green;
//  4. it doesn't make its next pass due.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openStores } from '../db/stores.ts'
import { createRunTokensTable } from '../do/brand-agent/tokens.ts'
import type { DueTask, Scheduler, TaskContext } from '../do/brand-agent/scheduler.ts'
import { createUsageLedger } from './ledger.ts'
import { usageStranded } from './signal.ts'
import { SWEEP_TASK_ID, createUsageSweep, sweepOnce } from './sweep.ts'
import type { TurnCallsReader } from './sweep.ts'
import { db, monthRow, resetUsage, turnIn, turnRow } from './test-fixtures.ts'

const T = Date.UTC(2026, 10, 15, 12, 0)
const MIN = 60_000
const ledger = createUsageLedger({ db })
let objects = 0

/** A fresh BrandAgent's SQLite with run_tokens rows: `[turnId, issuedAtMs, revokedAtMs | null]` (expiry 45 minutes on). */
async function inAgent<R>(tokens: [string, number, number | null][], fn: (sql: SqlStorage) => Promise<R>): Promise<R> {
  return runInDurableObject(env.BRAND_AGENT.getByName(`sweep-${++objects}`), async (_i, state) => {
    const sql = state.storage.sql
    createRunTokensTable(sql)
    for (const [turnId, issued, revoked] of tokens) {
      sql.exec(`INSERT INTO run_tokens (token_hash, turn_id, run_id, chat_id, member_id, session_id, model, side_model, routes_open,
        issued_at_ms, expires_at_ms, revoked_at_ms) VALUES (?, ?, 'r', 'c', 'm', 's', 'claude-sonnet-5-5', 'claude-haiku-5-5', ',', ?, ?, ?)`,
      `h_${turnId}_${issued}`, turnId, issued, issued + 45 * MIN, revoked)
    }
    return fn(sql)
  })
}
const TOKENS: [string, number, number | null][] = [['tA', T - 40 * MIN, T - 20 * MIN], ['tB', T - 40 * MIN, T - 10 * MIN]]
/** The reader W1 will provide, as a literal fake: tA's calls came to $0.70; tC is unknown to it. */
const reader: TurnCallsReader = (_sql, turnId) => (turnId === 'tA' ? { micro: 700_000 } : turnId === 'tB' ? { micro: 1 } : null)

beforeEach(async () => {
  await resetUsage('$10')
  for (const t of ['tA', 'tB', 'tC']) await ledger.reserve(turnIn(t, { nowMs: T - 180 * MIN }))
  await ledger.reserve(turnIn('tD', { nowMs: T - 10 * MIN }))
  await ledger.reserve(turnIn('tE', { nowMs: T - 180 * MIN }))
  await ledger.settle('tE', 100_000, T - 100 * MIN)
})

describe('usage-sweep', () => {
  it('settles only turns whose token ended 15+ minutes ago, from the reader, and skips turns it doesn\'t know (failures 1, 2)', async () => {
    // tA: revoked 20 min ago → due. tB: revoked 10 min ago → not yet. tC: no token, reserved 3 h ago → due, unknown to
    // the reader. tD: reserved 10 min ago. tE: final.
    const r = await inAgent(TOKENS, sql => sweepOnce({ db, sql, nowMs: T, turnCalls: reader }))
    expect(r).toEqual({ candidates: 2, settled: 1, unsettled: 1, failed: 0 })
    expect(await turnRow('tA')).toMatchObject({ final: 1, settled_micro: 700_000 })
    expect(await turnRow('tB')).toMatchObject({ final: 0 })
    expect(await turnRow('tC')).toMatchObject({ final: 0 })
    expect(await monthRow()).toMatchObject({ spent_micro: 800_000, reserved_micro: 750_000 })
  })

  it('with no reader wired settles nothing, warns, and the signal stays red (failures 2, 3)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const scheduled: Parameters<Scheduler['schedule']>[0][] = []
    const scheduler: Scheduler = { schedule: t => void scheduled.push(t), ensure: () => undefined, cancel: () => undefined }
    const task: DueTask = { id: SWEEP_TASK_ID, kind: 'usage-sweep', gen: 1, dueAtMs: T, payload: null, attempts: 0 }
    const result = await inAgent(TOKENS, sql => createUsageSweep(null)(task, { nowMs: T, env, sql, scheduler } as unknown as TaskContext))
    expect(result).toEqual({ done: true })
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'usage_sweep', candidates: 2, settled: 0, unsettled: 2, failed: 0, readerWired: false }))
    warn.mockRestore()
    // Failure 4: the next pass, an hour on.
    expect(scheduled).toEqual([{ id: SWEEP_TASK_ID, kind: 'usage-sweep', dueAtMs: T + 60 * MIN }])
    expect(await monthRow()).toMatchObject({ spent_micro: 100_000, reserved_micro: 1_000_000 })
    // Reserved 3 h ago, past 45 + 15 + 60 minutes: tA, tB, tC hold budget nobody settled.
    expect(await usageStranded(() => T).check({ env, stores: openStores(env) })).toEqual({ ok: false, detail: '3 turns hold budget past the sweep window' })
  })

  it('a candidate whose settle throws is counted and logged; the turns either side still settle (review round 1)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // Without tokens, tA, tB, tC are all due (reserved 3 h ago).
    const flaky = { ...ledger, settle: async (t: string, micro: number, nowMs: number) => {
      if (t === 'tB') throw new Error('fixture: settle failed')
      return ledger.settle(t, micro, nowMs)
    } }
    const r = await inAgent([], sql => sweepOnce({ db, sql, nowMs: T, turnCalls: () => ({ micro: 10_000 }), ledger: flaky }))
    expect(r).toEqual({ candidates: 3, settled: 2, unsettled: 0, failed: 1 })
    expect(err).toHaveBeenCalledWith(expect.objectContaining({ event: 'usage_sweep_turn_failed', turnId: 'tB' }))
    err.mockRestore()
    expect(await turnRow('tA')).toMatchObject({ final: 1 })
    expect(await turnRow('tB')).toMatchObject({ final: 0 })
    expect(await turnRow('tC')).toMatchObject({ final: 1 })
  })

  it('101 older turns the reader answers null for don\'t hide a newer stranded turn (review round 1)', async () => {
    const old = Array.from({ length: 101 }, (_, i) => db.prepare(`INSERT INTO usage_turns (turn_id, run_id, chat_id, member_id, model, month, reserved_micro, created_at_ms)
      VALUES (?, 'r', 'c', 'm', 'claude-sonnet-5-5', '2026-11', 0, ?)`).bind(`t_old_${String(i).padStart(3, '0')}`, T - 300 * MIN))
    await db.batch(old)
    const reader: TurnCallsReader = (_sql, turnId) => (turnId === 'tC' ? { micro: 20_000 } : null)
    const r = await inAgent(TOKENS, sql => sweepOnce({ db, sql, nowMs: T, turnCalls: reader }))
    expect(r).toMatchObject({ settled: 1, failed: 0 })
    expect(await turnRow('tC')).toMatchObject({ final: 1, settled_micro: 20_000 })
  })

  it('the signal is green when nothing held is older than the window', async () => {
    await inAgent(TOKENS, sql => sweepOnce({ db, sql, nowMs: T, turnCalls: () => ({ micro: 0 }) }))
    // tB is still within its grace at T; an hour later the sweep takes it too.
    await inAgent(TOKENS, sql => sweepOnce({ db, sql, nowMs: T + 60 * MIN, turnCalls: () => ({ micro: 0 }) }))
    expect(await usageStranded(() => T + 60 * MIN).check({ env, stores: openStores(env) })).toEqual({ ok: true })
  })
})
