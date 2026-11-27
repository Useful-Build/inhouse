// The ceiling's one writer (N10; Stage 1 M3-L, N23). Writes stay off (N2): no route and no seed calls it in M1 or M2;
// the test build's fakes hook (M2-B, `@test-fakes`) and the tests do. The Inhouse team's screen for it is M3-C's.
// Lowering the ceiling (turning an operation off, or a smaller daily maximum, largest call, bulk threshold or batch
// size) raises `lowered_rev` in the same statement, so every grant made under the old values stops covering anything
// (decide.ts `covers`, the claim's guard and the reservation all compare `ceiling_rev` with it). Raising it never brings
// an old grant back. Every change raises the row's `rev` (the screen's `ifRev`).
// Stage 1 M3-C (N26): the Inhouse team's route (server/api/ceiling.ts) writes through here too, with `ifRev`: the write
// applies only while the row is still at that `rev` (or, for `null`, while the operation has no row), checked inside
// the statement, so a stale screen changes nothing. `ceilingAtRev` is the same condition, for the change's audit line.
import { BATCH_ITEMS_MAX } from '../../shared/contract/actions.ts'
import { BULK_THRESHOLD_MAX, LIMIT_MAX } from '../../shared/contract/ceiling.ts'
import { stmt } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'
import type { WriteOperationKey } from './types.ts'

/**
 * 0760's defaults, M2's rules: one unit per call, more than 5 records is bulk, batches of 500. A caller that names no
 * limits (the M2 fakes hook, M2's tests) writes these.
 */
export const CEILING_LIMIT_DEFAULTS = { unitsMax: 1, bulkThreshold: BULK_THRESHOLD_MAX, batchMax: BATCH_ITEMS_MAX } as const

export interface SetCeilingInput {
  operation: WriteOperationKey
  enabled: boolean
  perDayMax: number
  /** The largest single call, whatever approves it (1 to `LIMIT_MAX`). */
  unitsMax?: number
  /** More records than this in one call is an exact `bulk` card (1 to 5). */
  bulkThreshold?: number
  /** The most items one batch card holds (1 to 500). */
  batchMax?: number
  actorId: string
  nowMs: number
  /**
   * Stage 1 M3-C: the row's `rev` the change was made against, or null to create a row that must not exist yet. Absent
   * (the test build's hook, the tests): the write applies whatever the row holds.
   */
  ifRev?: number | null
}

/**
 * The row is still as the change was read (N26): at `ifRev`, or absent for `null`. SQL with no free table name, so it
 * fits a statement's `WHERE` whatever table that statement writes.
 */
export function ceilingAtRev(operation: WriteOperationKey, ifRev: number | null): { sql: string; params: (string | number)[] } {
  if (ifRev !== null && !Number.isSafeInteger(ifRev)) throw new Error('ceilingAtRev: ifRev must be a whole number or null')
  return ifRev === null
    ? { sql: 'NOT EXISTS (SELECT 1 FROM permission_ceiling WHERE operation = ?)', params: [operation] }
    : { sql: 'EXISTS (SELECT 1 FROM permission_ceiling WHERE operation = ? AND rev = ?)', params: [operation, ifRev] }
}

const within = (n: number, max: number) => Number.isSafeInteger(n) && n >= 1 && n <= max

export function setCeilingStmt(input: SetCeilingInput): Stmt {
  const d = CEILING_LIMIT_DEFAULTS
  const v = { perDayMax: input.perDayMax, unitsMax: input.unitsMax ?? d.unitsMax, bulkThreshold: input.bulkThreshold ?? d.bulkThreshold, batchMax: input.batchMax ?? d.batchMax }
  if (!within(v.perDayMax, LIMIT_MAX)) throw new Error(`setCeilingStmt: perDayMax must be a whole number from 1 to ${LIMIT_MAX}`)
  if (!within(v.unitsMax, LIMIT_MAX)) throw new Error(`setCeilingStmt: unitsMax must be a whole number from 1 to ${LIMIT_MAX}`)
  if (!within(v.bulkThreshold, BULK_THRESHOLD_MAX)) throw new Error(`setCeilingStmt: bulkThreshold must be a whole number from 1 to ${BULK_THRESHOLD_MAX}`)
  if (!within(v.batchMax, BATCH_ITEMS_MAX)) throw new Error(`setCeilingStmt: batchMax must be a whole number from 1 to ${BATCH_ITEMS_MAX}`)
  // With `ifRev`, the row's values come from a SELECT that yields nothing unless the row is as read, so a stale change
  // neither inserts nor reaches the conflict's update. (A SELECT feeding an upsert needs its WHERE, sqlite.org/lang_upsert.)
  const at = input.ifRev === undefined ? { sql: '1', params: [] } : ceilingAtRev(input.operation, input.ifRev)
  return stmt(
    `INSERT INTO permission_ceiling (operation, enabled, per_day_max, units_max, bulk_threshold, batch_max, lowered_rev, rev, updated_at_ms, updated_by)
     SELECT ?, ?, ?, ?, ?, ?, 1, 1, ?, ? WHERE ${at.sql}
     ON CONFLICT (operation) DO UPDATE SET
       lowered_rev = lowered_rev + (excluded.enabled < enabled OR excluded.per_day_max < per_day_max OR excluded.units_max < units_max
         OR excluded.bulk_threshold < bulk_threshold OR excluded.batch_max < batch_max),
       rev = rev + 1,
       enabled = excluded.enabled, per_day_max = excluded.per_day_max, units_max = excluded.units_max,
       bulk_threshold = excluded.bulk_threshold, batch_max = excluded.batch_max,
       updated_at_ms = excluded.updated_at_ms, updated_by = excluded.updated_by`,
    input.operation, input.enabled ? 1 : 0, v.perDayMax, v.unitsMax, v.bulkThreshold, v.batchMax, input.nowMs, input.actorId, ...at.params,
  )
}
