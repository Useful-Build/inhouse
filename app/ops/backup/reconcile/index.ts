// The restore's reconcile (P8a R; plan "A restore, step by step"), run on a `restored_unreconciled` restore after G1's
// snapshot, write and proof (steps 1 and 2, ops/backup/restore.ts). In order, each idempotent, so a refused or stopped
// run is finished by running it again:
//  2b. the FTS rebuild (C1's `rebuildAfterRestore`, ops/backup/fts, handed in as `rebuildFts`): it writes
//     `restore/<restoreId>/fts.json`, and the reconcile stops unless that says the indexes were rebuilt;
//  3. the audit re-append (audit.ts);
//  4. P8b: hold every `approved` and `sending` outbox row, keep the outbox paused, and check each held action against
//     its tool's own record. Not built in P8a: the record says `outbox: 'p8b_pending'`, and this is where it goes;
//  5. the deletion-log replay past the watermark (replay.ts).
// The record stays `restored_unreconciled`; only an admin's audited confirm (confirm.ts) makes it `restored`. A refusal
// is stored on the record (`reconcile.refusal`) and returned, never thrown.
// Accepted (A10, 2026-11-22): the audit copy's cursor (`audit_copy_state`) comes back as the backup held it and isn't
// reset, so the next daily copy copies the re-appended range again under that day's key. A duplicate range in R2, no
// line lost; `fromDailyCopy` (audit.ts) reads a range written twice as one, and refuses if the two disagree.
import { z } from 'zod'
import type { At } from '../../../server/db/members.ts'
import { restoreKey } from '../../../server/db/r2-keys.ts'
import type { DeletionRule } from '../../delete/rules.ts'
import type { RetentionRule } from '../../retention/rules.ts'
import { tables as realRegistry } from '../../tables/index.ts'
import type { TableEntry } from '../../tables/types.ts'
import { RestoreRefusal } from '../errors.ts'
import type { RestoreRecord } from '../manifest.ts'
import { reappendAudit } from './audit.ts'
import { emptyReconcile, readRecord, writeRecord } from './record.ts'
import { replayDeletionLog } from './replay.ts'
import type { PersonRunner } from './replay.ts'

export { brandAgentRunner } from './replay.ts'
export type { PersonRunner } from './replay.ts'
export { confirmRestore } from './confirm.ts'

export interface ReconcileDeps {
  bucket: R2Bucket
  /** The restored database (the restore's `target`). */
  target: D1Database
  restoreId: string
  at: At
  registry?: readonly TableEntry[]
  deletionRules?: Readonly<Record<string, DeletionRule>>
  retentionRules?: Readonly<Record<string, RetentionRule>>
  /** Each custom store's runner, by store name (`brandAgentRunner(brandAgent(env))` for `BrandAgent`). */
  runners?: Readonly<Record<string, PersonRunner>>
  /**
   * C1's FTS rebuild (`rebuildAfterRestore` in ops/backup/fts, P8 C1 PR A). Required, so no reconcile skips it; it
   * refuses unless the record is `restored_unreconciled` and writes `restore/<restoreId>/fts.json`.
   */
  rebuildFts: (p: { bucket: R2Bucket; target: D1Database; restoreId: string }) => Promise<unknown>
}

/** The part of C1's `fts.json` the reconcile reads: anything but `rebuilt` stops it. */
const FtsResultSchema = z.object({ status: z.string() })

async function ftsRebuilt(deps: ReconcileDeps): Promise<void> {
  await deps.rebuildFts({ bucket: deps.bucket, target: deps.target, restoreId: deps.restoreId })
  const obj = await deps.bucket.get(restoreKey(deps.restoreId, 'fts.json'))
  if (!obj) throw new RestoreRefusal('fts_rebuild_failed', 'no fts.json')
  const parsed = FtsResultSchema.safeParse(JSON.parse(await obj.text()))
  if (!parsed.success) throw new RestoreRefusal('fts_rebuild_failed', 'fts.json unreadable')
  if (parsed.data.status !== 'rebuilt') throw new RestoreRefusal('fts_rebuild_failed', parsed.data.status)
}

export type ReconcileResult = { ok: RestoreRecord } | { refused: string; record: RestoreRecord | null }

export async function reconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  let record: RestoreRecord
  try {
    record = await readRecord(deps.bucket, deps.restoreId)
  } catch (err) {
    if (err instanceof RestoreRefusal) return { refused: err.reason, record: null }
    throw err
  }
  if (record.status !== 'restored_unreconciled') return { refused: `not_reconcilable: ${record.status}`, record }
  const reconcile = record.reconcile ?? emptyReconcile()
  try {
    // 2b. The derived indexes (FTS5), first: before the audit re-append and before any status change.
    await ftsRebuilt(deps)
    // 3. The audit lines newer than the backup's.
    const audit = await reappendAudit(deps.bucket, deps.target, record, deps.at)
    // 4. P8b: the outbox hold and the tool check go here, before the replay and the confirm. Not built in P8a.
    // 5. The deletion log past the watermark.
    const replay = await replayDeletionLog({
      bucket: deps.bucket, target: deps.target, at: deps.at, registry: deps.registry ?? realRegistry,
      deletion: deps.deletionRules, retention: deps.retentionRules, runners: deps.runners,
    }, record)
    return { ok: await writeRecord(deps.bucket, { ...record, reconcile: { ...reconcile, audit, replay, refusal: null } }) }
  } catch (err) {
    if (!(err instanceof RestoreRefusal)) throw err
    // A step that refuses leaves the restore unreconciled: neither step counts as done until a whole run gets through.
    const saved = await writeRecord(deps.bucket, { ...record, reconcile: { ...reconcile, audit: null, replay: null, refusal: err.reason } })
    return { refused: err.reason, record: saved }
  }
}
