// A batch's send (Stage 1 M3-B, N22), inside the same `outbox-send:<id>` task as a single action (dispatch.ts hands a
// batch row here). Its steps:
//  1. After the hold the batch is claimed once (`approved` to `sending`, all of N11: the gate at the approval's epoch and
//     the object's pause generation, the hold, the approval's age, and the whole `claimGuardSql` with the largest item's
//     records and units, since `units_max` bounds one call). Refused: it lapses back to waiting, or is withdrawn, as M2.
//  2. Then the items, in order. A pass stops after 20 items or 10 s, whichever is first, and runs again 1 s later. Each:
//     a. the item's claim: one conditional update `pending` to `sending` whose WHERE is the batch still `sending`, the
//        item within `approved_upto` and past its `not_before_ms`, the gate checks, the chat kept, the shop kept, and the
//        whole `claimGuardSql` over the batch with the item's own records and units, the grant's use for
//        `(id, approved_rev)` among it. A revoke that commits before an item's claim wins;
//     b. the permit: the object's pause flag and generation read again, no await before the hub call;
//     c. one hub call: `item: { n, of }`, `requestId = <id>:<n>`, `idempotencyKey = <id>:<n>`, the account generation and,
//        for every Shopify operation, the shop;
//     d. the result, compared on the item's attempt: `ok` is `sent`; `rate_limited` with `sent: 'no'` (nothing ran) goes
//        back to `pending` after the wait it names (clamped), `failed` after 5 such answers; any other `sent: 'no'` is
//        `failed`; anything unclear is `needs_check`. A failed item gives its units back to a grant-backed batch's use,
//        once (`permission_item_releases`).
//     A Pause after an item's permit can't recall that call; it stops every later item.
//  3. A refused item claim stops the batch: the pending items a person could still approve (a Pause, a revoke, the
//     approver's role dropped, the ceiling lowered) move to a new waiting card, with no `coalesce_key` and the reason; the
//     pending items that can never be approved (the asker removed, the chat deleted, the account or the policy changed:
//     M2's withdrawals) are `withdrawn`. Either gives their units back once. Items in `sending` keep their call's result.
//  4. The batch ends once no item is pending or sending: `needs_check` while any item is unclear; else `sent` if any
//     went out (its ref counts them), `failed` (its use given back) if none did.
import type { WriteRequest } from '../../../hub/index/contract.ts'
import { SYSTEM_MEMBER_ID, writeStamp } from '../../db/ids.ts'
import { first, runBatch, stmt } from '../../db/sql.ts'
import type { SqlValue, Stmt } from '../../db/sql.ts'
import { claimGuardSql } from '../../permissions/claim-guard.ts'
import { releaseItemSql } from '../../permissions/uses.ts'
import { safeError } from '../../safe-error.ts'
import { CHAT_KEPT, lapseStmts, SHOP_KEPT, whyRefused } from '../claim.ts'
import type { ClaimRefusal } from '../claim.ts'
import type { DispatchDeps } from '../dispatch.ts'
import { expectOf, outcomeOf, requestArgs, startCall, THROTTLE_WAIT_MS } from '../hub-call.ts'
import type { SendOutcome } from '../hub-call.ts'
import { notifyAll } from '../notify.ts'
import { actionLine, both, butNot, newActionId, releaseUseWhere, stamped, unreleasedUse } from '../sql.ts'
import type { Exists, LapseReason } from '../sql.ts'
import { timing } from '../timing.ts'
import type { OutboxActionRow, OutboxItemRow } from '../types.ts'
import { batchStoppedText, LAPSE_TEXT, NEEDS_CHECK_TEXT, WITHDRAWN_TEXT } from '../words.ts'
import { endBatchList, endBatchStmts } from './answer.ts'
import { batchPayloadHash, releaseItemsStmt } from './rows.ts'

/** A pass sends at most this many items, for at most this long, then runs again this much later (#433's per-pass cap). */
export const PASS_ITEMS = 20
export const PASS_MS = 10_000
export const PASS_GAP_MS = 1_000
/** Throttled answers after which an item is `failed`. */
export const THROTTLES_MAX = 5
/** Room left after the hub's limit for the result's own D1 write (dispatch.ts's, for an item's permit). */
const PERMIT_MARGIN_MS = 5_000

const who = (d: Pick<DispatchDeps, 'requestId'>, atMs: number) => ({ atMs, actorId: SYSTEM_MEMBER_ID, requestId: d.requestId })
const rowOf = (db: D1Database, id: string) => first<OutboxActionRow>(db, stmt('SELECT * FROM outbox_actions WHERE id = ?', id))
const itemOf = (db: D1Database, itemId: string) => first<OutboxItemRow>(db, stmt('SELECT * FROM outbox_items WHERE item_id = ?', itemId))

/** The guard's columns over a batch row, with `units` and `records` given by `counts` (SQL over `b`). */
const guardFrom = (counts: string, where: string) =>
  `SELECT b.id, b.approved_rev AS rev, b.operation, b.policy_rev, b.account_id, b.account_gen, b.asked_by, b.scope_json, b.grant_id,
     b.origin, b.scope_key, b.approved_by, ${counts} FROM outbox_actions b ${where}`

/** The gate open at the approval's epoch and the dispatcher's own pause generation (one `?`), SQL on `outbox_actions`. */
const GATE_AT_EPOCH = `EXISTS (SELECT 1 FROM outbox_gate gt WHERE gt.id = 1 AND gt.paused = 0 AND gt.restore_hold = 0
  AND gt.epoch = outbox_actions.approved_epoch AND gt.do_gen = ?)`

/**
 * Step 1, the batch's claim. The guard sees the largest item's units and records: `units_max` bounds one call (an item),
 * never the batch's total; the claim of each item checks its own again.
 */
export function batchClaimStmt(p: { actionId: string; nowMs: number; pauseGen: number; stamp: string }): Stmt {
  const guard = claimGuardSql('ba')
  const counts = `(SELECT MAX(i.units) FROM outbox_items i WHERE i.action_id = b.id AND i.n <= b.approved_upto) AS units,
     (SELECT MAX(i.records) FROM outbox_items i WHERE i.action_id = b.id AND i.n <= b.approved_upto) AS records`
  // Before the claim, the approved revision is the row's own: the guard's `rev` is `approved_rev`.
  return stmt(
    `UPDATE outbox_actions SET state = 'sending', rev = rev + 1, attempt = attempt + 1, claimed_at_ms = ?, updated_at_ms = ?, stamp = ?
     WHERE id = ? AND kind = 'batch' AND state = 'approved' AND approved_rev = rev AND approved_upto IS NOT NULL AND send_at_ms <= ? AND approved_at_ms > ?
       AND ${GATE_AT_EPOCH} AND ${CHAT_KEPT} AND ${SHOP_KEPT}
       AND EXISTS (SELECT 1 FROM (${guardFrom(counts, 'WHERE b.id = ?')}) AS ba WHERE ${guard.sql})`,
    p.nowMs, p.nowMs, p.stamp, p.actionId, p.nowMs, p.nowMs - timing().approvalMaxAgeMs, p.pauseGen, p.actionId, ...(guard.params as SqlValue[]),
  )
}

/** Step 2a, one item's claim. */
export function itemClaimStmt(p: { actionId: string; itemId: string; nowMs: number; pauseGen: number; stamp: string }): Stmt {
  const guard = claimGuardSql('ba')
  return stmt(
    `UPDATE outbox_items SET state = 'sending', attempt = attempt + 1, claimed_at_ms = ?, updated_at_ms = ?, stamp = ?
     WHERE item_id = ? AND action_id = ? AND state = 'pending' AND (not_before_ms IS NULL OR not_before_ms <= ?)
       AND EXISTS (SELECT 1 FROM outbox_actions WHERE id = ? AND kind = 'batch' AND state = 'sending' AND outbox_items.n <= approved_upto
         AND ${GATE_AT_EPOCH} AND ${CHAT_KEPT} AND ${SHOP_KEPT}
         AND EXISTS (SELECT 1 FROM (${guardFrom('i.units, i.records', 'JOIN outbox_items i ON i.action_id = b.id WHERE b.id = ? AND i.item_id = ?')}) AS ba
           WHERE ${guard.sql}))`,
    p.nowMs, p.nowMs, p.stamp, p.itemId, p.actionId, p.nowMs, p.actionId, p.pauseGen, p.actionId, p.itemId, ...(guard.params as SqlValue[]),
  )
}

/**
 * Why an item's claim was refused, read as the claim of a single action with the item's records and units at the
 * batch's approved revision (claim.ts `whyRefused`, in the claim's own order). Throws when nothing explains it.
 */
async function whyItemRefused(db: D1Database, batch: OutboxActionRow, item: OutboxItemRow, nowMs: number, pauseGen: number): Promise<ClaimRefusal> {
  const asItsCall: OutboxActionRow = {
    ...batch, state: 'approved', rev: batch.approved_rev ?? batch.rev, send_at_ms: nowMs, approved_at_ms: nowMs, units: item.units, records: item.records,
  }
  return whyRefused(db, asItsCall, nowMs, pauseGen)
}

/** One batch item's write request (step 2c). */
export function itemRequest(batch: OutboxActionRow, item: OutboxItemRow): WriteRequest {
  if (batch.approved_upto === null) throw new Error(`outbox: batch ${batch.id} has no approval to send under`)
  const scope = JSON.parse(batch.scope_json) as Record<string, string>
  return {
    actionId: batch.id, attempt: item.attempt, requestId: `${batch.id}:${item.n}`, accountId: batch.account_id,
    expect: expectOf(batch.operation, batch.account_gen, scope, batch.id),
    operation: batch.operation,
    args: requestArgs(batch.operation, scope, JSON.parse(item.args_json) as Record<string, unknown>),
    item: { n: item.n, of: batch.approved_upto },
    idempotencyKey: `${batch.id}:${item.n}`,
  }
}

const clampWait = (ms: number | undefined) => Math.min(THROTTLE_WAIT_MS.max, Math.max(THROTTLE_WAIT_MS.min, ms ?? THROTTLE_WAIT_MS.default))

/**
 * Step 2d: one item's result, compared on its attempt, from `sending` (or, a late result, from an unresolved
 * `needs_check`; `needs_check` itself only from `sending`). Returns whether it applied.
 */
async function storeItem(d: Pick<DispatchDeps, 'db' | 'requestId'>, batch: OutboxActionRow, item: OutboxItemRow, outcome: SendOutcome, nowMs: number, late: boolean): Promise<boolean> {
  if (outcome.kind === 'not_claimed') return false
  const stamp = writeStamp(d.requestId)
  const from = late ? "(state = 'sending' OR (state = 'needs_check' AND resolved_by IS NULL))" : "state = 'sending'"
  const now = (state: string): Exists => ({ sql: `SELECT 1 FROM outbox_items WHERE item_id = ? AND stamp = ? AND state = '${state}'`, params: [item.item_id, stamp] })
  const release = releaseItemSql(
    { actionId: batch.id, actionRev: batch.approved_rev ?? 0, n: item.n, units: item.units, reason: 'failed', atMs: nowMs }, now('failed'),
  )
  const stmts: Stmt[] = []
  if (outcome.kind === 'sent') {
    stmts.push(stmt(
      `UPDATE outbox_items SET state = 'sent', result_json = ?, error_code = NULL, updated_at_ms = ?, stamp = ? WHERE item_id = ? AND attempt = ? AND ${from}`,
      JSON.stringify({ ref: outcome.ref }), nowMs, stamp, item.item_id, item.attempt,
    ))
  } else if (outcome.kind === 'failed' && outcome.code === 'rate_limited' && !late) {
    // Throttled: nothing ran. Back to pending after the wait, until the 5th such answer.
    stmts.push(stmt(
      `UPDATE outbox_items SET throttles = throttles + 1, claimed_at_ms = NULL, updated_at_ms = ?, stamp = ?,
         state = CASE WHEN throttles + 1 >= ? THEN 'failed' ELSE 'pending' END,
         error_code = CASE WHEN throttles + 1 >= ? THEN 'rate_limited' ELSE NULL END,
         not_before_ms = CASE WHEN throttles + 1 >= ? THEN not_before_ms ELSE ? END
       WHERE item_id = ? AND attempt = ? AND state = 'sending'`,
      nowMs, stamp, THROTTLES_MAX, THROTTLES_MAX, THROTTLES_MAX, nowMs + clampWait(outcome.retryAfterMs), item.item_id, item.attempt,
    ), release)
  } else if (outcome.kind === 'failed') {
    stmts.push(stmt(
      `UPDATE outbox_items SET state = 'failed', error_code = ?, updated_at_ms = ?, stamp = ? WHERE item_id = ? AND attempt = ? AND ${from}`,
      outcome.code, nowMs, stamp, item.item_id, item.attempt,
    ), release)
  } else {
    stmts.push(
      stmt(`UPDATE outbox_items SET state = 'needs_check', updated_at_ms = ?, stamp = ? WHERE item_id = ? AND attempt = ? AND state = 'sending'`,
        nowMs, stamp, item.item_id, item.attempt),
      actionLine({ ...who(d, nowMs), args: { action: 'action.needs_check', actionId: batch.id, attempt: item.attempt, why: outcome.why, item: item.n } }, now('needs_check')),
    )
  }
  await runBatch(d.db, stmts)
  return (await itemOf(d.db, item.item_id))?.stamp === stamp
}

/**
 * Step 4: the batch's end, once no item is pending or sending. Its lines are built in SQL from the row (ids, counts and a
 * closed code only). Returns the row after.
 */
async function endBatch(d: Pick<DispatchDeps, 'db' | 'requestId' | 'notify'>, batch: OutboxActionRow, nowMs: number): Promise<OutboxActionRow | null> {
  const stamp = writeStamp(d.requestId)
  const id = batch.id
  const open = "SELECT 1 FROM outbox_items i WHERE i.action_id = outbox_actions.id AND i.state IN ('pending', 'sending')"
  const count = (state: string) => `(SELECT COUNT(*) FROM outbox_items i WHERE i.action_id = a.id AND i.state = '${state}')`
  const line = (action: string, state: 'sent' | 'failed' | 'withdrawn', args: string) => stmt(
    `INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id)
     SELECT ?, ?, ?, 'action', a.id, ${args}, ? FROM outbox_actions a WHERE a.id = ? AND a.stamp = ? AND a.state = ?`,
    nowMs, SYSTEM_MEMBER_ID, action, d.requestId, id, stamp, state,
  )
  const held = "json(CASE WHEN EXISTS (SELECT 1 FROM permission_uses u WHERE u.id = a.id || '#' || a.approved_rev AND u.released_at_ms IS NULL) THEN 'true' ELSE 'false' END)"
  const end = endBatchStmts({ row: batch, from: 'sending', onlyIf: { sql: 'SELECT 1', params: [] }, nowMs, requestId: d.requestId, stamp })
  await runBatch(d.db, [
    stmt(
      `UPDATE outbox_actions SET state = 'needs_check', rev = rev + 1, updated_at_ms = ?, stamp = ?
       WHERE id = ? AND state = 'sending' AND kind = 'batch' AND NOT EXISTS (${open})
         AND EXISTS (SELECT 1 FROM outbox_items i WHERE i.action_id = outbox_actions.id AND i.state = 'needs_check')`,
      nowMs, stamp, id,
    ),
    end.end,
    line('action.sent', 'sent', `json_object('actionId', a.id, 'attempt', a.attempt, 'items', json_object('sent', ${count('sent')}, 'failed', ${count('failed')}))`),
    // `released` decided before the release: whether the whole use was still held.
    line('action.failed', 'failed', `json_object('actionId', a.id, 'attempt', a.attempt, 'code', a.error_code, 'released', ${held})`),
    // Every item moved to a new card or was withdrawn when the batch stopped: it lapses in place, for the stop's reason.
    line('action.lapsed', 'withdrawn', `json_object('actionId', a.id, 'reason', a.lapsed_reason, 'released', ${held})`),
    ...(end.release ? [end.release] : []),
  ])
  const after = await rowOf(d.db, id)
  if (after?.stamp === stamp && after.state === 'needs_check') {
    await notifyAll(d.notify, [{ kind: 'needs_check', to: after.approver, actionId: id, key: `needs_check:${id}:${after.attempt}`, body: NEEDS_CHECK_TEXT }])
  }
  return after
}

/**
 * Step 3: a refused item claim (or a Pause at an item's permit) stops the batch. Its pending items move to a new
 * waiting card (`lapse`) or are withdrawn (`withdraw`), their units given back once; then the batch ends if nothing of it
 * is in flight. Everything is decided in SQL inside one D1 batch from the items pending at that moment (never a list
 * read before it: an item another pass sends back to pending, or claims, in between would be counted on the wrong card).
 * The items move in two steps: first marked with this stop's stamp, then moved and numbered 1 to k in their order, the
 * numbers taken from a materialised ranking of the marked items.
 */
export async function stopBatch(d: Pick<DispatchDeps, 'db' | 'requestId' | 'notify'>, batch: OutboxActionRow, how: 'lapse' | 'withdraw', reason: LapseReason, nowMs: number): Promise<void> {
  const { db } = d
  const stamp = writeStamp(d.requestId)
  const mine = stamped(batch.id, stamp)
  const useRev = batch.approved_rev ?? batch.rev
  const newId = newActionId()
  const marked = "FROM outbox_items i WHERE i.action_id = ? AND i.stamp = ? AND i.state = 'pending'"
  const stmts: Stmt[] = [
    stmt(
      "UPDATE outbox_actions SET stamp = ?, lapsed_reason = ?, updated_at_ms = ? WHERE id = ? AND state = 'sending' AND attempt = ?",
      stamp, reason, nowMs, batch.id, batch.attempt,
    ),
    // The items this stop takes: the ones pending now.
    stmt(
      "UPDATE outbox_items SET stamp = ? WHERE action_id = ? AND state = 'pending' AND EXISTS (SELECT 1 FROM outbox_actions WHERE id = ? AND stamp = ?)",
      stamp, batch.id, batch.id, stamp,
    ),
    releaseItemsStmt({
      actionId: batch.id, useRev, reason: how === 'lapse' ? 'moved' : 'withdrawn', atMs: nowMs,
      itemWhere: { sql: "i.state = 'pending' AND i.stamp = ?", params: [stamp] }, onlyIf: mine,
    }),
  ]
  if (how === 'lapse') {
    stmts.push(
      stmt(
        `INSERT INTO outbox_actions (id, rev, state, verdict, guardrail, origin, via, asked_by, approver, chat_id, run_id, turn_id, tool_use_id, job_id,
           account_id, account_gen, operation, policy_rev, scope_json, scope_key, args_json, payload_hash, records, units, card_json, lapsed_reason,
           expires_at_ms, created_at_ms, updated_at_ms, stamp, kind, items_n)
         SELECT ?, 1, 'waiting', 'exact', o.guardrail, o.origin, o.via, o.asked_by, o.approver, o.chat_id, o.run_id, o.turn_id, NULL, o.job_id,
           o.account_id, o.account_gen, o.operation, o.policy_rev, o.scope_json, o.scope_key, 'null', ?,
           (SELECT SUM(i.records) ${marked}), (SELECT SUM(i.units) ${marked}),
           json_set(o.card_json, '$.title', 'Changes in ' || json_extract(o.card_json, '$.label'), '$.lines', json('[]')), ?, ?, ?, ?, ?, 'batch',
           (SELECT COUNT(*) ${marked})
         FROM outbox_actions o WHERE o.id = ? AND o.stamp = ? AND EXISTS (SELECT 1 ${marked})`,
        newId, batchPayloadHash(newId), batch.id, stamp, batch.id, stamp, reason, nowMs + timing().expiresMs, nowMs, nowMs, stamp,
        batch.id, stamp, batch.id, stamp, batch.id, stamp,
      ),
      stmt(
        `UPDATE outbox_items SET action_id = ?, moved_from = ?, updated_at_ms = ?, n = r.k
         FROM (SELECT item_id, ROW_NUMBER() OVER (ORDER BY n) AS k FROM outbox_items WHERE action_id = ? AND stamp = ? AND state = 'pending') AS r
         WHERE outbox_items.item_id = r.item_id AND EXISTS (SELECT 1 FROM outbox_actions WHERE id = ? AND stamp = ?)`,
        newId, batch.id, nowMs, batch.id, stamp, newId, stamp,
      ),
      // The new card's request line, built in SQL from its row (ids, counts and closed codes only; no guardrail when the
      // batch ran under a grant).
      stmt(
        `INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id)
         SELECT ?, ?, 'action.requested', 'action', a.id,
           json_remove(json_object('actionId', a.id, 'operation', a.operation, 'verdict', 'exact', 'guardrail', a.guardrail, 'origin', a.origin,
             'records', a.records, 'units', a.units), CASE WHEN a.guardrail IS NULL THEN '$.guardrail' ELSE '$.none' END), ?
         FROM outbox_actions a WHERE a.id = ? AND a.stamp = ?`,
        nowMs, SYSTEM_MEMBER_ID, d.requestId, newId, stamp,
      ),
    )
  } else {
    stmts.push(stmt(
      "UPDATE outbox_items SET state = 'withdrawn', updated_at_ms = ? WHERE action_id = ? AND stamp = ? AND state = 'pending'",
      nowMs, batch.id, stamp,
    ))
  }
  // #501: the card's count and totals are what stayed on it (as an answer's split leaves them); `approved_upto` keeps
  // what the approval covered, so the end can say how many moved.
  const on = 'FROM outbox_items i WHERE i.action_id = outbox_actions.id'
  stmts.push(stmt(
    `UPDATE outbox_actions SET items_n = (SELECT COALESCE(MAX(i.n), 0) ${on}), records = (SELECT COALESCE(SUM(i.records), 0) ${on}),
       units = (SELECT COALESCE(SUM(i.units), 0) ${on})
     WHERE id = ? AND stamp = ?`,
    batch.id, stamp,
  ))
  await runBatch(db, stmts)
  const after = await rowOf(db, batch.id)
  if (after?.stamp !== stamp) return
  const counts = await first<{ sent: number; total: number; left: number }>(db, stmt(
    `SELECT SUM(state = 'sent') AS sent, COUNT(*) AS total, SUM(stamp = ? AND (state = 'withdrawn' OR action_id <> ?)) AS left
     FROM outbox_items WHERE action_id = ? OR moved_from = ?`,
    stamp, batch.id, batch.id, batch.id,
  ))
  const left = counts?.left ?? 0
  const moved = await first<{ id: string }>(db, stmt('SELECT id FROM outbox_actions WHERE id = ? AND stamp = ?', newId, stamp))
  console.log({ event: 'outbox_batch_stopped', actionId: batch.id, reason, how, left })
  // A deleted chat's actions are its owner's own doing: no notice (as its deletion's batch, #444).
  if (reason !== 'chat_deleted' && left > 0) {
    const why = (how === 'withdraw' ? WITHDRAWN_TEXT[reason] : undefined) ?? LAPSE_TEXT[reason]
    await notifyAll(d.notify, [{
      kind: 'approval_lapsed', to: batch.approver, actionId: moved ? newId : batch.id, key: `stopped:${batch.id}:${batch.attempt}`,
      body: batchStoppedText({ sent: counts?.sent ?? 0, total: counts?.total ?? 0, left, moved: moved !== null, why }),
    }])
  }
}

/** Every pending item of a sending batch fails with `code` (nothing sent), its units given back once. */
async function failPending(d: Pick<DispatchDeps, 'db' | 'requestId'>, batch: OutboxActionRow, code: 'not_configured', nowMs: number): Promise<void> {
  const stamp = writeStamp(d.requestId)
  const mine = stamped(batch.id, stamp)
  await runBatch(d.db, [
    stmt("UPDATE outbox_actions SET stamp = ?, updated_at_ms = ? WHERE id = ? AND state = 'sending' AND attempt = ?", stamp, nowMs, batch.id, batch.attempt),
    releaseItemsStmt({ actionId: batch.id, useRev: batch.approved_rev ?? batch.rev, reason: 'failed', atMs: nowMs, itemWhere: { sql: "i.state = 'pending'", params: [] }, onlyIf: mine }),
    stmt(
      "UPDATE outbox_items SET state = 'failed', error_code = ?, updated_at_ms = ? WHERE action_id = ? AND state = 'pending' AND EXISTS (SELECT 1 FROM outbox_actions WHERE id = ? AND stamp = ?)",
      code, nowMs, batch.id, batch.id, stamp,
    ),
  ])
}

/** The end of a call that timed out: a sure late answer may still settle the item while no person resolved it. */
function settleLate(d: DispatchDeps, batch: OutboxActionRow, item: OutboxItemRow, settled: Promise<Parameters<typeof outcomeOf>[0]>): void {
  const lateResult = settled.then(async a => {
    const o = outcomeOf(a)
    if (o.kind !== 'sent' && o.kind !== 'failed') return
    const stored = await storeItem(d, batch, item, o, Date.now(), true)
    console.log({ event: 'outbox_late_result', actionId: batch.id, item: item.n, attempt: item.attempt, outcome: o.kind, stored })
    if (stored) {
      const fresh = await rowOf(d.db, batch.id)
      if (fresh && fresh.state === 'needs_check') {
        const stamp = writeStamp(d.requestId)
        await runBatch(d.db, [
          stmt('UPDATE outbox_actions SET stamp = ? WHERE id = ? AND state = ? AND rev = ?', stamp, fresh.id, 'needs_check', fresh.rev),
          ...endBatchList({ row: fresh, from: 'needs_check', onlyIf: stamped(fresh.id, stamp), nowMs: Date.now(), requestId: d.requestId, stamp }),
        ])
      }
    }
  }).catch((err: unknown) => console.error({ event: 'outbox_late_result_failed', actionId: batch.id, error: safeError(err) }))
  d.onLate?.(lateResult)
}

type ItemStep = 'next' | 'stopped' | 'yield'

/** Steps 2a to 2d for one item. */
async function sendItem(d: DispatchDeps, batch: OutboxActionRow, item: OutboxItemRow, clock: () => number): Promise<ItemStep> {
  const { db } = d
  const hub = d.hub
  if (hub === null) throw new Error('outbox: a batch item reached its send with no write binding')
  const nowMs = clock()
  const gen = d.gate.pauseGen
  const stamp = writeStamp(d.requestId)
  await runBatch(db, [itemClaimStmt({ actionId: batch.id, itemId: item.item_id, nowMs, pauseGen: gen, stamp })])
  const claimed = await itemOf(db, item.item_id)
  if (!claimed || claimed.stamp !== stamp) {
    const now = await rowOf(db, batch.id)
    if (!now || now.state !== 'sending' || !claimed || claimed.action_id !== batch.id) return 'stopped'
    if (claimed.state !== 'pending') return 'next'
    if (claimed.not_before_ms !== null && claimed.not_before_ms > nowMs) return 'yield'
    const why = await whyItemRefused(db, now, claimed, nowMs, gen)
    if (why.kind === 'lapse' || why.kind === 'withdraw') {
      await stopBatch(d, now, why.kind, why.reason, nowMs)
      return 'stopped'
    }
    throw new Error(`outbox: the claim of item ${claimed.n} of ${batch.id} was refused for a reason the dispatcher can't name`)
  }
  // The permit (step 2b): no await from here to the call's start.
  const permitBy = (claimed.claimed_at_ms ?? nowMs) + timing().staleSendingMs - timing().hubTimeoutMs - PERMIT_MARGIN_MS
  const late = d.gate.paused || d.gate.pauseGen !== gen ? 'paused' as const : clock() >= permitBy ? 'slow' as const : null
  if (late !== null) {
    await runBatch(db, [stmt(
      "UPDATE outbox_items SET state = 'pending', claimed_at_ms = NULL, updated_at_ms = ? WHERE item_id = ? AND state = 'sending' AND attempt = ?",
      nowMs, claimed.item_id, claimed.attempt,
    )])
    if (late === 'slow') return 'yield'
    const now = await rowOf(db, batch.id)
    if (now && now.state === 'sending') await stopBatch(d, now, 'lapse', 'paused', nowMs)
    return 'stopped'
  }
  const { answer, settled } = startCall(hub, itemRequest(batch, claimed), d.timeoutMs ?? timing().hubTimeoutMs, { actionId: batch.id, item: claimed.n, attempt: claimed.attempt })
  const a = await answer
  const outcome = outcomeOf(a)
  if (!(await storeItem(d, batch, claimed, outcome, clock(), false))) {
    // Nothing else moves a `sending` item within the permit's deadline; if this fires, something did. Loud, not silent.
    console.error({ event: 'outbox_item_result_not_stored', actionId: batch.id, item: claimed.n, attempt: claimed.attempt, outcome: outcome.kind })
  }
  if ('timeout' in a) settleLate(d, batch, claimed, settled)
  return 'next'
}

const outcomeOfRow = (row: OutboxActionRow | null): SendOutcome => {
  if (!row) return { kind: 'not_claimed' }
  if (row.state === 'sent') return { kind: 'sent', ref: (JSON.parse(row.result_json ?? '{}') as { ref?: string }).ref ?? '' }
  if (row.state === 'failed') return { kind: 'failed', code: row.error_code ?? 'internal' }
  if (row.state === 'needs_check') return { kind: 'needs_check', why: 'unknown' }
  return { kind: 'not_claimed' }
}

/** One pass of one batch (dispatch.ts `sendAction` hands it any batch row). */
export async function sendBatch(row: OutboxActionRow, d: DispatchDeps): Promise<SendOutcome> {
  const { db, nowMs } = d
  const clock = d.clock ?? (() => nowMs)
  let batch = row
  if (batch.state === 'approved') {
    if (d.gate.paused) return { kind: 'not_claimed' }
    if (batch.send_at_ms !== null && batch.send_at_ms > nowMs) {
      d.again(batch.send_at_ms)
      return { kind: 'not_claimed' }
    }
    if (d.hub === null) {
      // No write binding in this build: a definite failure, nothing sent (its items withdrawn with it, 0770's trigger).
      const stamp = writeStamp(d.requestId)
      const mine = stamped(batch.id, stamp)
      const line = (released: boolean) => ({ ...who(d, nowMs), args: { action: 'action.failed' as const, actionId: batch.id, code: 'not_configured' as const, released } })
      await runBatch(db, [
        stmt(`UPDATE outbox_actions SET state = 'failed', rev = rev + 1, error_code = 'not_configured', final_at_ms = ?, updated_at_ms = ?, stamp = ?
              WHERE id = ? AND state = 'approved' AND rev = ?`, nowMs, nowMs, stamp, batch.id, batch.rev),
        actionLine(line(true), both(mine, unreleasedUse(batch.id, batch.rev))),
        actionLine(line(false), butNot(mine, unreleasedUse(batch.id, batch.rev))),
        releaseUseWhere({ actionId: batch.id, actionRev: batch.rev, reason: 'failed', atMs: nowMs }, mine),
      ])
      return { kind: 'failed', code: 'not_configured' }
    }
    const gen = d.gate.pauseGen
    const stamp = writeStamp(d.requestId)
    await runBatch(db, [batchClaimStmt({ actionId: batch.id, nowMs, pauseGen: gen, stamp })])
    const claimed = await rowOf(db, batch.id)
    if (!claimed) return { kind: 'not_claimed' }
    if (claimed.stamp !== stamp) {
      const maxOf = await first<{ units: number; records: number }>(db, stmt(
        'SELECT MAX(units) AS units, MAX(records) AS records FROM outbox_items WHERE action_id = ? AND n <= ?', claimed.id, claimed.approved_upto ?? 0,
      ))
      const why = await whyRefused(db, { ...claimed, units: maxOf?.units ?? claimed.units, records: maxOf?.records ?? claimed.records }, nowMs, gen)
      if (why.kind === 'gone') return { kind: 'not_claimed' }
      if (why.kind === 'wait') {
        d.again(why.atMs)
        return { kind: 'not_claimed' }
      }
      const lapse = writeStamp(d.requestId)
      await runBatch(db, lapseStmts({
        row: claimed, fromState: 'approved', to: why.kind === 'withdraw' ? 'withdrawn' : 'waiting', reason: why.reason, nowMs, stamp: lapse, requestId: d.requestId, actorId: SYSTEM_MEMBER_ID,
      }))
      const after = await first<{ stamp: string | null; rev: number }>(db, stmt('SELECT stamp, rev FROM outbox_actions WHERE id = ?', batch.id))
      // A deleted chat's actions are its owner's own doing: no notice (as its deletion's batch, #444).
      if (after?.stamp === lapse && why.reason !== 'chat_deleted') {
        const body = (why.kind === 'withdraw' ? WITHDRAWN_TEXT[why.reason] : undefined) ?? LAPSE_TEXT[why.reason]
        await notifyAll(d.notify, [{ kind: 'approval_lapsed', to: claimed.approver, actionId: batch.id, key: `lapsed:${batch.id}:${after.rev}`, body }])
      }
      return { kind: 'not_claimed' }
    }
    batch = claimed
  }
  if (batch.state !== 'sending') return outcomeOfRow(batch)
  const started = clock()
  // The sweep reads `updated_at_ms` to tell a batch whose task was lost from one that is sending.
  await runBatch(db, [stmt("UPDATE outbox_actions SET updated_at_ms = ? WHERE id = ? AND state = 'sending'", started, batch.id)])
  if (d.gate.paused) {
    await stopBatch(d, batch, 'lapse', 'paused', nowMs)
  } else {
    let done = 0
    for (;;) {
      if (d.hub === null) {
        // The binding went away mid-batch (a build without it): every item left fails `not_configured`, nothing sent.
        await failPending(d, batch, 'not_configured', clock())
        break
      }
      if (done >= PASS_ITEMS || clock() - started >= PASS_MS) {
        d.again(clock() + PASS_GAP_MS)
        return { kind: 'not_claimed' }
      }
      const item = await first<OutboxItemRow>(db, stmt(
        "SELECT * FROM outbox_items WHERE action_id = ? AND state = 'pending' AND n <= ? ORDER BY n LIMIT 1", batch.id, batch.approved_upto ?? 0,
      ))
      if (!item) break
      if (item.not_before_ms !== null && item.not_before_ms > clock()) {
        d.again(item.not_before_ms)
        return { kind: 'not_claimed' }
      }
      const step = await sendItem(d, batch, item, clock)
      if (step === 'stopped') break
      if (step === 'yield') {
        d.again(clock())
        return { kind: 'not_claimed' }
      }
      done++
    }
  }
  const after = await rowOf(db, batch.id)
  if (!after || after.state !== 'sending') return outcomeOfRow(after)
  const ended = await endBatch(d, after, clock())
  console.log({ event: 'outbox_batch_pass', actionId: batch.id, state: ended?.state })
  return outcomeOfRow(ended)
}
