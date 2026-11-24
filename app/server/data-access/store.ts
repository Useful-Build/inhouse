// P8a D: "Export everything" (route 95) over C1's export (ops/export/export.ts, brand scope). The store plans the
// export (counts only, a dry run), writes its audit line (counts, never a store's rows), then hands back the NDJSON
// stream, which reads D1 a page at a time and R2 one object at a time as the download is pulled: the archive is never
// built in memory.
//
// Storage failures before the answer starts are a `StoreUnavailableError` (503): D1's through sql.ts, R2's through the
// wrapped bucket below. Once the download is streaming, a failure ends the stream (no `end` line) and logs
// `data_export_failed` with the error's safe name; nothing else can be said then (the 200 has gone).
import { planExport, runExport } from '../../ops/export/export.ts'
import { auditInsert } from '../db/audit.ts'
import type { At } from '../db/members.ts'
import type { KeyedBucket } from '../db/r2-keys.ts'
import { runBatch, storage } from '../db/sql.ts'
import { safeError } from '../safe-error.ts'
import type { TableEntry } from '../../ops/tables/types.ts'

/** The R2 calls the export makes (ops/delete/r2.ts `listAll` and `readObject`). */
export type ExportBucket = Pick<KeyedBucket, 'list' | 'get'>

export interface DataExport {
  /** NDJSON, format 1 (ops/export/export.ts). */
  stream: ReadableStream<Uint8Array>
  /** How many stores the export holds, and how many rows and files it planned across them. */
  stores: number
  items: number
}

export interface DataExportStore {
  /** Plans the brand's whole export, writes its `data.exported` line, and returns the download. */
  brand(at: At): Promise<DataExport>
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
  })
}

export function dataExportStore({ db, bucket, registry }: { db: D1Database; bucket: ExportBucket; registry?: readonly TableEntry[] }): DataExportStore {
  return {
    async brand(at) {
      const deps = { db, bucket: guarded(bucket), at, registry }
      const planned = await planExport(deps, { kind: 'brand' })
      if (!('ok' in planned)) throw new Error(`data export: a brand plan was refused (${planned.refused})`)
      const plan = planned.ok
      const counts = Object.values(plan.counts)
      const items = counts.reduce((n, c) => n + c, 0)
      await runBatch(db, [auditInsert({
        atMs: at.nowMs,
        actorId: at.actorId,
        args: { action: 'data.exported', scope: 'brand', stores: counts.length, items },
        target: null,
        requestId: at.requestId,
      }, null)])
      return { stream: logged(runExport(deps, plan), at.requestId), stores: counts.length, items }
    },
  }
}
