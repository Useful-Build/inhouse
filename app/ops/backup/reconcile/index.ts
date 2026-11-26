// The restore's reconcile (P8a R; plan "A restore, step by step"), run on a `restored_unreconciled` restore after G1's
// snapshot, write and proof (steps 1 and 2, ops/backup/restore.ts). In order, each idempotent, so a refused or stopped
// run is finished by running it again:
//  2b. the FTS rebuild (C1's `rebuildAfterRestore`, ops/backup/fts/rebuild.ts): it writes
//     `restore/<restoreId>/fts.json`, and the reconcile stops unless the call and that file both say rebuilt. It reads
//     the record and never writes it, so the etag read before it still guards the reconcile's own write;
//  3. the audit re-append (audit.ts);
//  3b. the member removals and role changes those lines record, applied again (members.ts);
//  4. the outbox hold (M2-R, server/outbox/restore-hold.ts): the gate held and re-seated (`restore_hold = 1`,
//     `do_gen = -1`), every `approved` or `sending` row, and every `waiting` row the re-appended lines show approved, to
//     "Needs a check", every live grant revoked; a `waiting` row the re-appended lines show denied, withdrawn or expired
//     closed again. After step 3, whose lines it reads; its own lines carry this restore's
//     request id (`restoreStamp`), so step 3 on a re-run knows them. Only the confirm clears the hold;
//  5. the deletion-log replay past the watermark (replay.ts).
// The record stays `restored_unreconciled`; only an admin's audited confirm (confirm.ts) makes it `restored`. A refusal
// is stored on the record (`reconcile.refusal`) and returned, never thrown.
// Accepted (A10, 2026-11-22): the audit copy's cursor (`audit_copy_state`) comes back as the backup held it and isn't
// reset, so the next daily copy copies the re-appended range again under that day's key. A duplicate range in R2, no
// line lost; `fromDailyCopy` (audit.ts) reads a range written twice as one, and refuses if the two disagree.
import type { At } from '../../../server/db/members.ts'
import { restoreKey } from '../../../server/db/r2-keys.ts'
import type { DeletionRule } from '../../delete/rules.ts'
import type { RetentionRule } from '../../retention/rules.ts'
import { tables as realRegistry } from '../../tables/index.ts'
import type { TableEntry } from '../../tables/types.ts'
import { RestoreRefusal } from '../errors.ts'
import { FtsRecordSchema, rebuildAfterRestore } from '../fts/rebuild.ts'
import type { RebuildDeps, RebuildResult } from '../fts/rebuild.ts'
import type { RestoreRecord } from '../manifest.ts'
import { holdOutbox } from '../../../server/outbox/restore-hold.ts'
import { reappendAudit, restoreStamp } from './audit.ts'
import { reapplyMemberChanges } from './members.ts'
import { emptyReconcile, readRecord, writeRecord } from './record.ts'
import { replayDeletionLog } from './replay.ts'
import type { PersonRunner } from './replay.ts'

export { brandAgentRunner } from './replay.ts'
export type { PersonRunner } from './replay.ts'
export { confirmRestore } from './confirm.ts'
export { checkBeforeSwitch } from './switch.ts'

export interface ReconcileDeps {
  bucket: R2Bucket
  /** The restored database (the restore's `target`). */
  target: D1Database
  restoreId: string
  at: At
  registry?: readonly TableEntry[]
  deletionRules?: Readonly<Record<string, DeletionRule>>
  retentionRules?: Readonly<Record<string, RetentionRule>>
  /** The recovered object's person runner (`brandAgentRunner`) and optional overrides by store name. */
  runners?: Readonly<Record<string, PersonRunner>>
  /** The recovered BrandAgent's SQLite, when replay runs inside that object. */
  retentionSql?: SqlStorage
  /** C1's FTS rebuild; tests pass a stand-in. It refuses unless the record is `restored_unreconciled`. */
  rebuildFts?: (p: RebuildDeps) => Promise<RebuildResult>
}

async function ftsRebuilt(deps: ReconcileDeps): Promise<'rebuilt'> {
  const result = await (deps.rebuildFts ?? rebuildAfterRestore)({ bucket: deps.bucket, target: deps.target, restoreId: deps.restoreId, nowMs: deps.at.nowMs })
  // A refused rebuild writes no fts.json, so the answer is read first: an fts.json from an earlier run never counts.
  if ('refused' in result) throw new RestoreRefusal('fts_rebuild_refused', result.refused)
  if ('failed' in result) throw new RestoreRefusal('fts_rebuild_failed', result.failed)
  const obj = await deps.bucket.get(restoreKey(deps.restoreId, 'fts.json'))
  if (!obj) throw new RestoreRefusal('fts_rebuild_failed', 'no fts.json')
  const parsed = FtsRecordSchema.safeParse(JSON.parse(await obj.text()))
  if (!parsed.success) throw new RestoreRefusal('fts_rebuild_failed', 'fts.json unreadable')
  if (parsed.data.restoreId !== deps.restoreId || parsed.data.status !== 'rebuilt') throw new RestoreRefusal('fts_rebuild_failed', parsed.data.status)
  return 'rebuilt'
}

export type ReconcileResult = { ok: RestoreRecord } | { refused: string; record: RestoreRecord | null }

export async function reconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  let record: RestoreRecord
  let etag: string
  try {
    ({ record, etag } = await readRecord(deps.bucket, deps.restoreId))
  } catch (err) {
    if (err instanceof RestoreRefusal) return { refused: err.reason, record: null }
    throw err
  }
  if (record.status !== 'restored_unreconciled') return { refused: `not_reconcilable: ${record.status}`, record }
  const reconcile = record.reconcile ?? emptyReconcile()
  try {
    // 2b. The derived indexes (FTS5), first: before the audit re-append and before any status change.
    const fts = await ftsRebuilt(deps)
    // 3. The audit lines newer than the backup's.
    const audit = await reappendAudit(deps.bucket, deps.target, record, deps.at)
    // 3b. The member removals and role changes since the backup.
    const members = await reapplyMemberChanges(deps.target, audit.afterId)
    // 4. The outbox hold, before the replay and the confirm.
    const outbox = await holdOutbox(deps.target, {
      restoreId: deps.restoreId, afterId: audit.afterId, gap: audit.gap !== null,
      at: { nowMs: deps.at.nowMs, actorId: deps.at.actorId, requestId: restoreStamp(deps.restoreId) },
    })
    // 5. The deletion log past the watermark.
    const replay = await replayDeletionLog({
      bucket: deps.bucket, target: deps.target, at: deps.at, registry: deps.registry ?? realRegistry,
      deletion: deps.deletionRules, retention: deps.retentionRules, runners: deps.runners, retentionSql: deps.retentionSql,
    }, record)
    return { ok: await writeRecord(deps.bucket, { ...record, reconcile: { ...reconcile, fts, audit, members, outbox, replay, refusal: null } }, etag) }
  } catch (err) {
    if (!(err instanceof RestoreRefusal)) throw err
    // Another run wrote the record since this one read it: nothing to record over it.
    if (err.reason.startsWith('record_changed')) return { refused: err.reason, record: null }
    // A step that refuses leaves the restore unreconciled: no step counts as done until a whole run gets through.
    try {
      const saved = await writeRecord(deps.bucket, { ...record, reconcile: { ...reconcile, fts: null, audit: null, members: null, outbox: null, replay: null, refusal: err.reason } }, etag)
      return { refused: err.reason, record: saved }
    } catch (writeErr) {
      // Another run wrote the record meanwhile (review L-d): returned, never thrown, with the step's own refusal.
      if (writeErr instanceof RestoreRefusal && writeErr.reason.startsWith('record_changed')) return { refused: `${err.reason} (and ${writeErr.reason})`, record: null }
      throw writeErr
    }
  }
}
