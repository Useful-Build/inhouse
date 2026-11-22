// The admin's confirm (P8a R; plan "A restore, step by step", end of step 5): the only way a restore becomes
// `restored`. It refuses unless the reconcile's audit re-append and deletion-log replay are both done (step 4, the
// outbox hold, joins this check in P8b), nothing was logged in the deletion log since the replay read it, and the actor
// is an active Admin in the restored database. It writes one `restore.confirmed` audit line there (found again by its
// restore id on a re-run, never written twice), then the record. A refusal is returned, never thrown.
// An ops step, not a route: the record lives in R2 and the target isn't the live database until the runbook points
// the deployment at it, and that switch comes after the confirm (PR body: the route 90 proposal).
import { auditInsert } from '../../../server/db/audit.ts'
import { first, runBatch, stmt } from '../../../server/db/sql.ts'
import { listDeletionLog } from '../../delete/log.ts'
import { RestoreRefusal } from '../errors.ts'
import type { RestoreRecord } from '../manifest.ts'
import { readRecord, writeRecord } from './record.ts'
import { watermarkStart } from './replay.ts'
import type { ReplayDeps } from './replay.ts'

/** `at.actorId`: the confirming Admin's member id in the restored database (`target`). */
export type ConfirmDeps = Pick<ReplayDeps, 'bucket' | 'target' | 'at'> & { restoreId: string }

export type ConfirmResult = { ok: RestoreRecord } | { refused: string; record: RestoreRecord | null }

const confirmedLine = (db: D1Database, restoreId: string) =>
  first<{ id: number }>(db, stmt("SELECT id FROM audit_log WHERE action = 'restore.confirmed' AND json_extract(args_json, '$.restoreId') = ? ORDER BY id LIMIT 1", restoreId))

export async function confirmRestore(deps: ConfirmDeps): Promise<ConfirmResult> {
  let record: RestoreRecord
  try {
    record = await readRecord(deps.bucket, deps.restoreId)
  } catch (err) {
    if (err instanceof RestoreRefusal) return { refused: err.reason, record: null }
    throw err
  }
  if (record.status === 'restored') return { ok: record }
  if (record.status !== 'restored_unreconciled') return { refused: `not_reconcilable: ${record.status}`, record }
  const r = record.reconcile
  if (r === null || r.refusal !== null || r.audit === null) return { refused: 'not_reconciled: audit', record }
  if (r.replay === null) return { refused: 'not_reconciled: replay', record }
  // A deletion logged after the replay read the log would be lost: the reconcile must run again first.
  const after = r.replay.throughKey ?? watermarkStart(r.replay.watermarkMs)
  if ((await listDeletionLog(deps.bucket, { after, limit: 1 })).length > 0) return { refused: 'replay_stale', record }
  const admin = await first<{ n: number }>(deps.target, stmt("SELECT COUNT(*) AS n FROM members WHERE id = ? AND kind = 'person' AND role = 'admin' AND status = 'active'", deps.at.actorId))
  if ((admin?.n ?? 0) === 0) return { refused: 'not_admin', record }

  let line = await confirmedLine(deps.target, record.restoreId)
  if (!line) {
    await runBatch(deps.target, [auditInsert({
      atMs: deps.at.nowMs, actorId: deps.at.actorId, args: { action: 'restore.confirmed', restoreId: record.restoreId, backupId: record.backup.backupId },
      target: null, requestId: deps.at.requestId,
    }, null)])
    line = await confirmedLine(deps.target, record.restoreId)
    if (!line) throw new Error('confirm: the audit line was not written')
  }
  return {
    ok: await writeRecord(deps.bucket, {
      ...record, status: 'restored', reconciled: true,
      reconcile: { ...r, confirm: { actorId: deps.at.actorId, atMs: deps.at.nowMs, auditId: line.id } },
    }),
  }
}
