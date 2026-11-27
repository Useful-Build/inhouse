// A person's answers to a batch (Stage 1 M3-B, N22, N33): Approve or No for the items the card showed, and a
// "Needs a check" resolved item by item.
//  - Approve what you saw: the answer carries `upTo` (at most the tip) and the totals the card showed for items 1 to
//    `upTo`. One conditional update answers `(id, upTo)` only where those totals equal the stored items' (and every one
//    of them is still pending), clears `coalesce_key` and keeps items 1 to `upTo` on the card. In the same D1 batch, the
//    items after `upTo` (added while the card was open) move to a new card that collects in its place: a No covers only
//    what it saw too. Items 1 to `upTo` can't change after it (the triggers in 0770).
//  - Resolve: one unclear item at a time; "it didn't go out" gives its units back to a grant-backed batch's use once.
//    The batch ends `sent` or `failed` once no item is unclear (or still to send).
import type { ActionAnswerTotals, ActionChoice, ActionResolution } from '../../../shared/contract/actions.ts'
import { stmt } from '../../db/sql.ts'
import type { Stmt } from '../../db/sql.ts'
import { releaseItemSql } from '../../permissions/uses.ts'
import type { OperationEntry } from '../operations/types.ts'
import { actionLine, CHAT_NOT_DELETED, GATE_OPEN, mayDo, newActionId, releaseUseWhere, stamped } from '../sql.ts'
import type { Exists } from '../sql.ts'
import { timing } from '../timing.ts'
import type { OutboxActionRow, OutboxItemRow } from '../types.ts'
import { batchPayloadHash, coalesceKeyOf } from './rows.ts'

/** Every item of the batch 1 to `upTo` is pending and the stored totals are the ones the card showed. SQL on `outbox_actions`. */
const SHOWN = `(SELECT COALESCE(SUM(i.records), 0) FROM outbox_items i WHERE i.action_id = outbox_actions.id AND i.n <= ?) = ?
  AND (SELECT COALESCE(SUM(i.units), 0) FROM outbox_items i WHERE i.action_id = outbox_actions.id AND i.n <= ?) = ?
  AND (SELECT COUNT(*) FROM outbox_items i WHERE i.action_id = outbox_actions.id AND i.n <= ?) >= 1
  AND NOT EXISTS (SELECT 1 FROM outbox_items i WHERE i.action_id = outbox_actions.id AND i.n <= ? AND i.state <> 'pending')`

/**
 * Stage 1 M3-L (N23): no item 1 to `upTo` is past the ceiling's largest single call now (`units_max` bounds one call,
 * one item, never a batch's total). SQL on `outbox_actions`.
 */
export const ITEMS_WITHIN_UNITS_MAX = `NOT EXISTS (SELECT 1 FROM outbox_items i JOIN permission_ceiling pc ON pc.operation = outbox_actions.operation
  WHERE i.action_id = outbox_actions.id AND i.n <= ? AND i.units > pc.units_max)`

export interface BatchAnswer {
  before: OutboxActionRow
  entry: OperationEntry
  actorId: string
  choice: Extract<ActionChoice, 'approve' | 'deny'>
  ifRev: number
  upTo: number
  totals: ActionAnswerTotals
  nowMs: number
  stamp: string
  requestId: string
}

/** The answer's batch. The new card's id is returned so the caller can name it. */
export function batchAnswerStmts(a: BatchAnswer, hook: (s: Stmt) => Stmt): { stmts: Stmt[]; remainderId: string } {
  const { before, nowMs, stamp } = a
  const mine = stamped(before.id, stamp)
  const approving = a.choice === 'approve'
  const shown = [a.upTo, a.totals.records, a.upTo, a.totals.units, a.upTo, a.upTo]
  const prefix = (col: 'records' | 'units') => `(SELECT COALESCE(SUM(i.${col}), 0) FROM outbox_items i WHERE i.action_id = outbox_actions.id AND i.n <= ?)`
  const answer = approving
    ? stmt(
      `UPDATE outbox_actions SET state = 'approved', rev = rev + 1, approved_by = ?, approved_rev = rev + 1, approved_at_ms = ?,
         approved_epoch = (SELECT epoch FROM outbox_gate WHERE id = 1), send_at_ms = ?, grant_id = NULL, lapsed_reason = NULL,
         approved_upto = ?, coalesce_key = NULL, items_n = ?, records = ${prefix('records')}, units = ${prefix('units')}, updated_at_ms = ?, stamp = ?
       WHERE id = ? AND rev = ? AND state = 'waiting' AND kind = 'batch' AND approver = ? AND expires_at_ms > ? AND items_n >= ?
         AND ${mayDo('?', a.entry.memberMay)} AND EXISTS (${GATE_OPEN}) AND ${CHAT_NOT_DELETED} AND ${ITEMS_WITHIN_UNITS_MAX} AND ${SHOWN}`,
      a.actorId, nowMs, nowMs + timing().holdMs, a.upTo, a.upTo, a.upTo, a.upTo, nowMs, stamp,
      before.id, a.ifRev, a.actorId, nowMs, a.upTo, a.actorId, a.upTo, ...shown,
    )
    : stmt(
      `UPDATE outbox_actions SET state = 'denied', rev = rev + 1, coalesce_key = NULL, items_n = ?, records = ${prefix('records')},
         units = ${prefix('units')}, updated_at_ms = ?, stamp = ?
       WHERE id = ? AND rev = ? AND state = 'waiting' AND kind = 'batch' AND approver = ? AND items_n >= ?
         AND EXISTS (SELECT 1 FROM members m WHERE m.id = ? AND m.kind = 'person' AND m.status = 'active') AND ${CHAT_NOT_DELETED} AND ${SHOWN}`,
      a.upTo, a.upTo, a.upTo, nowMs, stamp, before.id, a.ifRev, a.actorId, a.upTo, a.actorId, ...shown,
    )
  const remainderId = newActionId()
  const stmts: Stmt[] = [
    answer,
    ...remainderStmts({ from: before, upTo: a.upTo, newId: remainderId, onlyIf: mine, nowMs, stamp, actorId: a.actorId, requestId: a.requestId }),
  ]
  // A No is final: only now, with the items after `upTo` gone to their new card, so the trigger withdraws only the
  // items the person said no to.
  if (!approving) stmts.push(stmt('UPDATE outbox_actions SET final_at_ms = ? WHERE id = ? AND stamp = ?', nowMs, before.id, stamp))
  stmts.push(hook(actionLine({
    atMs: nowMs, actorId: a.actorId, requestId: a.requestId, args: { action: 'action.answered', actionId: before.id, choice: a.choice, upTo: a.upTo },
  }, mine)))
  return { stmts, remainderId }
}

/**
 * The items after `upTo` of `from` (pending ones only) to a new waiting batch, in place: their ids and calls kept,
 * `action_id` and `n` renumbered from 1, `moved_from` set. The new card collects under the batch's key unless another
 * row holds it. Only where `onlyIf` holds and there is such an item.
 */
function remainderStmts(p: {
  from: OutboxActionRow; upTo: number; newId: string; onlyIf: Exists; nowMs: number; stamp: string; actorId: string; requestId: string
}): Stmt[] {
  const key = coalesceKeyOf({ operation: p.from.operation, accountId: p.from.account_id, accountGen: p.from.account_gen, scopeKey: p.from.scope_key })
  const after = "FROM outbox_items i WHERE i.action_id = o.id AND i.n > ? AND i.state = 'pending'"
  return [
    stmt(
      `INSERT INTO outbox_actions (id, rev, state, verdict, guardrail, origin, via, asked_by, approver, chat_id, run_id, turn_id, tool_use_id, job_id,
         account_id, account_gen, operation, policy_rev, scope_json, scope_key, args_json, payload_hash, records, units, card_json,
         expires_at_ms, created_at_ms, updated_at_ms, stamp, kind, items_n, coalesce_key)
       SELECT ?, 1, 'waiting', 'exact', o.guardrail, o.origin, o.via, o.asked_by, o.approver, o.chat_id, o.run_id, o.turn_id, NULL, o.job_id,
         o.account_id, o.account_gen, o.operation, o.policy_rev, o.scope_json, o.scope_key, 'null', ?,
         (SELECT SUM(i.records) ${after}), (SELECT SUM(i.units) ${after}), json_set(o.card_json, '$.title', 'Changes in ' || json_extract(o.card_json, '$.label'), '$.lines', json('[]')),
         ?, ?, ?, ?, 'batch', (SELECT MAX(i.n) - ? ${after}),
         CASE WHEN EXISTS (SELECT 1 FROM outbox_actions k WHERE k.chat_id = o.chat_id AND k.coalesce_key = ?) THEN NULL ELSE ? END
       FROM outbox_actions o WHERE o.id = ? AND EXISTS (${p.onlyIf.sql}) AND EXISTS (SELECT 1 ${after})`,
      p.newId, batchPayloadHash(p.newId), p.upTo, p.upTo, p.nowMs + timing().expiresMs, p.nowMs, p.nowMs, p.stamp, p.upTo, p.upTo,
      key, key, p.from.id, ...p.onlyIf.params, p.upTo,
    ),
    stmt(
      `UPDATE outbox_items SET action_id = ?, n = n - ?, moved_from = ?, updated_at_ms = ?
       WHERE action_id = ? AND n > ? AND state = 'pending' AND EXISTS (SELECT 1 FROM outbox_actions WHERE id = ? AND stamp = ?)`,
      p.newId, p.upTo, p.from.id, p.nowMs, p.from.id, p.upTo, p.newId, p.stamp,
    ),
    stmt(
      `INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id)
       SELECT ?, ?, 'action.requested', 'action', a.id, json_object('actionId', a.id, 'operation', a.operation, 'verdict', 'exact',
         'guardrail', a.guardrail, 'origin', a.origin, 'records', a.records, 'units', a.units), ?
       FROM outbox_actions a WHERE a.id = ? AND a.stamp = ? AND a.guardrail IS NOT NULL`,
      p.nowMs, p.actorId, p.requestId, p.newId, p.stamp,
    ),
  ]
}

/**
 * A batch ends once no item is pending, sending or unclear: `sent` if any item went out (its ref counts them against
 * what the approval covered, in server words: "48 of 50 went out", "2 of 5 went out; the other 3 moved to a new card
 * for a new OK"); `failed` if none did and one failed; `withdrawn` if none was sent or failed (every item
 * moved to a new card or was withdrawn when the batch stopped, its `lapsed_reason` saying why). Only where `onlyIf`
 * holds and the row is in `from`. A batch that ends `failed` or `withdrawn` gives its whole use back (`release`, to run
 * after any line that reads whether it was held).
 */
export function endBatchStmts(p: {
  row: Pick<OutboxActionRow, 'id' | 'approved_rev'>; from: 'sending' | 'needs_check'; onlyIf: Exists; nowMs: number; requestId: string; stamp: string
}): { end: Stmt; release: Stmt | null } {
  const open = "SELECT 1 FROM outbox_items i WHERE i.action_id = outbox_actions.id AND i.state IN ('pending', 'sending', 'needs_check')"
  const count = (state: string) => `(SELECT COUNT(*) FROM outbox_items i WHERE i.action_id = outbox_actions.id AND i.state = '${state}')`
  // Counted against what the approval covered (#501): items that moved to a new card when the batch stopped are named
  // as such, never left out of the count.
  const total = 'COALESCE(approved_upto, (SELECT COUNT(*) FROM outbox_items i WHERE i.action_id = outbox_actions.id))'
  const moved = `(${total} - (SELECT COUNT(*) FROM outbox_items i WHERE i.action_id = outbox_actions.id))`
  const ended = stamped(p.row.id, p.stamp)
  const useRev = p.row.approved_rev
  return {
    end: stmt(
      `UPDATE outbox_actions SET state = CASE WHEN ${count('sent')} > 0 THEN 'sent' WHEN ${count('failed')} > 0 THEN 'failed' ELSE 'withdrawn' END,
         rev = rev + 1,
         result_json = CASE WHEN ${count('sent')} > 0 THEN json_object('ref', ${count('sent')} || ' of ' || ${total} || ' went out'
           || CASE WHEN ${moved} > 0 THEN '; the other ' || ${moved} || ' moved to a new card for a new OK' ELSE '' END) ELSE NULL END,
         error_code = CASE WHEN ${count('sent')} > 0 OR ${count('failed')} = 0 THEN NULL
           ELSE COALESCE((SELECT i.error_code FROM outbox_items i WHERE i.action_id = outbox_actions.id AND i.state = 'failed'
             AND i.error_code IS NOT NULL ORDER BY i.n LIMIT 1), 'internal') END,
         final_at_ms = ?, updated_at_ms = ?, stamp = ?
       WHERE id = ? AND state = ? AND kind = 'batch' AND NOT EXISTS (${open}) AND EXISTS (${p.onlyIf.sql})`,
      p.nowMs, p.nowMs, p.stamp, p.row.id, p.from, ...p.onlyIf.params,
    ),
    release: useRev === null ? null : releaseUseWhere(
      { actionId: p.row.id, actionRev: useRev, reason: 'failed', atMs: p.nowMs },
      { sql: `${ended.sql} AND state IN ('failed', 'withdrawn')`, params: ended.params },
    ),
  }
}

/** `endBatchStmts` as a list, the end first. */
export function endBatchList(p: Parameters<typeof endBatchStmts>[0]): Stmt[] {
  const e = endBatchStmts(p)
  return e.release ? [e.end, e.release] : [e.end]
}

/** One unclear item resolved: the batch's revision moves (the person's `ifRev`), then the item, then maybe the batch's end. */
export function resolveItemStmts(p: {
  before: OutboxActionRow; item: Pick<OutboxItemRow, 'n' | 'units'>; outcome: ActionResolution; ifRev: number; actorId: string; nowMs: number
  stamp: string; requestId: string; hook: (s: Stmt) => Stmt
}): Stmt[] {
  const { before, nowMs, stamp } = p
  const mine = stamped(before.id, stamp)
  const useRev = before.approved_rev
  const itemNow = (state: string): Exists => ({
    sql: `${mine.sql} AND EXISTS (SELECT 1 FROM outbox_items WHERE action_id = ? AND n = ? AND state = '${state}' AND resolved_at_ms = ?)`,
    params: [...mine.params, before.id, p.item.n, nowMs],
  })
  const line = (released: boolean, onlyIf: Exists) => p.hook(actionLine({
    atMs: nowMs, actorId: p.actorId, requestId: p.requestId, args: { action: 'action.resolved', actionId: before.id, outcome: p.outcome, released, item: p.item.n },
  }, onlyIf))
  const itemUse: Exists = { sql: 'SELECT 1 FROM permission_uses WHERE id = ? AND released_at_ms IS NULL', params: [`${before.id}#${useRev ?? 0}`] }
  return [
    stmt(
      `UPDATE outbox_actions SET rev = rev + 1, resolved_by = ?, resolved_at_ms = ?, updated_at_ms = ?, stamp = ?
       WHERE id = ? AND rev = ? AND state = 'needs_check' AND kind = 'batch'
         AND EXISTS (SELECT 1 FROM members m WHERE m.id = ? AND m.kind = 'person' AND m.status = 'active'
           AND (m.id = outbox_actions.approver OR m.role = 'admin'))
         AND EXISTS (SELECT 1 FROM outbox_items i WHERE i.action_id = outbox_actions.id AND i.n = ? AND i.state = 'needs_check')`,
      p.actorId, nowMs, nowMs, stamp, before.id, p.ifRev, p.actorId, p.item.n,
    ),
    stmt(
      `UPDATE outbox_items SET state = ?, resolved_by = ?, resolved_at_ms = ?, updated_at_ms = ?
       WHERE action_id = ? AND n = ? AND state = 'needs_check' AND EXISTS (${mine.sql})`,
      p.outcome, p.actorId, nowMs, nowMs, before.id, p.item.n, ...mine.params,
    ),
    // The line's `released` is decided before the release, in SQL: this item gave units back only from a live use.
    ...(p.outcome === 'failed' && useRev !== null
      ? [
        line(true, { sql: `${itemNow('failed').sql} AND EXISTS (${itemUse.sql})`, params: [...itemNow('failed').params, ...itemUse.params] }),
        line(false, { sql: `${itemNow('failed').sql} AND NOT EXISTS (${itemUse.sql})`, params: [...itemNow('failed').params, ...itemUse.params] }),
        releaseItemSql({ actionId: before.id, actionRev: useRev, n: p.item.n, units: p.item.units, reason: 'failed', atMs: nowMs }, itemNow('failed')),
      ]
      : [line(false, itemNow(p.outcome))]),
    ...endBatchList({ row: before, from: 'needs_check', onlyIf: mine, nowMs, requestId: p.requestId, stamp }),
  ]
}
