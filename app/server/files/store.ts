// The Library's store slot (P4 W5, p4-w5 sections 1 to 3). It reads P3's `chat_files` (never writes it) and owns
// `library_uploads`, `library_marks` (0240) and the R2 prefix `library/`.
//
// What the Library lists (BD11), and so the only ids any Library route resolves:
// - a chat's current saved output: `kind = 'output'`, `state = 'saved'`, `replaced_at_ms IS NULL` (its chat may be
//   deleted: what a chat makes is the team's, OC 2);
// - a saved team upload.
// An input, a pending or superseded output, a pending upload, a transcript (R2 `sessions/`, never in D1) or an unknown id
// resolves to nothing, so every route answers 404 for it.
//
// Writes: every change and its audit line go in one `DB.batch`. A delete or restore of several files is one batch whose
// every statement carries the same predicate over all its files ("each is still at the revision the request sent, or
// already at the next one with this write's stamp"). The predicate holds for the whole batch iff it held at its start,
// so a stale revision anywhere (another writer got in first) makes every statement match nothing and the batch changes
// nothing; a first mark is `INSERT ... ON CONFLICT(file_id) DO NOTHING` under the same predicate (never `OR REPLACE`).
import { AuditArgsSchema } from '../../shared/contract/audit.ts'
import type { AuditArgs, LibraryTypeSchema } from '../../shared/contract/audit.ts'
import type { z } from 'zod'
import { recordActivity } from '../activity/store.ts'
import type { ActivityTemplateId } from '../activity/templates.ts'
import { writeStamp } from '../db/ids.ts'
import { libraryKey } from '../db/r2-keys.ts'
import type { KeyedBucket } from '../db/r2-keys.ts'
import { all, first, storage, stmt } from '../db/sql.ts'
import { newFileId, streamFile } from '../files-io/bytes.ts'
import type { FileRefusal } from '../files-io/bytes.ts'
import { FILE_CAPS } from '../files-io/caps.ts'
import { TEXT_PREVIEW_MAX, TEXT_PREVIEW_TYPES } from './kinds.ts'

/** One listed file, from either source, with what its card needs. */
export interface LibraryRow {
  source: 'chat' | 'upload'
  id: string
  name: string
  content_type: string
  bytes: number
  at_ms: number
  r2_key: string
  /** A chat output's chat, its owner, title and whether it's deleted; null on an upload. */
  chat_id: string | null
  owner_id: string | null
  chat_title: string | null
  chat_deleted: 0 | 1 | null
  /** An upload's uploader; null on a chat output. */
  created_by: string | null
  /** The chat owner's (an output) or uploader's (an upload) current name; null for a former member. */
  person_name: string | null
  /** The file's revision: its mark's, else 1. */
  rev: number
  deleted_at_ms: number | null
}

/** Who acts: the member, the request (for the write's stamp) and the request's one clock. */
export interface At {
  actorId: string
  requestId: string
  nowMs: number
}

/**
 * The listed files as one table. `?` slots: none. Members' names only while they have one (a pseudonymised member has
 * none). An output of a chat the system owns (`m_system`) is a routine run's.
 */
const LISTED = `
  SELECT x.*, COALESCE(m.rev, 1) AS rev, m.deleted_at_ms AS deleted_at_ms FROM (
    SELECT 'chat' AS source, f.id AS id, f.name AS name, f.content_type AS content_type, f.bytes AS bytes,
      f.created_at_ms AS at_ms, f.r2_key AS r2_key, f.chat_id AS chat_id, c.owner_id AS owner_id, COALESCE(c.custom_title, c.title) AS chat_title,
      CASE WHEN c.deleted_at_ms IS NULL THEN 0 ELSE 1 END AS chat_deleted, NULL AS created_by,
      (SELECT p.name FROM members p WHERE p.id = c.owner_id AND p.pseudonymised_at_ms IS NULL) AS person_name
    FROM chat_files f JOIN chats c ON c.id = f.chat_id
    WHERE f.kind = 'output' AND f.state = 'saved' AND f.replaced_at_ms IS NULL
    UNION ALL
    SELECT 'upload', u.id, u.name, u.content_type, u.bytes, u.created_at_ms, u.r2_key, NULL, NULL, NULL, NULL, u.created_by,
      (SELECT p.name FROM members p WHERE p.id = u.created_by AND p.pseudonymised_at_ms IS NULL)
    FROM library_uploads u WHERE u.state = 'saved'
  ) x LEFT JOIN library_marks m ON m.file_id = x.id AND m.source = x.source`

/** One changed file of a delete or restore: its id, source, the revision it was at and whether it has a mark (a mark starts at 2). */
interface Change {
  id: string
  source: 'chat' | 'upload'
  rev: number
  marked: boolean
}

/**
 * The batch's predicate (see the header): every file in `changes` is at its revision (no mark yet, for one at 1 with
 * none) or at the next one stamped by this write. Two parameters: the changes as JSON, the stamp; then their count.
 */
const STILL_AT = `(SELECT COUNT(*) FROM json_each(?) j LEFT JOIN library_marks k ON k.file_id = json_extract(j.value, '$.id')
  WHERE (k.file_id IS NULL AND json_extract(j.value, '$.marked') = 0)
     OR (k.rev = json_extract(j.value, '$.rev') AND json_extract(j.value, '$.marked') = 1)
     OR (k.rev = json_extract(j.value, '$.rev') + 1 AND k.req_id = ?)) = ?`

export type WriteOutcome = { ok: LibraryRow[] } | { not_found: true } | { conflict: LibraryRow[] }

export function libraryStore({ db, bucket }: { db: D1Database; bucket: Pick<KeyedBucket, 'put' | 'get' | 'delete'> }) {
  /** The listed files with these ids (deleted or not), by id. */
  async function resolve(ids: readonly string[]): Promise<Map<string, LibraryRow>> {
    if (ids.length === 0) return new Map()
    const rows = await all<LibraryRow>(db, stmt(`SELECT * FROM (${LISTED}) WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)))
    return new Map(rows.map(r => [r.id, r]))
  }

  /** An audit line that lands only when this write stamped `stamp` on some row of `table`. */
  const audit = (at: At, args: AuditArgs, target: { kind: string; id: string } | null, table: 'library_uploads' | 'library_marks', stamp: string) => {
    const { action, ...rest } = AuditArgsSchema.parse(args)
    return db.prepare(
      `INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ${table} WHERE req_id = ?)`,
    ).bind(at.nowMs, at.actorId, action, target?.kind ?? null, target?.id ?? null, JSON.stringify(rest), at.requestId, stamp)
  }

  const personLine = (template: ActivityTemplateId, fields: Record<string, number>, at: At, key: string) =>
    recordActivity(db, { template, fields, kind: 'change', actorId: at.actorId, atMs: at.nowMs }, { source: 'library', key })

  /** Delete (`deleted`) or restore (`live`) the files, against their revisions. */
  async function mark(to: 'deleted' | 'live', items: readonly { id: string; ifRev: number }[], at: At): Promise<WriteOutcome> {
    const ids = items.map(i => i.id)
    const found = await resolve(ids)
    if (ids.some(id => !found.has(id))) return { not_found: true }
    const rows = ids.map(id => found.get(id)!)
    if (items.some(i => found.get(i.id)!.rev !== i.ifRev)) return { conflict: rows }
    // A delete of a deleted file, or a restore of a live one (a file with no mark included), changes nothing.
    const changes: Change[] = rows
      .filter(r => (to === 'deleted') === (r.deleted_at_ms === null))
      .map(r => ({ id: r.id, source: r.source, rev: r.rev, marked: r.rev > 1 }))
    if (changes.length === 0) return { ok: rows }
    const stamp = writeStamp(at.requestId)
    const guard = [JSON.stringify(changes), stamp, changes.length] as const
    const deletedAt = to === 'deleted' ? at.nowMs : null
    const deletedBy = to === 'deleted' ? at.actorId : null
    const writes = changes.map(c => c.marked
      ? db.prepare(`UPDATE library_marks SET deleted_at_ms = ?, deleted_by = ?, rev = rev + 1, req_id = ? WHERE file_id = ? AND rev = ? AND ${STILL_AT}`)
        .bind(deletedAt, deletedBy, stamp, c.id, c.rev, ...guard)
      : db.prepare(`INSERT INTO library_marks (file_id, source, deleted_at_ms, deleted_by, rev, req_id) SELECT ?, ?, ?, ?, 2, ? WHERE ${STILL_AT}
          ON CONFLICT (file_id) DO NOTHING`)
        .bind(c.id, c.source, deletedAt, deletedBy, stamp, ...guard))
    const fileIds = changes.map(c => c.id)
    const action = to === 'deleted' ? 'library.deleted' : 'library.restored'
    const results = await storage('D1', () => db.batch([...writes, audit(at, { action, fileIds }, null, 'library_marks', stamp)]))
    const changed = results.slice(0, writes.length).map(r => r.meta.changes)
    // The predicate is the same for every statement: all changed, or none (someone else's write got in first).
    if (changed.some(n => n !== 1)) {
      if (changed.some(n => n === 1)) throw new Error('library mark: a batch changed some files and not others')
      const now = await resolve(ids)
      if (ids.some(id => !now.has(id))) return { not_found: true }
      return { conflict: ids.map(id => now.get(id)!) }
    }
    // One Activity line per changed file, keyed by the revision it made. TODO(#250): move each into the batch with
    // `recordActivity`'s guard (`stamped`) once P4 W2's guarded variant merges; until then it follows the commit.
    const template = to === 'deleted' ? 'library_deleted' : 'library_restored'
    await storage('D1', () => db.batch(changes.map(c => personLine(template, {}, at, `${c.id}|rev${c.rev + 1}`))))
    const after = await resolve(ids)
    return { ok: ids.map(id => after.get(id)!) }
  }

  return {
    /** A page of listed files, newest first (ties by id), live ones or deleted ones only. */
    async page(q: { deleted: boolean; limit: number; before: { atMs: number; id: string } | null }): Promise<{ rows: LibraryRow[]; last: { atMs: number; id: string } | null }> {
      const b = q.before
      const found = await all<LibraryRow>(db, stmt(
        `SELECT * FROM (${LISTED}) WHERE (deleted_at_ms IS NOT NULL) = ?
          AND (? IS NULL OR at_ms < ? OR (at_ms = ? AND id < ?)) ORDER BY at_ms DESC, id DESC LIMIT ?`,
        q.deleted ? 1 : 0, b?.atMs ?? null, b?.atMs ?? null, b?.atMs ?? null, b?.id ?? null, q.limit + 1,
      ))
      const rows = found.slice(0, q.limit)
      const lastRow = rows[rows.length - 1]
      return { rows, last: found.length > q.limit && lastRow ? { atMs: lastRow.at_ms, id: lastRow.id } : null }
    },

    /** One listed file (deleted or not), or null. */
    async byId(id: string): Promise<LibraryRow | null> {
      return (await resolve([id])).get(id) ?? null
    },

    /** A file's bytes with their stored size, or null when R2 has none. */
    async readObject(row: Pick<LibraryRow, 'r2_key'>): Promise<{ body: ReadableStream; size: number } | null> {
      const o = await storage('R2', () => bucket.get(row.r2_key))
      return o ? { body: o.body, size: o.size } : null
    },

    /** A small text file's contents for its card (React renders it as text), else undefined. */
    async textPreview(row: Pick<LibraryRow, 'r2_key' | 'content_type' | 'bytes'>): Promise<string | undefined> {
      if (!TEXT_PREVIEW_TYPES.includes(row.content_type) || row.bytes >= TEXT_PREVIEW_MAX) return undefined
      const o = await storage('R2', () => bucket.get(row.r2_key))
      return o ? new TextDecoder().decode(await o.arrayBuffer()) : undefined
    },

    /**
     * Route 41's rule (p4-w5 section 3, line A's answer 4): true when this chat output has a live delete mark, so it's
     * withdrawn from everyone but its chat's owner until a restore.
     */
    async withdrawn(fileId: string): Promise<boolean> {
      return (await first<{ one: number }>(db, stmt("SELECT 1 AS one FROM library_marks WHERE file_id = ? AND source = 'chat' AND deleted_at_ms IS NOT NULL", fileId))) !== null
    },

    /**
     * A team upload (route 63): a pending row, the body streamed to R2 with P3's checks (its declared length up to the
     * cap, its type from its bytes on P3's list, the claimed SHA-256), then `saved` with its audit and Activity lines in
     * one batch. Any refusal or failure removes the pending row and the object before it answers.
     */
    async upload(u: { name: string; request: Request; sha256: string | undefined; at: At }): Promise<{ ok: LibraryRow } | { refused: FileRefusal }> {
      const id = newFileId()
      const key = libraryKey(id)
      await storage('D1', () => db.prepare(
        `INSERT INTO library_uploads (id, name, content_type, bytes, sha256, r2_key, state, created_by, created_at_ms, req_id)
          VALUES (?, ?, '', 0, '', ?, 'pending', ?, ?, NULL)`,
      ).bind(id, u.name, key, u.at.actorId, u.at.nowMs).run())
      let kept = false
      try {
        const s = await streamFile(u.request, u.name, {
          max: FILE_CAPS.maxFileBytes, sha256: u.sha256,
          put: (body, contentType) => bucket.put(key, body, { httpMetadata: { contentType } }),
        })
        if ('refused' in s) return s
        if ('failed' in s) throw s.failed
        const stamp = writeStamp(u.at.requestId)
        const [saved] = await storage('D1', () => db.batch([
          db.prepare("UPDATE library_uploads SET state = 'saved', content_type = ?, bytes = ?, sha256 = ?, req_id = ? WHERE id = ? AND state = 'pending'")
            .bind(s.contentType, s.bytes, s.sha256, stamp, id),
          audit(u.at, { action: 'library.uploaded', fileId: id, contentType: s.contentType as z.infer<typeof LibraryTypeSchema>, bytes: s.bytes }, { kind: 'file', id }, 'library_uploads', stamp),
          // The row was inserted by this request a moment ago and only this request moves it: the update can't match
          // nothing, so the line rides the batch unguarded.
          personLine('library_uploaded', { files: 1 }, u.at, `${id}|uploaded`),
        ]))
        if (saved?.meta.changes !== 1) throw new Error('library upload: the pending row was gone at save')
        kept = true
        const row = await resolve([id])
        return { ok: row.get(id)! }
      } finally {
        if (!kept) {
          // Both run even when one fails; a failure here leaves a pending row (and maybe its object) for P8's retention.
          const done = await Promise.allSettled([
            storage('R2', () => bucket.delete(key)),
            storage('D1', () => db.prepare("DELETE FROM library_uploads WHERE id = ? AND state = 'pending'").bind(id).run()),
          ])
          const failed = done.find(d => d.status === 'rejected')
          if (failed) console.error(JSON.stringify({ event: 'library_upload_cleanup_failed', fileId: id, error: String((failed as PromiseRejectedResult).reason) }))
        }
      }
    },

    delete: (items: readonly { id: string; ifRev: number }[], at: At) => mark('deleted', items, at),
    restore: (items: readonly { id: string; ifRev: number }[], at: At) => mark('live', items, at),
  }
}

export type LibraryStore = ReturnType<typeof libraryStore>
