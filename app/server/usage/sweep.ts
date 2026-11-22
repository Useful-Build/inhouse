// The `usage-sweep` due task (p3-design section 9), hourly: a turn that still holds budget (not final in D1) after its
// run token ended (revoked at its fence, or expired) more than 15 minutes ago is settled from its calls. Owner: W4.
// The calls are the BrandAgent's (`model_calls`, W1), so the sweep reads them through `TurnCallsReader` (turn-calls.ts,
// wired at the registry, do/brand-agent/tasks/index.ts). A turn the reader answers null for is not settled (a money close
// books only what it can prove): the pass logs it and the held budget stays visible to the `usage_stranded` signal
// (signal.ts). Idempotent by task id: settle is `final = 0` guarded.
import type { DueTask, Scheduler, TaskContext, TaskHandler, TaskResult } from '../do/brand-agent/scheduler.ts'
import { RUN_TOKEN_TTL_MS } from '../do/brand-agent/tokens.ts'
import { createUsageLedger } from './ledger.ts'
import type { UsageLedger } from './ledger.ts'
import { safeError } from '../safe-error.ts'

/**
 * What the BrandAgent knows of a turn's model calls, in micro-USD: closed calls at their actual cost plus calls still
 * open (deciding, granted or inflight) at their admitted worst case, cut calls by 8.3's cut-stream rule (priced at the
 * admitted worst case). `null`: nothing is settled; the reader answers null unless the BrandAgent's turn is terminal (no
 * live run, nothing queued), and for a turn it doesn't know. Synchronous: it reads the object's SQLite only. W1
 * implements it over `model_calls` (turn-calls.ts); the registry passes it to `createUsageSweep`.
 */
export type TurnCallsReader = (sql: SqlStorage, turnId: string) => { micro: number } | null

export const SWEEP_TASK_ID = 'usage-sweep'
export const SWEEP_EVERY_MS = 60 * 60_000
/** How long after its token ended a turn may still settle by itself (the fence's flush grace and the ledger queue). */
export const SWEEP_GRACE_MS = 15 * 60_000
/** Turns read per page, oldest first; a pass pages on past the last seen `(created_at_ms, turn_id)`, up to `SWEEP_MAX_PAGES`. */
export const SWEEP_BATCH = 100
export const SWEEP_MAX_PAGES = 20

export interface SweepResult {
  candidates: number
  settled: number
  /** Candidates the reader answered null for (or every candidate, while no reader is wired). */
  unsettled: number
  /** Candidates whose read or settle threw (logged; the pass goes on). */
  failed: number
}

/** When the turn's last run token stopped working; with no token (never minted), its reservation + the token's life. */
function tokenEndMs(sql: SqlStorage, turnId: string, createdAtMs: number): number {
  const r = sql.exec<{ n: number; end: number | null }>(
    'SELECT COUNT(*) AS n, MAX(MIN(COALESCE(revoked_at_ms, expires_at_ms), expires_at_ms)) AS end FROM run_tokens WHERE turn_id = ?', turnId,
  ).one()
  return r.n > 0 && r.end !== null ? r.end : createdAtMs + RUN_TOKEN_TTL_MS
}

/** One pass: settles what it can and reports what it found. One bad turn never fails the pass. */
export async function sweepOnce(o: { db: D1Database; sql: SqlStorage; nowMs: number; turnCalls: TurnCallsReader | null; ledger?: UsageLedger }): Promise<SweepResult> {
  const ledger = o.ledger ?? createUsageLedger({ db: o.db })
  const r: SweepResult = { candidates: 0, settled: 0, unsettled: 0, failed: 0 }
  let after: { at: number; id: string } = { at: -1, id: '' }
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const rows = (await o.db.prepare(`SELECT turn_id, created_at_ms FROM usage_turns
        WHERE final = 0 AND created_at_ms < ? AND (created_at_ms > ? OR (created_at_ms = ? AND turn_id > ?))
        ORDER BY created_at_ms, turn_id LIMIT ?`)
      .bind(o.nowMs - SWEEP_GRACE_MS, after.at, after.at, after.id, SWEEP_BATCH).all<{ turn_id: string; created_at_ms: number }>()).results
    for (const row of rows) {
      if (tokenEndMs(o.sql, row.turn_id, row.created_at_ms) + SWEEP_GRACE_MS > o.nowMs) continue
      r.candidates++
      try {
        const calls = o.turnCalls ? o.turnCalls(o.sql, row.turn_id) : null
        if (calls === null) { r.unsettled++; continue }
        await ledger.settle(row.turn_id, calls.micro, o.nowMs)
        r.settled++
      } catch (err) {
        r.failed++
        console.error({ event: 'usage_sweep_turn_failed', turnId: row.turn_id, error: safeError(err) })
      }
    }
    if (rows.length < SWEEP_BATCH) break
    const last = rows[rows.length - 1]
    after = { at: last.created_at_ms, id: last.turn_id }
  }
  return r
}

/** Makes the next pass due an hour on. For its own id while it runs this is `schedule` (6: `ensure` would change nothing). */
export const scheduleNextSweep = (scheduler: Scheduler, nowMs: number): void =>
  scheduler.schedule({ id: SWEEP_TASK_ID, kind: 'usage-sweep', dueAtMs: nowMs + SWEEP_EVERY_MS })

export function createUsageSweep(turnCalls: TurnCallsReader | null): TaskHandler {
  return async (task: DueTask, ctx: TaskContext): Promise<TaskResult> => {
    const result = await sweepOnce({ db: ctx.env.DB, sql: ctx.sql, nowMs: ctx.nowMs, turnCalls })
    const line = { event: 'usage_sweep', taskId: task.id, ...result, readerWired: turnCalls !== null }
    if (result.unsettled > 0 || result.failed > 0) console.warn(line)
    else console.log(line)
    scheduleNextSweep(ctx.scheduler, ctx.nowMs)
    return { done: true }
  }
}
