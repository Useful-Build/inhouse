// The BrandAgent's due-task scheduler (p3-design section 6): the one owner of the object's alarm (BD10: timers are
// Durable Object alarms). Tasks live in `due_tasks`; after every change the alarm is set to the earliest `ready` task
// (quarantined tasks never count). A pass runs up to 20 tasks or 10 s, `grant-expiry` and `authority-sweep` first,
// then by due time. A handler's result commits only while the task's generation is the one it started with, so a
// reschedule or a cancel during the handler's await wins. Alarms can be late and run at least once (docs): handlers are
// idempotent by task id, and nothing relies on alarm timing for authority. Passes never overlap: the runtime runs one
// `alarm()` at a time per object ("Only one alarm() invocation runs per instance at a given moment", alarms docs).
// https://developers.cloudflare.com/durable-objects/api/alarms/ and /api/sqlite-storage-api/ (read 2026-11-20)
import type { SendTurnResult } from '../../../shared/contract/runs.ts'
import type { BrandAgentPorts, ChatStatus, DeferDecision, InternalSubmit, Refusal } from './ports.ts'
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
  /**
   * Insert only if no task has this id; never moves an existing ready one. A task of the same kind quarantined as an
   * unknown kind is revived (new generation, attempts 0, `ready`), so a seed whose handler was missing comes back once
   * it exists. One quarantined after 10 failures stays quarantined (its signal stays red until someone fixes it).
   */
  ensure(t: { id: string; kind: string; dueAtMs: number; payload?: unknown }): void
  cancel(id: string): void
}

export type TaskResult = { done: true } | { retryAtMs: number; error: string }
/**
 * A handler runs its task and answers `done` (the task is deleted) or `retryAtMs` (it runs again then). To run again
 * later, a handler returns `retryAtMs` or calls `schedule()` for its own id; `ensure()` for its own id while it runs
 * changes nothing (the row exists), so a `done` answer still deletes it. A result of any other shape counts as a
 * retry with the default backoff.
 */
export type TaskHandler<C = TaskContext> = ((task: DueTask, ctx: C) => Promise<TaskResult>) & {
  /**
   * A registry entry may declare one seed task of its kind (PR 5, ask D): `ensureSeeds()` ensures `{ id, kind }` due now
   * on every start (insert only if absent, so an existing one keeps its due time). Declared with `withSeed`.
   */
  readonly seed?: { readonly id: string }
}

/** A registry entry that declares its seed task: `'kind': withSeed(handler, { id: 'kind' })` in tasks/index.ts. */
export function withSeed<C>(handler: TaskHandler<C>, seed: { id: string }): TaskHandler<C> {
  const entry = (task: DueTask, ctx: C) => handler(task, ctx)
  return Object.assign(entry, { seed: { id: seed.id } })
}

/** Every seed the registry declares, as `{ id, kind }`, in the registry's order. */
export function registrySeeds(handlers: Readonly<Record<string, TaskHandler<never>>>): { id: string; kind: string }[] {
  return Object.entries(handlers).flatMap(([kind, h]) => (h.seed === undefined ? [] : [{ id: h.seed.id, kind }]))
}

/**
 * One submit from inside the object (PR 5, ask A): route 29's turn plus a structured-output format and an end task.
 * Preconditions the caller owns (no D1 read here):
 * - the chat exists in D1 with this owner: call `ensureChat` first (it also answers OK for a soft-deleted chat);
 * - never submit into a person's chat that is in the trash (D1 `deleted_at_ms` set): the BrandAgent's own mark can say
 *   live after a failed restore while D1 says deleted, and only route 29 reads D1;
 * - `onEnd.id` is unique per turn: a same-kind end task still pending for an earlier turn would swallow this one's
 *   (`ensure` never replaces it). An id another kind holds is refused `invalid`.
 */
export interface TaskRuns {
  submit(t: InternalSubmit): Promise<SendTurnResult | Refusal>
}

/** The BrandAgent's own work its W1 tasks run (core.ts). */
export interface AgentTasks {
  watch(turnId: string): Promise<TaskResult>
  advanceTask(runId: string): Promise<TaskResult>
  leaseTask(turnId: string): Promise<TaskResult>
  /** The turn's fixed rows into D1; true once they're in. */
  flushTurn(turnId: string): Promise<boolean>
  /** The `authority-sweep` task (authority.ts). */
  authoritySweep(): Promise<TaskResult>
  /** A `grant-expiry:<grantId>` task, by its task id (authority.ts). */
  grantExpiry(taskId: string): Promise<TaskResult>
  /** A `deferred-hook:<questionId>` task: P6's `onDeferred` (PR 6, core.ts). */
  deferredHook(task: DueTask, ctx: TaskContext): Promise<TaskResult>
  /** A `deferred-resume:<questionId>` task: a resume that waited out a pause, a drain or a full queue (PR 6). */
  deferredResume(task: DueTask): Promise<TaskResult>
}

/** What a handler gets: the BrandAgent's parts. */
export interface TaskContext {
  nowMs: number
  env: Env
  sql: SqlStorage
  scheduler: Scheduler
  tokens: RunTokens
  ports: BrandAgentPorts
  agent: AgentTasks
  /** Submits a turn through the same in-object path as `BrandAgentRpc.submitTurn` (core.ts `submitTurn`). */
  runs: TaskRuns
  /** Whether the brand is paused, read from the stored flag at each access (P6 ask 3). */
  readonly paused: boolean
  /** `BrandAgentRpc.resumeDeferred` (P6 ask 5), the same in-object path. */
  resumeDeferred(chatId: string, decision: DeferDecision, questionId: string): Promise<SendTurnResult | Refusal>
  /** Read-only chat state (P4, B2): `{ waiting: false, liveRunId: null }` for a chat the object doesn't know. */
  chats: { status(chatId: string): ChatStatus }
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
/** When the alarm couldn't be set to the earliest task, a pass leaves one this far ahead instead. */
export const FALLBACK_ALARM_MS = 30_000

const isResult = (r: unknown): r is TaskResult =>
  typeof r === 'object' && r !== null && (
    (r as { done?: unknown }).done === true
    || (Number.isFinite((r as { retryAtMs?: unknown }).retryAtMs) && typeof (r as { error?: unknown }).error === 'string'))

export interface SqlScheduler extends Scheduler {
  /** One pass: the object's `alarm()` calls this. */
  alarm(): Promise<void>
  /** Sets the alarm from the table (on start, after a reset) and waits for it. */
  syncAlarm(): Promise<void>
  /** Waits until every alarm change made so far is stored; throws the first one that failed. */
  settled(): Promise<void>
  /** How many tasks are quarantined (the runs signal goes red on any). */
  quarantinedCount(): number
  /**
   * Clears one quarantined task of this kind: `ready`, attempts 0, due now, a new generation, its payload kept byte for
   * byte (unlike `schedule`, which replaces it). A task of another kind is `not_found`; a ready one is left as it is.
   */
  revive(id: string, kind: string): 'revived' | 'not_quarantined' | 'not_found'
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
  let pending: Promise<void>[] = []
  let failure: unknown = null

  const earliest = () => sql.exec<{ at: number | null }>("SELECT MIN(due_at_ms) AS at FROM due_tasks WHERE state = 'ready'").one().at
  /**
   * Sets the alarm to the earliest ready task now, in the caller's turn. Storage operations apply in the order they're
   * issued, so the last change leaves the alarm current; `pending` only collects the results for `settled()`.
   */
  /** `notBefore`: after a failed pass, never arm earlier than this (no hot loop without backoff). */
  const changed = (notBefore?: number) => {
    const first = earliest()
    const at = first === null || notBefore === undefined ? first : Math.max(first, notBefore)
    const op = at === null ? o.alarm.delete() : o.alarm.set(at)
    pending.push(op.catch(err => {
      failure ??= err
      console.error({ event: 'scheduler_alarm_failed', error: errorText(err) })
    }))
  }
  const settled = async () => {
    const ops = pending
    pending = []
    await Promise.all(ops)
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

  /** One pass: up to 20 due tasks or 10 s, each at most once. */
  let degraded = false
  const pass = async () => {
    const started = o.now()
    const ran = new Set<string>()
    // Bounded by its own count, so the pass ends at 20 whatever `next` returns.
    for (let runs = 0; runs < PASS_MAX_TASKS && o.now() - started < PASS_MAX_MS; runs++) {
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
        const answer: unknown = await handler(task, o.context(o.now()))
        if (!isResult(answer)) throw new TypeError('the handler answered neither done nor retryAtMs')
        result = answer
      } catch (err) {
        result = { retryAtMs: o.now() + backoffMs(task.attempts), error: errorText(err) }
      }
      o.afterHandler?.(task, result)
      let applied = false
      try {
        applied = commit(task, result)
      } catch (err) {
        degraded = true
        console.error({ event: 'due_task_commit_failed', kind: task.kind, error: errorText(err) })
      }
      if (applied && !('done' in result) && task.attempts + 1 >= MAX_ATTEMPTS) {
        console.error({ event: 'due_task_quarantined', kind: task.kind, why: 'attempts' })
      }
    }
  }

  return {
    schedule(t) {
      insert(t, `UPDATE SET kind = excluded.kind, gen = excluded.gen, due_at_ms = excluded.due_at_ms,
        payload_json = excluded.payload_json, attempts = 0, state = 'ready', last_error = NULL`)
      changed()
    },
    ensure(t) {
      insert(t, `UPDATE SET gen = excluded.gen, due_at_ms = excluded.due_at_ms, payload_json = excluded.payload_json,
        attempts = 0, state = 'ready', last_error = NULL WHERE due_tasks.state = 'quarantined' AND due_tasks.kind = excluded.kind
          AND due_tasks.last_error = 'unknown kind ' || due_tasks.kind`)
      changed()
    },
    cancel(id) {
      sql.exec('DELETE FROM due_tasks WHERE id = ?', id)
      changed()
    },
    async alarm() {
      degraded = false
      try {
        await pass()
      } catch (err) {
        // A pass that failed part way (storage, a test's injected crash) leaves its task as it was: it runs again.
        degraded = true
        console.error({ event: 'scheduler_pass_failed', error: errorText(err) })
      }
      // Always leave an alarm: the earliest ready task (after a failure, no sooner than the fallback delay), else the
      // fallback alone if setting that failed.
      try {
        changed(degraded ? o.now() + FALLBACK_ALARM_MS : undefined)
        await settled()
      } catch (err) {
        console.error({ event: 'scheduler_alarm_fallback', error: errorText(err) })
        await o.alarm.set(o.now() + FALLBACK_ALARM_MS)
      }
    },
    async syncAlarm() {
      changed()
      await settled()
    },
    settled,
    quarantinedCount: () => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM due_tasks WHERE state = 'quarantined'").one().n,
    revive(id, kind) {
      const row = sql.exec<{ kind: string; state: string }>('SELECT kind, state FROM due_tasks WHERE id = ?', id).toArray()[0]
      if (!row || row.kind !== kind) return 'not_found'
      if (row.state !== 'quarantined') return 'not_quarantined'
      sql.exec(
        `UPDATE due_tasks SET state = 'ready', attempts = 0, due_at_ms = ?, last_error = NULL, gen = ?
          WHERE id = ? AND kind = ? AND state = 'quarantined'`, o.now(), ++lastGen, id, kind)
      changed()
      return 'revived'
    },
  }
}
