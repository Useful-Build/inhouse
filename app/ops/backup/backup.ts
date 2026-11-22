// The canonical-table backup to R2 (P8 G1; plan "Design notes", acceptance item 4). C1 calls it nightly.
// One consistent point: D1 has no read snapshot across queries, so one batch (one transaction,
// https://developers.cloudflare.com/d1/worker-api/d1-database/ read 2026-11-20) reads every `snapshot` table whole,
// the max id of every `append_only` table and the last applied migration. Append-only rows at or below a recorded max
// can't change after the batch, so paging them afterwards still gives exactly the state at the batch.
// Layout: `backups/d1/<backupId>/<table>/<part>.ndjson`, then `backups/d1/<backupId>/manifest.json` last.
// Derived tables (FTS5 indexes, registry entries with `derived`) aren't copied: the manifest lists them with their
// source tables, and a restore records them as needing a rebuild.
import { backupManifestKey, backupPartKey } from '../../server/db/r2-keys.ts'
import type { TableEntry } from '../tables/types.ts'
import { BackupError } from './errors.ts'
import { SNAPSHOT_MAX_ROWS, TableWriter, appendRows, encodeRow, keyRows, maxIdSelect, pointSelect, snapshotSelect, tableColumns } from './format.ts'
import { BackupManifestSchema } from './manifest.ts'
import type { BackupManifest, TableManifest } from './manifest.ts'
import { canonicalTables } from './tables.ts'

export interface BackupDeps {
  db: D1Database
  bucket: R2Bucket
  nowMs: number
  /** The table registry; tests pass fixtures. */
  registry?: readonly TableEntry[]
  testing?: { afterPointBatch?: () => Promise<void> }
}

/** `<UTC yyyyMMddTHHmmssSSSZ>-<8 random hex>`, so ids sort by time. Backups and restores share it. */
export function timeId(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:.]/g, '')
  const random = [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${stamp}-${random}`
}

const ndjson = { httpMetadata: { contentType: 'application/x-ndjson' } }
const json = { httpMetadata: { contentType: 'application/json' } }

/** Takes a backup of every canonical table and returns its manifest (written last). */
export async function backup(deps: BackupDeps): Promise<BackupManifest> {
  const { db, bucket, nowMs } = deps
  const { rules, derived } = await canonicalTables(db, deps.registry)
  const columns = new Map<string, string[]>()
  for (const r of rules) columns.set(r.name, await tableColumns(db, r.name))
  const cols = (name: string) => columns.get(name) as string[]

  // The point batch: snapshot tables whole, append-only maxima, insert-only points and counts, the migration. `paged`
  // tables are read after it (C1).
  const snapshotRules = rules.filter(r => r.mode === 'snapshot')
  const appendRules = rules.filter(r => r.mode === 'append_only')
  const insertRules = rules.filter(r => r.mode === 'insert_only')
  const results = await db.batch([
    ...snapshotRules.map(r => snapshotSelect(db, r, cols(r.name))),
    ...appendRules.map(r => maxIdSelect(db, r)),
    ...insertRules.map(r => pointSelect(db, r)),
    db.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1'),
  ])
  const snapshotRows = new Map(snapshotRules.map((r, i) => [r.name, results[i].results as Record<string, unknown>[]]))
  const maxIds = new Map(appendRules.map((r, i) => [r.name, (results[snapshotRules.length + i].results[0] as { max: number }).max]))
  const points = new Map(insertRules.map((r, i) => [r.name, results[snapshotRules.length + appendRules.length + i].results[0] as { point: number; n: number }]))
  const migration = (results[results.length - 1].results[0] as { name: string } | undefined)?.name
  if (!migration) throw new BackupError('no_migration', 'd1_migrations is empty')
  for (const [name, rows] of snapshotRows) if (rows.length > SNAPSHOT_MAX_ROWS) throw new BackupError('snapshot_too_large', `${name}: over ${SNAPSHOT_MAX_ROWS} rows`)
  await deps.testing?.afterPointBatch?.()

  const backupId = timeId(nowMs)
  const tables: TableManifest[] = []
  for (const r of rules) {
    const writer = new TableWriter(r.name, async (part, bytes) => {
      const key = backupPartKey(backupId, r.name, part)
      await bucket.put(key, bytes, ndjson)
      return key
    })
    const point = points.get(r.name)
    if (r.mode === 'snapshot') {
      for (const row of snapshotRows.get(r.name) ?? []) await writer.add(encodeRow(r.name, cols(r.name), row))
    } else if (r.mode === 'append_only') {
      for await (const row of appendRows(db, r, cols(r.name), maxIds.get(r.name) as number)) await writer.add(encodeRow(r.name, cols(r.name), row))
    } else {
      for await (const row of keyRows(db, r, cols(r.name), point === undefined ? {} : { createdAtMost: point.point })) await writer.add(encodeRow(r.name, cols(r.name), row))
    }
    const digest = await writer.finish()
    // An insert_only table is exact when it read back the rows the point batch counted; paged tables never are.
    const exact = r.mode === 'paged' ? false : point === undefined ? true : digest.rows === point.n
    tables.push({
      name: r.name, columns: cols(r.name), orderBy: [...r.orderBy], mode: r.mode, rows: digest.rows,
      ...(r.mode === 'append_only' ? { maxId: maxIds.get(r.name) } : {}),
      ...(point === undefined ? {} : { point: point.point }),
      consistency: exact ? 'exact' : 'paged',
      sha256: digest.sha256, parts: digest.parts,
    })
  }
  const manifest = BackupManifestSchema.parse({ format: 1, backupId, takenAtMs: nowMs, migration, tables, derived })
  await bucket.put(backupManifestKey(backupId), JSON.stringify(manifest), json)
  return manifest
}

/** Reads and parses a backup's manifest; null when it has none (an incomplete backup). A bad manifest throws. */
export async function readManifest(bucket: R2Bucket, backupId: string): Promise<BackupManifest | null> {
  const obj = await bucket.get(backupManifestKey(backupId))
  if (!obj) return null
  return BackupManifestSchema.parse(JSON.parse(await obj.text()))
}

/** Complete backups (manifest present and parsed), newest first. */
export async function listBackups(bucket: R2Bucket): Promise<BackupManifest[]> {
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix: 'backups/d1/', delimiter: '/', cursor })
    for (const p of page.delimitedPrefixes) ids.push(p.slice('backups/d1/'.length, -1))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  const out: BackupManifest[] = []
  for (const id of ids) {
    const obj = await bucket.get(backupManifestKey(id))
    if (!obj) continue
    // Not JSON, or not a manifest: not a complete backup, so not listed (a restore of it refuses by name).
    const text = await obj.text()
    let data: unknown
    try { data = JSON.parse(text) } catch { continue }
    const parsed = BackupManifestSchema.safeParse(data)
    if (parsed.success) out.push(parsed.data)
  }
  return out.sort((a, b) => b.takenAtMs - a.takenAtMs || (a.backupId < b.backupId ? 1 : -1))
}
