// The Inhouse ceiling's store (Stage 1 M3-C, N26): routes 150 and 151 read and change it through `Stores.ceiling`
// (api/ceiling.ts has the handlers). Its own module, with no HTTP imports, so the stores load anywhere they do (the
// sandbox seed imports them in plain Node).
//
// One change is one batch: the `ceiling.changed` audit line, then the row, both under the same "still as read"
// condition (permissions/ceiling.ts `ceilingAtRev`), so a stale change writes neither. The row goes through the
// ceiling's one writer (`setCeilingStmt`): lowering any value raises `lowered_rev` there, and disabling an operation
// lapses its approved actions at their next claim (the claim's guard reads the row, M2). server/ceiling-boundary.test.ts
// checks nothing else writes the table.
import { CeilingRowSchema } from '../../shared/contract/ceiling.ts'
import type { CeilingRow, CeilingValues } from '../../shared/contract/ceiling.ts'
import type { Guardrail } from '../../shared/contract/permissions.ts'
import { OPERATION_LIMITS, OPERATION_TITLE } from '../../shared/audit-text.ts'
import { auditInsert } from '../db/audit.ts'
import type { AuditHook } from '../db/audit.ts'
import type { At } from '../db/members.ts'
import { all, first, runBatch, stmt } from '../db/sql.ts'
import { OPERATION_KEYS, operationEntry } from '../outbox/operations/index.ts'
import type { OperationEntry, WriteOperationKey } from '../outbox/operations/types.ts'
import { CEILING_LIMIT_DEFAULTS, ceilingAtRev, setCeilingStmt } from '../permissions/ceiling.ts'

/** Each operation's line on the page, in plain words (the page's own; the agent's description lives on the entry). */
const DESCRIPTION: Readonly<Record<keyof typeof OPERATION_TITLE, string>> = {
  'shopify.order.tag_add': 'Adds 1 to 5 tags to orders in the connected store.',
  'shopify.order.tag_remove': 'Removes 1 to 5 tags from orders in the connected store.',
  'shopify.draft_order.create': 'Creates a draft order with products, quantities, a note and tags. It has no customer and is never sent or completed.',
  'slack.channel.post': 'Posts a message to a Slack channel the brand listed for notices. Links are removed and mentions stay silent.',
}
const TOOL: Readonly<Record<OperationEntry['connector'], string>> = { shopify: 'Shopify', slack: 'Slack' }
const EFFECT_GUARDRAILS = ['money', 'customer', 'destructive', 'access'] as const satisfies readonly Guardrail[]

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

/** One operation as the page lists it: its row, or off with the suggested values while it has none. */
function rowOf(key: WriteOperationKey, r: CeilingDbRow | undefined): CeilingRow {
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
    // No money operation exists yet (M3-S2 adds refunds); its currency is the shop's, null until an account names one.
    measure: limits.money ? { kind: 'money', currency: null } : { kind: 'count', label: e.unitsLabel },
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

export function ceilingStore({ db, hook = s => s }: { db: D1Database; hook?: AuditHook }) {
  const read = async (key: WriteOperationKey): Promise<CeilingDbRow | null> =>
    first<CeilingDbRow>(db, stmt(`SELECT ${COLUMNS} FROM permission_ceiling WHERE operation = ?`, key))

  return {
    /** Every operation in the table, in its order, each with its row or the suggested values. */
    async list(): Promise<CeilingRow[]> {
      const rows = await all<CeilingDbRow>(db, stmt(`SELECT ${COLUMNS} FROM permission_ceiling`))
      const by = new Map(rows.map(r => [r.operation, r]))
      return OPERATION_KEYS.map(k => rowOf(k, by.get(k)))
    },
    /** The operation's row after the change, or `conflict` with it as it is now (null `ifRev` and a row exists, or a stale `rev`). */
    async set(change: CeilingChange, at: At): Promise<{ ok: CeilingRow } | { conflict: CeilingRow }> {
      const { operation, ifRev, ...values } = change
      const before = await read(operation)
      const stale = ifRev === null ? before !== null : before === null || before.rev !== ifRev
      if (stale) return { conflict: rowOf(operation, before ?? undefined) }
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
      if (results[1]!.meta.changes !== 1) return { conflict: rowOf(operation, after ?? undefined) }
      if (!after) throw new Error(`ceiling: ${operation} has no row after its change`)
      return { ok: rowOf(operation, after) }
    },
  }
}
export type CeilingStore = ReturnType<typeof ceilingStore>
