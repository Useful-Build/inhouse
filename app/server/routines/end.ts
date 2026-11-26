// A routine run's end (p4-w2.md section 6): the `routine-end` due task P3 schedules when the slot's turn is final (seam
// B; across a question, once, at the true end: shapes.md "Routine end" r4). The whole end is one D1 batch and every
// delivery runs all of it; each statement is idempotent, so a retry or a revive (route 51) re-runs it safely and
// nothing doubles. A throw before the batch commits leaves nothing written. Never `poke` an end id: `poke` schedules with
// no payload, and the outcome lives only in it.
import { addNotice } from '../notices/store.ts'
import type { DueTask, TaskContext, TaskResult } from '../do/brand-agent/scheduler.ts'
import type { ReadGatewayLike } from '../egress/hub.ts'
import type { TurnEndPayload } from '../do/brand-agent/ports.ts'
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import { hashId, slotKeyOfEndTask } from './keys.ts'
import { RESULT_HANDLERS } from './results.ts'
import type { EndSlot, ResultOutput } from './results.ts'
import { slotLine } from './rows.ts'
import { alertRoutineFailed } from '../notify-slack/alerts-notices.ts'

export type EndContext = Pick<TaskContext, 'nowMs' | 'env'>

const OUTCOMES = new Set(['done', 'failed', 'stopped', 'interrupted', 'cancelled'])
/** A failure code as Activity and the bell store it: a fixed code (fields.ts), else `unknown`. */
const CODE = /^[a-z0-9][a-z0-9_.:|-]{0,63}$/
const asCode = (failure: string) => (CODE.test(failure) && !failure.startsWith('m_') ? failure : 'unknown')

function parsePayload(p: unknown): TurnEndPayload {
  const v = p as Partial<TurnEndPayload> | null
  if (!v || typeof v.turnId !== 'string' || typeof v.runId !== 'string' || typeof v.chatId !== 'string'
    || typeof v.outcome !== 'string' || !OUTCOMES.has(v.outcome) || !(v.failure === null || typeof v.failure === 'string')) {
    throw new Error('routine-end: the payload is not a turn end')
  }
  return { turnId: v.turnId, runId: v.runId, chatId: v.chatId, outcome: v.outcome, failure: v.failure, structuredOutput: v.structuredOutput ?? null }
}

export async function routineEnd(task: DueTask, ctx: EndContext): Promise<TaskResult> {
  const slotKey = slotKeyOfEndTask(task.id)
  if (slotKey === null) throw new Error('routine-end: not an end task id')
  const end = parsePayload(task.payload)
  const db = ctx.env.DB
  const now = ctx.nowMs
  const slot = await db.prepare(
    `SELECT s.slot_key, s.routine_id, s.run_id, s.kind, s.local_date, s.local_time, s.claimed_at_ms, s.state, s.creator_id, s.requested_by,
        r.kind AS routine_kind
      FROM routine_slots s JOIN routines r ON r.id = s.routine_id WHERE s.slot_key = ?`,
  ).bind(slotKey).first<EndSlot & { run_id: string | null; routine_kind: string }>()
  if (!slot) {
    // Gone to retention, or never made: nothing to land on. Logged loud; the task ends.
    console.error({ event: 'routine_end_no_slot' })
    return { done: true }
  }
  const handler = Object.hasOwn(RESULT_HANDLERS, slot.routine_kind) ? RESULT_HANDLERS[slot.routine_kind] : undefined
  const out: ResultOutput = handler
    ? await handler.run(slot, { outcome: end.outcome, failure: end.failure, structuredOutput: end.structuredOutput }, { db, nowMs: now, hub: ctx.env.HUB as unknown as ReadGatewayLike, turnId: end.turnId, runId: end.runId })
    : { statements: [], summary: null }
  // P3 sets `failure` only for failed and cancelled ends; every other end takes the handler's, or none (revision 3.3).
  const failure = end.failure ?? out.failure ?? null
  // The line links the run the slot started (the trace route 33 admits by the slot's ids). Under P6 a resumed turn ends
  // on a run of its own, which the slot doesn't name; the first end's run stays the slot's (statement 1's COALESCE).
  const traceRun = slot.run_id ?? end.runId

  const statements: D1PreparedStatement[] = [
    // 1. The slot, matched by key from any state but `ended` (an end that lands on `claimed`, `lost` or `missed` wins).
    db.prepare(
      `UPDATE routine_slots SET state = 'ended', run_id = COALESCE(run_id, ?), turn_id = COALESCE(turn_id, ?), outcome = ?,
          failure = ?, result_text = ?, ended_at_ms = COALESCE(ended_at_ms, ?)
        WHERE slot_key = ? AND state <> 'ended'`,
    ).bind(end.runId, end.turnId, end.outcome, failure, out.summary, now, slotKey),
    // 2. The result handler's own statements.
    ...out.statements,
    // 3. The routine's newest ended slot, by (local_date, claimed_at_ms) as a pair; a last slot gone to retention is older.
    db.prepare(
      `UPDATE routines SET last_slot_key = ? WHERE id = ? AND (last_slot_key IS NULL
          OR NOT EXISTS (SELECT 1 FROM routine_slots WHERE slot_key = routines.last_slot_key)
          OR (SELECT local_date, claimed_at_ms FROM routine_slots WHERE slot_key = routines.last_slot_key) < (?, ?))`,
    ).bind(slotKey, slot.routine_id, slot.local_date, slot.claimed_at_ms),
    // 4. Activity (keyed by the slot), and the bell on a failure other than W3's quiet `not_connected`.
    failure !== null
      ? slotLine(db, { template: 'routine_failed', fields: { code: asCode(failure) }, key: slotKey, runId: traceRun, atMs: now })
      : slotLine(db, { template: out.activity?.template ?? 'routine_ran', fields: out.activity?.fields ?? {}, key: slotKey, runId: traceRun, atMs: now }),
  ]
  if (failure !== null && failure !== 'not_connected') {
    const base = { template: 'routine_failed', fields: { code: asCode(failure) }, icon: 'error', link: { to: 'page' as const, page: 'routines' as const }, atMs: now }
    statements.push(addNotice(db, { ...base, id: await hashId('rf_', `${slotKey}|admins`), audience: 'admins' }))
    if (slot.creator_id !== SYSTEM_MEMBER_ID) {
      statements.push(addNotice(db, { ...base, id: await hashId('rf_', `${slotKey}|${slot.creator_id}`), audience: 'member', audienceMemberId: slot.creator_id }))
    }
  }
  await db.batch(statements)
  // Stage 1 M2-N (Q3 = A): the same failure's fixed notice to the alerts channel, after the end committed. Keyed on the
  // slot, so a re-run end posts once. A throw retries the end, whose every statement is idempotent.
  if (failure !== null && failure !== 'not_connected') await alertRoutineFailed(ctx.env, { slotKey, routineId: slot.routine_id, runId: traceRun }, { nowMs: now })
  return { done: true }
}
