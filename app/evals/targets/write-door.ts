// The eval door's write ops (Stage 1 M3-R, N30; Q3 = D). The eval deployment's hub answers every write through
// EvalWriteGateway (hub/testing/eval-write.ts), which logs it in the eval D1's `eval_write_log` (migration 0780) and sends
// nothing anywhere. Through the same database the door (door.ts's rules: the eval deployment's D1 only, credentials from
// the environment) turns an operation on (`setCeiling`), seeds a case person's "Always allow" (`grant`), reads the log
// (`writeLog`), sets the gateway's next answers for an operation (`setWriteFault`) and clears all of it per case-repeat
// (`resetWrites`). Statements are built here from checked values only: operations from WRITE_OPERATIONS, member ids,
// whole numbers. No Node import: the server tests run it on a real D1 (server/outbox/eval-write-log.test.ts).
// Writes stay off everywhere else (N2): nothing outside the eval harness calls this, and only the eval deployment's hub
// has the gateway.
import { WRITE_OPERATIONS } from '../../hub/index/contract.ts'
import type { WriteOperationKey } from '../../hub/index/contract.ts'
import { POLICY_REV } from '../../server/permissions/policy.ts'
import { D1_NOW_MS, DoorRefusal, sqlString } from './sql.ts'
import type { RunSql } from './sql.ts'

/** The faults EvalWriteGateway plays (hub/testing/eval-write.ts; migration 0780's CHECK holds the same three). */
export type EvalWriteFault = 'refuse' | 'unknown' | 'throttle'

/** The one Shopify account Stage 1 writes to (server/outbox/facts.ts ACCOUNT_IDS.shopify; a test pins the two). */
export const SHOPIFY_ACCOUNT = 'shopify:store'
const MEMBER_ID = /^[A-Za-z0-9_-]{1,80}$/
const FAULTS: readonly EvalWriteFault[] = ['refuse', 'unknown', 'throttle']
/** The largest daily limit the door seeds (a case needs a handful; anything near this is a typo). */
const MAX_PER_DAY = 10_000

export interface WriteLogRow {
  n: number
  atMs: number
  actionId: string
  attempt: number
  requestId: string
  accountId: string
  operation: string
  args: unknown
  expect: unknown
  item: { n: number; of: number } | null
  idempotencyKey: string | null
  outcome: 'sent' | EvalWriteFault
}

export interface WriteDoor {
  /** Turns `operation` on with this daily maximum (the ceiling's own writer's rule: a lower value raises `lowered_rev`). */
  setCeiling(operation: WriteOperationKey, perDayMax: number): Promise<void>
  /**
   * Seeds `memberId`'s "Always allow" for a Shopify `operation` on the connected store, `perDay` a day, as the outbox makes
   * one: the account's current generation, its shop as the scope, the current policy and the ceiling's revision. Refused
   * unless the operation is on, the store is connected with a shop and the member is an active person. Returns its id.
   */
  grant(g: { memberId: string; operation: WriteOperationKey; perDay: number }): Promise<string>
  /** Every request the gateway logged, oldest first. */
  writeLog(): Promise<WriteLogRow[]>
  /**
   * The gateway's answer to `operation`'s next `times` requests (default 1): `refuse`, `unknown` or `throttle` (with an
   * optional `retryAfterMs`). Null clears it.
   */
  setWriteFault(operation: WriteOperationKey, fault: EvalWriteFault | null, o?: { times?: number; retryAfterMs?: number }): Promise<void>
  /**
   * Clears what a case-repeat could leave for the next: the log, the faults, every open action (waiting, approved,
   * sending or an unresolved check), the grants and their uses, and the ceiling (writes off again). Read back: anything
   * left is a DoorRefusal. Live jobs aren't in D1: the harness cancels them through the API.
   */
  resetWrites(): Promise<void>
}

const operationOk = (op: unknown): op is WriteOperationKey => typeof op === 'string' && (WRITE_OPERATIONS as readonly string[]).includes(op)
const wholeIn = (n: unknown, min: number, max: number): n is number => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max

/** A permission id as the product makes one (`pg_` and 128 random bits, base64url). */
export function newGrantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `pg_${btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`
}

/** `nowSql` is the SQL for "now" in ms (default D1's own clock; tests give a fixed integer). */
export function createWriteDoor(run: RunSql, nowSql: () => string = () => D1_NOW_MS): WriteDoor {
  return {
    async setCeiling(operation, perDayMax) {
      if (!operationOk(operation)) throw new DoorRefusal('not a write operation')
      if (!wholeIn(perDayMax, 1, MAX_PER_DAY)) throw new DoorRefusal('not a daily maximum the door seeds')
      const now = nowSql()
      await run(
        `INSERT INTO permission_ceiling (operation, enabled, per_day_max, lowered_rev, updated_at_ms, updated_by) VALUES (${sqlString(operation)}, 1, ${perDayMax}, 1, ${now}, 'eval') ` +
          'ON CONFLICT (operation) DO UPDATE SET lowered_rev = lowered_rev + (excluded.enabled < enabled OR excluded.per_day_max < per_day_max), ' +
          'enabled = excluded.enabled, per_day_max = excluded.per_day_max, updated_at_ms = excluded.updated_at_ms, updated_by = excluded.updated_by',
      )
      const back = await run(`SELECT enabled, per_day_max FROM permission_ceiling WHERE operation = ${sqlString(operation)}`)
      if (back.length !== 1 || Number(back[0]!.enabled) !== 1 || Number(back[0]!.per_day_max) !== perDayMax) {
        throw new DoorRefusal(`the ceiling for ${operation} reads back ${JSON.stringify(back)}`)
      }
    },
    async grant(g) {
      if (!operationOk(g.operation) || !g.operation.startsWith('shopify.')) throw new DoorRefusal('not a Shopify write operation')
      if (!MEMBER_ID.test(g.memberId)) throw new DoorRefusal('not a member id')
      if (!wholeIn(g.perDay, 1, MAX_PER_DAY)) throw new DoorRefusal('not a daily limit the door seeds')
      const id = newGrantId()
      const m = sqlString(g.memberId)
      await run(
        'INSERT INTO permission_grants (id, holder, holder_member, account_id, account_gen, operation, scope_json, scope_key, per_day, ' +
          'policy_rev, granted_by, granted_role, ceiling_rev, granted_at_ms) ' +
          `SELECT ${sqlString(id)}, ${sqlString(`member:${g.memberId}`)}, ${m}, ca.account_id, ca.connected_at_ms, ${sqlString(g.operation)}, ` +
          `json_object('shop', ca.shop), 'shop=' || ca.shop, ${g.perDay}, ${POLICY_REV}, 'eval', 'member', c.lowered_rev, ${nowSql()} ` +
          'FROM permission_ceiling c, connector_accounts ca ' +
          `WHERE c.operation = ${sqlString(g.operation)} AND c.enabled = 1 AND ca.account_id = ${sqlString(SHOPIFY_ACCOUNT)} ` +
          "AND ca.last_state = 'connected' AND ca.connected_at_ms IS NOT NULL AND ca.shop IS NOT NULL " +
          `AND EXISTS (SELECT 1 FROM members mm WHERE mm.id = ${m} AND mm.kind = 'person' AND mm.status = 'active')`,
      )
      const back = await run(`SELECT id FROM permission_grants WHERE id = ${sqlString(id)} AND revoked_at_ms IS NULL`)
      if (back.length !== 1) throw new DoorRefusal(`no grant was made for ${g.operation}: the operation is off, the store isn't connected with a shop, or ${g.memberId} isn't an active person`)
      return id
    },
    async writeLog() {
      const rows = await run('SELECT n, at_ms, action_id, attempt, request_id, account_id, operation, args_json, expect_json, item_n, item_of, idempotency_key, outcome FROM eval_write_log ORDER BY n')
      return rows.map((r) => ({
        n: Number(r.n),
        atMs: Number(r.at_ms),
        actionId: String(r.action_id),
        attempt: Number(r.attempt),
        requestId: String(r.request_id),
        accountId: String(r.account_id),
        operation: String(r.operation),
        args: JSON.parse(String(r.args_json)),
        expect: JSON.parse(String(r.expect_json)),
        item: r.item_n === null ? null : { n: Number(r.item_n), of: Number(r.item_of) },
        idempotencyKey: r.idempotency_key === null ? null : String(r.idempotency_key),
        outcome: r.outcome as WriteLogRow['outcome'],
      }))
    },
    async setWriteFault(operation, fault, o = {}) {
      if (!operationOk(operation)) throw new DoorRefusal('not a write operation')
      if (fault === null) {
        await run(`DELETE FROM eval_write_fault WHERE operation = ${sqlString(operation)}`)
        return
      }
      if (!FAULTS.includes(fault)) throw new DoorRefusal('not a fault the gateway plays')
      const times = o.times ?? 1
      if (!wholeIn(times, 1, 1_000)) throw new DoorRefusal('not a number of requests the door seeds')
      if (o.retryAfterMs !== undefined && (fault !== 'throttle' || !wholeIn(o.retryAfterMs, 1, 86_400_000))) throw new DoorRefusal('retryAfterMs is a throttle\'s, a whole number of ms up to a day')
      const wait = o.retryAfterMs ?? 'NULL'
      await run(
        `INSERT INTO eval_write_fault (operation, fault, remaining, retry_after_ms) VALUES (${sqlString(operation)}, ${sqlString(fault)}, ${times}, ${wait}) ` +
          'ON CONFLICT (operation) DO UPDATE SET fault = excluded.fault, remaining = excluded.remaining, retry_after_ms = excluded.retry_after_ms',
      )
    },
    async resetWrites() {
      await run('DELETE FROM eval_write_log')
      await run('DELETE FROM eval_write_fault')
      await run('DELETE FROM outbox_actions WHERE final_at_ms IS NULL')
      await run('DELETE FROM permission_uses')
      await run('DELETE FROM permission_grants')
      await run('DELETE FROM permission_ceiling')
      const left = await run(
        'SELECT (SELECT COUNT(*) FROM eval_write_log) AS log, (SELECT COUNT(*) FROM eval_write_fault) AS faults, ' +
          '(SELECT COUNT(*) FROM outbox_actions WHERE final_at_ms IS NULL) AS open, (SELECT COUNT(*) FROM permission_grants) AS grants, ' +
          '(SELECT COUNT(*) FROM permission_ceiling) AS ceiling',
      )
      const r = left[0]
      if (!r || [r.log, r.faults, r.open, r.grants, r.ceiling].some((v) => Number(v) !== 0)) throw new DoorRefusal(`the write state is not clear after the reset: ${JSON.stringify(r)}`)
    },
  }
}

/**
 * The write families the product target provides (N30): `tag_ops` (add and remove tags), `stock_ops` (restock and
 * reduce) and `refund`, each only once every operation it needs is in WRITE_OPERATIONS, so a case never runs against an
 * operation that isn't built yet. Separate flags, so T07 (refund) and T08 can't share one.
 */
export function writeProvides(operations: readonly string[] = WRITE_OPERATIONS): Set<string> {
  const has = (...ops: string[]) => ops.every((op) => operations.includes(op))
  const out = new Set<string>()
  if (has('shopify.order.tag_add', 'shopify.order.tag_remove')) out.add('tag_ops')
  if (has('shopify.inventory.restock', 'shopify.inventory.reduce')) out.add('stock_ops')
  if (has('shopify.refund.create')) out.add('refund')
  return out
}
