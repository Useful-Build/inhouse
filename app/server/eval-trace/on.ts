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

/** At most this many bytes of inputs per turn's trace; the call that crosses it is cut there, later ones kept empty. */
export const IO_TRACE_MAX_BYTES = 256 * 1024
/** Inputs older than this are deleted (decision 6: eval `io` lives 7 days on the eval brand). */
export const IO_TTL_MS = 7 * 24 * 3_600_000
/** The TTL task's kind and id (a seed: ensured due now on every start), and how often it runs. */
export const IO_TTL_TASK: string = 'eval-io-ttl'
const IO_TTL_EVERY_MS = 6 * 3_600_000

const encoder = new TextEncoder()

/**
 * The `turn_trace` record that keeps this audit entry's input for its call, or null: no tool_use id (nothing to show it
 * on), or the call's input already kept (another hook's entry for the same call). The JSON text of `entry.input`, cut at
 * the turn's remaining room (a cut record says so, and keeps no partial character).
 */
export function ioRecord(sql: SqlStorage, turnId: string, entry: AuditEntry): Record<string, string> | null {
  const id = entry.toolUseId
  if (id === undefined || id === '') return null
  const kept = sql.exec<{ used: number | null; dup: number }>(
    `SELECT SUM(CAST(json_extract(json, '$.bytes') AS INTEGER)) AS used, COUNT(CASE WHEN json_extract(json, '$.io') = ? THEN 1 END) AS dup
      FROM turn_trace WHERE turn_id = ? AND json_extract(json, '$.io') IS NOT NULL`, id, turnId).one()
  if (kept.dup > 0) return null
  const room = Math.max(0, IO_TRACE_MAX_BYTES - (kept.used ?? 0))
  const input = JSON.stringify(entry.input ?? null)
  const bytes = encoder.encode(input)
  if (bytes.byteLength <= room) return { io: id, input, bytes: String(bytes.byteLength) }
  // `fatal: false` turns a split character at the cut into U+FFFD; drop it, so the kept text is whole characters.
  const cut = new TextDecoder().decode(bytes.subarray(0, room)).replace(/\uFFFD$/, '')
  return { io: id, input: cut, bytes: String(encoder.encode(cut).byteLength), cut: '1' }
}

/** A `turn_trace` record's kept input as `[tool_use id, io]`, or null when the record isn't one. */
export function ioFrom(rec: Record<string, string>): [string, StepIo] | null {
  if (typeof rec.io !== 'string' || typeof rec.input !== 'string') return null
  return [rec.io, rec.cut === '1' ? { input: rec.input, cut: true } : { input: rec.input }]
}

/** Deletes kept inputs older than IO_TTL_MS (other trace records stay), then schedules its next pass. */
const ioTtl = async (task: DueTask, ctx: TaskContext): Promise<TaskResult> => {
  const r = ctx.sql.exec(`DELETE FROM turn_trace WHERE at_ms < ? AND json_extract(json, '$.io') IS NOT NULL`, ctx.nowMs - IO_TTL_MS)
  console.log({ event: 'eval_io_ttl', taskId: task.id, deleted: r.rowsWritten })
  ctx.scheduler.schedule({ id: IO_TTL_TASK, kind: IO_TTL_TASK, dueAtMs: ctx.nowMs + IO_TTL_EVERY_MS })
  return { done: true }
}

/** The eval build's due tasks, added to the registry in the eval build only (tasks/index.ts). */
export const EVAL_TASKS: Readonly<Record<string, TaskHandler>> = { [IO_TTL_TASK]: withSeed(ioTtl, { id: IO_TTL_TASK }) }
