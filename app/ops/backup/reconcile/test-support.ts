// Helpers for the reconcile's tests. Never imported by a job.
import { restoreKey } from '../../../server/db/r2-keys.ts'
import { readRecord } from './record.ts'

/**
 * A stand-in for C1's `rebuildAfterRestore` (ops/backup/fts, P8 C1 PR A, not merged when this was written), to its
 * described interface: refuses unless the record is `restored_unreconciled`, writes `restore/<restoreId>/fts.json`
 * with `status`. `calls` counts its runs.
 */
export function ftsStub(status = 'rebuilt') {
  const stub = {
    calls: 0,
    async rebuildFts(p: { bucket: R2Bucket; target: D1Database; restoreId: string }): Promise<void> {
      stub.calls++
      const { record } = await readRecord(p.bucket, p.restoreId)
      if (record.status !== 'restored_unreconciled') throw new Error(`fts: ${record.status}`)
      await p.bucket.put(restoreKey(p.restoreId, 'fts.json'), JSON.stringify({ status }))
    },
  }
  return stub
}
