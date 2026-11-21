// P3's `files` store slot (p3-design 8.5, 11 and 12; W3). The chat files table (`0120_chat_files`): attachments
// (`input`, saved at upload) and outputs (`output`, `pending` from the egress's PUT until `confirm`). Every method takes
// data and returns data (the store contract in server/routes.ts). The bytes live in R2 under `files/<chatId>/<fileId>`
// (r2-keys.ts), streamed there (files-io/bytes.ts). An output is written with the SHA-256 its sender claims (R2 docs:
// checked for integrity, kept in the object's `checksums`); an upload's hash is known only once its bytes are in, so its
// row keeps the hash counted as it streamed (R2 keeps its own MD5 of a single-part put).
import type { ChatFile } from '../do/brand-agent/ports.ts'
import { chatFileKey } from '../db/r2-keys.ts'
import type { KeyedBucket } from '../db/r2-keys.ts'
import { all, first, runBatch, stmt } from '../db/sql.ts'
import { newFileId, streamFile } from './bytes.ts'
import type { FileRefusal } from './bytes.ts'
import { FILE_CAPS } from './caps.ts'

interface Row {
  id: string
  chat_id: string
  kind: 'input' | 'output'
  path: string
  name: string
  content_type: string
  bytes: number
  sha256: string
  r2_key: string
  state: 'pending' | 'saved'
  turn_id: string | null
  created_by: string | null
  created_at_ms: number
  replaced_at_ms: number | null
}

/** A saved file with where its bytes are and when it was made. */
export interface StoredFile extends ChatFile {
  r2Key: string
  createdAtMs: number
  createdBy: string | null
}

const file = (r: Row): StoredFile => ({
  id: r.id, chatId: r.chat_id, kind: r.kind, path: r.path, name: r.name, contentType: r.content_type, bytes: r.bytes, sha256: r.sha256,
  turnId: r.turn_id, r2Key: r.r2_key, createdAtMs: r.created_at_ms, createdBy: r.created_by,
})

export interface OutputSlot {
  id: string
  chatId: string
  turnId: string
  path: string
  name: string
  r2Key: string
  nowMs: number
}

export function fileStore({ db, bucket }: { db: D1Database; bucket: Pick<KeyedBucket, 'put' | 'get'> }) {
  return {
    /**
     * Writes a file's bytes (a stream of known length, or a buffer) under its key, with their SHA-256 (hex) when it's
     * known before the bytes: R2 checks the bytes against it, refuses the put on a mismatch, and keeps it.
     */
    async putBytes(key: string, body: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>, sha256: string | undefined, contentType: string): Promise<void> {
      await bucket.put(key, body, sha256 === undefined ? { httpMetadata: { contentType } } : { sha256, httpMetadata: { contentType } })
    },

    /** A saved file's bytes, or null when R2 has none. */
    async readBytes(f: Pick<StoredFile, 'r2Key'>): Promise<ReadableStream | null> {
      return (await bucket.get(f.r2Key))?.body ?? null
    },

    /** The owner of a live (not deleted) chat, or null. */
    async chatOwner(chatId: string): Promise<string | null> {
      return (await first<{ owner_id: string }>(db, stmt('SELECT owner_id FROM chats WHERE id = ? AND deleted_at_ms IS NULL', chatId)))?.owner_id ?? null
    },

    /**
     * Takes one of the turn's output slots (8.5): one conditional insert, so two PUTs racing for the last slot can't
     * both get it. The row is `pending` with no hash yet (`sha256 = ''`), so nothing can confirm it until it's complete.
     */
    async reserveOutput(s: OutputSlot, maxPerTurn: number): Promise<boolean> {
      const [r] = await runBatch(db, [stmt(
        `INSERT INTO chat_files (id, chat_id, kind, path, name, content_type, bytes, sha256, r2_key, state, turn_id, created_by, created_at_ms)
         SELECT ?, ?, 'output', ?, ?, '', 0, '', ?, 'pending', ?, NULL, ?
         WHERE (SELECT COUNT(*) FROM chat_files WHERE turn_id = ? AND kind = 'output') < ?`,
        s.id, s.chatId, s.path, s.name, s.r2Key, s.turnId, s.nowMs, s.turnId, maxPerTurn,
      )])
      return (r?.meta.changes ?? 0) === 1
    },

    /**
     * The reserved output's bytes are in R2: its type, size and hash (still `pending`). False when no pending row of that
     * id was there to change (the sweep expired it, or a purge deleted it, while the bytes were written).
     */
    async completeOutput(id: string, f: { contentType: string; bytes: number; sha256: string }): Promise<boolean> {
      const [r] = await runBatch(db, [stmt("UPDATE chat_files SET content_type = ?, bytes = ?, sha256 = ? WHERE id = ? AND state = 'pending'", f.contentType, f.bytes, f.sha256, id)])
      return (r?.meta.changes ?? 0) === 1
    },

    /** Frees a refused PUT's slot (only while it's still pending). */
    async dropOutput(id: string): Promise<void> {
      await runBatch(db, [stmt("DELETE FROM chat_files WHERE id = ? AND state = 'pending'", id)])
    },

    /**
     * Flips the turn's pending output at `path` with this hash to saved and supersedes the older saved row of that path,
     * in one batch (8.5). Idempotent: a repeat, or a retry after a lost reply, answers the same saved row. A retried PUT
     * leaves a duplicate pending row with the same path and hash: the batch drops it (freeing its slot) whether it comes
     * before or after the first confirm, and the turn keeps one saved row for that file. Null when no output of the turn
     * has that path and hash.
     */
    async confirm(chatId: string, turnId: string, path: string, sha256: string, nowMs: number): Promise<StoredFile | null> {
      const match = `SELECT id FROM chat_files WHERE chat_id = ? AND turn_id = ? AND path = ? AND sha256 = ? AND kind = 'output' AND state = 'pending'`
      const savedSame = `SELECT 1 FROM chat_files WHERE chat_id = ? AND turn_id = ? AND path = ? AND sha256 = ? AND kind = 'output' AND state = 'saved' AND replaced_at_ms IS NULL`
      const same = [chatId, turnId, path, sha256] as const
      await runBatch(db, [
        // The older current row of the path is superseded, unless it already is this turn's file with this hash.
        stmt(
          `UPDATE chat_files SET replaced_at_ms = ? WHERE chat_id = ? AND path = ? AND state = 'saved' AND replaced_at_ms IS NULL
           AND NOT (turn_id IS ? AND sha256 = ?) AND EXISTS (${match})`,
          nowMs, chatId, path, turnId, sha256, ...same,
        ),
        // The newest matching pending row is saved, unless this file is saved already.
        stmt(
          `UPDATE chat_files SET state = 'saved' WHERE id = (${match} ORDER BY created_at_ms DESC, id DESC LIMIT 1) AND NOT EXISTS (${savedSame})`,
          ...same, ...same,
        ),
        // Any other pending copy of the same file (a retried PUT) is dropped: its slot comes free.
        stmt(`DELETE FROM chat_files WHERE id IN (${match}) AND EXISTS (${savedSame})`, ...same, ...same),
      ])
      const row = await first<Row>(db, stmt(
        "SELECT * FROM chat_files WHERE chat_id = ? AND turn_id = ? AND path = ? AND sha256 = ? AND kind = 'output' AND state = 'saved' ORDER BY created_at_ms DESC, id DESC LIMIT 1",
        ...same,
      ))
      return row ? file(row) : null
    },

    /**
     * An attachment (route 39): its body streamed to R2 with the checks of files-io/bytes.ts (its type from its bytes,
     * on the allowed list), its own path `inputs/<fileId>-<name>` (so two uploads with one name both stay), then its row,
     * saved at once. A refused body leaves nothing in R2; a failed R2 write throws.
     */
    async saveInput(f: { chatId: string; name: string; request: Request; createdBy: string; nowMs: number }): Promise<StoredFile | { refused: FileRefusal }> {
      const id = newFileId()
      const r2Key = chatFileKey(f.chatId, id)
      const s = await streamFile(f.request, f.name, { max: FILE_CAPS.maxFileBytes, put: (body, contentType) => bucket.put(r2Key, body, { httpMetadata: { contentType } }) })
      if ('refused' in s) return s
      if ('failed' in s) throw s.failed
      const row: Row = {
        id, chat_id: f.chatId, kind: 'input', path: `inputs/${id}-${f.name}`, name: f.name, content_type: s.contentType,
        bytes: s.bytes, sha256: s.sha256, r2_key: r2Key, state: 'saved', turn_id: null,
        created_by: f.createdBy, created_at_ms: f.nowMs, replaced_at_ms: null,
      }
      await runBatch(db, [stmt(
        `INSERT INTO chat_files (id, chat_id, kind, path, name, content_type, bytes, sha256, r2_key, state, turn_id, created_by, created_at_ms)
         VALUES (?, ?, 'input', ?, ?, ?, ?, ?, ?, 'saved', NULL, ?, ?)`,
        row.id, row.chat_id, row.path, row.name, row.content_type, row.bytes, row.sha256, row.r2_key, row.created_by, row.created_at_ms,
      )])
      return file(row)
    },

    /** The chat's current saved files: attachments first, then outputs, each newest first (the restore order). */
    async listCurrent(chatId: string): Promise<StoredFile[]> {
      return (await all<Row>(db, stmt(
        `SELECT * FROM chat_files WHERE chat_id = ? AND state = 'saved' AND replaced_at_ms IS NULL
         ORDER BY CASE kind WHEN 'input' THEN 0 ELSE 1 END, created_at_ms DESC, id DESC`,
        chatId,
      ))).map(file)
    },

    /** The chat's current saved file at `path`, or null. */
    async currentAt(chatId: string, path: string): Promise<StoredFile | null> {
      const row = await first<Row>(db, stmt("SELECT * FROM chat_files WHERE chat_id = ? AND path = ? AND state = 'saved' AND replaced_at_ms IS NULL", chatId, path))
      return row ? file(row) : null
    },

    /** A saved file by id, with its chat's owner, or null (pending, unknown, or its chat deleted). */
    async savedById(id: string): Promise<(StoredFile & { ownerId: string }) | null> {
      const row = await first<Row & { owner_id: string }>(db, stmt(
        "SELECT f.*, c.owner_id FROM chat_files f JOIN chats c ON c.id = f.chat_id WHERE f.id = ? AND f.state = 'saved' AND c.deleted_at_ms IS NULL", id,
      ))
      return row ? { ...file(row), ownerId: row.owner_id } : null
    },

    /**
     * The saved `input` rows of this chat for these ids, in the order asked (`FileLedgerPort.inputsOf`: route 29 builds a
     * turn's attachments from them), or the ids that aren't one.
     */
    async inputsOf(chatId: string, fileIds: readonly string[]): Promise<{ ok: true; files: StoredFile[] } | { missing: string[] }> {
      if (fileIds.length === 0) return { ok: true, files: [] }
      const rows = await all<Row>(db, stmt(
        `SELECT * FROM chat_files WHERE chat_id = ? AND kind = 'input' AND state = 'saved' AND id IN (${fileIds.map(() => '?').join(', ')})`,
        chatId, ...fileIds,
      ))
      const byId = new Map(rows.map(r => [r.id, file(r)]))
      const missing = fileIds.filter(id => !byId.has(id))
      return missing.length === 0 ? { ok: true, files: fileIds.map(id => byId.get(id)!) } : { missing }
    },
  }
}

/** What the `files` store offers. */
export type FileStore = ReturnType<typeof fileStore>
