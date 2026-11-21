// The `audit-copy` due task (p3-design section 9; P3 acceptance 8): once a day the audit log's new lines go to R2 as
// JSON Lines, one object per id range. Owner: W4. Safe to rerun at any step:
// 1. the range is persisted first (`audit_copy_state.pending_from/to`, a conditional update from the cursor);
// 2. the object's key comes from that persisted range and the time it was persisted
//    (`audit-copy/<date>/<from>-<to>.jsonl`), so a rerun rewrites the same key with the same lines;
// 3. the cursor advances only `WHERE last_id = from - 1 AND pending_from = from`, so a lost reply or a rerun moves it once;
// 4. lines are read in keyset pages of 1,000; a range holds at most 10,000 lines, and a pass copies at most five ranges;
// 5. then tomorrow's task is ensured. After a D1 restore the cursor is reset by P8's restore (flagged to P8).
// R2 `put` "stores the given value and metadata under the associated key"
// (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/, read 2026-11-20; the page doesn't say more
// about an existing key): a rerun puts the same lines under the same key, and audit-copy.test.ts proves one object per range.
import { auditCopyKey } from './db/r2-keys.ts'
import type { DueTask, TaskContext, TaskHandler, TaskResult } from './do/brand-agent/scheduler.ts'

export const AUDIT_COPY_PAGE = 1_000
export const AUDIT_COPY_MAX_RANGE = 10_000
const MAX_RANGES_PER_PASS = 5

export interface AuditCopyDeps {
  db: D1Database
  files: R2Bucket
  nowMs: number
  /** Tests only: runs just before the cursor update (throw: the update never ran). */
  beforeAdvance?: () => void
  /** Tests only: runs just after the cursor update committed (throw: its reply was lost). */
  afterAdvance?: () => void
}

type State = { last_id: number; pending_from: number | null; pending_to: number | null; at_ms: number }
type Line = { id: number; at_ms: number; actor_id: string; action: string; target_kind: string | null; target_id: string | null; args_json: string; req_id: string }

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** One pass: copies every pending or new range (up to five) and returns the keys it wrote. */
export async function copyAuditLog(d: AuditCopyDeps): Promise<{ key: string; from: number; to: number; lines: number }[]> {
  const { db } = d
  const state = () => db.prepare('SELECT last_id, pending_from, pending_to, at_ms FROM audit_copy_state WHERE id = 1').first<State>()
  await db.prepare('INSERT OR IGNORE INTO audit_copy_state (id, last_id, at_ms) VALUES (1, 0, ?)').bind(d.nowMs).run()
  const written: { key: string; from: number; to: number; lines: number }[] = []
  for (let pass = 0; pass < MAX_RANGES_PER_PASS; pass++) {
    let s = await state()
    if (!s) throw new Error('audit copy: no state row')
    if (s.pending_from === null) {
      const max = (await db.prepare('SELECT COALESCE(MAX(id), 0) AS max FROM audit_log').first<{ max: number }>())?.max ?? 0
      const from = s.last_id + 1
      if (max < from) break
      const to = Math.min(max, from + AUDIT_COPY_MAX_RANGE - 1)
      await db.prepare('UPDATE audit_copy_state SET pending_from = ?, pending_to = ?, at_ms = ? WHERE id = 1 AND last_id = ? AND pending_from IS NULL')
        .bind(from, to, d.nowMs, s.last_id).run()
      s = await state()
      if (!s || s.pending_from === null || s.pending_to === null) throw new Error('audit copy: the range was not persisted')
    }
    const from = s.pending_from
    const to = s.pending_to as number
    const key = auditCopyKey(utcDate(s.at_ms), from, to)
    const lines: Line[] = []
    for (let after = from - 1; ;) {
      const page = (await db.prepare('SELECT id, at_ms, actor_id, action, target_kind, target_id, args_json, req_id FROM audit_log WHERE id > ? AND id <= ? ORDER BY id LIMIT ?')
        .bind(after, to, AUDIT_COPY_PAGE).all<Line>()).results
      lines.push(...page)
      if (page.length < AUDIT_COPY_PAGE) break
      after = page[page.length - 1].id
    }
    await d.files.put(key, lines.map(l => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''), { httpMetadata: { contentType: 'application/x-ndjson' } })
    d.beforeAdvance?.()
    await db.prepare('UPDATE audit_copy_state SET last_id = ?, pending_from = NULL, pending_to = NULL, at_ms = ? WHERE id = 1 AND last_id = ? AND pending_from = ?')
      .bind(to, d.nowMs, from - 1, from).run()
    d.afterAdvance?.()
    written.push({ key, from, to, lines: lines.length })
  }
  return written
}

/** The task id for a UTC date: `audit-copy:YYYY-MM-DD`. */
export const auditCopyTaskId = (date: string): string => `audit-copy:${date}`
/** When a day's copy is due: 02:00 UTC that day. */
export const auditCopyDueMs = (date: string): number => Date.parse(`${date}T02:00:00Z`)

const nextDate = (date: string) => utcDate(Date.parse(`${date}T00:00:00Z`) + 86_400_000)

export const auditCopy: TaskHandler = async (task: DueTask, ctx: TaskContext): Promise<TaskResult> => {
  const m = /^audit-copy:(\d{4}-\d{2}-\d{2})$/.exec(task.id)
  const date = m && !Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`)) ? m[1] : utcDate(ctx.nowMs)
  const written = await copyAuditLog({ db: ctx.env.DB, files: ctx.env.FILES, nowMs: ctx.nowMs })
  console.log({ event: 'audit_copy', taskId: task.id, ranges: written.length, lines: written.reduce((n, w) => n + w.lines, 0) })
  const tomorrow = nextDate(date)
  ctx.scheduler.ensure({ id: auditCopyTaskId(tomorrow), kind: 'audit-copy', dueAtMs: auditCopyDueMs(tomorrow) })
  return { done: true }
}
