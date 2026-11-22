// The confirm (P8a R; plan "A restore, step by step", end of step 5): the only way a restore becomes `restored`. It
// refuses unless every reconcile step is done with no refusal (step 4, the outbox hold, joins this check in P8b) and
// nothing was logged in the deletion log since the replay read it. Who (review M3, A10's option i): the actor is the
// Inhouse operator running it (an active `inhouse` row in the restored database); `approvedBy` is the brand's Admin
// whose approval the runbook has in writing before the confirm runs, checked as an active Admin person there. Only when
// the restored database has no active Admin at all (the restore removed or demoted the last one: the deadlock the
// review's L5 names) may `approvedBy` be an active Inhouse operator instead. It writes one `restore.confirmed` line
// (`approvedBy` in its arguments; found again by its restore id on a re-run, never written twice), then the record,
// with the derived indexes marked rebuilt. A refusal is returned, never thrown.
// An ops step, not a route: the record lives in R2 and the target isn't the live database until the runbook points
// the deployment at it, after the confirm and `checkBeforeSwitch` (switch.ts).
import { auditInsert } from '../../../server/db/audit.ts'
import { first, runBatch, stmt } from '../../../server/db/sql.ts'
import { listDeletionLog } from '../../delete/log.ts'
import { RestoreRefusal } from '../errors.ts'
import type { RestoreRecord } from '../manifest.ts'
import { readRecord, writeRecord } from './record.ts'
import { watermarkStart } from './replay.ts'
import type { ReplayDeps } from './replay.ts'

/** `at.actorId`: the Inhouse operator's member id in the restored database (`target`); `approvedBy`: the approving Admin's. */
export type ConfirmDeps = Pick<ReplayDeps, 'bucket' | 'target' | 'at'> & { restoreId: string; approvedBy: string }

export type ConfirmResult = { ok: RestoreRecord } | { refused: string; record: RestoreRecord | null }

const confirmedLine = (db: D1Database, restoreId: string) =>
  first<{ id: number }>(db, stmt("SELECT id FROM audit_log WHERE action = 'restore.confirmed' AND json_extract(args_json, '$.restoreId') = ? ORDER BY id LIMIT 1", restoreId))

export async function confirmRestore(deps: ConfirmDeps): Promise<ConfirmResult> {
  let record: RestoreRecord
  let etag: string
  try {
    ({ record, etag } = await readRecord(deps.bucket, deps.restoreId))
  } catch (err) {
    if (err instanceof RestoreRefusal) return { refused: err.reason, record: null }
    throw err
  }
  if (record.status === 'restored') return { ok: record }
  if (record.status !== 'restored_unreconciled') return { refused: `not_reconcilable: ${record.status}`, record }
  const r = record.reconcile
  if (r === null || r.refusal !== null) return { refused: 'not_reconciled: audit', record }
  for (const step of ['fts', 'audit', 'members', 'replay'] as const) if (r[step] === null) return { refused: `not_reconciled: ${step}`, record }
  const replay = r.replay as NonNullable<typeof r.replay>
  // A deletion logged after the replay read the log would be lost: the reconcile must run again first.
  const after = replay.throughKey ?? watermarkStart(replay.watermarkMs)
  if ((await listDeletionLog(deps.bucket, { after, limit: 1 })).length > 0) return { refused: 'replay_stale', record }
  const count = async (where: string, ...args: string[]) => (await first<{ n: number }>(deps.target, stmt(`SELECT COUNT(*) AS n FROM members WHERE ${where}`, ...args)))?.n ?? 0
  const ACTIVE_ADMIN = "kind = 'person' AND role = 'admin' AND status = 'active'"
  const ACTIVE_INHOUSE = "kind = 'inhouse' AND status = 'active'"
  if (await count(`id = ? AND ${ACTIVE_INHOUSE}`, deps.at.actorId) === 0) return { refused: 'not_inhouse', record }
  if (await count(`id = ? AND ${ACTIVE_ADMIN}`, deps.approvedBy) === 0) {
    const noAdmin = await count(ACTIVE_ADMIN) === 0
    if (!noAdmin || await count(`id = ? AND ${ACTIVE_INHOUSE}`, deps.approvedBy) === 0) return { refused: 'not_admin', record }
  }

  let line = await confirmedLine(deps.target, record.restoreId)
  if (!line) {
    await runBatch(deps.target, [auditInsert({
      atMs: deps.at.nowMs, actorId: deps.at.actorId, args: { action: 'restore.confirmed', restoreId: record.restoreId, backupId: record.backup.backupId, approvedBy: deps.approvedBy },
      target: null, requestId: deps.at.requestId,
    }, null)])
    line = await confirmedLine(deps.target, record.restoreId)
    if (!line) throw new Error('confirm: the audit line was not written')
  }
  return {
    ok: await writeRecord(deps.bucket, {
      ...record, status: 'restored', reconciled: true,
      d1: { ...record.d1, derived: record.d1.derived.map(d => ({ ...d, state: 'rebuilt' as const })) },
      reconcile: { ...r, confirm: { actorId: deps.at.actorId, approvedBy: deps.approvedBy, atMs: deps.at.nowMs, auditId: line.id } },
    }, etag),
  }
}
