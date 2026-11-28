// The Inhouse ceiling's store (Stage 1 M3-C, N26): routes 150 and 151 read and change it through `Stores.ceiling`
// (api/ceiling.ts has the handlers). Its own module, with no HTTP imports, so the stores load anywhere they do (the
// sandbox seed imports them in plain Node).
//
// One change is one batch: the `ceiling.changed` audit line, then the row, both under the same "still as read"
// condition (permissions/ceiling.ts `ceilingAtRev`), so a stale change writes neither. The row goes through the
// ceiling's one writer (`setCeilingStmt`): lowering any value raises `lowered_rev` there, and disabling an operation
// lapses its approved actions at their next claim (the claim's guard reads the row, M2). server/ceiling-boundary.test.ts
// checks nothing else writes the table, and that only the route calls `set`.
//
// Writes stay off (N2, #520): `set` itself refuses `writes_off` unless editing is on in this build, so no caller holding
// the stores can turn an operation on in a deployable build. `CEILING_EDIT_ON` is false until M3-J flips it after the
// paid write-injection run; the test build turns editing on for its own specs (compiled in AND switched on, as the
// test-fakes hook is gated), never the eval build, which also runs with `INHOUSE_TEST_BUILD=1`. Who may change it (the
// Inhouse team) is the route's check, where the caller is known.
import { CeilingRowSchema } from '../../shared/contract/ceiling.ts'
import type { CeilingRow, CeilingValues } from '../../shared/contract/ceiling.ts'
import type { Guardrail } from '../../shared/contract/permissions.ts'
import { OPERATION_LIMITS, OPERATION_TITLE } from '../../shared/audit-text.ts'
import { auditInsert } from '../db/audit.ts'
import type { AuditHook } from '../db/audit.ts'
import type { At } from '../db/members.ts'
import { all, first, runBatch, stmt } from '../db/sql.ts'
import { ACCOUNT_IDS } from '../outbox/facts.ts'
import { OPERATION_KEYS, operationEntry } from '../outbox/operations/index.ts'
import type { OperationEntry, WriteOperationKey } from '../outbox/operations/types.ts'
import { CEILING_LIMIT_DEFAULTS, ceilingAtRev, setCeilingStmt } from '../permissions/ceiling.ts'

/**
 * Each operation's line on the page, in plain words (the page's own; the agent's description lives on the entry). Keyed
 * by the operation table's keys, so an operation added there without its line here fails the typecheck; the list
 * (ceiling.test.ts) checks every operation reads back too.
 */
const DESCRIPTION: Readonly<Record<WriteOperationKey, string>> = {
  'shopify.order.tag_add': 'Adds 1 to 5 tags to orders in the connected store.',
  'shopify.order.tag_remove': 'Removes 1 to 5 tags from orders in the connected store.',
  'shopify.draft_order.create': 'Creates a draft order with products, quantities, a note and tags. It has no customer and is never sent or completed.',
  'slack.channel.post': 'Posts a message to a Slack channel the brand listed for notices. Links are removed and mentions stay silent.',
  'shopify.inventory.restock': 'Raises the available stock of one product at one location in the connected store.',
  'shopify.inventory.reduce': "Lowers the available stock of one product at one location in the connected store. It can't be undone.",
  'shopify.refund.create': "Refunds line items, and shipping if asked, on one order in the shop's currency. Shopify may send the customer its own refund notice.",
}
/** `mcp` (Stage 1 M4, N46): an MCP tool's write; M4-W2 names the connection where the screen needs it. */
export const TOOL: Readonly<Record<OperationEntry['connector'], string>> = { shopify: 'Shopify', slack: 'Slack', mcp: 'A connected tool' }
/** The guardrails an operation's effects always apply, each an `Effects` flag (contract-coverage.test.ts checks every one is). */
export const EFFECT_GUARDRAILS = ['money', 'customer', 'destructive', 'access', 'unreviewed'] as const satisfies readonly Guardrail[]

interface CeilingDbRow {
  operation: string
  enabled: number
  per_day_max: number
  units_max: number
  bulk_threshold: number
  batch_max: number
  rev: number
  updated_at_ms: number
  updated_by: string
}

const AUDIT_COLUMNS = 'INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id)'
const COLUMNS = 'operation, enabled, per_day_max, units_max, bulk_threshold, batch_max, rev, updated_at_ms, updated_by'
const valuesOf = (r: CeilingDbRow): CeilingValues =>
  ({ enabled: r.enabled === 1, perDayMax: r.per_day_max, unitsMax: r.units_max, bulkThreshold: r.bulk_threshold, batchMax: r.batch_max })

/**
 * One operation as the page lists it: its row, or off with the suggested values while it has none. `currency`: the
 * connected Shopify store's (M3-S2, 0790), what a money operation's limits are in; null while no store names one.
 */
function rowOf(key: WriteOperationKey, r: CeilingDbRow | undefined, currency: string | null): CeilingRow {
  const e = operationEntry(key)
  if (!e) throw new Error(`ceiling: ${key} is not in the operation table`)
  const limits = OPERATION_LIMITS[key]
  const suggested = e.defaults.ceiling
  const values: CeilingValues = r
    ? valuesOf(r)
    : { enabled: false, ...suggested, bulkThreshold: CEILING_LIMIT_DEFAULTS.bulkThreshold, batchMax: CEILING_LIMIT_DEFAULTS.batchMax }
  return CeilingRowSchema.parse({
    ...values,
    operation: key,
    title: OPERATION_TITLE[key],
    description: DESCRIPTION[key],
    tool: TOOL[e.connector],
    // A money operation's units are the shop's minor currency units (#515): the page shows them as money in its currency.
    measure: limits.money ? { kind: 'money', currency } : { kind: 'count', label: e.unitsLabel },
    applies: { perDay: limits.perDay, batch: limits.batch },
    guardrails: EFFECT_GUARDRAILS.filter(g => e.effects[g]),
    approverKind: e.memberMay ? 'person' : 'admins',
    suggested,
    rev: r ? r.rev : null,
    updatedAt: r ? { iso: new Date(r.updated_at_ms).toISOString(), ms: r.updated_at_ms } : null,
    updatedBy: r ? r.updated_by : null,
  })
}

export type CeilingChange = { operation: WriteOperationKey; ifRev: number | null } & CeilingValues

declare const __INHOUSE_TEST_BUILD__: boolean
declare const __INHOUSE_EVAL_BUILD__: boolean

/**
 * Whether the Inhouse team may change the ceiling in a deployable build (N2, N26). Off until M3-J flips it, after the
 * paid write-injection run shows zero bypasses. Only M3-J changes this line.
 */
export const CEILING_EDIT_ON = false

/** What this build compiles in: the test build's switch and the eval build's mark (vite's defines). */
export interface CeilingBuild { testBuild: boolean; evalBuild: boolean }

/**
 * The defines as compiled. Read lazily and through `typeof`: the stores also load in plain Node (the sandbox seed),
 * where the defines don't exist, and there editing is off.
 */
function compiledBuild(): CeilingBuild {
  return {
    testBuild: typeof __INHOUSE_TEST_BUILD__ !== 'undefined' && __INHOUSE_TEST_BUILD__ === true,
    evalBuild: typeof __INHOUSE_EVAL_BUILD__ === 'undefined' || __INHOUSE_EVAL_BUILD__ !== false,
  }
}

/** Editing is on: the constant, or the test build compiled in, not the eval build, and switched on in its env. */
export const ceilingEditOn = (build: CeilingBuild, env: { INHOUSE_TEST_BUILD?: unknown }): boolean =>
  CEILING_EDIT_ON || (build.testBuild && !build.evalBuild && env.INHOUSE_TEST_BUILD === '1')

/**
 * The store over `db`. `env` is the Worker's (its `INHOUSE_TEST_BUILD` switch); `build` stands in for the compiled
 * defines in the unit tests only.
 */
export function ceilingStore({ db, hook = s => s, env, build = compiledBuild() }: { db: D1Database; hook?: AuditHook; env: { INHOUSE_TEST_BUILD?: unknown }; build?: CeilingBuild }) {
  const editOn = () => ceilingEditOn(build, env)
  const read = async (key: WriteOperationKey): Promise<CeilingDbRow | null> =>
    first<CeilingDbRow>(db, stmt(`SELECT ${COLUMNS} FROM permission_ceiling WHERE operation = ?`, key))
  /** The connected Shopify store's currency (copied from the hub, as the outbox's facts read it), or null. */
  const shopCurrency = async (): Promise<string | null> => (await first<{ currency: string | null }>(db, stmt(
    `SELECT currency FROM connector_accounts WHERE account_id = ? AND connected_at_ms IS NOT NULL
       AND (disconnected_at_ms IS NULL OR disconnected_at_ms < connected_at_ms)`, ACCOUNT_IDS.shopify)))?.currency ?? null

  return {
    /** Whether a change may go through in this build (the list's `writesOff` and `can.edit` read it). */
    editOn,
    /** Every operation in the table, in its order, each with its row or the suggested values. */
    async list(): Promise<CeilingRow[]> {
      const [rows, currency] = await Promise.all([all<CeilingDbRow>(db, stmt(`SELECT ${COLUMNS} FROM permission_ceiling`)), shopCurrency()])
      const by = new Map(rows.map(r => [r.operation, r]))
      return OPERATION_KEYS.map(k => rowOf(k, by.get(k), currency))
    },
    /**
     * The operation's row after the change, `conflict` with it as it is now (null `ifRev` and a row exists, or a stale
     * `rev`), or `writesOff` (nothing read or written) while editing is off in this build.
     */
    async set(change: CeilingChange, at: At): Promise<{ ok: CeilingRow } | { conflict: CeilingRow } | { writesOff: true }> {
      if (!editOn()) return { writesOff: true }
      const { operation, ifRev, ...values } = change
      const [before, currency] = await Promise.all([read(operation), shopCurrency()])
      const stale = ifRev === null ? before !== null : before === null || before.rev !== ifRev
      if (stale) return { conflict: rowOf(operation, before ?? undefined, currency) }
      const guard = ceilingAtRev(operation, ifRev)
      // The line first, under the same condition as the row's write: both in one batch, so both apply or neither.
      // `auditInsert` checks the line against the audit schema; its values are the line's columns in order.
      const plain = auditInsert({
        atMs: at.nowMs, actorId: at.actorId, requestId: at.requestId, target: null,
        args: { action: 'ceiling.changed', operation, old: before ? valuesOf(before) : null, new: values },
      }, null)
      const line = hook(stmt(`${AUDIT_COLUMNS} SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`, ...plain.params, ...guard.params))
      const results = await runBatch(db, [line, setCeilingStmt({ operation, ...values, ifRev, actorId: at.actorId, nowMs: at.nowMs })])
      const after = await read(operation)
      if (results[1]!.meta.changes !== 1) return { conflict: rowOf(operation, after ?? undefined, currency) }
      if (!after) throw new Error(`ceiling: ${operation} has no row after its change`)
      return { ok: rowOf(operation, after, currency) }
    },
  }
}
export type CeilingStore = ReturnType<typeof ceilingStore>
