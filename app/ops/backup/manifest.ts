// The shapes the backup and the restore write to R2 (P8 G1), parsed on every read. C1 and F1 build on them.
import { z } from 'zod'

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const Count = z.number().int().nonnegative()

export const PartSchema = z.object({ key: z.string().min(1), rows: Count, sha256: Sha256 })

export const TableManifestSchema = z.object({
  name: z.string().min(1),
  columns: z.array(z.string().min(1)).min(1),
  orderBy: z.array(z.string().min(1)).min(1),
  mode: z.enum(['snapshot', 'append_only', 'insert_only', 'paged']),
  rows: Count,
  /** `append_only` tables: the largest id at the point batch (0 when empty). */
  maxId: Count.optional(),
  /** `insert_only` and bounded `append_only` tables (C1): the largest creation value at the point batch (0 when empty). */
  point: z.number().optional(),
  /**
   * C1: `exact` when the table is the state at the point batch; `paged` when it was read after it and may differ (every
   * `paged` table, and an `insert_only` one whose count moved). Absent in a backup taken before C1 (all exact then).
   */
  consistency: z.enum(['exact', 'paged']).optional(),
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

export const RESTORE_STATUSES = ['restored_unreconciled', 'refused', 'failed', 'failed_verification'] as const

/**
 * `restore/<restoreId>/record.json`, written whatever the outcome. `restored_unreconciled` is the success status: an
 * import isn't a safe restore until F1's reconcile. Fields that need the backup's manifest (`takenAtMs`, `migration`,
 * `restorePointMs`, `watermarkMs`) are null when it couldn't be read; `snapshot` is null when no snapshot was taken.
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
    derived: z.array(z.object({ name: z.string(), from: z.array(z.string()), state: z.literal('rebuild_needed') })),
    /** C1: the tables the backup read after its point batch (`consistency: 'paged'`); F1's reconcile reads it. */
    paged: z.array(z.string()).optional(),
  }),
  /** The `resetAfterRestore` hooks that ran on the target (a job's cursor rows), in order. */
  resets: z.array(z.string()),
  r2: z.object({
    prefixes: z.array(z.object({ prefix: z.string(), objects: Count })),
    missingPhotoKeys: z.array(z.string()),
  }),
  /** Each Durable Object's recovery time; none on P2. */
  durableObjects: z.array(z.object({ name: z.string(), recoveredAtMs: Count })),
  /** The earliest of the D1 point and every Durable Object recovery time. */
  watermarkMs: Count.nullable(),
  snapshot: z.union([
    z.object({ key: z.string(), auditRows: Count, auditMaxId: Count }),
    z.object({ gap: z.literal('unreadable') }),
  ]).nullable(),
  reconciled: z.literal(false),
})

export type RestoreRecord = z.infer<typeof RestoreRecordSchema>
