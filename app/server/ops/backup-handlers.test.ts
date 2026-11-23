// The nightly backup's due task (P8 C1). Ways it can fail, written down first:
//  1. the seed is made again on every start, or a restart moves its due time;
//  2. a throw before the re-arm stops the schedule (or quarantines the task through retries);
//  3. it doesn't run at 01:30 UTC, or doesn't write a complete manifest;
//  4. it answers `retryAtMs` (a failure that counts toward quarantine and turns the runs signal red);
//  5. a routine run ending mid-backup (fk_closure) fails the night: it retries once, and a second failure is logged;
//  6. its D1 queries pass the invocation's 1,000 (G1's ceiling); a handler sets or deletes the alarm.
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { backup, listBackups } from '../../ops/backup/backup.ts'
import { BackupError } from '../../ops/backup/errors.ts'
import type { DueTask, TaskContext } from '../do/brand-agent/scheduler.ts'
import { inAgent } from '../testing/brand-agent/core-harness.ts'
import { openStores } from '../db/stores.ts'
import { seedBrand } from '../seed/seed.ts'
import { BACKUP_AT, BACKUP_TASK_ID, createBackupTask, nextDaily } from './backup-handlers.ts'
import type { BackupRun } from './backup-handlers.ts'
import { counting } from './retention-handlers.ts'

const NOW = Date.UTC(2027, 2, 10, 1, 30)
const task: DueTask = { id: BACKUP_TASK_ID, kind: BACKUP_TASK_ID, gen: 1, dueAtMs: NOW, payload: null, attempts: 0 }
function fakeCtx(nowMs = NOW) {
  const scheduled: { id: string; kind: string; dueAtMs: number }[] = []
  const ctx = { nowMs, env, scheduler: { schedule: (t: { id: string; kind: string; dueAtMs: number }) => { scheduled.push(t) }, ensure: () => {}, cancel: () => {} } } as unknown as TaskContext
  return { ctx, scheduled }
}
const handlerSources = import.meta.glob<string>(['./backup-handlers.ts', './retention-handlers.ts'], { query: '?raw', import: 'default', eager: true })

describe('the backup task', () => {
  it('the backup seed is created once and keeps its due time across object restarts', () => inAgent(async h => {
    const h2 = h.restart()
    const due = () => h2.sql.exec<{ due_at_ms: number }>("SELECT due_at_ms FROM due_tasks WHERE id = 'backup'").toArray()
    const first = due()
    expect(first).toHaveLength(1)
    h2.clock.now += 3_600_000
    const h3 = h2.restart()
    expect(h3.sql.exec<{ due_at_ms: number }>("SELECT due_at_ms FROM due_tasks WHERE id = 'backup'").toArray()).toEqual(first)
  }))

  it('the backup handler re-arms its next slot before any work, so a throw neither quarantines the task nor stops the schedule', async () => {
    const { ctx, scheduled } = fakeCtx()
    const order: string[] = []
    const failing: BackupRun = async () => { order.push(`run after ${scheduled.length} schedule`); throw new Error('D1 down (test)') }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await createBackupTask(failing)(task, ctx)
    spy.mockRestore()
    expect(order).toEqual(['run after 1 schedule'])
    expect(scheduled).toEqual([{ id: BACKUP_TASK_ID, kind: BACKUP_TASK_ID, dueAtMs: nextDaily(NOW, BACKUP_AT) }])
    expect(r).toEqual({ done: true })
  })

  it('the nightly backup writes one complete manifest and arms the next run at 01:30 UTC', async () => {
    await seedBrand(env.DB, openStores(env), NOW)
    const before = (await listBackups(env.FILES)).length
    const { ctx, scheduled } = fakeCtx()
    expect(await createBackupTask()(task, ctx)).toEqual({ done: true })
    expect((await listBackups(env.FILES)).length).toBe(before + 1)
    expect(scheduled[0].dueAtMs).toBe(Date.UTC(2027, 2, 11, 1, 30))
    // Just after 01:30 the next run is tomorrow's; just before, today's.
    expect(nextDaily(Date.UTC(2027, 2, 10, 1, 29), BACKUP_AT)).toBe(Date.UTC(2027, 2, 10, 1, 30))
    expect(nextDaily(Date.UTC(2027, 2, 10, 1, 30), BACKUP_AT)).toBe(Date.UTC(2027, 2, 11, 1, 30))
  })

  it('the backup handler never returns retryAtMs', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const err of [new Error('x'), new BackupError('snapshot_too_large', 't'), new BackupError('fk_closure', 'a -> b: "1"')]) {
      const r = await createBackupTask(async () => { throw err })(task, fakeCtx().ctx)
      expect(r).toEqual({ done: true })
    }
    spy.mockRestore()
  })

  it('retries once on fk_closure, and logs backup_failed when the retry fails too', async () => {
    const calls: number[] = []
    const okOnSecond: BackupRun = async d => {
      calls.push(1)
      if (calls.length === 1) throw new BackupError('fk_closure', 'today_items.slot_key -> routine_slots.slot_key: "s"')
      return backup(d)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await createBackupTask(okOnSecond)(task, fakeCtx().ctx)).toEqual({ done: true })
    expect(calls).toHaveLength(2)
    const errors: unknown[] = []
    const err = vi.spyOn(console, 'error').mockImplementation(e => { errors.push(e) })
    let n = 0
    await createBackupTask(async () => { n++; throw new BackupError('fk_closure', 'x -> y: "1"') })(task, fakeCtx().ctx)
    warn.mockRestore()
    err.mockRestore()
    expect(n).toBe(2)
    expect(errors).toEqual([{ event: 'backup_failed', taskId: BACKUP_TASK_ID, error: 'BackupError:fk_closure', code: 'fk_closure', attempt: 2 }])
  })

  it('the backup\'s D1 queries and R2 calls for the seeded brand are recorded against the stated ceiling', async () => {
    const c = counting(env.DB, env.FILES)
    const m = await backup({ db: c.db, bucket: c.bucket, nowMs: NOW + 5 })
    // G1's ceiling is the invocation's 1,000 D1 queries; record the numbers so the PR can state them.
    console.log({ event: 'backup_cost_seeded', d1: c.used.d1, r2: c.used.r2, tables: m.tables.length })
    expect(c.used.d1).toBeLessThan(500)
    expect(c.used.r2).toBeLessThan(500)
  })

  it('no handler file calls setAlarm or deleteAlarm', () => {
    expect(Object.keys(handlerSources).sort()).toEqual(['./backup-handlers.ts', './retention-handlers.ts'])
    for (const [file, text] of Object.entries(handlerSources)) expect(/\b(setAlarm|deleteAlarm)\b/.test(text), file).toBe(false)
  })
})
