// The restore from an R2 backup (P8 G1; plan "Design notes", a restore step by step, steps 1 and 2). In order:
//  1. snapshot the live audit log and list the deletion log to `restore/<restoreId>/snapshot/`, before anything is
//     written anywhere (a readable `live` whose snapshot fails stops the restore);
//  2. check the backup (manifest, format, migration level, columns, every part's rows and sha256);
//  3. check the target is a freshly migrated database (only rows identical to the backup's, the service rows, or a
//     named migration-seeded row, which the write overwrites with the backup's values);
//  4. write each part as one statement, members before the audit log;
//  5. prove it: re-read every table from the target and compare rows and sha256 with the manifest;
//  6. write the restore record, whatever the outcome.
// The target is never the live database: the audit log's triggers refuse every DELETE, so it can't be cleared, and
// pointing the deployment at the restored database is the runbook's step. The restore writes no audit line: the
// record is its record, and F1's reconcile (audit re-append, deletion-log replay, outbox hold, the admin's confirm)
// decides whether it gets one. Success is `restored_unreconciled`, never done.
import { backupManifestKey, backupPartKey, restoreKey } from '../../server/db/r2-keys.ts'
import type { At } from '../../server/db/members.ts'
import { tables as realRegistry } from '../tables/index.ts'
import type { TableEntry } from '../tables/types.ts'
import { timeId } from './backup.ts'
import { BackupError, RestoreRefusal } from './errors.ts'
import { TableWriter, appendRows, encodeRow, insertPartSql, isRowLine, keyRows, linesAsArray, newDigest, maxIdSelect, partLines, sha256, snapshotSelect, tableColumns, toHex } from './format.ts'
import { BackupManifestSchema, DeletionLogListSchema, RestoreRecordSchema, SnapshotManifestSchema } from './manifest.ts'
import type { BackupManifest, RestoreRecord, TableManifest } from './manifest.ts'
import { canonicalTables, ident } from './tables.ts'
import type { DerivedTable, TableRule } from './tables.ts'

export interface RestoreDeps {
  bucket: R2Bucket
  /** A freshly migrated database (the live one can't be cleared). */
  target: D1Database
  /** The database in use now, for the pre-restore snapshot; `'unreadable'` records the gap and goes on. */
  live: D1Database | 'unreadable'
  backupId: string
  at: At
  registry?: readonly TableEntry[]
  /** The cursor resets to run on the target after a proven write; default `RESET_AFTER_RESTORE`. */
  resetAfterRestore?: readonly ResetHook[]
  testing?: { beforeTargetWrite?: () => Promise<void>; afterTargetWrite?: () => Promise<void> }
}

/**
 * A job's own state that must not carry over from the restore point (a cursor row, such as P3's audit-copy cursor):
 * `run` resets it on the target. Each runs once, in order, after the proof passes; the record lists their names.
 */
export interface ResetHook {
  name: string
  run(target: D1Database, at: At): Promise<void>
}

/** The resets every restore runs. Empty on P2: a phase that adds a job with a cursor adds its hook here. */
export const RESET_AFTER_RESTORE: readonly ResetHook[] = []

/** A failure that stops the restore, with a named reason (`failed`, not `refused`). */
class RestoreFailure extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.reason = reason
    this.name = 'RestoreFailure'
  }
}

const json = { httpMetadata: { contentType: 'application/json' } }
const ndjson = { httpMetadata: { contentType: 'application/x-ndjson' } }
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
const pad = (n: number) => String(n).padStart(5, '0')
/** Target rows read per table for the emptiness check; a table with more isn't freshly migrated. */
const TARGET_ROWS_CHECKED = 1_000

/**
 * Rows a migration inserts that a used database changes (P8 C1): on a freshly migrated target each differs from the
 * backup's (its times are the migration's), so the write overwrites it with the backup's values instead of refusing.
 * Any other row in the target still refuses (`seeded_row_differs`, `target_not_empty`). 0005's service rows aren't
 * listed: they never change, so they match the backup's and are skipped. `key` is the row's primary key, in order.
 */
export const SEEDED_ROWS: readonly { table: string; key: readonly (string | number)[]; migration: string }[] = [
  { table: 'routines', key: ['routine-morning-check'], migration: '0221_morning_check.sql' },
]
const seededKey = (table: string, pk: string) => SEEDED_ROWS.some(r => r.table === table && JSON.stringify(r.key) === pk)

async function listAll(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const out: R2Object[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor })
    out.push(...page.objects)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

// Step 1: the pre-restore snapshot. The audit log in the backup's format, the deletion log listed (never copied:
// nothing a restore does can change it and its objects are never overwritten), then the manifest, last.
async function takeSnapshot(bucket: R2Bucket, live: D1Database | 'unreadable', restoreId: string, nowMs: number): Promise<NonNullable<RestoreRecord['snapshot']>> {
  let audit: { columns: string[]; rows: number; maxId: number; sha256: string; parts: { key: string; rows: number; sha256: string }[] } | 'unreadable' = 'unreadable'
  if (live !== 'unreadable') {
    const rule: TableRule = { name: 'audit_log', orderBy: ['id'], mode: 'append_only' }
    const columns = await tableColumns(live, rule.name)
    const maxId = (await maxIdSelect(live, rule).first<{ max: number }>())?.max ?? 0
    const writer = new TableWriter(rule.name, async (part, bytes) => {
      const key = restoreKey(restoreId, `snapshot/audit_log/${pad(part)}.ndjson`)
      await bucket.put(key, bytes, ndjson)
      return key
    })
    for await (const row of appendRows(live, rule, columns, maxId)) await writer.add(encodeRow(rule.name, columns, row))
    audit = { columns, maxId, ...(await writer.finish()) }
  }
  const objects = (await listAll(bucket, 'deletion-log/')).map(o => ({ key: o.key, etag: o.etag }))
  const listText = JSON.stringify(DeletionLogListSchema.parse({ format: 1, objects }))
  const listKey = restoreKey(restoreId, 'snapshot/deletion-log.json')
  await bucket.put(listKey, listText, json)
  const manifest = SnapshotManifestSchema.parse({
    format: 1, restoreId, takenAtMs: nowMs, audit,
    deletionLog: { key: listKey, objects: objects.length, sha256: await sha256(new TextEncoder().encode(listText)) },
  })
  const key = restoreKey(restoreId, 'snapshot/manifest.json')
  await bucket.put(key, JSON.stringify(manifest), json)
  return audit === 'unreadable' ? { gap: 'unreadable' } : { key, auditRows: audit.rows, auditMaxId: audit.maxId }
}

async function loadManifest(bucket: R2Bucket, backupId: string): Promise<BackupManifest> {
  let key: string
  try { key = backupManifestKey(backupId) } catch (err) { throw new RestoreRefusal('manifest_missing', messageOf(err)) }
  const obj = await bucket.get(key)
  if (!obj) throw new RestoreRefusal('manifest_missing', backupId)
  let data: unknown
  try { data = JSON.parse(await obj.text()) } catch { throw new RestoreRefusal('manifest_invalid', 'not JSON') }
  const parsed = BackupManifestSchema.safeParse(data)
  if (!parsed.success) throw new RestoreRefusal('manifest_invalid', parsed.error.issues.map(i => i.path.join('.')).join(', '))
  if (parsed.data.backupId !== backupId) throw new RestoreRefusal('manifest_invalid', 'backupId')
  return parsed.data
}

const pkIndexes = (t: TableManifest) => t.orderBy.map(c => {
  const i = t.columns.indexOf(c)
  if (i < 0) throw new RestoreRefusal('manifest_invalid', `${t.name}: key ${c} not a column`)
  return i
})
const pkOf = (line: string, idx: readonly number[]) => {
  const cells = JSON.parse(line) as unknown[]
  return JSON.stringify(idx.map(i => cells[i]))
}

/** The rows already in the target, per table, by primary key (as encoded lines). */
async function targetRows(target: D1Database, manifest: BackupManifest): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>()
  for (const t of manifest.tables) {
    const order = t.orderBy.map(ident).join(', ')
    const rows = (await target.prepare(`SELECT ${t.columns.map(ident).join(', ')} FROM ${ident(t.name)} ORDER BY ${order} LIMIT ${TARGET_ROWS_CHECKED + 1}`).all<Record<string, unknown>>()).results
    if (rows.length > TARGET_ROWS_CHECKED) throw new RestoreRefusal('target_not_empty', `${t.name}: over ${TARGET_ROWS_CHECKED} rows`)
    // A freshly migrated database has no audit line: one there means a used database (perhaps the live one).
    if (t.mode === 'append_only' && rows.length > 0) throw new RestoreRefusal('target_not_empty', `${t.name}: has rows`)
    const idx = pkIndexes(t)
    out.set(t.name, new Map(rows.map(r => {
      const line = encodeRow(t.name, t.columns, r)
      return [pkOf(line, idx), line]
    })))
  }
  return out
}

/**
 * Step 2's part check, and step 3's match of the target's rows. Returns the lines already in the target (`skip`), and
 * the primary keys of the named seeded rows that differ (`overwrite`), per table.
 */
async function checkParts(bucket: R2Bucket, manifest: BackupManifest, existing: Map<string, Map<string, string>>): Promise<{ skip: Map<string, Set<string>>; overwrite: Map<string, Set<string>> }> {
  const skip = new Map<string, Set<string>>()
  const overwrite = new Map<string, Set<string>>()
  const differs: string[] = []
  for (const t of manifest.tables) {
    const idx = pkIndexes(t)
    const inTarget = existing.get(t.name) ?? new Map<string, string>()
    const matched = new Set<string>()
    const replaced = new Set<string>()
    const digest = newDigest()
    const hash = digest.getWriter()
    let rows = 0
    for (const [i, part] of t.parts.entries()) {
      if (part.key !== backupPartKey(manifest.backupId, t.name, i)) throw new RestoreRefusal('manifest_invalid', `${t.name}: part ${i} key`)
      const obj = await bucket.get(part.key)
      if (!obj) throw new RestoreRefusal('part_missing', `${t.name}/${pad(i)}`)
      const bytes = new Uint8Array(await obj.arrayBuffer())
      if (await sha256(bytes) !== part.sha256) throw new RestoreRefusal('part_sha256', `${t.name}/${pad(i)}`)
      const lines = partLines(new TextDecoder().decode(bytes))
      if (lines.some(l => !isRowLine(l, t.columns.length))) throw new RestoreRefusal('part_invalid', `${t.name}/${pad(i)}`)
      if (lines.length !== part.rows) throw new RestoreRefusal('part_rows', `${t.name}/${pad(i)}`)
      await hash.write(bytes)
      rows += lines.length
      for (const line of lines) {
        const pk = pkOf(line, idx)
        const there = inTarget.get(pk)
        if (there === undefined) continue
        if (there === line) matched.add(line)
        else if (seededKey(t.name, pk)) replaced.add(pk)
        else differs.push(t.name)
      }
    }
    await hash.close()
    if (rows !== t.rows) throw new RestoreRefusal('part_rows', `${t.name}: ${rows} rows, manifest ${t.rows}`)
    if (toHex(await digest.digest) !== t.sha256) throw new RestoreRefusal('table_sha256', t.name)
    skip.set(t.name, matched)
    overwrite.set(t.name, replaced)
  }
  if (differs.length > 0) throw new RestoreRefusal('seeded_row_differs', differs[0])
  for (const t of manifest.tables) {
    if ((existing.get(t.name)?.size ?? 0) > (skip.get(t.name)?.size ?? 0) + (overwrite.get(t.name)?.size ?? 0)) throw new RestoreRefusal('target_not_empty', t.name)
  }
  return { skip, overwrite }
}

async function targetMigration(target: D1Database): Promise<string | null> {
  const has = await target.prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").first<{ one: number }>()
  if (!has) return null
  return (await target.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first<{ name: string }>())?.name ?? null
}

/** Reads one table back with the backup's own reader and format: its row count and sha256. */
async function digestTable(db: D1Database, rule: TableRule, columns: readonly string[]): Promise<{ rows: number; sha256: string }> {
  const writer = new TableWriter(rule.name, async () => '')
  if (rule.mode === 'snapshot') {
    for (const row of (await snapshotSelect(db, rule, columns).all<Record<string, unknown>>()).results) await writer.add(encodeRow(rule.name, columns, row))
  } else if (rule.mode === 'append_only') {
    const maxId = (await maxIdSelect(db, rule).first<{ max: number }>())?.max ?? 0
    for await (const row of appendRows(db, rule, columns, maxId)) await writer.add(encodeRow(rule.name, columns, row))
  } else for await (const row of keyRows(db, rule, columns)) await writer.add(encodeRow(rule.name, columns, row))
  const d = await writer.finish()
  return { rows: d.rows, sha256: d.sha256 }
}

/** Restores the backup into `target` and returns the restore record (also stored at `restore/<restoreId>/record.json`). */
export async function restore(deps: RestoreDeps): Promise<RestoreRecord> {
  const { bucket, target, live, backupId, at } = deps
  const registry = deps.registry ?? realRegistry
  const restoreId = timeId(at.nowMs)
  let status: RestoreRecord['status'] = 'failed'
  let reason: string | undefined
  let manifest: BackupManifest | null = null
  let snapshot: RestoreRecord['snapshot'] = null
  const verified = new Map<string, boolean>()
  let prefixes: RestoreRecord['r2']['prefixes'] = []
  let missingPhotoKeys: string[] = []
  const resets: string[] = []
  let record!: RestoreRecord
  try {
    // The target is never the live database (its audit log can't be cleared, and the write would land on top of it).
    if (live !== 'unreadable' && target === live) throw new RestoreRefusal('target_is_live')

    // 1. The snapshot, before anything is written anywhere.
    try { snapshot = await takeSnapshot(bucket, live, restoreId, at.nowMs) } catch (err) { throw new RestoreFailure(`snapshot_failed: ${messageOf(err)}`) }

    // 2. The backup, checked before any write.
    manifest = await loadManifest(bucket, backupId)
    if (manifest.format !== 1) throw new RestoreRefusal('format_unsupported', String(manifest.format))
    const migration = await targetMigration(target)
    if (migration !== manifest.migration) throw new RestoreRefusal('migration_mismatch', `backup ${manifest.migration}, target ${migration ?? 'none'}`)
    let rules: TableRule[]
    let derived: DerivedTable[]
    try { ({ rules, derived } = await canonicalTables(target, registry)) } catch (err) {
      if (err instanceof BackupError) throw new RestoreRefusal('target_schema', err.message)
      throw err
    }
    const byName = new Map(manifest.tables.map(t => [t.name, t]))
    if (byName.size !== manifest.tables.length || byName.size !== rules.length || rules.some(r => !byName.has(r.name))) {
      throw new RestoreRefusal('tables_mismatch', `backup [${[...byName.keys()].join(', ')}], canonical [${rules.map(r => r.name).join(', ')}]`)
    }
    const byDerivedName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    if (JSON.stringify([...manifest.derived].sort(byDerivedName)) !== JSON.stringify(derived)) {
      throw new RestoreRefusal('tables_mismatch', `derived: backup [${manifest.derived.map(d => d.name).join(', ')}], target [${derived.map(d => d.name).join(', ')}]`)
    }
    for (const r of rules) {
      const t = byName.get(r.name) as TableManifest
      if (t.mode !== r.mode || JSON.stringify(t.orderBy) !== JSON.stringify(r.orderBy)) throw new RestoreRefusal('tables_mismatch', `${r.name}: mode or key`)
      if (JSON.stringify(await tableColumns(target, r.name)) !== JSON.stringify(t.columns)) throw new RestoreRefusal('columns_mismatch', r.name)
    }
    // 3. The target: only rows the backup holds identically (migration 0005's service rows) are allowed, skipped below,
    // and the named seeded rows, overwritten below.
    const existing = await targetRows(target, manifest)
    const { skip, overwrite } = await checkParts(bucket, manifest, existing)

    // 4. The write, one statement per part.
    await deps.testing?.beforeTargetWrite?.()
    const r2Keys = new Set<string>()
    for (const r of rules) {
      const t = byName.get(r.name) as TableManifest
      const keyCols = (r.r2KeyColumns ?? []).map(c => t.columns.indexOf(c))
      const sql = insertPartSql(t.name, t.columns)
      // A named seeded row goes first, so the backup's row is inserted in its place (its children come later in order).
      for (const pk of overwrite.get(t.name) ?? []) {
        const values = JSON.parse(pk) as (string | number)[]
        await target.prepare(`DELETE FROM ${ident(t.name)} WHERE ${t.orderBy.map(c => `${ident(c)} = ?`).join(' AND ')}`).bind(...values).run()
      }
      for (const [i, part] of t.parts.entries()) {
        const obj = await bucket.get(part.key)
        if (!obj) throw new RestoreFailure(`part_changed: ${t.name}/${pad(i)}`)
        const bytes = new Uint8Array(await obj.arrayBuffer())
        if (await sha256(bytes) !== part.sha256) throw new RestoreFailure(`part_changed: ${t.name}/${pad(i)}`)
        const lines = partLines(new TextDecoder().decode(bytes))
        for (const line of lines) {
          const cells = JSON.parse(line) as unknown[]
          for (const k of keyCols) if (typeof cells[k] === 'string') r2Keys.add(cells[k])
        }
        const toWrite = lines.filter(l => !skip.get(t.name)?.has(l))
        if (toWrite.length > 0) await target.prepare(sql).bind(linesAsArray(toWrite)).run()
      }
    }
    await deps.testing?.afterTargetWrite?.()

    // 5. The proof.
    for (const r of rules) {
      const t = byName.get(r.name) as TableManifest
      const d = await digestTable(target, r, t.columns)
      verified.set(r.name, d.rows === t.rows && d.sha256 === t.sha256)
    }
    // The R2 state the restored rows point into, after the proof (photos aren't backed up: a missing one is reported,
    // never nulled). One listing per prefix; a key column's value is missing when no listed object has it.
    const listed = new Set<string>()
    for (const e of registry.filter(e => e.kind === 'r2' && e.retention !== 'backup')) {
      const objects = await listAll(bucket, e.name)
      for (const o of objects) listed.add(o.key)
      prefixes.push({ prefix: e.name, objects: objects.length })
    }
    missingPhotoKeys = [...r2Keys].filter(k => !listed.has(k)).sort()

    const bad = [...verified].filter(([, ok]) => !ok).map(([name]) => name)
    if (bad.length > 0) {
      status = 'failed_verification'
      reason = `verification: ${bad.join(', ')}`
    } else {
      // A job's cursor rows, reset only on a proven target (the proof compares with the backup as it was).
      for (const hook of deps.resetAfterRestore ?? RESET_AFTER_RESTORE) {
        try { await hook.run(target, at) } catch (err) { throw new RestoreFailure(`reset_failed: ${hook.name}: ${messageOf(err)}`) }
        resets.push(hook.name)
      }
      status = 'restored_unreconciled'
    }
  } catch (err) {
    if (err instanceof RestoreRefusal) {
      status = 'refused'
      reason = err.reason
    } else {
      status = 'failed'
      reason = err instanceof RestoreFailure ? err.reason : `error: ${messageOf(err)}`
      prefixes = []
      missingPhotoKeys = []
    }
  } finally {
    const m = manifest
    record = RestoreRecordSchema.parse({
      format: 1, restoreId, status, ...(reason === undefined ? {} : { reason }),
      startedAtMs: at.nowMs, finishedAtMs: Math.max(at.nowMs, Date.now()), actorId: at.actorId, source: 'r2-backup',
      backup: { backupId, takenAtMs: m?.takenAtMs ?? null, migration: m?.migration ?? null },
      d1: { restorePointMs: m?.takenAtMs ?? null, tables: (m?.tables ?? []).map(t => ({ name: t.name, rows: t.rows, sha256: t.sha256, verified: verified.get(t.name) ?? false })),
        derived: (m?.derived ?? []).map(d => ({ ...d, state: 'rebuild_needed' as const })),
        paged: (m?.tables ?? []).filter(t => t.consistency === 'paged').map(t => t.name) },
      resets,
      r2: { prefixes, missingPhotoKeys },
      durableObjects: [],
      // The earliest of the D1 point and every Durable Object recovery time; on P2 there are no Durable Objects.
      watermarkMs: m?.takenAtMs ?? null,
      snapshot,
      reconciled: false,
    })
    await bucket.put(restoreKey(restoreId, 'record.json'), JSON.stringify(record), json)
  }
  return record
}
