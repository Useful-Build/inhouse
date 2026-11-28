// How a call becomes part of a batch (Stage 1 M3-B, N22). Two ways in:
//  1. One call with more records than one card should carry: an exact `bulk` card over the bulk threshold, or a
//     multi-record call under a grant (a `run` batch with one reservation for all its units). The call is split by its
//     entry's `items` into one item per record, its own batch (the call's `tool_use_id` is on the batch row).
//  2. Collecting (only `coalesces: true` operations): a call its grant can't take (`count`), or the 6th waiting single
//     card of its kind in the chat (`bulk`), joins the chat's one open collecting batch for that key, as one item holding
//     the whole call (its `tool_use_id` on the item). The append is one D1 batch: open the collecting row if none (the
//     unique index on `(chat_id, coalesce_key)`), raise the tip only where it still equals the one read before, then the
//     item only where that raise took this append's stamp. A lost compare reads again, at most 3 times, then "busy".
// The same `(chat_id, tool_use_id)` returns its item wherever it now sits; a call whose payload equals a pending item of
// the open batch returns that item. At `batch_max` the key clears and the next call is refused `batch_full`. A batch past
// its expiry is not open: the next append clears its key and opens a fresh one (#504), without waiting for the sweep.
import { writeStamp } from '../../db/ids.ts'
import { first, runBatch, stmt } from '../../db/sql.ts'
import type { SqlValue, Stmt } from '../../db/sql.ts'
import { payloadHashOf } from '../../permissions/resolve.ts'
import type { Resolved, ResolveFacts } from '../../permissions/types.ts'
import { reserveUseSql, useDay as dayOfUse } from '../../permissions/uses.ts'
import type { ActionDetail } from '../../../shared/contract/actions.ts'
import type { StoredCard } from '../card.ts'
import { detailJson } from '../detail.ts'
import type { OperationEntry } from '../operations/types.ts'
import { actionLine, GATE_OPEN, newActionId, stamped, unreleasedUse } from '../sql.ts'
import type { Exists } from '../sql.ts'
import { timing } from '../timing.ts'
import type { OutboxActionRow, OutboxItemRow, OutboxRequestCtx, OutboxRequestResult } from '../types.ts'
import { batchStoredTitle } from '../words.ts'
import { batchPayloadHash, coalesceKeyOf, insertItemsStmt, itemByCall, newItemId } from './rows.ts'
import type { NewItem } from './rows.ts'

/** How many times an append reads the tip again after losing its compare. */
export const APPEND_TRIES = 3

/** A chat's waiting single cards of one operation past which a call collects (or is refused `too_many_waiting`). */
export const WAITING_SINGLES_MAX = 5

export interface BatchRequestDeps {
  db: D1Database
  requestId: string
  nowMs: number
  hook: (s: Stmt) => Stmt
}

/**
 * `detail` (Stage 1 M3, card details): an item's display-only detail rows from the store's answer (store.ts reads it once
 * per call), stored as `detail_json`; null when there are none.
 */
interface Call {
  ctx: OutboxRequestCtx; r: Resolved; entry: OperationEntry; rf: ResolveFacts; via: 'tool' | 'approval_request'; label: string
  detail: (args: unknown) => ActionDetail | null
}

const BATCH_COLUMNS = [
  'id', 'rev', 'state', 'verdict', 'guardrail', 'origin', 'via', 'asked_by', 'approver', 'chat_id', 'run_id', 'turn_id', 'tool_use_id', 'job_id',
  'account_id', 'account_gen', 'operation', 'policy_rev', 'scope_json', 'scope_key', 'args_json', 'payload_hash', 'records', 'units', 'card_json',
  'grant_id', 'approved_by', 'approved_rev', 'approved_at_ms', 'send_at_ms', 'expires_at_ms', 'created_at_ms', 'updated_at_ms', 'stamp',
  'kind', 'items_n', 'coalesce_key',
] as const

/** The batch row's insert, only where `also` holds, never into a deleted chat. An approved row takes the gate's epoch. */
function insertBatchRow(c: Call, b: {
  id: string; state: 'waiting' | 'approved'; verdict: 'run' | 'exact'; guardrail: string | null; toolUseId: string | null; args: unknown
  payloadHash: string; records: number; units: number; card: StoredCard; grantId: string | null; itemsN: number; coalesceKey: string | null
  nowMs: number; stamp: string
}, also: readonly Exists[], conflict: 'ignore' | 'fail'): Stmt {
  const asker = c.ctx.asker
  if (!asker) throw new Error('outbox: a batch with no asker')
  const t = timing()
  const approved = b.state === 'approved'
  const values: SqlValue[] = [
    b.id, 1, b.state, b.verdict, b.guardrail, c.ctx.origin, c.via, asker.memberId, asker.memberId, c.ctx.chatId,
    c.ctx.invocation?.runId ?? null, c.ctx.invocation?.turnId ?? null, b.toolUseId, c.ctx.jobId,
    c.r.accountId, c.r.accountGen, c.r.operation, c.r.policyRev, JSON.stringify(c.r.scope), c.r.scopeKey, JSON.stringify(b.args), b.payloadHash,
    b.records, b.units, JSON.stringify(b.card),
    b.grantId, approved ? `grant:${b.grantId}` : null, approved ? 1 : null, approved ? b.nowMs : null, approved ? b.nowMs + t.holdMs : null,
    b.nowMs + t.expiresMs, b.nowMs, b.nowMs, b.stamp,
    'batch', b.itemsN, b.coalesceKey,
  ]
  const conds = ['NOT EXISTS (SELECT 1 FROM chats WHERE id = ? AND deleted_at_ms IS NOT NULL)', ...also.map(e => `EXISTS (${e.sql})`)]
  return stmt(
    `INSERT INTO outbox_actions (${BATCH_COLUMNS.join(', ')}, approved_epoch)
     SELECT ${BATCH_COLUMNS.map(() => '?').join(', ')}, ${approved ? '(SELECT epoch FROM outbox_gate WHERE id = 1)' : 'NULL'}
     WHERE ${conds.join(' AND ')}${conflict === 'ignore' ? '\n     ON CONFLICT DO NOTHING' : ''}`,
    ...values, c.ctx.chatId, ...also.flatMap(e => e.params),
  )
}

/** The call's items, one per record (way 1), each the operation's own arguments, hashed and lined in the Worker. */
async function splitItems(c: Call): Promise<NewItem[]> {
  const split = c.entry.items
  if (!split) throw new Error(`outbox: ${c.entry.key} has no items, so a call of it can't be split`)
  const parts = split(c.r.args)
  const items: NewItem[] = []
  for (const [k, a] of parts.entries()) {
    items.push({
      itemId: newItemId(), n: k + 1, toolUseId: null, args: a,
      payloadHash: await payloadHashOf({ operation: c.r.operation, accountId: c.r.accountId, accountGen: c.r.accountGen, scope: c.r.scope, args: a }),
      line: c.entry.itemLine(a, c.rf), detail: detailJson(c.detail(a)), records: c.entry.records(a), units: c.entry.units(a),
    })
  }
  // The items must add up to the call: anything else is a bug in the entry, and nothing is written.
  const records = items.reduce((s, i) => s + i.records, 0)
  const units = items.reduce((s, i) => s + i.units, 0)
  if (items.length === 0 || records !== c.r.records || units !== c.r.units) {
    throw new Error(`outbox: ${c.entry.key} split into ${items.length} items, ${records} records and ${units} units for a call of ${c.r.records} and ${c.r.units}`)
  }
  return items
}

/** The ceiling's `batch_max` for the operation, in SQL. */
const BATCH_MAX = 'SELECT batch_max FROM permission_ceiling WHERE operation = ?'

/** Way 1's batch fits `batch_max`. */
const fitsBatchMax = (operation: string, n: number): Exists => ({ sql: `SELECT 1 WHERE ? <= (${BATCH_MAX})`, params: [n, operation] })

/** No waiting card in this chat holds the same payload (as M2's insert: a retry finds the card already there). */
const noWaitingDup = (chatId: string, payloadHash: string, nowMs: number): Exists => ({
  sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM outbox_actions WHERE chat_id = ? AND payload_hash = ? AND state = 'waiting' AND expires_at_ms > ?)",
  params: [chatId, payloadHash, nowMs],
})

export type OneCallBatch = { kind: 'run'; grantId: string; tz: string } | { kind: 'exact' }

/**
 * Way 1: the call's own batch. `run`: approved under the grant, its one use reserved for all its units first, the row only
 * where that use exists and the gate is open (the use goes again in the same batch otherwise). `exact`: a waiting `bulk`
 * card. Returns the row, or null when the insert didn't apply (the caller reads why).
 */
export async function oneCallBatch(d: BatchRequestDeps, c: Call, how: OneCallBatch): Promise<OutboxActionRow | null> {
  const items = await splitItems(c)
  const id = newActionId()
  const stamp = writeStamp(d.requestId)
  const mine = stamped(id, stamp)
  const asker = c.ctx.asker
  if (!asker) throw new Error('outbox: a batch with no asker')
  const words = c.entry.card(c.r.args, c.rf)
  const card: StoredCard = { title: words.title, lines: words.lines, label: c.label, nudge: false }
  const row = (state: 'waiting' | 'approved', verdict: 'run' | 'exact', guardrail: string | null, grantId: string | null, also: Exists[]) => insertBatchRow(c, {
    id, state, verdict, guardrail, toolUseId: c.ctx.invocation?.toolUseId ?? null, args: c.r.args, payloadHash: c.r.payloadHash,
    records: c.r.records, units: c.r.units, card, grantId, itemsN: items.length, coalesceKey: null, nowMs: d.nowMs, stamp,
  }, [noWaitingDup(c.ctx.chatId, c.r.payloadHash, d.nowMs), fitsBatchMax(c.r.operation, items.length), ...also], 'ignore')
  const line = (verdict: 'run' | 'exact', guardrail: 'bulk' | null, permissionId: string | null) => d.hook(actionLine({
    atMs: d.nowMs, actorId: asker.memberId, requestId: d.requestId,
    args: {
      action: 'action.requested', actionId: id, operation: c.r.operation, verdict, ...(guardrail ? { guardrail } : {}), origin: c.ctx.origin,
      records: c.r.records, units: c.r.units, ...(permissionId ? { permissionId } : {}),
    },
  }, mine))
  if (how.kind === 'run') {
    await runBatch(d.db, [
      reserveUseSql({ actionId: id, actionRev: 1, grantId: how.grantId, day: dayOfUse(d.nowMs, how.tz), units: c.r.units, atMs: d.nowMs }),
      row('approved', 'run', null, how.grantId, [unreleasedUse(id, 1), { sql: GATE_OPEN, params: [] }]),
      insertItemsStmt(id, c.ctx.chatId, items, d.nowMs, mine),
      // The approval covers every item, set only once they're in (the insert trigger refuses items an approval covers).
      stmt('UPDATE outbox_actions SET approved_upto = items_n WHERE id = ? AND stamp = ?', id, stamp),
      stmt('DELETE FROM permission_uses WHERE id = ? AND NOT EXISTS (SELECT 1 FROM outbox_actions WHERE id = ?)', `${id}#1`, id),
      line('run', null, how.grantId),
    ])
  } else {
    await runBatch(d.db, [
      row('waiting', 'exact', 'bulk', null, []),
      insertItemsStmt(id, c.ctx.chatId, items, d.nowMs, mine),
      line('exact', 'bulk', null),
    ])
  }
  return first<OutboxActionRow>(d.db, stmt('SELECT * FROM outbox_actions WHERE id = ? AND stamp = ?', id, stamp))
}

/** Whether way 1's batch would pass `batch_max` (the caller then refuses `batch_full`). */
export async function overBatchMax(db: D1Database, operation: string, n: number): Promise<boolean> {
  const r = await first<{ batch_max: number }>(db, stmt(BATCH_MAX, operation))
  return r === null || n > r.batch_max
}

/** A collected call's result: the batch that holds its item now, and the item. */
async function collected(db: D1Database, item: OutboxItemRow, existing: boolean): Promise<OutboxRequestResult> {
  const action = await first<OutboxActionRow>(db, stmt('SELECT * FROM outbox_actions WHERE id = ?', item.action_id))
  if (!action) throw new Error(`outbox: item ${item.item_id} sits in no batch`)
  return { outcome: 'collected', action, item, existing }
}

/** A collected call's replay: its item wherever it sits now, or null. */
export async function replayItem(db: D1Database, ctx: OutboxRequestCtx, payloadHash: string): Promise<OutboxRequestResult | 'conflict' | null> {
  if (!ctx.invocation) return null
  const item = await first<OutboxItemRow>(db, itemByCall(ctx.chatId, ctx.invocation.toolUseId))
  if (!item) return null
  return item.payload_hash === payloadHash ? collected(db, item, true) : 'conflict'
}

/** A full waiting batch for this key in this chat: the next call is refused `batch_full` until it's answered. */
const fullBatch = (c: Call, nowMs: number): Exists => ({
  sql: `SELECT 1 FROM outbox_actions WHERE chat_id = ? AND kind = 'batch' AND state = 'waiting' AND expires_at_ms > ? AND coalesce_key IS NULL
          AND tool_use_id IS NULL AND operation = ? AND account_id = ? AND account_gen = ? AND scope_key = ?
          AND items_n >= (${BATCH_MAX})`,
  params: [c.ctx.chatId, nowMs, c.r.operation, c.r.accountId, c.r.accountGen, c.r.scopeKey, c.r.operation],
})

export type CollectResult = OutboxRequestResult | { outcome: 'busy' } | { outcome: 'full' } | { outcome: 'conflict' } | { outcome: 'gone' }

/** Way 2: the call joins (or opens) the chat's collecting batch for its key, as one item holding the whole call. */
export async function collect(d: BatchRequestDeps, c: Call, guardrail: 'count' | 'bulk'): Promise<CollectResult> {
  const { db } = d
  const key = coalesceKeyOf(c.r)
  const asker = c.ctx.asker
  if (!asker) throw new Error('outbox: a batch with no asker')
  const toolUseId = c.ctx.invocation?.toolUseId ?? null
  for (let tries = 0; tries < APPEND_TRIES; tries++) {
    const replay = await replayItem(db, c.ctx, c.r.payloadHash)
    if (replay === 'conflict') return { outcome: 'conflict' }
    if (replay) return replay
    // Only a batch still within its expiry collects (#504): one past it but not yet swept keeps its key until the sweep's
    // state change clears it, takes no call (the raise below compares the expiry) and matches no payload.
    const open = await first<OutboxActionRow>(db, stmt(
      'SELECT * FROM outbox_actions WHERE chat_id = ? AND coalesce_key = ? AND expires_at_ms > ?', c.ctx.chatId, key, d.nowMs,
    ))
    if (open) {
      const dup = await first<OutboxItemRow>(db, stmt(
        "SELECT * FROM outbox_items WHERE action_id = ? AND payload_hash = ? AND state = 'pending' ORDER BY n LIMIT 1", open.id, c.r.payloadHash,
      ))
      if (dup) return collected(db, dup, true)
    } else if (await first(db, stmt(`SELECT 1 AS one WHERE EXISTS (${fullBatch(c, d.nowMs).sql})`, ...fullBatch(c, d.nowMs).params))) {
      return { outcome: 'full' }
    }
    const id = open?.id ?? newActionId()
    const tip = open?.items_n ?? 0
    const stamp = writeStamp(d.requestId)
    const mine = stamped(id, stamp)
    const itemId = newItemId()
    // This call has no row and no item yet (a replay racing it can't leave an item in two places).
    const unseen: Exists = {
      sql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM outbox_items WHERE chat_id = ? AND tool_use_id = ?)
              AND NOT EXISTS (SELECT 1 FROM outbox_actions o WHERE o.chat_id = ? AND o.tool_use_id = ?)`,
      params: [c.ctx.chatId, toolUseId, c.ctx.chatId, toolUseId],
    }
    const stmts: Stmt[] = []
    if (!open) {
      // An expired batch still holding the key stops collecting, in the same D1 batch, so the unique index lets the new
      // one open (#504). It can never take a call or an answer again, so this holds whether or not the rest applies.
      stmts.push(stmt(
        'UPDATE outbox_actions SET coalesce_key = NULL WHERE chat_id = ? AND coalesce_key = ? AND expires_at_ms <= ?', c.ctx.chatId, key, d.nowMs,
      ))
      // Opened under a stamp of its own: only the raise below marks this append as the winner.
      const card: StoredCard = { title: batchStoredTitle(c.label), lines: [], label: c.label, nudge: false }
      const full = fullBatch(c, d.nowMs)
      stmts.push(insertBatchRow(c, {
        id, state: 'waiting', verdict: 'exact', guardrail, toolUseId: null, args: null, payloadHash: batchPayloadHash(id), records: 0, units: 0,
        card, grantId: null, itemsN: 0, coalesceKey: key, nowMs: d.nowMs, stamp: writeStamp(d.requestId),
      }, [{ sql: `SELECT 1 WHERE NOT EXISTS (${full.sql})`, params: full.params }, unseen], 'ignore'))
    }
    // The compare on the tip: raised only where it's still the one read, the batch still collecting under this key for
    // this asker, under its `batch_max`, and this call has no row or item yet. At the cap the key clears.
    stmts.push(
      stmt(
        `UPDATE outbox_actions SET items_n = items_n + 1, records = records + ?, units = units + ?, updated_at_ms = ?, stamp = ?,
           coalesce_key = CASE WHEN items_n + 1 >= (${BATCH_MAX}) THEN NULL ELSE coalesce_key END
         WHERE id = ? AND items_n = ? AND state = 'waiting' AND kind = 'batch' AND coalesce_key = ? AND asked_by = ? AND expires_at_ms > ?
           AND items_n < (${BATCH_MAX})
           AND NOT EXISTS (SELECT 1 FROM chats WHERE id = outbox_actions.chat_id AND deleted_at_ms IS NOT NULL)
           AND EXISTS (${unseen.sql})`,
        c.r.records, c.r.units, d.nowMs, stamp, c.r.operation, id, tip, key, asker.memberId, d.nowMs, c.r.operation, ...unseen.params,
      ),
      insertItemsStmt(id, c.ctx.chatId, [{
        itemId, n: tip + 1, toolUseId, args: c.r.args, payloadHash: c.r.payloadHash, line: c.entry.itemLine(c.r.args, c.rf),
        detail: detailJson(c.detail(c.r.args)), records: c.r.records, units: c.r.units,
      }], d.nowMs, mine),
      d.hook(actionLine({
        atMs: d.nowMs, actorId: asker.memberId, requestId: d.requestId,
        args: { action: 'action.requested', actionId: id, operation: c.r.operation, verdict: 'exact', guardrail, origin: c.ctx.origin, records: c.r.records, units: c.r.units },
      }, mine)),
    )
    await runBatch(db, stmts)
    const item = await first<OutboxItemRow>(db, stmt('SELECT * FROM outbox_items WHERE item_id = ?', itemId))
    if (item) return collected(db, item, false)
    if (await first(db, stmt('SELECT 1 AS one FROM chats WHERE id = ? AND deleted_at_ms IS NOT NULL', c.ctx.chatId))) return { outcome: 'gone' }
    // A batch at or past `batch_max` (it may have been lowered meanwhile) stops collecting; the next try reads it full.
    if (open) {
      await runBatch(db, [stmt(
        `UPDATE outbox_actions SET coalesce_key = NULL WHERE id = ? AND coalesce_key = ? AND items_n >= (${BATCH_MAX})`, open.id, key, c.r.operation,
      )])
    }
  }
  return { outcome: 'busy' }
}
