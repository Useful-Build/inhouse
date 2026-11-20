// Members' photos (p2-design section 3, routes 13 to 15): bytes in R2 under `photos/<memberId>/<random>`, a new key on
// every upload, the key on the member row. Upload order: the new object first, then one D1 batch (the key, `rev`, the
// `photo.changed` line); if the batch fails or changes nothing, the new object is deleted; once it commits, the old one
// is. The row's key is swapped only from the key read before (compare and swap), so two uploads at once never orphan
// an object silently: the loser deletes its own and is told (409 with the photo as it is). Deleting the old object
// after a commit is best effort (logged). Never a public bucket or a signed URL.
// R2 Workers API (put, get, delete, httpMetadata): https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ (read 2026-11-20)
import type { PhotoType } from './photo-bytes.ts'
import { auditInsert } from './audit.ts'
import type { AuditHook } from './audit.ts'
import { writeStamp } from './ids.ts'
import type { At } from './members.ts'
import { photoKey } from './r2-keys.ts'
import { first, runBatch, stmt, storage } from './sql.ts'
import type { Stmt } from './sql.ts'

/** The R2 calls the photo store makes (on the `FILES` binding). */
export type PhotoFiles = Pick<R2Bucket, 'put' | 'get' | 'delete'>

export interface PhotoStoreDeps {
  db: D1Database
  files: PhotoFiles
  hook?: AuditHook
  /** Tests only: runs just before the D1 batch of an upload or a removal (to fail it, or to win a race against it). */
  beforeBatch?: () => Promise<void>
}

const randomPart = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')

/** Another write changed the photo first: the key the row holds now. */
export type PhotoConflict = { conflict: { photoKey: string | null } }

export function photoStore({ db, files: bucket, hook = s => s, beforeBatch }: PhotoStoreDeps) {
  const write = (stmts: Stmt[]) => runBatch(db, stmts.map(s => (s.sql.startsWith('INSERT INTO audit_log') ? hook(s) : s)))
  // Every R2 call goes through `storage`: a failure is a StoreUnavailableError (503), as D1's are (sql.ts).
  const files = {
    put: (key: string, value: Uint8Array, type: string) => storage('R2', () => bucket.put(key, value, { httpMetadata: { contentType: type } })),
    get: (key: string) => storage('R2', () => bucket.get(key)),
    delete: (key: string) => storage('R2', () => bucket.delete(key)),
  }
  /** After a commit, the object nobody points to any more: best effort (a failure is logged with the key only). */
  const dropOld = async (key: string) => {
    try {
      await files.delete(key)
    } catch (err) {
      console.error({ event: 'photo_old_delete_failed', key, error: err instanceof Error ? err.name : 'unknown' })
    }
  }
  const keyOf = async (memberId: string) =>
    first<{ photo_key: string | null }>(db, stmt("SELECT photo_key FROM members WHERE id = ? AND kind = 'person'", memberId))

  return {
    /** Stores a person's own photo. A conflict: another upload or a removal changed it first (nothing kept of this one). */
    async set(input: { memberId: string; bytes: Uint8Array; type: PhotoType }, at: At): Promise<{ ok: true } | PhotoConflict> {
      const before = await keyOf(input.memberId)
      if (!before) throw new Error('set: not a person row')
      const key = photoKey(input.memberId, randomPart())
      await files.put(key, input.bytes, input.type)
      let changes: number
      try {
        await beforeBatch?.()
        const stamp = writeStamp(at.requestId)
        const [change] = await write([
          stmt(
            "UPDATE members SET photo_key = ?, rev = rev + 1, req_id = ? WHERE id = ? AND kind = 'person' AND status = 'active' AND photo_key IS ?",
            key, stamp, input.memberId, before.photo_key,
          ),
          auditInsert(
            { atMs: at.nowMs, actorId: at.actorId, args: { action: 'photo.changed', type: input.type, size: input.bytes.byteLength }, target: { kind: 'member', id: input.memberId }, requestId: at.requestId },
            { table: 'members', where: 'id = ?', params: [input.memberId], stamp },
          ),
        ])
        changes = change.meta.changes
      } catch (err) {
        // The batch may have committed before the error reached us: delete the new object only once the row is known
        // not to point to it (if the row can't be read, keep it: an orphan beats a member row pointing at nothing).
        const now = await keyOf(input.memberId).catch(() => undefined)
        if (now !== undefined && now?.photo_key !== key) await files.delete(key)
        if (now?.photo_key === key) {
          if (before.photo_key) await dropOld(before.photo_key)
          return { ok: true }
        }
        throw err
      }
      if (changes === 0) {
        await files.delete(key)
        return { conflict: { photoKey: (await keyOf(input.memberId))?.photo_key ?? null } }
      }
      if (before.photo_key) await dropOld(before.photo_key)
      return { ok: true }
    },

    /**
     * Removes a person's own photo (the row's key first, then the object). `removed: false` when there was none; a
     * conflict when another upload or removal changed it first.
     */
    async remove(memberId: string, at: At): Promise<{ removed: boolean } | PhotoConflict> {
      const before = await keyOf(memberId)
      if (!before) throw new Error('remove: not a person row')
      if (!before.photo_key) return { removed: false }
      await beforeBatch?.()
      const stamp = writeStamp(at.requestId)
      const [change] = await write([
        stmt(
          "UPDATE members SET photo_key = NULL, rev = rev + 1, req_id = ? WHERE id = ? AND kind = 'person' AND photo_key = ?",
          stamp, memberId, before.photo_key,
        ),
        auditInsert(
          { atMs: at.nowMs, actorId: at.actorId, args: { action: 'photo.removed' }, target: { kind: 'member', id: memberId }, requestId: at.requestId },
          { table: 'members', where: 'id = ?', params: [memberId], stamp },
        ),
      ])
      if (change.meta.changes === 0) return { conflict: { photoKey: (await keyOf(memberId))?.photo_key ?? null } }
      await dropOld(before.photo_key)
      return { removed: true }
    },

    /** A person's photo as stored: its bytes and the type recorded at upload, or null (no such person, or no photo). */
    async get(memberId: string): Promise<{ body: ReadableStream; type: string; size: number } | null> {
      const row = await keyOf(memberId)
      if (!row?.photo_key) return null
      const object = await files.get(row.photo_key)
      if (!object) return null
      const type = object.httpMetadata?.contentType
      if (!type) throw new Error('get: photo stored without a type')
      return { body: object.body, type, size: object.size }
    },
  }
}

export type PhotoStore = ReturnType<typeof photoStore>
