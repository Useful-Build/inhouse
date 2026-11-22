// The shapes the backup and the restore write to R2 (P8 G1), parsed on every read. C1 and F1 build on them.
import { z } from 'zod'

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const Count = z.number().int().nonnegative()

export const PartSchema = z.object({ key: z.string().min(1), rows: Count, sha256: Sha256 })

export const TableManifestSchema = z.object({
  name: z.string().min(1),
  columns: z.array(z.string().min(1)).min(1),
  orderBy: z.array(z.string().min(1)).min(1),
  mode: z.enum(['snapshot', 'append_only']),
  rows: Count,
  /** `append_only` tables: the largest id at the point batch (0 when empty). */
  maxId: Count.optional(),
  /** Of every part's bytes, in order. */
  sha256: Sha256,
  parts: z.array(PartSchema),
})

/** `backups/d1/<backupId>/manifest.json`, written last: a backup without one is incomplete. */
export const BackupManifestSchema = z.object({
  // Any number here, so a restore can refuse another format by name instead of failing to parse.
  format: z.number(),
  backupId: z.string().min(1),
  takenAtMs: Count,
  migration: z.string().min(1),
  tables: z.array(TableManifestSchema),
  /** Derived tables (FTS5 indexes): not in the backup, rebuilt from the tables in `from` after a restore. */
  derived: z.array(z.object({ name: z.string().min(1), from: z.array(z.string().min(1)).min(1) })),
})

export type TableManifest = z.infer<typeof TableManifestSchema>
export type BackupManifest = z.infer<typeof BackupManifestSchema>

/** `restore/<restoreId>/snapshot/manifest.json`, written last: the live state before the restore touched anything. */
export const SnapshotManifestSchema = z.object({
  format: z.literal(1),
  restoreId: z.string().min(1),
  takenAtMs: Count,
  audit: z.union([
    z.object({ columns: z.array(z.string()), rows: Count, maxId: Count, sha256: Sha256, parts: z.array(PartSchema) }),
    z.literal('unreadable'),
  ]),
  deletionLog: z.object({ key: z.string().min(1), objects: Count, sha256: Sha256 }),
})

export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>

/** `restore/<restoreId>/snapshot/deletion-log.json`: every deletion-log key with its etag at the snapshot. */
export const DeletionLogListSchema = z.object({
  format: z.literal(1),
  objects: z.array(z.object({ key: z.string().min(1), etag: z.string() })),
})

/**
 * `restored_unreconciled`: the import is proven but isn't a safe restore yet. `restored` (P8a R): the reconcile's audit
 * re-append and deletion-log replay are done and an admin confirmed, with an audit line. Only `confirmRestore`
 * (ops/backup/reconcile/confirm.ts) writes it, and the schema refuses it without both steps and the confirm.
 */
export const RESTORE_STATUSES = ['restored_unreconciled', 'restored', 'refused', 'failed', 'failed_verification'] as const

/**
 * The reconcile (P8a R; plan "A restore, step by step", steps 3 to 5), on a `restored_unreconciled` restore. Each step's
 * field is null until it's done; `refusal` holds the last refusal (a step that stopped, by name), null once a run
 * gets through. Step 4 (the outbox hold and the tool check) is P8b's: `outbox` says so until it lands.
 */
export const ReconcileSchema = z.object({
  /** Step 2b: C1's FTS rebuild, read back from its `fts.json`. */
  fts: z.literal('rebuilt').nullable(),
  /** Step 3: the audit lines newer than the backup's, appended back to the target with their own ids. */
  audit: z.object({
    /** `snapshot`: the pre-restore snapshot; `audit_copy`: the daily copy, because the snapshot recorded the audit as unreadable. */
    source: z.enum(['snapshot', 'audit_copy']),
    /** The backup's largest audit id: every line above it came back. */
    afterId: Count,
    /** The largest id appended back (`afterId` when none). */
    throughId: Count,
    appended: Count,
    /** From the daily copy only: lines after `afterId` the live database held and no copy did are lost. */
    gap: z.object({ afterId: Count, reason: z.literal('live_unreadable') }).nullable(),
    /**
     * Actors of appended lines with no member row in the target (added after the backup): a pseudonymised, removed
     * placeholder row was written for each, with a `restore.member_placeholder` line. Every one so far, re-runs included.
     */
    placeholders: z.array(z.string()),
  }).nullable(),
  /**
   * Step 3b: the member removals and role changes the re-appended lines record (`member.removed`,
   * `member.role_changed`), applied again to the restored rows, so a member removed after the backup stays removed.
   */
  members: z.object({
    removed: z.array(z.string()),
    roles: z.array(z.object({ memberId: z.string(), role: z.enum(['member', 'admin']) })),
  }).nullable(),
  /** Step 4, P8b: the outbox hold and the check against each tool's record. Not built in P8a. */
  outbox: z.literal('p8b_pending'),
  /** Step 5: the deletion log replayed past the watermark. */
  replay: z.object({
    watermarkMs: Count,
    /** The last deletion-log key read (null when the log had nothing past the watermark); the confirm checks nothing came after it. */
    throughKey: z.string().nullable(),
    runs: z.array(z.object({
      runId: z.string(),
      kind: z.enum(['person', 'retention']),
      /** The stores the run was applied to again (those whose own point is at or before the run's last entry). */
      stores: z.array(z.string()),
    })),
    /** Runs a `refused` entry stopped: they removed nothing, so nothing is replayed. */
    skippedRefused: z.array(z.string()),
  }).nullable(),
  /**
   * The confirm, with its audit line's id in the target: `actorId` the Inhouse operator who ran it, `approvedBy` the
   * brand's Admin whose written approval it carries (an Inhouse operator only when the target has no active Admin).
   */
  confirm: z.object({ actorId: z.string().min(1), approvedBy: z.string().min(1), atMs: Count, auditId: Count }).nullable(),
  refusal: z.string().nullable(),
})

export type Reconcile = z.infer<typeof ReconcileSchema>

/**
 * `restore/<restoreId>/record.json`, written whatever the outcome. `restored_unreconciled` is the import's success
 * status; `restored` only after the reconcile and the confirm. Fields that need the backup's manifest (`takenAtMs`,
 * `migration`, `restorePointMs`, `watermarkMs`) are null when it couldn't be read; `snapshot` is null when no snapshot
 * was taken.
 */
export const RestoreRecordSchema = z.object({
  format: z.literal(1),
  restoreId: z.string().min(1),
  status: z.enum(RESTORE_STATUSES),
  reason: z.string().optional(),
  startedAtMs: Count,
  finishedAtMs: Count,
  actorId: z.string().min(1),
  source: z.literal('r2-backup'),
  backup: z.object({ backupId: z.string(), takenAtMs: Count.nullable(), migration: z.string().nullable() }),
  d1: z.object({
    restorePointMs: Count.nullable(),
    tables: z.array(z.object({ name: z.string(), rows: Count, sha256: Sha256, verified: z.boolean() })),
    /** The backup's derived tables (FTS5 indexes): not restored from the backup; ops/backup/fts rebuilds them. */
    derived: z.array(z.object({ name: z.string(), from: z.array(z.string()), state: z.enum(['rebuild_needed', 'rebuilt']) })),
  }),
  /** The `resetAfterRestore` hooks that ran on the target (a job's cursor rows), in order. */
  resets: z.array(z.string()),
  r2: z.object({
    prefixes: z.array(z.object({ prefix: z.string(), objects: Count })),
    missingPhotoKeys: z.array(z.string()),
  }),
  /**
   * Each Durable Object's recovery time, as the runbook's point-in-time recovery left it (`RestoreDeps.durableObjects`).
   * The reconcile refuses while a Durable Object a person deletion reaches has none.
   */
  durableObjects: z.array(z.object({ name: z.string(), recoveredAtMs: Count })),
  /** The earliest of the D1 point and every Durable Object recovery time (R2 isn't rewound: its state is the restore's own). */
  watermarkMs: Count.nullable(),
  snapshot: z.union([
    z.object({ key: z.string(), auditRows: Count, auditMaxId: Count }),
    z.object({ gap: z.literal('unreadable') }),
  ]).nullable(),
  /** True only with status `restored`. */
  reconciled: z.boolean(),
  /** Null until a reconcile runs (and on every status but `restored_unreconciled` and `restored`). */
  reconcile: ReconcileSchema.nullable(),
}).superRefine((r, ctx) => {
  // No path marks a restore done before the audit re-append, the deletion-log replay and the admin's confirm.
  const c = r.reconcile
  const done = c !== null && c.fts !== null && c.audit !== null && c.members !== null && c.replay !== null && c.confirm !== null && c.refusal === null
    && r.d1.derived.every(d => d.state === 'rebuilt')
  if ((r.status === 'restored') !== done) ctx.addIssue({ code: 'custom', path: ['status'], message: 'restored needs the FTS rebuild, the audit re-append, the member changes, the replay, the confirm and no refusal' })
  if (r.status !== 'restored' && r.d1.derived.some(d => d.state === 'rebuilt')) ctx.addIssue({ code: 'custom', path: ['d1', 'derived'], message: 'rebuilt only on a restored record' })
  if (r.reconciled !== (r.status === 'restored')) ctx.addIssue({ code: 'custom', path: ['reconciled'], message: 'reconciled is true only when restored' })
  if (r.reconcile !== null && r.status !== 'restored_unreconciled' && r.status !== 'restored') ctx.addIssue({ code: 'custom', path: ['reconcile'], message: 'only a proven restore is reconciled' })
})

export type RestoreRecord = z.infer<typeof RestoreRecordSchema>
