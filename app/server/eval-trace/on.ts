// The eval trace (p3-eval-observability rev 2, rec 1 and 5, option a-i), what `@eval-trace` resolves to in the eval
// build only (`vite build --mode product-eval`); every other build gets ./off.ts. Import it only as `@eval-trace`, never
// by its path. scripts/check-product-build.mjs fails the product and test builds on this module or its canary, and the
// eval build without them.
//
// Inputs only, never results (a Bash result can hold a live run token, a WebFetch result is a third-party page): at
// `writeToolCall` the BrandAgent keeps the audit entry's input (already capped at 16 KiB by the runner's `capInput`) as
// one `turn_trace` record `{ io: <tool_use id>, input, bytes[, cut] }`; route 33 shows it as `io.input` on that call's
// `tool` step, to the run's owner only (runs-read.ts). `turn_trace` is in PERSON_DATA_TABLES, so deleting a person
// removes it; the TTL task below deletes inputs after 7 days (decision 6).
import type { AuditEntry } from '../../shared/protocol/index.ts'
import type { StepIo } from '../../shared/contract/trace.ts'
import { withSeed } from '../do/brand-agent/scheduler.ts'
import type { DueTask, TaskContext, TaskHandler, TaskResult } from '../do/brand-agent/scheduler.ts'

/** The string the bundle scan looks for. It rides in EVAL_BUILD_FLAVOR, so it stays in the eval build's bundle. */
export const EVAL_TRACE_CANARY: string = 'inhouse-eval-trace-canary-5d1e8a40'

/** The flavor the health route's version signal names in the eval build (server/ops/signals/core.ts). */
export const EVAL_BUILD_FLAVOR: string | null = `eval (${EVAL_TRACE_CANARY})`

/**
 * At most this many bytes of inputs per trace, that is per run over all its turns (route 33 reads a run's trace), counted
 * as stored: each record's JSON with its id and the input escaped inside it. The call that crosses it is cut there, later
 * ones kept empty (each still a small record, so the reader sees the call was made).
 */
export const IO_TRACE_MAX_BYTES = 256 * 1024
/** Inputs older than this are deleted (decision 6: eval `io` lives 7 days on the eval brand). */
export const IO_TTL_MS = 7 * 24 * 3_600_000
/** The TTL task's kind and id (a seed: ensured due now on every start), and how often it runs. */
export const IO_TTL_TASK: string = 'eval-io-ttl'
const IO_TTL_EVERY_MS = 6 * 3_600_000

const encoder = new TextEncoder()
/** A kept input's stored size: its record's JSON, id and escaped input (the `bytes` and `cut` fields aside). */
const storedBytes = (id: string, input: string): number => encoder.encode(JSON.stringify({ io: id, input })).byteLength

/**
 * The `turn_trace` record that keeps this audit entry's input for its call, or null: no tool_use id (nothing to show it
 * on), or the call's input already kept in this run (another hook's entry for the same call). The JSON text of
 * `entry.input`, cut to the run's remaining room at a whole character (a cut record says so; `bytes` is its stored size).
 */
export function ioRecord(sql: SqlStorage, turnId: string, entry: AuditEntry): Record<string, string> | null {
  const id = entry.toolUseId
  if (id === undefined || id === '') return null
  const kept = sql.exec<{ used: number | null; dup: number }>(
    `SELECT SUM(CAST(json_extract(json, '$.bytes') AS INTEGER)) AS used, COUNT(CASE WHEN json_extract(json, '$.io') = ? THEN 1 END) AS dup
      FROM turn_trace WHERE json_extract(json, '$.io') IS NOT NULL
        AND turn_id IN (SELECT turn_id FROM turns WHERE run_id = (SELECT run_id FROM turns WHERE turn_id = ?))`, id, turnId).one()
  if (kept.dup > 0) return null
  const room = Math.max(0, IO_TRACE_MAX_BYTES - (kept.used ?? 0))
  const input = JSON.stringify(entry.input ?? null)
  const full = storedBytes(id, input)
  if (full <= room) return { io: id, input, bytes: String(full) }
  // The longest prefix of whole characters (code points) whose stored size fits the room: no split character, and the
  // escaping is counted as stored. Binary search: the stored size only grows with the prefix.
  const chars = Array.from(input)
  let lo = 0
  let hi = chars.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (storedBytes(id, chars.slice(0, mid).join('')) <= room) lo = mid
    else hi = mid - 1
  }
  const cut = chars.slice(0, lo).join('')
  return { io: id, input: cut, bytes: String(storedBytes(id, cut)), cut: '1' }
}

/** A `turn_trace` record's kept input as `[tool_use id, io]`, or null when the record isn't one. */
export function ioFrom(rec: Record<string, string>): [string, StepIo] | null {
  if (typeof rec.io !== 'string' || typeof rec.input !== 'string') return null
  return [rec.io, rec.cut === '1' ? { input: rec.input, cut: true } : { input: rec.input }]
}

/** Deletes kept inputs older than IO_TTL_MS (other trace records stay), then schedules its next pass. */
const ioTtl = async (task: DueTask, ctx: TaskContext): Promise<TaskResult> => {
  const old = `FROM turn_trace WHERE at_ms < ? AND json_extract(json, '$.io') IS NOT NULL`
  const before = ctx.nowMs - IO_TTL_MS
  // Counted, then deleted, in one synchronous step (nothing interleaves in the object): the log's count is the rows
  // deleted, not the storage's row-write count (which counts index writes too).
  const deleted = ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n ${old}`, before).one().n
  ctx.sql.exec(`DELETE ${old}`, before)
  console.log({ event: 'eval_io_ttl', taskId: task.id, deleted })
  ctx.scheduler.schedule({ id: IO_TTL_TASK, kind: IO_TTL_TASK, dueAtMs: ctx.nowMs + IO_TTL_EVERY_MS })
  return { done: true }
}

/** The eval build's due tasks, added to the registry in the eval build only (tasks/index.ts). */
export const EVAL_TASKS: Readonly<Record<string, TaskHandler>> = { [IO_TTL_TASK]: withSeed(ioTtl, { id: IO_TTL_TASK }) }
