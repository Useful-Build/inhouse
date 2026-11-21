// Routes 13 to 15 on the real migrations and the test R2. Ways they can fail, written down first:
//  1. bytes that aren't PNG, JPEG or WebP are stored because the Content-Type says image/png (or a real image is
//     stored under a Content-Type that names another type);
//  2. a body over 1 MiB is stored: a lying or missing Content-Length, a chunked body;
//  3. a failed D1 batch leaves the new object in R2 (an orphan), or a replaced photo leaves the old one;
//  4. the photo.changed line holds the bytes (or anything but the type and size);
//  5. the photo is served with a sniffable or runnable type, or cached publicly;
//  6. the owner check comes after the write.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_PHOTO_BYTES, photoType } from '../db/photo-bytes.ts'
import { photoStore } from '../db/photos.ts'
import { openStores } from '../db/stores.ts'
import type { Stores } from '../db/stores.ts'
import { at, lastLineId, linesSince, person, personPrincipal, reset } from '../db/test-support.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { PHOTO_RESPONSE_HEADERS } from '../http.ts'
import { deletePhoto, getMemberPhoto, putPhoto } from './photo.ts'

const db = env.DB
const files = env.FILES
const stores = openStores(env)
let me: string
let u = 0

beforeEach(async () => {
  await reset(db)
  me = await person(stores, { email: `p-${++u}@example.test`, subject: `sp-${u}`, role: 'member' })
})

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]
const webp = (rest: number[] = []) => [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, ...rest]
const bytesOf = (head: number[], size = 64) => { const b = new Uint8Array(size); b.set(head); return b }

/** This test's member's objects (R2 isn't reset between tests; every member has its own prefix). */
/** The member row's rev, read back: what a photo answer must carry. */
const revOf = async () => (await db.prepare('SELECT rev FROM members WHERE id = ?').bind(me).first<number>('rev'))!
/** The photo URL the row's key makes now: the path, versioned by the key's last part (null: no photo). */
const keyNow = async () => db.prepare('SELECT photo_key FROM members WHERE id = ?').bind(me).first<string | null>('photo_key')
const urlNow = async () => {
  const key = await keyNow()
  return key === null ? null : `/api/members/${me}/photo?v=${key.slice(key.lastIndexOf('/') + 1)}`
}
const objects = async () => (await files.list({ prefix: `photos/${me}/` })).objects.map(o => o.key).sort()

function photoCtx(body: BodyInit | null, headers: Record<string, string>, s: Stores = stores, objectsSeen: unknown[] = []): ApiCtx {
  return {
    request: new Request('http://brand.localhost:8787/api/photo', { method: body === null ? 'DELETE' : 'PUT', body, headers, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit),
    principal: personPrincipal(me, 'member'),
    params: {},
    requestId: `r-${++u}`,
    nowMs: 1_800_000_000_000,
    stores: s,
    access: { requireObject: o => { objectsSeen.push(o) } },
  }
}
const put = async (bytes: Uint8Array, type: string, s?: Stores) => {
  const res = await putPhoto(photoCtx(bytes as Uint8Array<ArrayBuffer>, { 'Content-Type': type }, s))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('the type comes from the bytes (failure 1)', () => {
  test.prop([fc.uint8Array({ minLength: 0, maxLength: 64 }).filter(b => photoType(b) === null), fc.constantFrom('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'text/html')], { numRuns: 100 })(
    'bytes that are none of the three are refused, whatever Content-Type says', async (bytes, type) => {
      expect(await put(bytes, type)).toEqual({ status: 400, body: { error: { code: 'invalid', reason: 'bad_type' } } })
      expect(await objects()).toEqual([])
    },
  )
  it('a real image under a Content-Type naming another type is refused', async () => {
    expect((await put(bytesOf(PNG), 'image/jpeg')).body).toEqual({ error: { code: 'invalid', reason: 'bad_type' } })
    expect((await put(bytesOf(JPEG), 'image/png')).body).toEqual({ error: { code: 'invalid', reason: 'bad_type' } })
  })
  it('takes PNG, JPEG and WebP under their own type', async () => {
    for (const [head, type] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [webp(), 'image/webp']] as const) {
      const answer = await put(bytesOf(head), `${type}; charset=binary`)
      expect(answer).toEqual({ status: 200, body: { photoUrl: await urlNow(), rev: await revOf() } })
    }
  })
})

describe('the size cap (failure 2)', () => {
  it('refuses a body over 1 MiB with or without Content-Length, and takes exactly 1 MiB', async () => {
    const over = bytesOf(PNG, MAX_PHOTO_BYTES + 1)
    expect(await put(over, 'image/png')).toEqual({ status: 400, body: { error: { code: 'invalid', reason: 'too_large' } } })
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { if (sent >= over.length) return c.close(); c.enqueue(over.subarray(sent, sent + 65536)); sent += 65536 },
    })
    const res = await putPhoto(photoCtx(stream, { 'Content-Type': 'image/png' }))
    expect(res.status).toBe(400)
    expect(await objects()).toEqual([])
    expect((await put(bytesOf(PNG, MAX_PHOTO_BYTES), 'image/png')).status).toBe(200)
  })
})

describe('R2 and D1 together (failures 3, 4)', () => {
  it('a failed D1 batch leaves no new object; the old photo stays', async () => {
    expect((await put(bytesOf(PNG), 'image/png')).status).toBe(200)
    const kept = await objects()
    const failing = openStores(env, undefined, { beforePhotoBatch: async () => { throw new Error('D1 down') } })
    await expect(put(bytesOf(JPEG), 'image/jpeg', failing)).rejects.toThrow('D1 down')
    expect(await objects()).toEqual(kept)
    const row = await db.prepare('SELECT photo_key FROM members WHERE id = ?').bind(me).first<string>('photo_key')
    expect([row]).toEqual(kept)
  })
  it('a replaced photo deletes the old object; the line holds only the type and size', async () => {
    const before = await lastLineId(db)
    await put(bytesOf(PNG, 100), 'image/png')
    const first = await objects()
    await put(bytesOf(JPEG, 200), 'image/jpeg')
    const second = await objects()
    expect(second).toHaveLength(1)
    expect(second[0]).not.toBe(first[0])
    expect(second[0].startsWith(`photos/${me}/`)).toBe(true)
    const lines = await linesSince(db, before)
    expect(lines.map(l => [l.action, l.actor_id, JSON.parse(l.args_json)])).toEqual([
      ['photo.changed', me, { type: 'image/png', size: 100 }], ['photo.changed', me, { type: 'image/jpeg', size: 200 }],
    ])
    const removed = await deletePhoto(photoCtx(null, {}))
    expect(await removed.json()).toEqual({ photoUrl: null, rev: await revOf() })
    expect(await objects()).toEqual([])
    expect((await linesSince(db, before)).map(l => l.action)).toEqual(['photo.changed', 'photo.changed', 'photo.removed'])
    // Removing again changes nothing and logs nothing.
    await deletePhoto(photoCtx(null, {}))
    expect(await linesSince(db, before)).toHaveLength(3)
  })
})

describe('serving (failure 5) and the owner check (failure 6)', () => {
  it('serves the bytes with the stored type and the photo headers; 404 without a photo', async () => {
    const bytes = bytesOf(webp([9, 9]), 80)
    await put(bytes, 'image/webp')
    const c = { ...photoCtx(null, {}), params: { id: me } }
    const res = await getMemberPhoto(c)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/webp')
    for (const [k, v] of Object.entries(PHOTO_RESPONSE_HEADERS)) expect(res.headers.get(k)).toBe(v)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
    expect((await getMemberPhoto({ ...c, params: { id: 'm_nobody' } })).status).toBe(404)
  })
  it('calls requireObject with the caller as owner before reading the body or writing', async () => {
    const seen: unknown[] = []
    const c = photoCtx(bytesOf(PNG), { 'Content-Type': 'image/png' }, stores, seen)
    c.access = { requireObject: o => { seen.push(o); throw new Error('refused') } }
    await expect(putPhoto(c)).rejects.toThrow('refused')
    expect(seen).toEqual([{ ownerId: me }])
    expect(await objects()).toEqual([])
    expect(c.request.bodyUsed).toBe(false)
  })
})

describe('after the commit, and races (fix round 1)', () => {
  const store = (over: { files?: Partial<R2Bucket>; db?: D1Database; beforeBatch?: () => Promise<void> } = {}) =>
    photoStore({ db: over.db ?? db, files: { put: files.put.bind(files), get: files.get.bind(files), delete: files.delete.bind(files), ...over.files } as R2Bucket, beforeBatch: over.beforeBatch })
  it("a failing delete of the old object after the commit is logged with the key only, and the upload still succeeds", async () => {
    await put(bytesOf(PNG), 'image/png')
    const [old] = await objects()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = store({ files: { delete: async (k: string | string[]) => { if (k === old) throw new Error('R2 down'); await files.delete(k) } } })
      expect(await s.set({ memberId: me, bytes: bytesOf(JPEG), type: 'image/jpeg' }, at(me))).toEqual({ ok: true, rev: await revOf(), key: await keyNow() })
      expect(error.mock.calls).toEqual([[{ event: 'photo_old_delete_failed', key: old, error: 'StoreUnavailableError' }]])
      const row = await db.prepare('SELECT photo_key FROM members WHERE id = ?').bind(me).first<string>('photo_key')
      expect(row).not.toBe(old)
      expect(await objects()).toEqual([old, row].sort())
    } finally {
      vi.restoreAllMocks()
    }
  })
  it('a batch that committed but reported a failure keeps the new object the row points to', async () => {
    // The batch runs, then its reply is lost.
    const lostReply = new Proxy(db, {
      get(t, prop) {
        if (prop === 'batch') return async (stmts: D1PreparedStatement[]) => { await t.batch(stmts); throw new Error('reply lost') }
        const v = Reflect.get(t, prop, t)
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
    expect(await store({ db: lostReply }).set({ memberId: me, bytes: bytesOf(PNG), type: 'image/png' }, at(me))).toEqual({ ok: true, rev: await revOf(), key: await keyNow() })
    const row = await db.prepare('SELECT photo_key FROM members WHERE id = ?').bind(me).first<string>('photo_key')
    expect(await objects()).toEqual([row])
  })
  it('a removal that loses a race is 409 conflict with the photo as it is now, and logs nothing', async () => {
    await put(bytesOf(PNG), 'image/png')
    const before = await lastLineId(db)
    // Another upload lands between the removal's read and its write.
    const racing = openStores(env, undefined, { beforePhotoBatch: async () => { await db.prepare("UPDATE members SET photo_key = 'photos/' || id || '/other' WHERE id = ?").bind(me).run() } })
    const res = await deletePhoto(photoCtx(null, {}, racing))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: { code: 'conflict', current: { photoUrl: `/api/members/${me}/photo?v=other`, rev: await revOf() } } })
    expect(await linesSince(db, before)).toEqual([])
  })
  it('an upload that loses a race is 409 conflict with the photo as it is now', async () => {
    const racing = openStores(env, undefined, { beforePhotoBatch: async () => { await db.prepare("UPDATE members SET photo_key = 'photos/' || id || '/other' WHERE id = ?").bind(me).run() } })
    const res = await putPhoto(photoCtx(bytesOf(PNG) as Uint8Array<ArrayBuffer>, { 'Content-Type': 'image/png' }, racing))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: { code: 'conflict', current: { photoUrl: `/api/members/${me}/photo?v=other`, rev: await revOf() } } })
    expect(await objects()).toEqual([])
  })
})

describe('the photo URL changes with the photo (a browser never shows a replaced one from its cache)', () => {
  test.prop([fc.integer({ min: 2, max: 5 })], { numRuns: 5 })('every upload answers a URL no earlier upload had, and me and the row say the same', async n => {
    const seen = new Set<string>()
    for (let i = 0; i < n; i++) {
      const { body } = await put(bytesOf(PNG), 'image/png')
      const url = body.photoUrl as string
      expect(url).toMatch(new RegExp(`^/api/members/${me}/photo\\?v=[0-9a-f]{32}$`))
      expect(seen.has(url), 'a new upload, a new URL').toBe(false)
      seen.add(url)
      expect((await stores.members.get(me))?.photo).toBe(url)
    }
  })
  it('the download route reads only the path: any version serves the photo the row holds', async () => {
    const { body } = await put(bytesOf(PNG), 'image/png')
    for (const v of [body.photoUrl as string, `/api/members/${me}/photo?v=stale`]) {
      const res = await getMemberPhoto({ ...photoCtx(null, {}), request: new Request(`http://brand.localhost:8787${v}`), params: { id: me } })
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('image/png')
    }
  })
})

describe("the answer's rev is the photo write's own (fix round 4)", () => {
  /** A name save from another device: it lands right after the photo's batch has committed, before the answer is made. */
  const otherWrite = async () => { await db.prepare('UPDATE members SET rev = rev + 1 WHERE id = ?').bind(me).run() }
  it('an upload answers with the rev its own write left, not a later write\'s', async () => {
    const before = await revOf()
    const racing = openStores(env, undefined, { afterPhotoBatch: otherWrite })
    const res = await putPhoto(photoCtx(bytesOf(PNG) as Uint8Array<ArrayBuffer>, { 'Content-Type': 'image/png' }, racing))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ photoUrl: await urlNow(), rev: before + 1 })
    expect(await revOf(), 'the other write did land').toBe(before + 2)
  })
  it('a removal answers with the rev its own write left, not a later write\'s', async () => {
    await put(bytesOf(PNG), 'image/png')
    const before = await revOf()
    const racing = openStores(env, undefined, { afterPhotoBatch: otherWrite })
    const res = await deletePhoto(photoCtx(null, {}, racing))
    expect(await res.json()).toEqual({ photoUrl: null, rev: before + 1 })
    expect(await revOf()).toBe(before + 2)
  })
})

describe('the Content-Length check and the count, each on its own (fix round 1)', () => {
  it('a small lying Content-Length with a large streamed body is refused by the count', async () => {
    const big = bytesOf(PNG, MAX_PHOTO_BYTES + 4096)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (sent >= big.length) return c.close(); c.enqueue(big.subarray(sent, sent + 65536)); sent += 65536 } })
    const res = await putPhoto(photoCtx(stream, { 'Content-Type': 'image/png', 'Content-Length': '100' }))
    expect(await res.json()).toEqual({ error: { code: 'invalid', reason: 'too_large' } })
    expect(await objects()).toEqual([])
  })
  it('an honest oversize Content-Length is refused before any byte is read', async () => {
    let pulled = 0
    // highWaterMark 0: the stream is pulled only when someone reads it.
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(1)) } }, { highWaterMark: 0 })
    const res = await putPhoto(photoCtx(stream, { 'Content-Type': 'image/png', 'Content-Length': String(MAX_PHOTO_BYTES + 1) }))
    expect(await res.json()).toEqual({ error: { code: 'invalid', reason: 'too_large' } })
    expect(pulled).toBe(0)
  })
})
