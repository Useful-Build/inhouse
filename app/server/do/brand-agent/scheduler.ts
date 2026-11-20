// The BrandAgent's due-task scheduler (p3-design section 6): the one owner of the object's alarm (BD10: timers are
// Durable Object alarms). Tasks live in `due_tasks`; after every change the alarm is set to the earliest `ready` task
// (quarantined tasks never count). A pass runs up to 20 tasks or 10 s, `grant-expiry` and `authority-sweep` first,
// then by due time. A handler's result commits only while the task's generation is the one it started with, so a
// reschedule or a cancel during the handler's await wins. Alarms can be late and run at least once (docs): handlers are
// idempotent by task id, and nothing relies on alarm timing for authority.
// https://developers.cloudflare.com/durable-objects/api/alarms/ and /api/sqlite-storage-api/ (read 2026-11-20)
import type { BrandAgentPorts } from './ports.ts'
import type { RunTokens } from './tokens.ts'

export interface DueTask {
  id: string
  kind: string
  gen: number
  dueAtMs: number
  /** The task's JSON payload, parsed; null when it has none. */
  payload: unknown
  /** Failed runs so far. */
  attempts: number
}

export interface Scheduler {
  /** Upsert: sets the kind, due time and payload, a new generation, attempts 0 and `ready` (a quarantined task too). */
  schedule(t: { id: string; kind: string; dueAtMs: number; payload?: unknown }): void
  /** Insert only if no task has this id (never moves an existing one). */
  ensure(t: { id: string; kind: string; dueAtMs: number; payload?: unknown }): void
  cancel(id: string): void
}

export type TaskResult = { done: true } | { retryAtMs: number; error: string }
export type TaskHandler<C = TaskContext> = (task: DueTask, ctx: C) => Promise<TaskResult>

/** What a handler gets: the BrandAgent's parts. */
export interface TaskContext {
  nowMs: number
  env: Env
  sql: SqlStorage
  scheduler: Scheduler
  tokens: RunTokens
  ports: BrandAgentPorts
}

/** The object's alarm. Only the scheduler holds one (a test scans the folder for any other `setAlarm`). */
export interface AlarmPort {
  get(): Promise<number | null>
  set(atMs: number): Promise<void>
  delete(): Promise<void>
}

export const alarmPort = (storage: DurableObjectStorage): AlarmPort => ({
  get: () => storage.getAlarm(),
  set: atMs => storage.setAlarm(atMs),
  delete: () => storage.deleteAlarm(),
})

/** Kinds a pass runs before any other due task. */
export const FIRST_KINDS: readonly string[] = ['grant-expiry', 'authority-sweep']
export const PASS_MAX_TASKS = 20
export const PASS_MAX_MS = 10_000
/** A task that failed this many times is quarantined. */
export const MAX_ATTEMPTS = 10
/** The retry delay after `attempts` failures: 30 s doubling, at most an hour. */
export const backoffMs = (attempts: number): number => Math.min(2 ** attempts * 30_000, 3_600_000)

export interface SqlScheduler extends Scheduler {
  /** One pass: the object's `alarm()` calls this. */
  alarm(): Promise<void>
  /** Sets the alarm from the table (on start, after a reset) and waits for it. */
  syncAlarm(): Promise<void>
  /** Waits until every alarm change made so far is stored; throws the first one that failed. */
  settled(): Promise<void>
  /** How many tasks are quarantined (the runs signal goes red on any). */
  quarantinedCount(): number
}

export interface SchedulerOptions<C> {
  sql: SqlStorage
  alarm: AlarmPort
  now: () => number
  handlers: Readonly<Record<string, TaskHandler<C>>>
  context: (nowMs: number) => C
  /** Tests only: runs after a handler returns, before its result commits (to inject a crash there). */
  afterHandler?: (task: DueTask, result: TaskResult) => void
}

export function createDueTasksTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS due_tasks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, gen INTEGER NOT NULL,
    due_at_ms INTEGER NOT NULL, payload_json TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'quarantined')), last_error TEXT)`)
  sql.exec('CREATE INDEX IF NOT EXISTS due_tasks_ready ON due_tasks(state, due_at_ms)')
}

type Row = { id: string; kind: string; gen: number; due_at_ms: number; payload_json: string | null; attempts: number }

const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : 'unknown').slice(0, 500)

export function createScheduler<C>(o: SchedulerOptions<C>): SqlScheduler {
  const { sql } = o
  createDueTasksTable(sql)
  // Generations come from one counter for the whole table, never `gen + 1` per row: a task cancelled and scheduled
  // again during a handler's await must not get back the generation that handler holds. Only handlers of this
  // instance can be in flight, so the counter starts above every stored generation.
  let lastGen = sql.exec<{ g: number | null }>('SELECT MAX(gen) AS g FROM due_tasks').one().g ?? 0
  let chain: Promise<void> = Promise.resolve()
  let failure: unknown = null

  const earliest = () => sql.exec<{ at: number | null }>("SELECT MIN(due_at_ms) AS at FROM due_tasks WHERE state = 'ready'").one().at
  const setAlarm = async () => {
    const at = earliest()
    if (at === null) await o.alarm.delete()
    else await o.alarm.set(at)
  }
  /** Queues an alarm update; each reads the table when it runs, so the last one leaves the alarm current. */
  const changed = () => {
    chain = chain.then(setAlarm).catch(err => {
      failure ??= err
      console.error({ event: 'scheduler_alarm_failed', error: errorText(err) })
    })
  }
  const settled = async () => {
    await chain
    if (failure !== null) {
      const err = failure
      failure = null
      throw err
    }
  }

  const insert = (t: { id: string; kind: string; dueAtMs: number; payload?: unknown }, onConflict: string) =>
    sql.exec(
      `INSERT INTO due_tasks (id, kind, gen, due_at_ms, payload_json, attempts, state) VALUES (?, ?, ?, ?, ?, 0, 'ready')
        ON CONFLICT(id) DO ${onConflict}`,
      t.id, t.kind, ++lastGen, t.dueAtMs, t.payload === undefined ? null : JSON.stringify(t.payload),
    )

  const next = (nowMs: number, ran: ReadonlySet<string>): Row | undefined => {
    const firsts = FIRST_KINDS.map(() => '?').join(', ')
    const rows = sql.exec<Row>(
      `SELECT id, kind, gen, due_at_ms, payload_json, attempts FROM due_tasks WHERE state = 'ready' AND due_at_ms <= ?
        ORDER BY (kind IN (${firsts})) DESC, due_at_ms, id LIMIT ?`,
      nowMs, ...FIRST_KINDS, ran.size + 1,
    ).toArray()
    return rows.find(r => !ran.has(r.id))
  }

  /** Applies a handler's result if the task still has its generation; whether it did. */
  const commit = (task: DueTask, result: TaskResult): boolean => {
    if ('done' in result) return sql.exec('DELETE FROM due_tasks WHERE id = ? AND gen = ?', task.id, task.gen).rowsWritten > 0
    return sql.exec(
      `UPDATE due_tasks SET attempts = attempts + 1, due_at_ms = ?, last_error = ?,
        state = CASE WHEN attempts + 1 >= ? THEN 'quarantined' ELSE 'ready' END WHERE id = ? AND gen = ?`,
      result.retryAtMs, result.error.slice(0, 500), MAX_ATTEMPTS, task.id, task.gen,
    ).rowsWritten > 0
  }

  return {
    schedule(t) {
      insert(t, `UPDATE SET kind = excluded.kind, gen = excluded.gen, due_at_ms = excluded.due_at_ms,
        payload_json = excluded.payload_json, attempts = 0, state = 'ready', last_error = NULL`)
      changed()
    },
    ensure(t) {
      insert(t, 'NOTHING')
      changed()
    },
    cancel(id) {
      sql.exec('DELETE FROM due_tasks WHERE id = ?', id)
      changed()
    },
    async alarm() {
      const started = o.now()
      const ran = new Set<string>()
      while (ran.size < PASS_MAX_TASKS && o.now() - started < PASS_MAX_MS) {
        const row = next(o.now(), ran)
        if (!row) break
        ran.add(row.id)
        const task: DueTask = {
          id: row.id, kind: row.kind, gen: row.gen, dueAtMs: row.due_at_ms, attempts: row.attempts,
          payload: row.payload_json === null ? null : JSON.parse(row.payload_json),
        }
        const handler = Object.hasOwn(o.handlers, task.kind) ? o.handlers[task.kind] : undefined
        if (!handler) {
          sql.exec(
            "UPDATE due_tasks SET state = 'quarantined', last_error = ? WHERE id = ? AND gen = ?",
            `unknown kind ${task.kind}`.slice(0, 500), task.id, task.gen,
          )
          console.error({ event: 'due_task_quarantined', kind: task.kind, why: 'unknown_kind' })
          continue
        }
        let result: TaskResult
        try {
          result = await handler(task, o.context(o.now()))
        } catch (err) {
          result = { retryAtMs: o.now() + backoffMs(task.attempts), error: errorText(err) }
        }
        o.afterHandler?.(task, result)
        if (commit(task, result) && !('done' in result) && task.attempts + 1 >= MAX_ATTEMPTS) {
          console.error({ event: 'due_task_quarantined', kind: task.kind, why: 'attempts' })
        }
      }
      changed()
      await settled()
    },
    async syncAlarm() {
      changed()
      await settled()
    },
    settled,
    quarantinedCount: () => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM due_tasks WHERE state = 'quarantined'").one().n,
  }
}
