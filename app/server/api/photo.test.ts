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
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_PHOTO_BYTES, photoType } from '../db/photo-bytes.ts'
import { openStores } from '../db/stores.ts'
import type { Stores } from '../db/stores.ts'
import { lastLineId, linesSince, person, personPrincipal, reset } from '../db/test-support.ts'
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
      expect(await put(bytesOf(head), `${type}; charset=binary`)).toEqual({ status: 200, body: { photoUrl: `/api/members/${me}/photo` } })
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
    expect(await removed.json()).toEqual({ photoUrl: null })
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
