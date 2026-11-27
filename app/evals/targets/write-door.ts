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
import { renderStmt } from '../../server/db/sql-statement.ts'
import { OPERATIONS } from '../../server/outbox/operations/index.ts'
import { POLICY_REV } from '../../server/permissions/policy.ts'
import { BATCH_ITEMS_MAX } from '../../shared/contract/actions.ts'
import { BULK_THRESHOLD_MAX, LIMIT_MAX } from '../../shared/contract/ceiling.ts'
import { D1_NOW_MS, DoorRefusal, sqlString } from './sql.ts'
import type { RunSql } from './sql.ts'

/** The faults EvalWriteGateway plays (hub/testing/eval-write.ts; migration 0780's CHECK holds the same three). */
export type EvalWriteFault = 'refuse' | 'unknown' | 'throttle'

/** The one Shopify account Stage 1 writes to (server/outbox/facts.ts ACCOUNT_IDS.shopify; a test pins the two). */
export const SHOPIFY_ACCOUNT = 'shopify:store'
const MEMBER_ID = /^[A-Za-z0-9_-]{1,80}$/
const ACTION_ID = /^ac_[A-Za-z0-9_-]{22}$/
const FAULTS: readonly EvalWriteFault[] = ['refuse', 'unknown', 'throttle']
/** The largest daily count a grant the door seeds holds (a case needs a handful; anything near this is a typo). */
const MAX_PER_DAY = 10_000

/** A ceiling's limits (N23, N24): each defaults to the operation's own ceiling defaults, then 0760's. */
export interface CeilingLimits {
  perDayMax?: number
  unitsMax?: number
  bulkThreshold?: number
  batchMax?: number
}

/**
 * The ceiling's own writer's statement (server/permissions/ceiling.ts `setCeilingStmt`, turning an operation on, no `ifRev`), as SQL
 * text with checked literals. Its text is that function's, copied: the door runs in Node, where ceiling.ts's D1 types
 * don't resolve, so a server test (server/outbox/eval-write-log.test.ts) holds the two equal for any input (#497).
 */
export function ceilingSql(c: { operation: WriteOperationKey; perDayMax: number; unitsMax: number; bulkThreshold: number; batchMax: number; nowMs: number }): string {
  return renderStmt({
    sql: `INSERT INTO permission_ceiling (operation, enabled, per_day_max, units_max, bulk_threshold, batch_max, lowered_rev, rev, updated_at_ms, updated_by)
     SELECT ?, ?, ?, ?, ?, ?, 1, 1, ?, ? WHERE 1
     ON CONFLICT (operation) DO UPDATE SET
       lowered_rev = lowered_rev + (excluded.enabled < enabled OR excluded.per_day_max < per_day_max OR excluded.units_max < units_max
         OR excluded.bulk_threshold < bulk_threshold OR excluded.batch_max < batch_max),
       rev = rev + 1,
       enabled = excluded.enabled, per_day_max = excluded.per_day_max, units_max = excluded.units_max,
       bulk_threshold = excluded.bulk_threshold, batch_max = excluded.batch_max,
       updated_at_ms = excluded.updated_at_ms, updated_by = excluded.updated_by`,
    params: [c.operation, 1, c.perDayMax, c.unitsMax, c.bulkThreshold, c.batchMax, c.nowMs, 'eval'],
  })
}

/** The ceiling the door writes for `operation` when a case names no limits: the operation's N24 defaults. */
export function ceilingDefaults(operation: WriteOperationKey): { perDayMax: number; unitsMax: number } {
  const c = OPERATIONS[operation].defaults.ceiling
  return { perDayMax: c.perDayMax ?? MAX_PER_DAY, unitsMax: c.unitsMax }
}

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

/** A row of the ceiling as the door reads it back (the preflight's check). */
export interface CeilingRow { operation: string; enabled: boolean; perDayMax: number; unitsMax: number; bulkThreshold: number; batchMax: number; rev: number; loweredRev: number }
/** A live grant as the door reads it back. */
export interface GrantRow { id: string; holderMember: string | null; operation: string; perDay: number; unitsMax: number; accountGen: number; ceilingRev: number }
/** The connected Shopify account as the product last copied it from the hub (`connector_accounts`). */
export interface ShopifyAccountRow { lastState: string; connectedAtMs: number | null; shop: string | null; currency: string | null }

/** The outbox rows a case-repeat left (N31 grades every one), read straight from D1. */
export interface OutboxRows {
  actions: {
    id: string; rev: number; state: string; verdict: string; guardrail: string | null; origin: string; kind: string; approverKind: string
    askedBy: string; approvedBy: string | null; approvedRev: number | null; approvedUpto: number | null; grantId: string | null
    operation: string; args: unknown; chatId: string; createdAtMs: number
  }[]
  items: { actionId: string; n: number; args: unknown; state: string; units: number }[]
  uses: { actionId: string; actionRev: number; grantId: string; units: number; released: boolean }[]
}

export interface WriteDoor {
  /**
   * Turns `operation` on with these limits, each defaulting to the operation's N24 ceiling (#497). The statement is the
   * ceiling's own writer's (server/permissions/ceiling.ts `setCeilingStmt`), rendered: a lower value raises
   * `lowered_rev`, every change raises `rev`. Read back.
   */
  setCeiling(operation: WriteOperationKey, limits?: CeilingLimits): Promise<void>
  /**
   * Seeds `memberId`'s "Always allow" for a Shopify `operation` on the connected store, `perDay` a day and `unitsMax` in
   * one call (each the operation's N24 grant defaults when absent; an operation with none, money or destructive, needs
   * both named: the eval plants such a grant only to prove the product ignores it), as the outbox makes one: the
   * account's current generation, its shop as the scope, the current policy and the ceiling's revision. Refused unless
   * the operation is on, the store is connected with a shop and the member is an active person. Returns its id.
   */
  grant(g: { memberId: string; operation: WriteOperationKey; perDay?: number; unitsMax?: number }): Promise<string>
  /** The ceiling's rows, by operation. */
  ceilings(): Promise<CeilingRow[]>
  /** Every live grant. */
  grants(): Promise<GrantRow[]>
  /** The Shopify account's row, or null when the product has never copied it from the hub. */
  shopifyAccount(): Promise<ShopifyAccountRow | null>
  /** The actions created at or after `sinceMs` (D1's clock), their items and their permission uses. */
  outbox(sinceMs: number): Promise<OutboxRows>
  /** D1's clock now, in ms (the mark `outbox` reads from). */
  now(): Promise<number>
  /**
   * The brand's sends not yet ended: actions approved (in their hold) or sending, and items sending. The harness waits
   * for none before it reads a repeat's evidence, so a held write is graded, never deleted unseen by the reset.
   */
  inFlight(): Promise<number>
  /** Every request the gateway logged, oldest first. */
  writeLog(): Promise<WriteLogRow[]>
  /**
   * The gateway's answer to `operation`'s next `times` requests (default 1): `refuse`, `unknown` or `throttle` (with an
   * optional `retryAfterMs`). Null clears it.
   */
  setWriteFault(operation: WriteOperationKey, fault: EvalWriteFault | null, o?: { times?: number; retryAfterMs?: number }): Promise<void>
  /**
   * Clears what a case-repeat could leave for the next: the log, the faults, every open action (waiting, approved,
   * sending or an unresolved check) and open item, the grants, their uses and item releases, and the ceiling (writes off
   * again). Read back, every one of them (#498): anything left is a DoorRefusal. Live jobs aren't in D1: the harness
   * cancels them through the API and waits for them to end first (#450), so none writes into the next repeat's log.
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
  const door: WriteDoor = {
    async setCeiling(operation, limits = {}) {
      if (!operationOk(operation)) throw new DoorRefusal('not a write operation')
      const d = ceilingDefaults(operation)
      const v = { perDayMax: limits.perDayMax ?? d.perDayMax, unitsMax: limits.unitsMax ?? d.unitsMax, bulkThreshold: limits.bulkThreshold ?? BULK_THRESHOLD_MAX, batchMax: limits.batchMax ?? BATCH_ITEMS_MAX }
      if (!wholeIn(v.perDayMax, 1, LIMIT_MAX)) throw new DoorRefusal('not a daily maximum the door seeds')
      if (!wholeIn(v.unitsMax, 1, LIMIT_MAX)) throw new DoorRefusal('not a largest call the door seeds')
      if (!wholeIn(v.bulkThreshold, 1, BULK_THRESHOLD_MAX)) throw new DoorRefusal('not a bulk threshold the door seeds')
      if (!wholeIn(v.batchMax, 1, BATCH_ITEMS_MAX)) throw new DoorRefusal('not a batch size the door seeds')
      // The ceiling's own writer's statement (#497): checked values only, at D1's clock, every change raising `rev`.
      await run(ceilingSql({ operation, ...v, nowMs: await door.now() }).replace(/;$/, ''))
      const back = (await door.ceilings()).filter((c) => c.operation === operation)
      const r = back[0]
      if (back.length !== 1 || !r!.enabled || r!.perDayMax !== v.perDayMax || r!.unitsMax !== v.unitsMax || r!.bulkThreshold !== v.bulkThreshold || r!.batchMax !== v.batchMax) {
        throw new DoorRefusal(`the ceiling for ${operation} reads back ${JSON.stringify(back)}`)
      }
    },
    async grant(g) {
      if (!operationOk(g.operation) || !g.operation.startsWith('shopify.')) throw new DoorRefusal('not a Shopify write operation')
      if (!MEMBER_ID.test(g.memberId)) throw new DoorRefusal('not a member id')
      const d = OPERATIONS[g.operation].defaults.grant
      const perDay = g.perDay ?? d?.perDay
      const unitsMax = g.unitsMax ?? d?.unitsMax
      if (perDay === undefined || unitsMax === undefined) throw new DoorRefusal(`${g.operation} has no grant defaults: name perDay and unitsMax`)
      if (!wholeIn(perDay, 1, MAX_PER_DAY)) throw new DoorRefusal('not a daily limit the door seeds')
      if (!wholeIn(unitsMax, 1, LIMIT_MAX)) throw new DoorRefusal('not a largest call the door seeds')
      const id = newGrantId()
      const m = sqlString(g.memberId)
      await run(
        'INSERT INTO permission_grants (id, holder, holder_member, account_id, account_gen, operation, scope_json, scope_key, per_day, units_max, ' +
          'policy_rev, granted_by, granted_role, ceiling_rev, granted_at_ms) ' +
          `SELECT ${sqlString(id)}, ${sqlString(`member:${g.memberId}`)}, ${m}, ca.account_id, ca.connected_at_ms, ${sqlString(g.operation)}, ` +
          `json_object('shop', ca.shop), 'shop=' || ca.shop, ${perDay}, ${unitsMax}, ${POLICY_REV}, 'eval', 'member', c.lowered_rev, ${nowSql()} ` +
          'FROM permission_ceiling c, connector_accounts ca ' +
          `WHERE c.operation = ${sqlString(g.operation)} AND c.enabled = 1 AND ca.account_id = ${sqlString(SHOPIFY_ACCOUNT)} ` +
          "AND ca.last_state = 'connected' AND ca.connected_at_ms IS NOT NULL AND ca.shop IS NOT NULL " +
          `AND EXISTS (SELECT 1 FROM members mm WHERE mm.id = ${m} AND mm.kind = 'person' AND mm.status = 'active')`,
      )
      const back = (await door.grants()).filter((x) => x.id === id)
      if (back.length !== 1) throw new DoorRefusal(`no grant was made for ${g.operation}: the operation is off, the store isn't connected with a shop, or ${g.memberId} isn't an active person`)
      if (back[0]!.perDay !== perDay || back[0]!.unitsMax !== unitsMax) throw new DoorRefusal(`the grant for ${g.operation} reads back ${JSON.stringify(back[0])}`)
      return id
    },
    async ceilings() {
      const rows = await run('SELECT operation, enabled, per_day_max, units_max, bulk_threshold, batch_max, rev, lowered_rev FROM permission_ceiling ORDER BY operation')
      return rows.map((r) => ({
        operation: String(r.operation), enabled: Number(r.enabled) === 1, perDayMax: Number(r.per_day_max), unitsMax: Number(r.units_max),
        bulkThreshold: Number(r.bulk_threshold), batchMax: Number(r.batch_max), rev: Number(r.rev), loweredRev: Number(r.lowered_rev),
      }))
    },
    async grants() {
      const rows = await run('SELECT id, holder_member, operation, per_day, units_max, account_gen, ceiling_rev FROM permission_grants WHERE revoked_at_ms IS NULL ORDER BY id')
      return rows.map((r) => ({
        id: String(r.id), holderMember: r.holder_member === null ? null : String(r.holder_member), operation: String(r.operation), perDay: Number(r.per_day),
        unitsMax: Number(r.units_max), accountGen: Number(r.account_gen), ceilingRev: Number(r.ceiling_rev),
      }))
    },
    async shopifyAccount() {
      const rows = await run(`SELECT last_state, connected_at_ms, shop, currency FROM connector_accounts WHERE account_id = ${sqlString(SHOPIFY_ACCOUNT)}`)
      const r = rows[0]
      if (!r) return null
      return {
        lastState: String(r.last_state), connectedAtMs: r.connected_at_ms === null ? null : Number(r.connected_at_ms),
        shop: r.shop === null ? null : String(r.shop), currency: r.currency === null ? null : String(r.currency),
      }
    },
    async now() {
      const nowMs = Number((await run(`SELECT ${nowSql()} AS now`))[0]?.now)
      if (!Number.isSafeInteger(nowMs)) throw new DoorRefusal('D1 gave no clock')
      return nowMs
    },
    async inFlight() {
      const r = (await run("SELECT (SELECT COUNT(*) FROM outbox_actions WHERE state IN ('approved', 'sending')) + (SELECT COUNT(*) FROM outbox_items WHERE state = 'sending') AS n"))[0]
      const n = Number(r?.n)
      if (!Number.isSafeInteger(n)) throw new DoorRefusal('the outbox gave no count')
      return n
    },
    async outbox(sinceMs) {
      if (!wholeIn(sinceMs, 0, Number.MAX_SAFE_INTEGER)) throw new DoorRefusal('not a time the door reads from')
      const actions = await run(
        'SELECT id, rev, state, verdict, guardrail, origin, kind, approver_kind, asked_by, approved_by, approved_rev, approved_upto, grant_id, operation, args_json, chat_id, created_at_ms ' +
          `FROM outbox_actions WHERE created_at_ms >= ${sinceMs} ORDER BY created_at_ms, id`,
      )
      const ids = actions.map((a) => String(a.id))
      for (const id of ids) if (!ACTION_ID.test(id)) throw new DoorRefusal('the outbox holds an action id the door does not read')
      const list = ids.map(sqlString).join(', ')
      const items = ids.length === 0 ? [] : await run(`SELECT action_id, n, args_json, state, units FROM outbox_items WHERE action_id IN (${list}) ORDER BY action_id, n`)
      const uses = ids.length === 0 ? [] : await run(`SELECT action_id, action_rev, grant_id, units, released_at_ms FROM permission_uses WHERE action_id IN (${list}) ORDER BY action_id, action_rev`)
      const json = (v: unknown): unknown => JSON.parse(String(v))
      const orNull = (v: unknown): number | null => (v === null ? null : Number(v))
      return {
        actions: actions.map((a) => ({
          id: String(a.id), rev: Number(a.rev), state: String(a.state), verdict: String(a.verdict), guardrail: a.guardrail === null ? null : String(a.guardrail),
          origin: String(a.origin), kind: String(a.kind), approverKind: String(a.approver_kind), askedBy: String(a.asked_by),
          approvedBy: a.approved_by === null ? null : String(a.approved_by), approvedRev: orNull(a.approved_rev), approvedUpto: orNull(a.approved_upto),
          grantId: a.grant_id === null ? null : String(a.grant_id), operation: String(a.operation), args: json(a.args_json), chatId: String(a.chat_id), createdAtMs: Number(a.created_at_ms),
        })),
        items: items.map((i) => ({ actionId: String(i.action_id), n: Number(i.n), args: json(i.args_json), state: String(i.state), units: Number(i.units) })),
        uses: uses.map((u) => ({ actionId: String(u.action_id), actionRev: Number(u.action_rev), grantId: String(u.grant_id), units: Number(u.units), released: u.released_at_ms !== null })),
      }
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
      // A batch's items go with it (0770's trigger); an open item left by any other path goes here.
      await run('DELETE FROM outbox_items WHERE final_at_ms IS NULL')
      await run('DELETE FROM permission_item_releases')
      await run('DELETE FROM permission_uses')
      await run('DELETE FROM permission_grants')
      await run('DELETE FROM permission_ceiling')
      const left = await run(
        'SELECT (SELECT COUNT(*) FROM eval_write_log) AS log, (SELECT COUNT(*) FROM eval_write_fault) AS faults, ' +
          '(SELECT COUNT(*) FROM outbox_actions WHERE final_at_ms IS NULL) AS open, (SELECT COUNT(*) FROM outbox_items WHERE final_at_ms IS NULL) AS items, ' +
          '(SELECT COUNT(*) FROM permission_uses) AS uses, (SELECT COUNT(*) FROM permission_item_releases) AS releases, ' +
          '(SELECT COUNT(*) FROM permission_grants) AS grants, (SELECT COUNT(*) FROM permission_ceiling) AS ceiling',
      )
      const r = left[0]
      if (!r || [r.log, r.faults, r.open, r.items, r.uses, r.releases, r.grants, r.ceiling].some((v) => Number(v) !== 0)) throw new DoorRefusal(`the write state is not clear after the reset: ${JSON.stringify(r)}`)
    },
  }
  return door
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
