// Helpers for the reconcile's tests. Never imported by a job.
import { restoreKey } from '../../../server/db/r2-keys.ts'
import type { RebuildDeps, RebuildResult } from '../fts/rebuild.ts'
import { readRecord } from './record.ts'

/**
 * A stand-in for C1's `rebuildAfterRestore` (ops/backup/fts/rebuild.ts) where a test isn't about the indexes: refuses
 * unless the record is `restored_unreconciled`, writes an `fts.json` with `status`. `calls` counts its runs.
 * finish.test.ts runs the real one.
 */
export function ftsStub(status: 'rebuilt' | 'failed' = 'rebuilt') {
  const stub = {
    calls: 0,
    async rebuildFts(p: RebuildDeps): Promise<RebuildResult> {
      stub.calls++
      const { record } = await readRecord(p.bucket, p.restoreId)
      if (record.status !== 'restored_unreconciled') return { refused: `restore_status: ${record.status}` }
      const fts = { format: 1 as const, restoreId: p.restoreId, atMs: p.nowMs ?? 0, status, tables: [] }
      await p.bucket.put(restoreKey(p.restoreId, 'fts.json'), JSON.stringify(fts))
      return status === 'rebuilt' ? { ok: fts } : { failed: status }
    },
  }
  return stub
}
