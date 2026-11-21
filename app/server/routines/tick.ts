// The routine tick (p4-w2.md section 4): a P3 due-task handler, kind `routine-tick`, under two ids. `routine-tick` is the
// heartbeat (seeded by the registry's `withSeed`); `routine-poke` is a wake-up a route asks for after a routine write or
// a Run now. One pass: decide new slots, close or submit the open ones, then (heartbeat only) arm the next pass. Every
// step is idempotent by the slot key, so two passes, a crash at any await or a re-delivered alarm can't run a slot twice
// (section 5). A slot's turn runs as `m_system` (OC 1) and ends through `routine-end` (end.ts).
// Durable Object alarms: at-least-once, one `alarm()` at a time (https://developers.cloudflare.com/durable-objects/api/alarms/);
// D1 batches are one transaction (https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). Both read 2026-11-21.
import { ensureChat } from '../db/chats.ts'
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import type { DueTask, TaskContext, TaskResult } from '../do/brand-agent/scheduler.ts'
import { brandFacts, stageIndex, submitSettings } from './brand.ts'
import type { BrandFacts, SubmitSettings } from './brand.ts'
import { renderSlot, submitOf } from './render.ts'
import { alertStatement, inState, slotInsert, slotLine } from './rows.ts'
import type { NewSlot, RoutineRow, SlotRow } from './rows.ts'
import { nextSlot, slotsDue } from './slots.ts'
import { BACKSTOP_MS } from './limits.ts'
import type { Slot } from './slots.ts'
import { afterTickBatch } from '@test-controls'

export const TICK_KIND = 'routine-tick'
export const TICK_ID = 'routine-tick'
export const POKE_ID = 'routine-poke'

const MIN = 60_000
/** The heartbeat's longest gap. */
export const HEARTBEAT_MS = 5 * MIN
/** A slot is on time within this of its due instant (OC 2). */
export const ON_TIME_MS = 10 * MIN
/** A started slot with no end after this, whose chat neither waits nor runs, is lost (OC 8). */
export const LOST_AFTER_MS = 45 * MIN
export { BACKSTOP_MS } from './limits.ts'
/** A transient refusal or a thrown submit waits this long before the row is tried again. */
export const RETRY_MS = 30_000
export const MAX_SUBMIT_FAILURES = 3
/** Routines decided per pass (the most behind first, Opus F10). */
export const DECIDE_LIMIT = 50
/** Claimed rows worked per pass. */
export const SUBMIT_LIMIT = 20
/** Started rows closed per pass, and the sweep's page size. */
export const SWEEP_LIMIT = 50
/** Pages of started rows one pass reads at most (waiting rows are read but not counted). */
export const SWEEP_PAGES = 20
/** At most this many rows that won't run (missed, skipped) per routine per pass; older ones advance the cursor unrecorded. */
export const NOT_RUN_ROWS_MAX = 7
/** The enabled routines a pass reads for the next-slot time (a brand has a handful). */
const ROUTINES_READ_MAX = 500

/** Refusals that leave the row claimed until its deadline (OC 7). */
const TRANSIENT = new Set(['rate_limited', 'unavailable'])

export type TickContext = Pick<TaskContext, 'nowMs' | 'env' | 'scheduler' | 'runs' | 'chats'>

interface PassResult {
  /** Rows whose state this pass moved (made, started, refused, missed, skipped or lost). */
  moved: number
  /** A bound cut the pass short: work may be left. */
  stoppedEarly: boolean
  nextSlotAt: number | null
  nextAttemptAt: number | null
}

const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300)

/** The `routine-tick` handler (both ids). */
export async function routineTick(task: DueTask, ctx: TickContext): Promise<TaskResult> {
  const now = ctx.nowMs
  const heartbeat = task.id === TICK_ID
  // Step 0 (Sonnet M-2): arm the next heartbeat before anything can throw. From here this task's own commit is on an old
  // generation and matches no row, so a failure below neither retries nor quarantines it.
  if (heartbeat) ctx.scheduler.schedule({ id: TICK_ID, kind: TICK_KIND, dueAtMs: now + HEARTBEAT_MS })
  try {
    const pass = await runPass(ctx, now)
    if (heartbeat) ctx.scheduler.schedule({ id: TICK_ID, kind: TICK_KIND, dueAtMs: rearmAt(pass, now) })
  } catch (err) {
    console.error({ event: 'routine_tick_failed', id: task.id, error: errorText(err) })
  }
  return { done: true }
}

/** Step 4: the next heartbeat, early for a slot or a retry, never a spin. */
export function rearmAt(p: PassResult, now: number): number {
  let at = Math.min(p.nextSlotAt ?? Infinity, now + HEARTBEAT_MS)
  if (p.nextAttemptAt !== null) at = Math.min(at, Math.max(p.nextAttemptAt, now + RETRY_MS))
  if (p.stoppedEarly) at = p.moved > 0 ? now : Math.min(at, now + RETRY_MS)
  return Math.max(at, now)
}

async function runPass(ctx: TickContext, now: number): Promise<PassResult> {
  const db = ctx.env.DB
  const brand = await brandFacts(db)
  const routines = (await db.prepare(
    'SELECT * FROM routines WHERE enabled = 1 AND deleted_at_ms IS NULL ORDER BY checked_until_ms ASC, id ASC LIMIT ?',
  ).bind(ROUTINES_READ_MAX).all<RoutineRow>()).results

  const decided = await decideAll(db, brand, routines, now)
  // The test build's stop-after-batch control (server/ops/test-controls.ts, route 67); nothing in every other build.
  afterTickBatch()
  const swept = await sweepStarted(db, ctx, now)
  const worked = await workClaimed(db, ctx, now)

  let nextSlotAt: number | null = null
  if (typeof brand.tz === 'string') {
    for (const r of routines) {
      const n = nextSlot(r, brand.tz, Math.max(now, r.checked_until_ms), HEARTBEAT_MS)
      if (n && (nextSlotAt === null || n.dueAtMs < nextSlotAt)) nextSlotAt = n.dueAtMs
    }
  }
  const nextAttemptAt = (await db.prepare("SELECT MIN(next_attempt_ms) AS at FROM routine_slots WHERE state = 'claimed'").first<{ at: number | null }>())?.at ?? null
  return {
    moved: decided.moved + swept.moved + worked.moved,
    stoppedEarly: decided.stoppedEarly || swept.stoppedEarly || worked.stoppedEarly,
    nextSlotAt, nextAttemptAt,
  }
}

// ---------- step 1: decide new slots ----------

async function decideAll(db: D1Database, brand: BrandFacts, routines: RoutineRow[], now: number): Promise<{ moved: number; stoppedEarly: boolean }> {
  const behind = routines.filter(r => r.checked_until_ms < now)
  if (behind.length === 0) return { moved: 0, stoppedEarly: false }
  if (typeof brand.tz !== 'string') {
    console.error({ event: 'routine_tz_invalid' })
    await alertStatement(db, 'tz_invalid', now).run()
    return { moved: 0, stoppedEarly: false }
  }
  const settings = await submitSettings(db)
  if ('refused' in settings) {
    console.error({ event: 'routine_settings_refused', code: settings.refused.code, reason: settings.refused.reason ?? null })
    return { moved: 0, stoppedEarly: false }
  }
  let moved = 0
  for (const r of behind.slice(0, DECIDE_LIMIT)) {
    try {
      moved += await decideRoutine(db, r, { stage: brand.stage, tz: brand.tz }, settings, now)
    } catch (err) {
      console.error({ event: 'routine_decide_failed', routineId: r.id, error: errorText(err) })
    }
  }
  return { moved, stoppedEarly: behind.length > DECIDE_LIMIT }
}

interface Decision { slot: Slot; state: NewSlot['state']; reason: string | null; deadline: number }

/** The rules in words (section 4, step 1), oldest slot first. Exported for the model-based test's oracle to compare against. */
export function decideSlots(r: Pick<RoutineRow, 'need' | 'missed' | 'catch_up_within_min'>, stage: number, slots: readonly Slot[], now: number): Decision[] {
  if (stage < r.need) return slots.map(slot => ({ slot, state: 'skipped', reason: 'stage', deadline: slot.dueAtMs + ON_TIME_MS }))
  const late = slots.filter(s => now - s.dueAtMs > ON_TIME_MS)
  const window = r.catch_up_within_min * MIN
  const newestLate = late[late.length - 1]
  const catchUp = r.missed === 'catch_up' && newestLate && now - newestLate.dueAtMs <= window ? newestLate : undefined
  return slots.map(slot => {
    if (now - slot.dueAtMs <= ON_TIME_MS) return { slot, state: 'claimed', reason: null, deadline: slot.dueAtMs + ON_TIME_MS }
    if (slot === catchUp) return { slot, state: 'claimed', reason: null, deadline: slot.dueAtMs + window }
    return { slot, state: 'missed', reason: 'late', deadline: slot.dueAtMs + ON_TIME_MS }
  })
}

async function decideRoutine(db: D1Database, r: RoutineRow, brand: { stage: number; tz: string }, settings: SubmitSettings, now: number): Promise<number> {
  const all = decideSlots(r, brand.stage, slotsDue(r, brand.tz, r.checked_until_ms, now), now)
  // Keep every claimed row and the newest rows that won't run, at most NOT_RUN_ROWS_MAX of them.
  const notRun = all.filter(d => d.state !== 'claimed')
  const dropped = new Set(notRun.slice(0, Math.max(0, notRun.length - NOT_RUN_ROWS_MAX)))
  if (dropped.size > 0) console.warn({ event: 'routine_slots_unrecorded', routineId: r.id, count: dropped.size })
  const kept = all.filter(d => !dropped.has(d))

  const rows = await Promise.all(kept.map(d => renderSlot(r, settings, {
    slot_key: d.slot.key, kind: 'scheduled', local_date: d.slot.localDate, local_time: d.slot.localTime, tz: brand.tz,
    due_at_ms: d.slot.dueAtMs, deadline_ms: d.deadline, state: d.state, reason: d.reason, requested_by: null, claimed_at_ms: now,
  })))
  // Cursor first, inserts gated on it (Sonnet M-3, Opus F6): a write that bumped `rev` or a pass that moved the cursor
  // since the read makes this batch insert nothing; the next pass decides again.
  const cursor = db.prepare(
    'UPDATE routines SET checked_until_ms = ? WHERE id = ? AND rev = ? AND checked_until_ms = ? AND enabled = 1 AND deleted_at_ms IS NULL',
  ).bind(now, r.id, r.rev, r.checked_until_ms)
  const gate = { sql: 'EXISTS (SELECT 1 FROM routines WHERE id = ? AND rev = ? AND checked_until_ms = ?)', params: [r.id, r.rev, now] }
  // A missed row's Activity line rides the same batch, guarded on the row this pass just made (state and claim time).
  const lines = rows.filter(s => s.state === 'missed')
    .map(s => slotLine(db, { template: 'routine_missed', key: `${s.slot_key}|missed`, need: r.need, runId: null, atMs: now }, inState(s.slot_key, 'missed', now)))
  const results = await db.batch([cursor, ...rows.map(s => slotInsert(db, s, gate)), ...lines])
  if (results[0].meta.changes === 0) {
    console.warn({ event: 'routine_decide_raced', routineId: r.id })
    return 0
  }
  return rows.filter((_, i) => results[i + 1].meta.changes > 0).length
}

// ---------- step 2: the open rows ----------

/** A close's update, named from-state only. */
const close = (db: D1Database, slotKey: string, from: 'claimed' | 'started', to: 'lost' | 'missed' | 'skipped' | 'refused', reason: string) =>
  db.prepare('UPDATE routine_slots SET state = ?, reason = ? WHERE slot_key = ? AND state = ?').bind(to, reason, slotKey, from)

type StartedRead = { slot_key: string; chat_id: string; run_id: string | null; started_at_ms: number; need: number }

/**
 * Started rows past 45 minutes, oldest first, paged by `(started_at_ms, slot_key)`. A row whose chat waits on a question
 * or runs a turn is passed over without counting toward the bound, so a pile of waiting rows can't starve a newer
 * overdue one or keep the pass "stopped early". At most SWEEP_LIMIT closes per pass; the scan itself stops after
 * SWEEP_PAGES pages (logged), which never re-arms early.
 */
async function sweepStarted(db: D1Database, ctx: TickContext, now: number): Promise<{ moved: number; stoppedEarly: boolean }> {
  let moved = 0
  let closes = 0
  let after: { ms: number; key: string } | null = null
  for (let page = 0; page < SWEEP_PAGES; page++) {
    const rows: StartedRead[] = (await db.prepare(
      `SELECT s.slot_key, s.chat_id, s.run_id, s.started_at_ms, r.need FROM routine_slots s JOIN routines r ON r.id = s.routine_id
        WHERE s.state = 'started' AND s.started_at_ms <= ? AND (? IS NULL OR (s.started_at_ms, s.slot_key) > (?, ?))
        ORDER BY s.started_at_ms ASC, s.slot_key ASC LIMIT ?`,
    ).bind(now - LOST_AFTER_MS, after?.ms ?? null, after?.ms ?? 0, after?.key ?? '', SWEEP_LIMIT).all<StartedRead>()).results
    for (const s of rows) {
      after = { ms: s.started_at_ms, key: s.slot_key }
      let reason: string
      if (now > s.started_at_ms + BACKSTOP_MS) reason = 'timeout'
      else {
        // Section 6b: a chat that waits on a question, or runs a (resumed) turn, isn't lost; only read here.
        const st = ctx.chats.status(s.chat_id)
        if (st.waiting || st.liveRunId !== null) continue
        reason = 'no_end'
      }
      if (closes === SWEEP_LIMIT) return { moved, stoppedEarly: true }
      closes++
      try {
        const [res] = await db.batch([
          close(db, s.slot_key, 'started', 'lost', reason),
          slotLine(db, { template: 'routine_lost', key: `${s.slot_key}|lost`, need: s.need, runId: s.run_id, atMs: now }, inState(s.slot_key, 'lost')),
        ])
        moved += res.meta.changes
      } catch (err) {
        console.error({ event: 'routine_sweep_failed', error: errorText(err) })
      }
    }
    if (rows.length < SWEEP_LIMIT) return { moved, stoppedEarly: false }
  }
  console.warn({ event: 'routine_sweep_scan_capped', pages: SWEEP_PAGES })
  return { moved, stoppedEarly: false }
}

interface ClaimedRead extends SlotRow {
  r_name: string
  r_need: number
  r_enabled: number
  r_deleted_at_ms: number | null
  chat_deleted_at_ms: number | null
  /** The brand's `stage` setting as stored, read with the row (never the pass's earlier read). */
  stage_json: string | null
}

type ClaimedKey = { slot_key: string; chat_id: string; local_date: string; r_name: string }

async function workClaimed(db: D1Database, ctx: TickContext, now: number): Promise<{ moved: number; stoppedEarly: boolean }> {
  const keys = (await db.prepare(
    // Closest to expiry first; among equals, the one waiting longest, so a bound can't starve the same rows every pass.
    `SELECT s.slot_key, s.chat_id, s.local_date, r.name AS r_name FROM routine_slots s JOIN routines r ON r.id = s.routine_id
      WHERE s.state = 'claimed' AND s.next_attempt_ms <= ?
      ORDER BY s.deadline_ms ASC, s.next_attempt_ms ASC, s.claimed_at_ms ASC, s.slot_key ASC LIMIT ?`,
  ).bind(now, SUBMIT_LIMIT + 1).all<ClaimedKey>()).results
  let moved = 0
  for (const k of keys.slice(0, SUBMIT_LIMIT)) {
    try {
      moved += await workOne(db, ctx, k, now)
    } catch (err) {
      console.error({ event: 'routine_work_failed', error: errorText(err) })
    }
  }
  return { moved, stoppedEarly: keys.length > SUBMIT_LIMIT }
}

/** A thrown submit (or chat): one more failure, tried again after the delay; the third makes it `refused` (internal). */
async function failedOnce(db: D1Database, slotKey: string, now: number, err: unknown): Promise<number> {
  console.error({ event: 'routine_submit_failed', error: errorText(err) })
  const row = await db.prepare(
    `UPDATE routine_slots SET submit_failures = submit_failures + 1, next_attempt_ms = ?,
        state = CASE WHEN submit_failures + 1 >= ? THEN 'refused' ELSE state END,
        reason = CASE WHEN submit_failures + 1 >= ? THEN 'internal' ELSE reason END
      WHERE slot_key = ? AND state = 'claimed' RETURNING state`,
  ).bind(now + RETRY_MS, MAX_SUBMIT_FAILURES, MAX_SUBMIT_FAILURES, slotKey).first<{ state: string }>()
  return row?.state === 'refused' ? 1 : 0
}

/**
 * One claimed row. The chat is ensured first, so the last D1 read (the row with its routine, chat and the brand's
 * stage) sits right before the synchronous checks and the submit: no write can land between what decides and the run.
 * How many rows it moved (0 or 1).
 */
async function workOne(db: D1Database, ctx: TickContext, k: ClaimedKey, now: number): Promise<number> {
  try {
    await ensureChat(db, { id: k.chat_id, ownerId: SYSTEM_MEMBER_ID, title: `${k.r_name}, ${k.local_date}` }, now)
  } catch (err) {
    return failedOnce(db, k.slot_key, now, err)
  }
  const s = await db.prepare(
    `SELECT s.*, r.name AS r_name, r.need AS r_need, r.enabled AS r_enabled, r.deleted_at_ms AS r_deleted_at_ms,
        c.deleted_at_ms AS chat_deleted_at_ms,
        (SELECT value_json FROM settings WHERE owner = 'brand' AND key = 'stage') AS stage_json
      FROM routine_slots s JOIN routines r ON r.id = s.routine_id LEFT JOIN chats c ON c.id = s.chat_id
      WHERE s.slot_key = ? AND s.state = 'claimed'`,
  ).bind(k.slot_key).first<ClaimedRead>()
  if (!s) return 0
  const closeTo = async (to: 'missed' | 'skipped', reason: string) => {
    const stmts = [close(db, s.slot_key, 'claimed', to, reason)]
    if (to === 'missed') stmts.push(slotLine(db, { template: 'routine_missed', key: `${s.slot_key}|missed`, need: s.r_need, runId: null, atMs: now }, inState(s.slot_key, 'missed')))
    const [res] = await db.batch(stmts)
    return res.meta.changes
  }
  const stage = stageIndex(s.stage_json === null ? null : JSON.parse(s.stage_json))
  // Never a submit into a trashed chat: `ensureChat` answers OK for one and the in-object submit reads no D1 (rev 3.3).
  if (s.chat_deleted_at_ms !== null) return closeTo('skipped', 'chat_deleted')
  if (s.r_deleted_at_ms !== null) return closeTo('skipped', 'deleted')
  if (s.kind === 'scheduled' && s.r_enabled !== 1) return closeTo('skipped', 'disabled')
  if (stage < s.r_need) return closeTo('skipped', 'stage')
  if (now > s.deadline_ms) return closeTo('missed', 'late')
  return submit(db, ctx, s, now)
}

async function submit(db: D1Database, ctx: TickContext, s: ClaimedRead, now: number): Promise<number> {
  let answer: Awaited<ReturnType<TickContext['runs']['submit']>>
  try {
    answer = await ctx.runs.submit(submitOf(s))
  } catch (err) {
    return failedOnce(db, s.slot_key, now, err)
  }
  if (!('refused' in answer)) {
    // Forward only (Sonnet H-2): an end that already landed (`ended`) can't be reopened by this answer.
    const res = await db.prepare(
      "UPDATE routine_slots SET state = 'started', run_id = ?, turn_id = ?, started_at_ms = ? WHERE slot_key = ? AND state = 'claimed'",
    ).bind(answer.runId, answer.turnId, now, s.slot_key).run()
    return res.meta.changes
  }
  const { code, reason } = answer.refused
  if (code === 'conflict' && reason === 'key_reused') {
    // An invariant break: the turn may be running, so never refused. Logged, counted, tried again after the delay.
    console.error({ event: 'routine_key_reused' })
    await db.batch([
      alertStatement(db, 'key_reused', now),
      db.prepare("UPDATE routine_slots SET next_attempt_ms = ? WHERE slot_key = ? AND state = 'claimed'").bind(now + RETRY_MS, s.slot_key),
    ])
    return 0
  }
  if (TRANSIENT.has(code)) {
    await db.prepare("UPDATE routine_slots SET next_attempt_ms = ? WHERE slot_key = ? AND state = 'claimed'").bind(now + RETRY_MS, s.slot_key).run()
    return 0
  }
  // Final (OC 7): paused, cap_reached, removed and any code not named transient.
  const res = await close(db, s.slot_key, 'claimed', 'refused', reason ?? code).run()
  return res.meta.changes
}
