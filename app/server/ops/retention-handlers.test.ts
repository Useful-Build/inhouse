// The daily retention's due task (P8 C1). Ways it can fail, written down first:
//  1. the seed is made again on every start, or a restart moves its due time;
//  2. a throw before the re-arm stops the schedule; it runs at another time than 03:30 UTC; `retention-more` re-arms
//     the daily slot;
//  3. it answers `retryAtMs`;
//  4. one run passes 200 D1 statements or 100 R2 calls (a pass's 10 s budget), or leftover work is dropped instead of
//     continuing under `retention-more` from where it stopped;
//  5. the BrandAgent part's removals aren't in the deletion log, or the log holds more than ids and counts.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { deletionLogEntrySchema, listDeletionLog } from '../../ops/delete/log.ts'
import { token } from '../../ops/delete/test-support.ts'
import { addChat } from '../../ops/coverage/chat-watch-connectors/test-support.ts'
import { tables } from '../../ops/tables/index.ts'
import type { DueTask, TaskContext } from '../do/brand-agent/scheduler.ts'
import { inAgent } from '../testing/brand-agent/core-harness.ts'
import { openStores } from '../db/stores.ts'
import { seedBrand } from '../seed/seed.ts'
import type { Seeded } from '../seed/seed.ts'
import { nextDaily } from './backup-handlers.ts'
import { MAX_D1, MAX_R2, MORE_AFTER_MS, RETENTION_AT, RETENTION_MORE_ID, RETENTION_TASK_ID, createRetentionTask, retentionPass, retentionStores } from './retention-handlers.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2040, 0, 15, 3, 30)
let seeded: Seeded
const daily: DueTask = { id: RETENTION_TASK_ID, kind: RETENTION_TASK_ID, gen: 1, dueAtMs: NOW, payload: null, attempts: 0 }
function fakeCtx(over: Partial<TaskContext> = {}) {
  const scheduled: { id: string; kind: string; dueAtMs: number; payload?: unknown }[] = []
  const ctx = { nowMs: NOW, env, scheduler: { schedule: (t: (typeof scheduled)[number]) => { scheduled.push(t) }, ensure: () => {}, cancel: () => {} }, ...over } as unknown as TaskContext
  return { ctx, scheduled }
}
const entry = (name: string) => tables.find(t => t.name === name)!

beforeAll(async () => {
  seeded = await seedBrand(env.DB, openStores(env), NOW - 9_000 * DAY)
})

describe('the retention task', () => {
  it('the retention seed is created once and keeps its due time across object restarts', () => inAgent(async h => {
    const h2 = h.restart()
    const first = h2.sql.exec<{ due_at_ms: number }>("SELECT due_at_ms FROM due_tasks WHERE id = 'retention'").toArray()
    expect(first).toHaveLength(1)
    h2.clock.now += 3_600_000
    const h3 = h2.restart()
    expect(h3.sql.exec<{ due_at_ms: number }>("SELECT due_at_ms FROM due_tasks WHERE id = 'retention'").toArray()).toEqual(first)
  }))

  it('the retention handler re-arms its next slot before any work, so a throw neither quarantines the task nor stops the schedule; the retention handler arms the next slot at 03:30 UTC', async () => {
    // A database that fails on first use: the re-arm has already happened.
    const broken = { prepare: () => { throw new Error('D1 down (test)') }, batch: () => Promise.reject(new Error('D1 down (test)')) } as unknown as D1Database
    const { ctx, scheduled } = fakeCtx({ env: { ...env, DB: broken } as Env })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await createRetentionTask({ registry: [entry('activity_lines')] })(daily, ctx)).toEqual({ done: true })
    spy.mockRestore()
    expect(scheduled[0]).toEqual({ id: RETENTION_TASK_ID, kind: RETENTION_TASK_ID, dueAtMs: Date.UTC(2040, 0, 16, 3, 30) })
    expect(nextDaily(Date.UTC(2040, 0, 15, 3, 29), RETENTION_AT)).toBe(Date.UTC(2040, 0, 15, 3, 30))
    // retention-more never re-arms the daily slot.
    const more = fakeCtx()
    await createRetentionTask({ registry: [entry('activity_lines')] })({ ...daily, id: RETENTION_MORE_ID, payload: { from: 0 } }, more.ctx)
    expect(more.scheduled.filter(s => s.id === RETENTION_TASK_ID)).toEqual([])
  })

  it('the retention handler never returns retryAtMs', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = { prepare: () => { throw new Error('x') }, batch: () => Promise.reject(new Error('x')) } as unknown as D1Database
    expect(await createRetentionTask()(daily, fakeCtx({ env: { ...env, DB: broken } as Env }).ctx)).toEqual({ done: true })
    expect(await createRetentionTask({ registry: [entry('activity_lines')] })(daily, fakeCtx().ctx)).toEqual({ done: true })
    spy.mockRestore()
  })

  it('one retention run stays within 200 D1 statements and 100 R2 calls; leftover work continues under retention-more', async () => {
    const cut = NOW - 365 * DAY
    // More than one run's worth: 30 chats past retention (10 a run) and 2,000 old Activity lines (1,500 a run).
    for (let i = 0; i < 30; i++) await addChat(env.DB, env.FILES, { id: `c_${token()}`, owner: seeded.members.dana, lastAtMs: cut - 1 - i, marker: `bud${i}` })
    await env.DB.prepare(`WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 2000)
      INSERT INTO activity_lines (id, at_ms, kind, template, fields_json, source, source_key) SELECT 'ab_' || i, ?, 'change', 't', '{}', 'test', 'ab_' || i FROM s`).bind(cut - 1).run()
    const registry = ['chats', 'chat_messages', 'files/', 'sessions/', 'activity_lines'].map(entry)
    let from = 0
    let runs = 0
    while (from < retentionStores(registry).length) {
      const pass = await retentionPass({ db: env.DB, bucket: env.FILES, nowMs: NOW, requestId: `r${runs}`, from, registry })
      expect(pass.used.d1, `run ${runs}`).toBeLessThanOrEqual(MAX_D1)
      expect(pass.used.r2, `run ${runs}`).toBeLessThanOrEqual(MAX_R2)
      from = pass.reached
      runs++
      expect(runs).toBeLessThan(20)
    }
    expect(runs).toBeGreaterThan(2)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM chats WHERE last_at_ms < ?').bind(cut).first<{ n: number }>())!.n).toBe(0)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM activity_lines WHERE at_ms < ?').bind(cut).first<{ n: number }>())!.n).toBe(0)
    // Through the handler: a run that stops early schedules retention-more a minute on, from where it stopped.
    for (let i = 0; i < 25; i++) await addChat(env.DB, env.FILES, { id: `c_${token()}`, owner: seeded.members.dana, lastAtMs: cut - 1, marker: `bud2${i}` })
    const { ctx, scheduled } = fakeCtx()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await createRetentionTask({ registry })(daily, ctx)
    vi.restoreAllMocks()
    expect(scheduled.find(s => s.id === RETENTION_MORE_ID)).toEqual({ id: RETENTION_MORE_ID, kind: RETENTION_TASK_ID, dueAtMs: NOW + MORE_AFTER_MS, payload: { from: 0 } })
  })

  it('the retention handler writes the BrandAgent part\'s deletion-log entries with ids and counts only', async () => {
    const stub = env.BRAND_AGENT.get(env.BRAND_AGENT.idFromName(`rh-${token()}`))
    const before = (await listDeletionLog(env.FILES)).map(e => e.key)
    await runInDurableObject(stub, async (_obj, state) => {
      await state.storage.deleteAlarm()
      const sql = state.storage.sql
      sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, started_at_ms, ended_at_ms) VALUES ('r_log', 'c_log', 'm_x', 'ended', 0, ?)", NOW - 400 * DAY)
      sql.exec(`INSERT INTO turns (turn_id, run_id, chat_id, owner_id, ord, client_key, payload_hash, state, priority, text, attachments_json, model, picker_id, side_model, effort, max_turns, answer_position, d1_flushed, created_at_ms)
        VALUES ('t_log', 'r_log', 'c_log', 'm_x', 0, 'k', 'h', 'ended', 'now', 'a private question', '[]', 'm', 'p', 's', 'e', 1, 'end', 1, 0)`)
      sql.exec("INSERT INTO events (run_id, seq, turn_id, at_ms, json) VALUES ('r_log', 0, 't_log', 0, '{\"text\":\"private\"}')")
      await retentionPass({ db: env.DB, bucket: env.FILES, sql, nowMs: NOW, requestId: 'rlog', from: 0, registry: [entry('BrandAgent')] })
      expect(sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE run_id = 'r_log'").one().n).toBe(0)
    })
    const added = (await listDeletionLog(env.FILES)).filter(e => !before.includes(e.key))
    const progress = added.filter(e => e.entry.phase === 'progress')
    expect(progress.flatMap(e => e.entry.removed ?? [])).toEqual([{ store: 'BrandAgent', ids: ['r_log'], count: 3 }])
    for (const e of added) {
      expect(deletionLogEntrySchema.parse(e.entry)).toEqual(e.entry)
      expect(JSON.stringify(e.entry)).not.toContain('private')
    }
  })
})
