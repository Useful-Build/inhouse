// What the BrandAgent knows of a turn's model calls, for the hourly usage sweep (p3-design 9; W4's `TurnCallsReader`,
// `app/server/usage/sweep.ts` on `feat/chat-w4-usage`): closed calls at their price (a cut one at its cut price, 8.3:
// its admitted worst case; a freed grant at 0), calls still `deciding`, `granted` or `inflight` at their admitted worst
// case, waiting ones not at all (they hold no money). `null`: the object doesn't know the turn, so the sweep settles
// nothing. Synchronous, over the object's SQLite only.
//
// The type is W4's, stubbed here identically until W4's PR merges; then this file imports it from `usage/sweep.ts`
// and the registry passes `turnCalls` to `createUsageSweep` (orchestrator-only file, `tasks/index.ts`).
export type TurnCallsReader = (sql: SqlStorage, turnId: string) => { micro: number } | null

export const turnCalls: TurnCallsReader = (sql, turnId) => {
  if (sql.exec('SELECT 1 FROM turns WHERE turn_id = ?', turnId).toArray().length === 0) return null
  const r = sql.exec<{ micro: number }>(
    `SELECT COALESCE(SUM(CASE WHEN state IN ('done', 'cut', 'freed') THEN micro
        WHEN state IN ('deciding', 'granted', 'inflight') THEN worst_micro ELSE 0 END), 0) AS micro
      FROM model_calls WHERE turn_id = ?`, turnId).one()
  return { micro: r.micro }
}
