// The dispatcher (N11): the task `outbox-send:<id>` inside BrandAgent, one per approved action. The only module that
// names the hub's write binding (boundary.test.ts scans for it). Its steps:
//  1. Paused: don't claim (the pause sync sends the row back to waiting). No write binding: the row fails
//     `not_configured`, nothing sent.
//  2. The claim (claim.ts). Refused: the row lapses back to waiting (or is withdrawn) and its approver is told why.
//  3. The permit: the object's pause flag and generation read again, synchronously. If either changed, the row goes back
//     to waiting with no call made. No `await` sits between this check and the start of the hub call. A Pause after the
//     permit can't recall the call; its result is recorded as usual.
//  4. The hub call, 15 s limit.
//  5. The result, stored with a compare on the claim's attempt: the hub's `ok` is `sent`; an error with `sent: 'no'` is
//     `failed` (the use released); anything else (a throw, a timeout, `sent: 'unknown'`, an answer that doesn't parse)
//     is `needs_check`. No retry, ever: an unclear send is never sent again by the system.
//  6. Its audit line, and a notice to the approver for `needs_check`.
// A result that arrives after the timeout may still move the row from `needs_check` to `sent` or `failed`, but only
// while no person has resolved it.
import { z } from 'zod'
import type { WriteGateway, WriteRequest } from '../../hub/index/contract.ts'
import { ActionFailCodeSchema } from '../../shared/contract/audit.ts'
import type { NeedsCheckWhySchema } from '../../shared/contract/audit.ts'
import { writeStamp } from '../db/ids.ts'
import { first, runBatch, stmt } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'
import type { DueTask, TaskContext, TaskHandler, TaskResult } from '../do/brand-agent/scheduler.ts'
import { safeError } from '../safe-error.ts'
import { claimStmt, lapseStmts, whyRefused } from './claim.ts'
import { notifyAll, outboxNotifier } from './notify.ts'
import type { OutboxNotice, OutboxNotifier } from './notify.ts'
import { actionLine, both, butNot, releaseUseWhere, stamped, unreleasedUse } from './sql.ts'
import { SEND_KIND } from './send-task.ts'
import { timing } from './timing.ts'
import type { OutboxActionRow } from './types.ts'
import { LAPSE_TEXT, NEEDS_CHECK_TEXT } from './words.ts'

type NeedsCheckWhy = z.infer<typeof NeedsCheckWhySchema>


/** The hub's answer, as the dispatcher trusts it: a safe ref, or a closed error code with what the hub knows was sent. */
const ResultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.object({ ref: z.string().max(500) }) }),
  z.object({ ok: z.literal(false), error: z.object({ code: ActionFailCodeSchema }), sent: z.enum(['no', 'unknown']) }),
])

export type SendOutcome =
  | { kind: 'not_claimed' }
  | { kind: 'sent'; ref: string }
  | { kind: 'failed'; code: string }
  | { kind: 'needs_check'; why: NeedsCheckWhy }

export interface DispatchDeps {
  db: D1Database
  nowMs: number
  /** The object's pause flag and generation, read at each access (TaskContext's getters). */
  gate: { readonly paused: boolean; readonly pauseGen: number }
  hub: WriteGateway | null
  /** Runs this action's send task again at `atMs` (its hold isn't over yet). */
  again: (atMs: number) => void
  notify: OutboxNotifier
  requestId: string
  /** Tests only: the call's late result, stored after a timeout, settles this. */
  onLate?: (p: Promise<void>) => void
  /** Tests only: the hub call's limit (default `timing().hubTimeoutMs`). */
  timeoutMs?: number
}

const SYSTEM = 'm_system'
/** A safe ref as the card shows it: no control characters, at most 200 characters. */
const safeRef = (ref: string) => ref.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 200)

/** The write the hub is asked for. A Slack post names the listed channel's id the claim just checked (N13). */
export function writeRequest(row: OutboxActionRow, requestId: string): WriteRequest {
  const args = JSON.parse(row.args_json) as Record<string, unknown>
  const scope = JSON.parse(row.scope_json) as Record<string, string>
  return {
    actionId: row.id, attempt: row.attempt, requestId, accountId: row.account_id, expect: { connectedAtMs: row.account_gen },
    operation: row.operation,
    args: row.operation === 'slack.channel.post' ? { ...args, channel: scope.channelId } : args,
  }
}

/**
 * Stores one result for the claim's attempt: from `sending`, or (a late result) from an unresolved `needs_check`. A
 * `needs_check` result is stored only from `sending`. Returns whether it applied.
 */
async function storeResult(d: Pick<DispatchDeps, 'db' | 'requestId' | 'notify'>, row: OutboxActionRow, outcome: SendOutcome, nowMs: number, late: boolean): Promise<boolean> {
  if (outcome.kind === 'not_claimed') return false
  const stamp = writeStamp(d.requestId)
  const mine = stamped(row.id, stamp)
  const useRev = row.approved_rev as number
  const from = late ? "(state = 'sending' OR (state = 'needs_check' AND resolved_by IS NULL))" : "state = 'sending'"
  const who = { atMs: nowMs, actorId: SYSTEM, requestId: d.requestId }
  const stmts: Stmt[] = []
  if (outcome.kind === 'sent') {
    stmts.push(
      stmt(`UPDATE outbox_actions SET state = 'sent', rev = rev + 1, result_json = ?, error_code = NULL, final_at_ms = ?, updated_at_ms = ?, stamp = ?
            WHERE id = ? AND attempt = ? AND ${from}`, JSON.stringify({ ref: outcome.ref }), nowMs, nowMs, stamp, row.id, row.attempt),
      actionLine({ ...who, args: { action: 'action.sent', actionId: row.id, attempt: row.attempt } }, mine),
    )
  } else if (outcome.kind === 'failed') {
    const code = outcome.code as z.infer<typeof ActionFailCodeSchema>
    const line = (released: boolean) => ({ ...who, args: { action: 'action.failed' as const, actionId: row.id, attempt: row.attempt, code, released } })
    stmts.push(
      stmt(`UPDATE outbox_actions SET state = 'failed', rev = rev + 1, error_code = ?, final_at_ms = ?, updated_at_ms = ?, stamp = ?
            WHERE id = ? AND attempt = ? AND ${from}`, code, nowMs, nowMs, stamp, row.id, row.attempt),
      actionLine(line(true), both(mine, unreleasedUse(row.id, useRev))),
      actionLine(line(false), butNot(mine, unreleasedUse(row.id, useRev))),
      releaseUseWhere({ actionId: row.id, actionRev: useRev, reason: 'failed', atMs: nowMs }, mine),
    )
  } else {
    stmts.push(
      stmt(`UPDATE outbox_actions SET state = 'needs_check', rev = rev + 1, updated_at_ms = ?, stamp = ?
            WHERE id = ? AND attempt = ? AND state = 'sending'`, nowMs, stamp, row.id, row.attempt),
      actionLine({ ...who, args: { action: 'action.needs_check', actionId: row.id, attempt: row.attempt, why: outcome.why } }, mine),
    )
  }
  await runBatch(d.db, stmts)
  const after = await first<{ stamp: string | null; rev: number }>(d.db, stmt('SELECT stamp, rev FROM outbox_actions WHERE id = ?', row.id))
  const applied = after?.stamp === stamp
  if (applied && outcome.kind === 'needs_check') {
    await notifyAll(d.notify, [{ kind: 'needs_check', to: row.approver, actionId: row.id, key: `needs_check:${row.id}:${row.attempt}`, body: NEEDS_CHECK_TEXT }])
  }
  return applied
}

/** What the hub's answer (or its absence) means. Anything the dispatcher can't read as sure is a check for a person. */
function outcomeOf(answer: { value: unknown } | { thrown: true } | { timeout: true }): SendOutcome {
  if ('thrown' in answer) return { kind: 'needs_check', why: 'thrown' }
  if ('timeout' in answer) return { kind: 'needs_check', why: 'timeout' }
  const parsed = ResultSchema.safeParse(answer.value)
  if (!parsed.success) return { kind: 'needs_check', why: 'bad_result' }
  const r = parsed.data
  if (r.ok) return { kind: 'sent', ref: safeRef(r.value.ref) }
  return r.sent === 'no' ? { kind: 'failed', code: r.error.code } : { kind: 'needs_check', why: 'unknown' }
}

/** One send of one approved action (steps 1 to 6 above). */
export async function sendAction(actionId: string, d: DispatchDeps): Promise<SendOutcome> {
  const { db, nowMs } = d
  if (d.gate.paused) return { kind: 'not_claimed' }
  const row = await first<OutboxActionRow>(db, stmt('SELECT * FROM outbox_actions WHERE id = ?', actionId))
  if (!row || row.state !== 'approved') return { kind: 'not_claimed' }
  if (row.send_at_ms !== null && row.send_at_ms > nowMs) {
    d.again(row.send_at_ms)
    return { kind: 'not_claimed' }
  }
  const who = { atMs: nowMs, actorId: SYSTEM, requestId: d.requestId }

  if (d.hub === null) {
    // No write binding in this build: a definite failure, nothing sent.
    const stamp = writeStamp(d.requestId)
    const mine = stamped(row.id, stamp)
    const line = (released: boolean) => ({ ...who, args: { action: 'action.failed' as const, actionId: row.id, code: 'not_configured' as const, released } })
    await runBatch(db, [
      stmt(`UPDATE outbox_actions SET state = 'failed', rev = rev + 1, error_code = 'not_configured', final_at_ms = ?, updated_at_ms = ?, stamp = ?
            WHERE id = ? AND state = 'approved' AND rev = ?`, nowMs, nowMs, stamp, row.id, row.rev),
      actionLine(line(true), both(mine, unreleasedUse(row.id, row.rev))),
      actionLine(line(false), butNot(mine, unreleasedUse(row.id, row.rev))),
      releaseUseWhere({ actionId: row.id, actionRev: row.rev, reason: 'failed', atMs: nowMs }, mine),
    ])
    return { kind: 'failed', code: 'not_configured' }
  }

  const gen = d.gate.pauseGen
  const stamp = writeStamp(d.requestId)
  await runBatch(db, [claimStmt({ actionId, nowMs, pauseGen: gen, stamp })])
  const claimed = await first<OutboxActionRow>(db, stmt('SELECT * FROM outbox_actions WHERE id = ?', actionId))
  if (!claimed || claimed.stamp !== stamp) {
    if (!claimed) return { kind: 'not_claimed' }
    const why = await whyRefused(db, claimed, nowMs, gen)
    if (why.kind === 'gone') return { kind: 'not_claimed' }
    if (why.kind === 'wait') {
      d.again(why.atMs)
      return { kind: 'not_claimed' }
    }
    const lapse = writeStamp(d.requestId)
    await runBatch(db, lapseStmts({
      row: claimed, fromState: 'approved', to: why.kind === 'withdraw' ? 'withdrawn' : 'waiting', reason: why.reason, nowMs, stamp: lapse, requestId: d.requestId, actorId: SYSTEM,
    }))
    const after = await first<{ stamp: string | null; rev: number }>(db, stmt('SELECT stamp, rev FROM outbox_actions WHERE id = ?', actionId))
    if (after?.stamp === lapse) {
      await notifyAll(d.notify, [{ kind: 'approval_lapsed', to: claimed.approver, actionId, key: `lapsed:${actionId}:${after.rev}`, body: LAPSE_TEXT[why.reason] }])
    }
    return { kind: 'not_claimed' }
  }

  const req = writeRequest(claimed, d.requestId)
  const hub = d.hub
  // The permit (step 3). From this check to the call's start there is no await.
  if (d.gate.paused || d.gate.pauseGen !== gen) {
    const back = writeStamp(d.requestId)
    await runBatch(db, lapseStmts({
      row: claimed, fromState: 'sending', attempt: claimed.attempt, to: 'waiting', reason: 'paused', nowMs, stamp: back, requestId: d.requestId, actorId: SYSTEM,
    }))
    return { kind: 'not_claimed' }
  }
  let call: Promise<unknown>
  try {
    call = hub.runAction(req)
  } catch (err) {
    call = Promise.reject(err)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ timeout: true }>(r => { timer = setTimeout(() => r({ timeout: true }), d.timeoutMs ?? timing().hubTimeoutMs) })
  const settled = call.then(value => ({ value }), (err: unknown) => {
    console.error({ event: 'outbox_send_threw', actionId, attempt: claimed.attempt, error: safeError(err) })
    return { thrown: true as const }
  })
  const answer = await Promise.race([settled, timeout])
  clearTimeout(timer)
  const outcome = outcomeOf(answer)
  await storeResult(d, claimed, outcome, nowMs, false)
  if ('timeout' in answer) {
    // The hub may still answer. A sure answer may then settle the row, while no person has resolved it.
    const late = settled.then(async a => {
      const o = outcomeOf(a)
      if (o.kind === 'sent' || o.kind === 'failed') await storeResult(d, claimed, o, Date.now(), true)
    }).catch((err: unknown) => console.error({ event: 'outbox_late_result_failed', actionId, error: safeError(err) }))
    d.onLate?.(late)
  }
  console.log({ event: 'outbox_send', actionId, attempt: claimed.attempt, outcome: outcome.kind, ...(outcome.kind === 'needs_check' ? { why: outcome.why } : {}) })
  return outcome
}

/** The task's handler (tasks/index.ts): the binding read here and nowhere else. */
export const outboxSend: TaskHandler = async (task: DueTask, ctx: TaskContext): Promise<TaskResult> => {
  const actionId = task.id.slice(SEND_KIND.length + 1)
  const hub = (ctx.env as unknown as { HUB_WRITE?: WriteGateway }).HUB_WRITE ?? null
  await sendAction(actionId, {
    db: ctx.env.DB, nowMs: ctx.nowMs, gate: ctx, hub, notify: outboxNotifier(ctx.env), requestId: `outbox-send-${crypto.randomUUID()}`,
    again: atMs => ctx.scheduler.schedule({ id: task.id, kind: SEND_KIND, dueAtMs: atMs }),
  })
  return { done: true }
}

export type { OutboxNotice }
