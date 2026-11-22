// The check the runbook runs right before it points the deployment at the restored database (P8a R, review M2). The
// live database keeps running until that switch, so anything it did after the reconcile read it would be lost: a
// deletion logged after the replay read the log, or an audit line written after the pre-restore snapshot. Read only:
// it writes nothing anywhere. The runbook pauses the brand, the person-deletion job and the retention job from the
// snapshot until the switch (P8a O), so this should always pass; it refuses by name when it doesn't, and the restore is
// run again from a new snapshot.
import { first, stmt } from '../../../server/db/sql.ts'
import { listDeletionLog } from '../../delete/log.ts'
import { RestoreRefusal } from '../errors.ts'
import { readRecord } from './record.ts'
import { watermarkStart } from './replay.ts'
import type { ReplayDeps } from './replay.ts'

export type SwitchDeps = Pick<ReplayDeps, 'bucket'> & { restoreId: string; /** The database in use now. */ live: D1Database }

export async function checkBeforeSwitch(deps: SwitchDeps): Promise<{ ok: true } | { refused: string }> {
  let record
  try {
    ({ record } = await readRecord(deps.bucket, deps.restoreId))
  } catch (err) {
    if (err instanceof RestoreRefusal) return { refused: err.reason }
    throw err
  }
  if (record.status !== 'restored') return { refused: `not_restored: ${record.status}` }
  const { replay, audit } = record.reconcile as NonNullable<typeof record.reconcile>
  if (replay === null || audit === null) return { refused: 'not_restored: reconcile' }
  const after = replay.throughKey ?? watermarkStart(replay.watermarkMs)
  const late = await listDeletionLog(deps.bucket, { after, limit: 1 })
  if (late.length > 0) return { refused: `deletion_after_replay: ${late[0].key}` }
  // The live audit log's last line must be one the re-append saw: the snapshot's last, or (read from the daily copy) the last copied.
  const seen = record.snapshot !== null && 'auditMaxId' in record.snapshot ? record.snapshot.auditMaxId : audit.throughId
  const liveMax = (await first<{ max: number }>(deps.live, stmt('SELECT COALESCE(MAX(id), 0) AS max FROM audit_log')))?.max ?? 0
  if (liveMax > seen) return { refused: `audit_after_snapshot: live line ${liveMax}, the restore saw up to ${seen}` }
  return { ok: true }
}
