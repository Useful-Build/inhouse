// The daily retention's due task (P8 C1; p3-design section 6): `retention`, seeded (ensure semantics), run at 03:30 UTC
// (after the 02:00 audit copy), inside the BrandAgent so its storage part reaches the object's SQLite (`ctx.sql`).
// Rules it keeps:
// - re-arm first: only the `retention` id re-arms the daily slot, before any work;
// - store by store: each run plans and runs one store with G2's registry narrowed to it and its job's `limit`, so no
//   plan outlives its invocation;
// - bounded by counts, not time (a pass starts up to 20 tasks or runs 10 s): at most 200 D1 statements and 100 R2 calls
//   per run, counted by wrappers. Before each store it checks there's room for that store's worst case; with more to
//   do it schedules `retention-more` a minute on, resuming at that store, and stops;
// - never `retryAtMs`: a failure is a log line (`retention_failed`, the error's name and code only); the freshness
//   signal shows the newest `done` entry in the deletion log.
// Every removal is in the deletion log (G2's entries: ids and counts only), the BrandAgent part's too.
// No handler sets or deletes the alarm: the scheduler owns it.
import { runRetention, planRetention } from '../../ops/retention/retention.ts'
import { DEFAULT_DAYS, hasRetentionWork, periodsFor, retentionRules } from '../../ops/retention/rules.ts'
import type { PeriodName } from '../../ops/retention/rules.ts'
import { SERVED_BY } from '../../ops/coverage/chat-watch-connectors/retention-jobs.ts'
import { tables } from '../../ops/tables/index.ts'
import type { TableEntry } from '../../ops/tables/types.ts'
import type { KeyedBucket } from '../db/r2-keys.ts'
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import { BRAND_OWNER, retentionDaysOf } from '../db/settings.ts'
import { all, stmt } from '../db/sql.ts'
import type { DueTask, TaskContext, TaskHandler, TaskResult } from '../do/brand-agent/scheduler.ts'
import { withSeed } from '../do/brand-agent/scheduler.ts'
import { safeError } from '../safe-error.ts'
import { nextDaily } from './backup-handlers.ts'
import { RETENTION_AT } from '../../shared/contract/data-access.ts'

export const RETENTION_TASK_ID = 'retention'
export const RETENTION_MORE_ID = 'retention-more'
// The cleanup's time lives in the shared contract, so Data and access shows the same next cleanup the scheduler sets.
export { RETENTION_AT } from '../../shared/contract/data-access.ts'
export const MORE_AFTER_MS = 60_000
export const MAX_D1 = 200
export const MAX_R2 = 100

/**
 * One store's worst case per run, for the room check: D1 statements and R2 calls (plan and run, the log's start,
 * progress and done puts included). The chat cascade lists two prefixes per chat at plan and again at run, and deletes
 * once per round of 10, so it takes at most `CHATS_LIMIT` chats a run.
 */
export const CHATS_LIMIT = 10
const COST = { d1: 30, r2: 12 }
const CHATS_COST = { d1: 30, r2: 4 * CHATS_LIMIT + 6 }
const LIMIT = 90

export async function brandRetentionSettings(db: D1Database) {
  const rows = await all<{ key: 'd:chats' | 'd:steps'; value_json: string; shortened_at_ms: number | null; retention_enabled_at_ms: number | null }>(db, stmt(
    "SELECT key, value_json, shortened_at_ms, retention_enabled_at_ms FROM settings WHERE owner = ? AND key IN ('d:chats', 'd:steps')", BRAND_OWNER,
  ))
  const days: Record<PeriodName, number | null> = { ...DEFAULT_DAYS }
  const shortenedAt: Partial<Record<PeriodName, number>> = {}
  const enabledAt: Partial<Record<PeriodName, number>> = {}
  for (const row of rows) {
    const group = row.key === 'd:chats' ? 'chats' : 'steps'
    if (row.shortened_at_ms !== null) shortenedAt[group] = row.shortened_at_ms
    if (row.retention_enabled_at_ms !== null) enabledAt[group] = row.retention_enabled_at_ms
    days[group] = retentionDaysOf(row.key, JSON.parse(row.value_json))
  }
  return { days, shortenedAt, enabledAt }
}

export const brandRetentionDays = async (db: D1Database) => (await brandRetentionSettings(db)).days

/**
 * Every store retention acts on, in registry order: a `retention_period` entry that isn't derived, or a custom rule;
 * never one another store's job serves (a chat's messages go with the chats run), so an empty run isn't logged twice.
 */
export function retentionStores(registry: readonly TableEntry[] = tables): TableEntry[] {
  return registry.filter(e => !e.derived && SERVED_BY[e.name] === undefined && (e.retention === 'retention_period' || retentionRules[e.name]?.kind === 'custom'))
}

/** A D1 database and a bucket that count what they're asked to do. */
export function counting(db: D1Database, bucket: KeyedBucket) {
  const used = { d1: 0, r2: 0 }
  const countedDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') return (q: string) => { used.d1++; return target.prepare(q) }
      const v = Reflect.get(target, prop, receiver) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
  const countedBucket = new Proxy(bucket, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown
      if (typeof v !== 'function') return v
      return (...a: unknown[]) => { used.r2++; return (v as (...a: unknown[]) => unknown).apply(target, a) }
    },
  })
  return { db: countedDb, bucket: countedBucket, used }
}

const resumeAt = (payload: unknown): number =>
  typeof payload === 'object' && payload !== null && 'from' in payload && typeof payload.from === 'number' && Number.isSafeInteger(payload.from) && payload.from >= 0 ? payload.from : 0

export interface PassInput {
  db: D1Database
  bucket: KeyedBucket
  sql?: SqlStorage
  nowMs: number
  requestId: string
  /** The store to start at (a `retention-more` task's payload). */
  from: number
  /** Tests narrow the registry. */
  registry?: readonly TableEntry[]
}

/**
 * One bounded pass, store by store from `from`: where it stopped (`stores.length` when it finished), what it used, and
 * the stores that failed. A failing store is logged (`retention_failed`, its name and the error's safe name) and the
 * pass goes on: one broken store never stops the others (#346 review M1); its freshness signal stays red.
 */
export async function retentionPass(input: PassInput): Promise<{ stores: number; reached: number; used: { d1: number; r2: number }; failed: string[] }> {
  const stores = retentionStores(input.registry)
  const { db, bucket, used } = counting(input.db, input.bucket)
  const days = await brandRetentionDays(db)
  const failed: string[] = []
  let from = input.from
  for (; from < stores.length; from++) {
    const entry = stores[from]
    const cost = entry.name === 'chats' ? CHATS_COST : COST
    if (used.d1 + cost.d1 > MAX_D1 || used.r2 + cost.r2 > MAX_R2) break
    const registry = [entry]
    const deps = { db, bucket, sql: input.sql, at: { actorId: SYSTEM_MEMBER_ID, requestId: input.requestId, nowMs: input.nowMs }, registry }
    try {
      const periods = periodsFor(registry, days)
      if (!hasRetentionWork(entry.name, periods)) continue
      const plan = await planRetention(deps, { periods, limit: entry.name === 'chats' ? CHATS_LIMIT : LIMIT })
      const result = await runRetention(deps, plan, { maxRounds: 3 })
      if (result.more) break
    } catch (err) {
      failed.push(entry.name)
      console.error({ event: 'retention_failed', store: entry.name, error: safeError(err) })
    }
  }
  return { stores: stores.length, reached: from, used, failed }
}

export interface RetentionTaskOptions {
  /** Tests narrow the registry. */
  registry?: readonly TableEntry[]
}

export function createRetentionTask(opts: RetentionTaskOptions = {}): TaskHandler {
  const handler = async (task: DueTask, ctx: TaskContext): Promise<TaskResult> => {
    if (task.id === RETENTION_TASK_ID) ctx.scheduler.schedule({ id: RETENTION_TASK_ID, kind: RETENTION_TASK_ID, dueAtMs: nextDaily(ctx.nowMs, RETENTION_AT) })
    try {
      const from = task.id === RETENTION_MORE_ID ? resumeAt(task.payload) : 0
      const pass = await retentionPass({ db: ctx.env.DB, bucket: ctx.env.FILES, sql: ctx.sql, nowMs: ctx.nowMs, requestId: `retention-${task.id}`, from, registry: opts.registry })
      if (pass.reached < pass.stores) ctx.scheduler.schedule({ id: RETENTION_MORE_ID, kind: RETENTION_TASK_ID, dueAtMs: ctx.nowMs + MORE_AFTER_MS, payload: { from: pass.reached } })
      console.log({ event: 'retention_done', taskId: task.id, stores: pass.stores, reached: pass.reached, failed: pass.failed.length, d1: pass.used.d1, r2: pass.used.r2 })
    } catch (err) {
      console.error({ event: 'retention_failed', taskId: task.id, error: safeError(err) })
    }
    return { done: true }
  }
  return withSeed(handler, { id: RETENTION_TASK_ID })
}

export const retentionTask: TaskHandler = createRetentionTask()
