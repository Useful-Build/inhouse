// The `chat-file-sweep` due task (P3 tracker row "Later (W3 follow-up): chat file orphan sweep"; p3-design 8.5, 6).
// Two kinds of leftovers the file store can't clean up by itself, per brand (one D1 and one R2 bucket per brand):
//  - R2 objects under `files/` with no `chat_files` row: a D1 write that failed after the put (route 39), a retried
//    PUT's dropped copy (`confirm` deletes the duplicate row, not its object), a PUT that failed after its put.
//  - `pending` rows never confirmed: the PUT's slot row stays when the Worker died before its `finally`, or the runner
//    never sent `file_saved`.
// What it never touches: a row that isn't `pending` (so no saved, superseded or trashed chat's file: a chat in the trash
// keeps its rows and objects until its purge deletes them), an object that has any row, an object or row younger than
// `SAFETY_AGE_MS`, a pending row whose turn still has a file confirm queued in the object, and any key outside `files/`
// (`sessions/`, `photos/`, `audit-copy/` and the rest of the bucket).
// Bounded: a pass lists at most `SCAN_PAGES` pages of `SCAN_PAGE` keys and reads at most `PENDING_PAGES` pages of
// `PENDING_PAGE` rows; the R2 listing resumes from the task's payload cursor on the next pass. Idempotent: a repeat
// finds nothing left, and an R2 delete of a missing key is not an error. Logs counts only.
// R2 `list` returns up to 1,000 keys with `uploaded`, a `truncated` flag and a `cursor`; `delete` takes up to 1,000 keys
// (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/, read 2026-11-21).
// D1 allows 100 bound parameters a query (https://developers.cloudflare.com/d1/platform/limits/, read 2026-11-21),
// so `SCAN_PAGE` is 100: one lookup per page.
import { CHAT_FILES_PREFIX as FILES_PREFIX } from '../db/r2-keys.ts'
import { RUN_TOKEN_TTL_MS } from '../do/brand-agent/tokens.ts'
import type { DueTask, Scheduler, TaskContext, TaskHandler, TaskResult } from '../do/brand-agent/scheduler.ts'
import { withSeed } from '../do/brand-agent/scheduler.ts'

export const SWEEP_TASK_ID = 'chat-file-sweep'
/**
 * How old an object or a pending row must be before the sweep may remove it: the run token's life (45 minutes: an output
 * PUT needs a live token, and the runner's `file_saved` follows its PUT inside the turn) plus 15 minutes for the
 * confirm's 30 s retries, the 90 s release wait, a route 39 upload's put-to-row gap and a late alarm. One age for both.
 */
export const SAFETY_AGE_MS = RUN_TOKEN_TTL_MS + 15 * 60_000
/** A finished scan starts over this long after; an unfinished one (or a pending backlog) goes on after `CONTINUE_MS`. */
export const SCAN_EVERY_MS = 6 * 60 * 60_000
export const CONTINUE_MS = 60_000
export const SCAN_PAGE = 100
export const SCAN_PAGES = 5
export const PENDING_PAGE = 100
export const PENDING_PAGES = 5

export interface SweepResult {
  /** Objects looked at. */
  scanned: number
  /** Objects with no row, old enough: deleted. */
  orphansDeleted: number
  /** Pending rows past the window with no confirm queued: row and object deleted. */
  pendingExpired: number
  /** The R2 listing's resume point, or null when this pass reached its end. */
  cursor: string | null
  /** The pending phase stopped at its bound with rows left to read. */
  pendingMore: boolean
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ')

export interface SweepDeps {
  db: D1Database
  bucket: Pick<R2Bucket, 'list' | 'delete'>
  nowMs: number
  /** Does this turn still have a file confirm queued in the object (`turn_effects`)? Read-only. */
  confirmQueued: (turnId: string) => boolean
  cursor?: string | null
}

/** Pending rows past the window, oldest first: the row goes first (guarded on `pending`), then its object. */
async function expirePending(d: SweepDeps): Promise<{ expired: number; more: boolean }> {
  let expired = 0
  let after = { at: -1, id: '' }
  for (let page = 0; page < PENDING_PAGES; page++) {
    const rows = (await d.db.prepare(
      `SELECT id, r2_key, turn_id, created_at_ms FROM chat_files
        WHERE state = 'pending' AND created_at_ms < ? AND (created_at_ms > ? OR (created_at_ms = ? AND id > ?))
        ORDER BY created_at_ms, id LIMIT ?`,
    ).bind(d.nowMs - SAFETY_AGE_MS, after.at, after.at, after.id, PENDING_PAGE).all<{ id: string; r2_key: string; turn_id: string | null; created_at_ms: number }>()).results
    const gone: string[] = []
    for (const r of rows) {
      if (r.turn_id !== null && d.confirmQueued(r.turn_id)) continue
      // A confirm that flipped it to saved after the read leaves 0 changes: the file is kept, object and all.
      const res = await d.db.prepare("DELETE FROM chat_files WHERE id = ? AND state = 'pending'").bind(r.id).run()
      if ((res.meta.changes ?? 0) === 1) gone.push(r.r2_key)
    }
    // A key another row still names (a duplicate or a reused key) stays: the orphan rule decides it, never this one.
    if (gone.length > 0) {
      const named = new Set((await d.db.prepare(`SELECT r2_key FROM chat_files WHERE r2_key IN (${marks(gone.length)})`).bind(...gone).all<{ r2_key: string }>()).results.map(x => x.r2_key))
      const free = gone.filter(k => !named.has(k))
      if (free.length > 0) await d.bucket.delete(free)
    }
    expired += gone.length
    if (rows.length < PENDING_PAGE) return { expired, more: false }
    const last = rows[rows.length - 1]
    after = { at: last.created_at_ms, id: last.id }
  }
  return { expired, more: true }
}

/** Lists up to `SCAN_PAGES` pages under `files/` from `cursor`, deletes the old keys no row names. */
async function sweepOrphans(d: SweepDeps): Promise<{ scanned: number; deleted: number; cursor: string | null }> {
  let scanned = 0
  let deleted = 0
  let cursor = d.cursor ?? undefined
  for (let page = 0; page < SCAN_PAGES; page++) {
    const listed = await d.bucket.list({ prefix: FILES_PREFIX, limit: SCAN_PAGE, ...(cursor ? { cursor } : {}) })
    const old = listed.objects.filter(o => o.key.startsWith(FILES_PREFIX) && o.uploaded.getTime() < d.nowMs - SAFETY_AGE_MS).map(o => o.key)
    scanned += listed.objects.length
    if (old.length > 0) {
      const named = new Set((await d.db.prepare(`SELECT r2_key FROM chat_files WHERE r2_key IN (${marks(old.length)})`).bind(...old).all<{ r2_key: string }>()).results.map(x => x.r2_key))
      const orphans = old.filter(k => !named.has(k))
      if (orphans.length > 0) { await d.bucket.delete(orphans); deleted += orphans.length }
    }
    if (!listed.truncated) return { scanned, deleted, cursor: null }
    cursor = listed.cursor
  }
  return { scanned, deleted, cursor: cursor ?? null }
}

/** One pass: expires stale pending rows, then lists a bounded run of `files/` for orphans. */
export async function sweepOnce(d: SweepDeps): Promise<SweepResult> {
  const p = await expirePending(d)
  const o = await sweepOrphans(d)
  return { scanned: o.scanned, orphansDeleted: o.deleted, pendingExpired: p.expired, cursor: o.cursor, pendingMore: p.more }
}

const cursorOf = (payload: unknown): string | null =>
  typeof payload === 'object' && payload !== null && 'cursor' in payload && typeof payload.cursor === 'string' ? payload.cursor : null

/** Makes the next pass due: soon with the resume cursor while work is left, else a fresh scan in `SCAN_EVERY_MS`. */
export const scheduleNext = (scheduler: Scheduler, nowMs: number, r: SweepResult): void =>
  scheduler.schedule(r.cursor !== null || r.pendingMore
    ? { id: SWEEP_TASK_ID, kind: SWEEP_TASK_ID, dueAtMs: nowMs + CONTINUE_MS, payload: r.cursor !== null ? { cursor: r.cursor } : undefined }
    : { id: SWEEP_TASK_ID, kind: SWEEP_TASK_ID, dueAtMs: nowMs + SCAN_EVERY_MS })

const run: TaskHandler = async (task: DueTask, ctx: TaskContext): Promise<TaskResult> => {
  const confirmQueued = (turnId: string) => ctx.sql.exec('SELECT 1 FROM turn_effects WHERE turn_id = ? LIMIT 1', turnId).toArray().length > 0
  const r = await sweepOnce({ db: ctx.env.DB, bucket: ctx.env.FILES, nowMs: ctx.nowMs, confirmQueued, cursor: cursorOf(task.payload) })
  console.log({ event: 'chat_file_sweep', taskId: task.id, scanned: r.scanned, orphansDeleted: r.orphansDeleted, pendingExpired: r.pendingExpired, resumed: r.cursor !== null, pendingMore: r.pendingMore })
  scheduleNext(ctx.scheduler, ctx.nowMs, r)
  return { done: true }
}

/** The registered handler (tasks/index.ts): seeded due now on every start, `ensure` semantics (an existing one keeps its time). */
export const chatFileSweep: TaskHandler = withSeed(run, { id: SWEEP_TASK_ID })
