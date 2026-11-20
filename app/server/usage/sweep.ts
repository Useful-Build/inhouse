// The `usage-sweep` due task (p3-design section 9), hourly: a turn that still holds budget (not final in D1) after its
// run token ended (revoked at its fence, or expired) more than 15 minutes ago is settled from its calls. Owner: W4.
// The calls are the BrandAgent's (`model_calls`, W1), so the sweep reads them through `TurnCallsReader`; until that
// reader is wired it settles nothing (a money close books only what it can prove), logs what it found and leaves the
// held budget visible to the `usage_stranded` signal (signal.ts). Idempotent by task id: settle is `final = 0` guarded.
import type { DueTask, Scheduler, TaskContext, TaskHandler, TaskResult } from '../do/brand-agent/scheduler.ts'
import { RUN_TOKEN_TTL_MS } from '../do/brand-agent/tokens.ts'
import { createUsageLedger } from './ledger.ts'
import type { UsageLedger } from './ledger.ts'

/**
 * What the BrandAgent knows of a turn's model calls, in micro-USD: closed calls at their actual cost plus calls still
 * open (deciding, granted or inflight) at their admitted worst case, cut calls by 8.3's cut-stream rule (priced at the
 * admitted worst case). `null`: the BrandAgent doesn't know the turn, so nothing is settled. Synchronous: it reads the
 * object's SQLite only. W1 implements it over `model_calls` and wires it at `usageSweep` below.
 */
export type TurnCallsReader = (sql: SqlStorage, turnId: string) => { micro: number } | null

export const SWEEP_TASK_ID = 'usage-sweep'
export const SWEEP_EVERY_MS = 60 * 60_000
/** How long after its token ended a turn may still settle by itself (the fence's flush grace and the ledger queue). */
export const SWEEP_GRACE_MS = 15 * 60_000
/** Turns looked at per pass, oldest first. */
export const SWEEP_BATCH = 100

export interface SweepResult {
  candidates: number
  settled: number
  /** Candidates the reader didn't know (or every candidate, while no reader is wired). */
  unsettled: number
}

/** When the turn's last run token stopped working; with no token (never minted), its reservation + the token's life. */
function tokenEndMs(sql: SqlStorage, turnId: string, createdAtMs: number): number {
  const r = sql.exec<{ n: number; end: number | null }>(
    'SELECT COUNT(*) AS n, MAX(MIN(COALESCE(revoked_at_ms, expires_at_ms), expires_at_ms)) AS end FROM run_tokens WHERE turn_id = ?', turnId,
  ).one()
  return r.n > 0 && r.end !== null ? r.end : createdAtMs + RUN_TOKEN_TTL_MS
}

/** One pass: settles what it can and reports what it found. */
export async function sweepOnce(o: { db: D1Database; sql: SqlStorage; nowMs: number; turnCalls: TurnCallsReader | null; ledger?: UsageLedger }): Promise<SweepResult> {
  const ledger = o.ledger ?? createUsageLedger({ db: o.db })
  const rows = (await o.db.prepare('SELECT turn_id, created_at_ms FROM usage_turns WHERE final = 0 AND created_at_ms < ? ORDER BY created_at_ms LIMIT ?')
    .bind(o.nowMs - SWEEP_GRACE_MS, SWEEP_BATCH).all<{ turn_id: string; created_at_ms: number }>()).results
  const due = rows.filter(r => tokenEndMs(o.sql, r.turn_id, r.created_at_ms) + SWEEP_GRACE_MS <= o.nowMs)
  let settled = 0
  for (const r of due) {
    const calls = o.turnCalls ? o.turnCalls(o.sql, r.turn_id) : null
    if (calls === null) continue
    await ledger.settle(r.turn_id, calls.micro, o.nowMs)
    settled++
  }
  return { candidates: due.length, settled, unsettled: due.length - settled }
}

/** Makes the next pass due an hour on. For its own id while it runs this is `schedule` (6: `ensure` would change nothing). */
export const scheduleNextSweep = (scheduler: Scheduler, nowMs: number): void =>
  scheduler.schedule({ id: SWEEP_TASK_ID, kind: 'usage-sweep', dueAtMs: nowMs + SWEEP_EVERY_MS })

export function createUsageSweep(turnCalls: TurnCallsReader | null): TaskHandler {
  return async (task: DueTask, ctx: TaskContext): Promise<TaskResult> => {
    const result = await sweepOnce({ db: ctx.env.DB, sql: ctx.sql, nowMs: ctx.nowMs, turnCalls })
    const line = { event: 'usage_sweep', taskId: task.id, ...result, readerWired: turnCalls !== null }
    if (result.unsettled > 0) console.warn(line)
    else console.log(line)
    scheduleNextSweep(ctx.scheduler, ctx.nowMs)
    return { done: true }
  }
}

/** The registered handler (tasks/index.ts). W1 passes its `model_calls` reader here; null until then. */
export const usageSweep: TaskHandler = createUsageSweep(null)
