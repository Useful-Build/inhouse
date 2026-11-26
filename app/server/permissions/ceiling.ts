// The ceiling's one writer (N10). Writes stay off (N2): no route and no seed calls it in M1 or M2; the test build's
// fakes hook (M2-B, `@test-fakes`) and the tests do. The Inhouse team's screen for it is M3.
// Lowering the ceiling (turning an operation off, or a smaller daily maximum) raises `lowered_rev` in the same
// statement, so every grant made under the old value stops covering anything (decide.ts `covers`, the claim's guard and
// the reservation all compare `ceiling_rev` with it). Raising it never brings an old grant back.
import { stmt } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'
import type { WriteOperationKey } from './types.ts'

export function setCeilingStmt(input: { operation: WriteOperationKey; enabled: boolean; perDayMax: number; actorId: string; nowMs: number }): Stmt {
  if (!Number.isSafeInteger(input.perDayMax) || input.perDayMax < 1) throw new Error('setCeilingStmt: perDayMax must be a whole number, at least 1')
  return stmt(
    `INSERT INTO permission_ceiling (operation, enabled, per_day_max, lowered_rev, updated_at_ms, updated_by) VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (operation) DO UPDATE SET
       lowered_rev = lowered_rev + (excluded.enabled < enabled OR excluded.per_day_max < per_day_max),
       enabled = excluded.enabled, per_day_max = excluded.per_day_max,
       updated_at_ms = excluded.updated_at_ms, updated_by = excluded.updated_by`,
    input.operation, input.enabled ? 1 : 0, input.perDayMax, input.nowMs, input.actorId,
  )
}
