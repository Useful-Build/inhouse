// P8a D: "Export everything" (route 95) over C1's export (ops/export/export.ts, `brandForCaller` scope: the brand's
// shared data and the caller's own, never another person's personal rows; ops/export/brand-for-caller.ts). The store
// plans the export (counts only, a dry run, within one request's budget), writes its audit line (counts, never a
// store's rows), then hands back the NDJSON stream, which reads D1 a page at a time and R2 a piece of one object at a
// time as the download is pulled: the archive is never built in memory. Route 96 runs the same plan and answers
// whether the export would start, writing nothing.
//
// A brand too big for one request (`REQUEST_BUDGET`) is refused `too_large` before the answer starts, with no audit
// line: the export would otherwise stop part way through a 200.
//
// Storage failures before the answer starts are a `StoreUnavailableError` (503): D1's through sql.ts, R2's through the
// wrapped bucket below. Once the download is streaming, a failure ends the stream (no `end` line) and logs
// `data_export_failed` with the error's safe name; nothing else can be said then (the 200 has gone).
import { REQUEST_BUDGET, planExport, runExport } from '../../ops/export/export.ts'
import type { ExportCaller, ExportCost, ExportPlan } from '../../ops/export/export.ts'
import type { JobDeps } from '../../ops/delete/r2.ts'
import { auditInsert } from '../db/audit.ts'
import type { At } from '../db/members.ts'
import type { KeyedBucket } from '../db/r2-keys.ts'
import { runBatch, storage } from '../db/sql.ts'
import { safeError } from '../safe-error.ts'
import type { TableEntry } from '../../ops/tables/types.ts'

/** The R2 calls the export makes (ops/delete/r2.ts `listPages`, and a `get` per object). */
export type ExportBucket = Pick<KeyedBucket, 'list' | 'get'>

export interface DataExport {
  /** NDJSON, format 1 (ops/export/export.ts). */
  stream: ReadableStream<Uint8Array>
  /** How many stores the export holds, and how many rows and files it planned across them. */
  stores: number
  items: number
}

export interface DataExportSize {
  stores: number
  items: number
}

export type DataExportRefusal = { refused: 'too_large' }

export interface DataExportStore {
  /** Route 96: plans `caller`'s export and answers its size, or the refusal. Writes nothing. */
  check(at: At, caller: ExportCaller): Promise<DataExportSize | DataExportRefusal>
  /** Route 95: plans `caller`'s export, writes its `data.exported` line, and returns the download, or the refusal (no line). */
  brand(at: At, caller: ExportCaller): Promise<DataExport | DataExportRefusal>
}

/** The bucket with every call behind the stores' storage boundary: an R2 failure is a 503, like D1's. */
function guarded(bucket: ExportBucket): KeyedBucket {
  const wrapped: ExportBucket = {
    list: options => storage('R2', () => bucket.list(options)),
    get: ((key: string, options?: R2GetOptions) => storage('R2', () => bucket.get(key, options))) as KeyedBucket['get'],
  }
  // The export takes a whole bucket (ops/delete/r2.ts `JobDeps`) and calls only `list` and `get`.
  return wrapped as KeyedBucket
}

/** Logs a failure once the download has started (fixed event, the error's safe name only), then passes it on. */
function logged(stream: ReadableStream<Uint8Array>, requestId: string): ReadableStream<Uint8Array> {
  const reader = stream.getReader()
  // No queue of its own (high-water mark 0): a piece is read only when the download asks for one.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      } catch (err) {
        console.error({ event: 'data_export_failed', requestId, error: safeError(err) })
        // Fixed text: the storage error stays out of anything the runtime might print.
        controller.error(new Error('data export stopped'))
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  }, { highWaterMark: 0 })
}

const sizeOf = (plan: ExportPlan): DataExportSize => {
  const counts = Object.values(plan.counts)
  return { stores: counts.length, items: counts.reduce((n, c) => n + c, 0) }
}

/** `budget` is the request's (`REQUEST_BUDGET`); tests pass a smaller one to reach the refusal. */
export function dataExportStore({ db, bucket, registry, budget = REQUEST_BUDGET }: { db: D1Database; bucket: ExportBucket; registry?: readonly TableEntry[]; budget?: ExportCost }): DataExportStore {
  const plan = async (at: At, caller: ExportCaller): Promise<{ deps: JobDeps; plan: ExportPlan } | DataExportRefusal> => {
    const deps = { db, bucket: guarded(bucket), at, registry }
    const planned = await planExport(deps, { kind: 'brandForCaller', caller }, { budget })
    if ('ok' in planned) return { deps, plan: planned.ok }
    if (planned.refused === 'too_large') return { refused: 'too_large' }
    throw new Error(`data export: a brandForCaller plan was refused (${planned.refused})`)
  }
  return {
    async check(at, caller) {
      const p = await plan(at, caller)
      return 'refused' in p ? p : sizeOf(p.plan)
    },
    async brand(at, caller) {
      const p = await plan(at, caller)
      if ('refused' in p) return p
      const { stores, items } = sizeOf(p.plan)
      await runBatch(db, [auditInsert({
        atMs: at.nowMs,
        actorId: at.actorId,
        args: { action: 'data.exported', scope: 'brand', stores, items },
        target: null,
        requestId: at.requestId,
      }, null)])
      return { stream: logged(runExport(p.deps, p.plan), at.requestId), stores, items }
    },
  }
}
