// Step 3 of a restore (P8a R; plan "A restore, step by step"): the audit lines newer than the backup's come back, so
// audit history never rewinds. They're the lines above the backup's largest audit id, read from the pre-restore
// snapshot (`restore/<restoreId>/snapshot/`, each part checked against its sha256), or, when the snapshot recorded the
// live audit log as unreadable, from the daily copy (`audit-copy/`, server/audit-copy.ts) with the gap recorded: lines
// after the last copied one are lost. Each line goes back with its own id, by plain INSERT (the table's triggers refuse
// anything else). A re-run appends nothing twice: a target line with the same id and the same values is skipped; one
// that differs, or a target line the source lacks, refuses (`audit_conflict`), since something else wrote the target.
// A line whose actor has no member row in the target (a member added after the backup) refuses by name
// (`audit_actor_missing`): `audit_log.actor_id` references `members(id)`, and dropping the line would rewind history.
import { backupManifestKey } from '../../../server/db/r2-keys.ts'
import { listAll } from '../../delete/r2.ts'
import { RestoreRefusal } from '../errors.ts'
import { encodeRow, insertPartSql, isRowLine, linesAsArray, partLines, sha256, tableColumns } from '../format.ts'
import { BackupManifestSchema, SnapshotManifestSchema } from '../manifest.ts'
import type { Reconcile, RestoreRecord } from '../manifest.ts'

type AuditResult = NonNullable<Reconcile['audit']>

/** Lines bound per INSERT (a snapshot part holds at most 1,000 lines and 1,000,000 bytes; a copied line is smaller). */
const INSERT_LINES = 500
const PAGE = 5_000

async function backupAudit(bucket: R2Bucket, backupId: string): Promise<{ columns: string[]; maxId: number }> {
  const obj = await bucket.get(backupManifestKey(backupId))
  if (!obj) throw new RestoreRefusal('manifest_missing', backupId)
  const manifest = BackupManifestSchema.parse(JSON.parse(await obj.text()))
  const audit = manifest.tables.find(t => t.name === 'audit_log')
  if (!audit || audit.maxId === undefined) throw new RestoreRefusal('manifest_invalid', 'audit_log has no maxId')
  return { columns: audit.columns, maxId: audit.maxId }
}

/** The snapshot's lines above `afterId`, each part checked against the snapshot manifest. */
async function fromSnapshot(bucket: R2Bucket, manifestKey: string, columns: readonly string[], afterId: number): Promise<string[]> {
  const obj = await bucket.get(manifestKey)
  if (!obj) throw new RestoreRefusal('snapshot_missing', manifestKey)
  const snap = SnapshotManifestSchema.parse(JSON.parse(await obj.text()))
  if (snap.audit === 'unreadable') throw new RestoreRefusal('snapshot_invalid', 'the record names a readable snapshot, the manifest says unreadable')
  if (JSON.stringify(snap.audit.columns) !== JSON.stringify(columns)) throw new RestoreRefusal('audit_columns', 'snapshot')
  const idIdx = columns.indexOf('id')
  const out: string[] = []
  for (const part of snap.audit.parts) {
    const body = await bucket.get(part.key)
    if (!body) throw new RestoreRefusal('snapshot_missing', part.key)
    const bytes = new Uint8Array(await body.arrayBuffer())
    if (await sha256(bytes) !== part.sha256) throw new RestoreRefusal('snapshot_sha256', part.key)
    const lines = partLines(new TextDecoder().decode(bytes))
    if (lines.length !== part.rows || lines.some(l => !isRowLine(l, columns.length))) throw new RestoreRefusal('snapshot_invalid', part.key)
    for (const l of lines) if ((JSON.parse(l) as number[])[idIdx] > afterId) out.push(l)
  }
  return out
}

const COPY_KEY = /^audit-copy\/\d{4}-\d{2}-\d{2}\/(\d+)-(\d+)\.jsonl$/

/** The daily copy's lines above `afterId`, in id order, one per id (a copy written twice must agree with itself). */
async function fromDailyCopy(bucket: R2Bucket, columns: readonly string[], afterId: number): Promise<string[]> {
  const byId = new Map<number, string>()
  for (const o of await listAll(bucket, 'audit-copy/')) {
    const m = COPY_KEY.exec(o.key)
    if (!m) throw new RestoreRefusal('audit_copy_invalid', o.key)
    if (Number(m[2]) <= afterId) continue
    const body = await bucket.get(o.key)
    if (!body) throw new RestoreRefusal('audit_copy_invalid', `${o.key} vanished`)
    for (const text of (await body.text()).split('\n')) {
      if (text === '') continue
      let row: Record<string, unknown>
      try { row = JSON.parse(text) as Record<string, unknown> } catch { throw new RestoreRefusal('audit_copy_invalid', o.key) }
      if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...columns].sort())) throw new RestoreRefusal('audit_columns', o.key)
      const id = row.id
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) throw new RestoreRefusal('audit_copy_invalid', o.key)
      if (id <= afterId) continue
      const line = encodeRow('audit_log', columns, row)
      const seen = byId.get(id)
      if (seen !== undefined && seen !== line) throw new RestoreRefusal('audit_copy_conflict', String(id))
      byId.set(id, line)
    }
  }
  return [...byId.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l)
}

/** The target's audit lines above `afterId`, by id. */
async function targetLines(target: D1Database, columns: readonly string[], afterId: number): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const sql = `SELECT ${columns.map(c => `"${c}"`).join(', ')} FROM audit_log WHERE id > ? ORDER BY id LIMIT ${PAGE}`
  for (let after = afterId; ;) {
    const page = (await target.prepare(sql).bind(after).all<Record<string, unknown>>()).results
    for (const r of page) out.set(r.id as number, encodeRow('audit_log', columns, r))
    if (page.length < PAGE) return out
    after = page[page.length - 1].id as number
  }
}

export async function reappendAudit(bucket: R2Bucket, target: D1Database, record: RestoreRecord): Promise<AuditResult> {
  const snapshot = record.snapshot
  if (snapshot === null) throw new RestoreRefusal('snapshot_missing', 'the record has none')
  const { columns, maxId: afterId } = await backupAudit(bucket, record.backup.backupId)
  if (JSON.stringify(await tableColumns(target, 'audit_log')) !== JSON.stringify(columns)) throw new RestoreRefusal('audit_columns', 'target')
  const source: AuditResult['source'] = 'gap' in snapshot ? 'audit_copy' : 'snapshot'
  const lines = 'gap' in snapshot ? await fromDailyCopy(bucket, columns, afterId) : await fromSnapshot(bucket, snapshot.key, columns, afterId)
  const idIdx = columns.indexOf('id')
  const actorIdx = columns.indexOf('actor_id')
  const idOf = (l: string) => (JSON.parse(l) as number[])[idIdx]

  const inTarget = await targetLines(target, columns, afterId)
  const toWrite: string[] = []
  for (const l of lines) {
    const there = inTarget.get(idOf(l))
    if (there === undefined) toWrite.push(l)
    else if (there !== l) throw new RestoreRefusal('audit_conflict', `id ${idOf(l)} differs in the target`)
    inTarget.delete(idOf(l))
  }
  const extra = [...inTarget.keys()]
  if (extra.length > 0) throw new RestoreRefusal('audit_conflict', `the target has line ${extra[0]} the source lacks`)

  const actors = [...new Set(toWrite.map(l => (JSON.parse(l) as string[])[actorIdx]))]
  if (actors.length > 0) {
    const found = new Set((await target.prepare('SELECT id FROM members WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(actors)).all<{ id: string }>()).results.map(r => r.id))
    const missing = actors.filter(a => !found.has(a))
    if (missing.length > 0) throw new RestoreRefusal('audit_actor_missing', `${missing.length} actor(s) without a member row in the target, first ${missing[0]}`)
  }
  const sql = insertPartSql('audit_log', columns)
  for (let i = 0; i < toWrite.length; i += INSERT_LINES) await target.prepare(sql).bind(linesAsArray(toWrite.slice(i, i + INSERT_LINES))).run()

  const throughId = lines.length > 0 ? idOf(lines[lines.length - 1]) : afterId
  return { source, afterId, throughId, appended: toWrite.length, gap: source === 'audit_copy' ? { afterId: throughId, reason: 'live_unreadable' } : null }
}
