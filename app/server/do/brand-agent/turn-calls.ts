// What the BrandAgent knows of a turn's model calls, for the hourly usage sweep (p3-design 9; W4's `TurnCallsReader`,
// `app/server/usage/sweep.ts` on `feat/chat-w4-usage`): closed calls at their price (a cut one at its cut price, 8.3:
// its admitted worst case; a freed grant at 0), calls still `deciding`, `granted` or `inflight` at their admitted worst
// case, waiting ones not at all (they hold no money). `null`: the object doesn't know the turn, or the turn isn't over
// (`ended` or `cancelled`) and may still run, so the sweep settles nothing (#154's review: settling a queued turn at 0
// would release its hold and it would then start and fail `turn_budget`). Synchronous, over the object's SQLite only.
// Wired at `usage/sweep.ts`'s `usageSweep`.
import type { TurnCallsReader } from '../../usage/sweep.ts'

/** The calls' sum by the rule above, whatever the turn's state (the run's cost, the trace). */
export function callsMicro(sql: SqlStorage, turnId: string): number {
  return sql.exec<{ micro: number }>(
    `SELECT COALESCE(SUM(CASE WHEN state IN ('done', 'cut', 'freed') THEN micro
        WHEN state IN ('deciding', 'granted', 'inflight') THEN worst_micro ELSE 0 END), 0) AS micro
      FROM model_calls WHERE turn_id = ?`, turnId).one().micro
}

export const turnCalls: TurnCallsReader = (sql, turnId) => {
  if (sql.exec("SELECT 1 FROM turns WHERE turn_id = ? AND state IN ('ended', 'cancelled')", turnId).toArray().length === 0) return null
  return { micro: callsMicro(sql, turnId) }
}
