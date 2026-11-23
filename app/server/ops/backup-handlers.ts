// The nightly backup's due task (P8 C1; p3-design section 6): `backup`, seeded (ensure semantics: due now on the first
// start, then it keeps its time), run at 01:30 UTC. Rules it keeps:
// - re-arm first: the next slot is scheduled before any work, so a throw neither quarantines the task nor stops the
//   schedule (the task's own commit then lands on an old generation and matches no row);
// - never `retryAtMs`: it answers `done`, and a failure is a log line (`backup_failed`, the error's name and code only)
//   that the freshness signal shows (the newest complete backup's age);
// - one retry on `fk_closure` (B2): a routine run ending inside the backup's read window can re-point a today item at a
//   slot claimed after the point, which fails the closure check in normal use. A second failure is `backup_failed`.
// G1's backup is one invocation: about 50 PRAGMA reads (the rules' columns, foreign keys and modes), one point batch
// and a read per page, and an R2 put per 1,000-row part plus the manifest. The retry can double that once.
// No handler sets or deletes the alarm: the scheduler owns it.
import { backup } from '../../ops/backup/backup.ts'
import { BackupError } from '../../ops/backup/errors.ts'
import type { BackupManifest } from '../../ops/backup/manifest.ts'
import type { KeyedBucket } from '../db/r2-keys.ts'
import type { DueTask, TaskContext, TaskHandler, TaskResult } from '../do/brand-agent/scheduler.ts'
import { withSeed } from '../do/brand-agent/scheduler.ts'
import { safeError } from '../safe-error.ts'

export const BACKUP_TASK_ID = 'backup'
export const BACKUP_AT = { hour: 1, minute: 30 } as const

/** The next `hour:minute` UTC strictly after `nowMs`. */
export function nextDaily(nowMs: number, at: { hour: number; minute: number }): number {
  const d = new Date(nowMs)
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), at.hour, at.minute)
  return today > nowMs ? today : today + 86_400_000
}

export type BackupRun = (deps: { db: D1Database; bucket: KeyedBucket; nowMs: number }) => Promise<BackupManifest>

/** The handler, with the backup it runs (G1's `backup`; tests pass a double). */
export function createBackupTask(run: BackupRun = backup): TaskHandler {
  const handler = async (task: DueTask, ctx: TaskContext): Promise<TaskResult> => {
    ctx.scheduler.schedule({ id: BACKUP_TASK_ID, kind: BACKUP_TASK_ID, dueAtMs: nextDaily(ctx.nowMs, BACKUP_AT) })
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const m = await run({ db: ctx.env.DB, bucket: ctx.env.FILES, nowMs: ctx.nowMs })
        const rows = m.tables.reduce((n, t) => n + t.rows, 0)
        const parts = m.tables.reduce((n, t) => n + t.parts.length, 0)
        console.log({ event: 'backup_done', taskId: task.id, backupId: m.backupId, tables: m.tables.length, rows, parts, attempt })
        return { done: true }
      } catch (err) {
        const code = err instanceof BackupError ? err.code : undefined
        if (code === 'fk_closure' && attempt === 1) {
          console.warn({ event: 'backup_retry', taskId: task.id, code })
          continue
        }
        console.error({ event: 'backup_failed', taskId: task.id, error: safeError(err), code, attempt })
        return { done: true }
      }
    }
    return { done: true }
  }
  return withSeed(handler, { id: BACKUP_TASK_ID })
}

export const backupTask: TaskHandler = createBackupTask()
