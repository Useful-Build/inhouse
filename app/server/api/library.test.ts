// The Library's routes, rows 62 to 66 (p4-w5 section 3), on the real migrations, D1 and R2. Ways they can fail, written
// down first (the brief's tests 1 to 5):
//  1. the list or a download shows a file BD11 keeps private (an input, another person's input, a transcript), a file
//     that isn't saved and current, or a deleted one; or hides one the team may see (acceptance 7). The oracle is the
//     table in p4-w5 section 1, written out here for the seeded files, never read from the code;
//  2. a download goes out `inline`, without `nosniff`, the sandbox CSP or `private, no-store`, or with a type the
//     sniffer didn't set (an HTML or SVG row with its own type);
//  3. an upload the checks refuse (HTML named .pdf, SVG, one byte over the cap, a wrong hash, R2 failing mid-stream)
//     leaves a row or an object behind, or a stored type comes from the request;
//  4. a stale `ifRev` changes some files of a batch; a deleted file still lists or downloads; a restore doesn't bring
//     it back with `rev + 1`; a delete or restore writes no audit or Activity line, or writes them for a refused batch;
//  5. a chat output names its chat (title, link) to anyone but the chat's owner.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Principal } from '../auth/principal.ts'
import { openStores } from '../db/stores.ts'
import { ctx, lastLineId, linesSince, personPrincipal } from '../db/test-support.ts'
import { newFileId } from '../files-io/bytes.ts'
import { fileStore } from '../files-io/store.ts'
import { libraryStore } from '../files/store.ts'
import { SECURITY_HEADERS, keepPhotoHeaders } from '../http.ts'
import { withSecurityHeaders } from '../../shared/security-headers.ts'
import type { LibraryFile } from '../../shared/contract/library.ts'
import { deleteLibraryFiles, downloadLibraryFile, listLibrary, restoreLibraryFiles, uploadLibraryFile } from './library.ts'

const db = env.DB
const stores = openStores(env)
const files = fileStore({ db, bucket: env.FILES })
const enc = new TextEncoder()
const numRuns = Number(import.meta.env.VITE_PROP_RUNS) || 100
let n = 0
const uniq = () => `${++n}-${Math.random().toString(36).slice(2, 8)}`
const A = 'm_lib_a'
const B = 'm_lib_b'
const C = 'm_lib_c'
const INH = 'm_lib_inhouse'
const inhouse: Principal = { kind: 'inhouse', memberId: INH, subject: 's-lib-inh', grant: { id: 'g_x', endsAtMs: 4_102_444_800_000 }, requestId: 'r-lib-inh', expMs: 4_102_444_800_000 }
const viewers: [string, Principal][] = [
  ['A, member', personPrincipal(A, 'member')], ['B, admin', personPrincipal(B, 'admin')], ['C, member', personPrincipal(C, 'member')], ['Inhouse', inhouse],
]

beforeAll(async () => {
  for (const [id, name, email] of [[A, 'Ann Lee', 'lib-a@example.com'], [B, 'Bo Kim', 'lib-b@example.com'], [C, 'Cy Park', 'lib-c@example.com']]) {
    await db.prepare("INSERT OR IGNORE INTO members (id, kind, role, status, name, email_norm, created_at_ms) VALUES (?, 'person', 'member', 'active', ?, ?, 1)").bind(id, name, email).run()
  }
  await db.prepare("INSERT OR IGNORE INTO members (id, kind, role, status, name, subject, created_at_ms) VALUES (?, 'inhouse', NULL, 'active', 'Inhouse support', 's-lib-inh', 1)").bind(INH).run()
})

const newChat = async (owner: string, title = 'Stuck orders') => {
  const id = `chat-${uniq()}`
  await db.prepare('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, ?, 1, 1)').bind(id, owner, title).run()
  return id
}
const sha = async (b: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x => x.toString(16).padStart(2, '0')).join('')

/** An output saved through P3's own store (the row a turn leaves), bypassing the sniffer: what a stored row could hold. */
async function output(chatId: string, name: string, body: string, type: string, o: { confirm?: boolean; atMs?: number } = {}): Promise<string> {
  const turnId = `t_${uniq()}`
  const id = newFileId()
  const bytes = enc.encode(body) as Uint8Array<ArrayBuffer>
  const h = await sha(bytes)
  await files.reserveOutput({ id, chatId, turnId, path: `outputs/${name}`, name, r2Key: `files/${chatId}/${id}`, nowMs: o.atMs ?? 5 }, 20)
  await files.putBytes(`files/${chatId}/${id}`, bytes, h, type)
  await files.completeOutput(id, { contentType: type, bytes: bytes.length, sha256: h })
  if (o.confirm !== false) await files.confirm(chatId, turnId, `outputs/${name}`, h, 6)
  return id
}
async function input(chatId: string, owner: string): Promise<string> {
  const body = enc.encode('sku,qty\n')
  const request = new Request('https://brand.example.test/x', { method: 'POST', headers: { 'Content-Length': String(body.length) }, body })
  const saved = await files.saveInput({ chatId, name: 'mine.csv', request, createdBy: owner, nowMs: 7 })
  if ('refused' in saved) throw new Error(saved.refused)
  return saved.id
}

const call = async (handler: typeof listLibrary, p: Principal, init: { method: string; path: string; params?: Record<string, string>; body?: unknown; bytes?: Uint8Array; headers?: Record<string, string> }, s = stores) => {
  const { c } = ctx(s, p, { method: init.method, path: init.path, params: init.params, body: init.body })
  if (init.bytes === undefined) return handler(c)
  const headers = new Headers(init.headers)
  headers.set('Content-Length', String(init.bytes.length))
  return handler({ ...c, request: new Request(`https://brand.example.test${init.path}`, { method: init.method, headers, body: init.bytes as Uint8Array<ArrayBuffer> }) })
}
/** Every page of route 62 for this viewer. */
async function listAll(p: Principal, deleted = false): Promise<LibraryFile[]> {
  const out: LibraryFile[] = []
  let cursor: string | null = null
  do {
    const q: string = `?limit=100${deleted ? '&deleted=1' : ''}${cursor ? `&cursor=${cursor}` : ''}`
    const res = await call(listLibrary, p, { method: 'GET', path: `/api/library${q}` })
    expect(res.status).toBe(200)
    const page = (await res.json()) as { items: LibraryFile[]; nextCursor: string | null }
    out.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return out
}
const download = (p: Principal, id: string) => call(downloadLibraryFile, p, { method: 'GET', path: `/api/library/${id}/download`, params: { id } })
const del = (p: Principal, items: { id: string; ifRev: number }[]) => call(deleteLibraryFiles, p, { method: 'POST', path: '/api/library/delete', body: { items } })
const restore = (p: Principal, items: { id: string; ifRev: number }[]) => call(restoreLibraryFiles, p, { method: 'POST', path: '/api/library/restore', body: { items } })
const upload = (p: Principal, name: string, bytes: Uint8Array, headers: Record<string, string> = {}, s = stores) =>
  call(uploadLibraryFile, p, { method: 'POST', path: '/api/library/uploads', bytes, headers: { 'X-File-Name': encodeURIComponent(name), ...headers } }, s)
const NOT_FOUND = { error: { code: 'not_found' } }

describe('visibility (test 1, acceptance 7)', () => {
  const seeded: Record<string, string> = {}
  /** The ids the table in section 1 lists, to everyone the routes let in. */
  const visible = new Set<string>()
  const all: string[] = []
  beforeAll(async () => {
    const chatA = await newChat(A, 'Ann private title')
    const chatB = await newChat(B, 'Bo private title')
    const routine = await newChat('m_system', 'Morning check')
    seeded.aOut = await output(chatA, 'a.csv', 'a,1\n', 'text/csv')
    seeded.aIn = await input(chatA, A)
    seeded.bOut = await output(chatB, 'b.md', '# b\n', 'text/markdown')
    seeded.bIn = await input(chatB, B)
    seeded.routineOut = await output(routine, 'r.csv', 'r,1\n', 'text/csv')
    seeded.pendingOut = await output(chatA, 'p.csv', 'p,1\n', 'text/csv', { confirm: false })
    // A path saved twice: the first is superseded, never listed.
    seeded.oldOut = await output(chatB, 'same.csv', 'v1\n', 'text/csv')
    seeded.newOut = await output(chatB, 'same.csv', 'v2\n', 'text/csv')
    const up = await upload(personPrincipal(C, 'member'), 'team.csv', enc.encode('t,1\n'))
    expect(up.status).toBe(201)
    seeded.upload = ((await up.json()) as LibraryFile).id
    seeded.deletedOut = await output(chatB, 'gone.csv', 'g,1\n', 'text/csv')
    expect((await del(personPrincipal(A, 'member'), [{ id: seeded.deletedOut, ifRev: 1 }])).status).toBe(200)
    for (const k of ['aOut', 'bOut', 'routineOut', 'newOut', 'upload']) visible.add(seeded[k])
    all.push(...Object.values(seeded), newFileId(), newFileId(), 'sessions', `f_${'x'.repeat(22)}`)
  })

  it('route 62 lists exactly the files the table allows, to every viewer', async () => {
    const ours = new Set(Object.values(seeded))
    for (const [who, p] of viewers) {
      const listed = (await listAll(p)).map(f => f.id).filter(id => ours.has(id))
      expect(new Set(listed), who).toEqual(visible)
      expect(listed.length, `${who}: no id twice`).toBe(visible.size)
    }
    expect((await listAll(personPrincipal(C, 'member'), true)).map(f => f.id)).toContain(seeded.deletedOut)
  })

  test.prop([fc.constantFrom(...viewers.map((_, i) => i)), fc.nat()], { numRuns })('route 64 serves exactly those; every other id is 404 with no file bytes', async (vi, k) => {
    const id = all[k % all.length]
    const res = await download(viewers[vi][1], id)
    if (visible.has(id)) {
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; /)
      await res.arrayBuffer()
    } else {
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(NOT_FOUND)
    }
  })

  it("a Member can't reach another person's attachment through any Library route; the batch changes nothing", async () => {
    const before = await db.prepare('SELECT COUNT(*) AS n FROM library_marks').first<number>('n')
    for (const p of [personPrincipal(A, 'member'), personPrincipal(C, 'member')]) {
      expect((await download(p, seeded.bIn)).status).toBe(404)
      expect((await del(p, [{ id: seeded.aOut, ifRev: 1 }, { id: seeded.bIn, ifRev: 1 }])).status).toBe(404)
      expect((await restore(p, [{ id: seeded.bIn, ifRev: 1 }])).status).toBe(404)
      expect((await del(p, [{ id: seeded.pendingOut, ifRev: 1 }])).status).toBe(404)
    }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM library_marks').first<number>('n')).toBe(before)
  })
})

/** A download as the API sends it: the site headers, then the route's own kept (api.ts's last step). */
const wrapped = (res: Response) => keepPhotoHeaders(res, withSecurityHeaders(SECURITY_HEADERS, res))

describe('headers on every download (test 2)', () => {
  it('each stored type gets the exact set; HTML and SVG rows go out as octet-stream; never inline', async () => {
    const chat = await newChat(A)
    const cases: [string, string, string, string][] = [
      // name, stored type, served type, the name it downloads under
      ['r.csv', 'text/csv', 'text/csv', 'r.csv'],
      ['n.txt', 'text/plain', 'text/plain', 'n.txt'],
      ['m.md', 'text/markdown', 'text/markdown', 'm.md'],
      ['d.json', 'application/json', 'application/json', 'd.json'],
      ['p.pdf', 'application/pdf', 'application/pdf', 'p.pdf'],
      ['i.png', 'image/png', 'image/png', 'i.png'],
      ['i.jpg', 'image/jpeg', 'image/jpeg', 'i.jpg'],
      ['i.webp', 'image/webp', 'image/webp', 'i.webp'],
      ['s.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 's.xlsx'],
      ['w.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'w.docx'],
      ['k.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'k.pptx'],
      ['page.html', 'text/html', 'application/octet-stream', 'page.html.bin'],
      ['pic.svg', 'image/svg+xml', 'application/octet-stream', 'pic.svg.bin'],
      ['x.xhtml', 'application/xhtml+xml', 'application/octet-stream', 'x.xhtml.bin'],
      ['page.html', 'text/plain', 'text/plain', 'page.html.txt'],
    ]
    for (const [name, stored, served, as] of cases) {
      const id = await output(chat, name, 'body', stored)
      const res = await download(personPrincipal(B, 'member'), id)
      expect(res.status, name).toBe(200)
      expect(Object.fromEntries(res.headers), name).toEqual({
        'content-type': served,
        'content-length': '4',
        'content-disposition': `attachment; filename="${as}"; filename*=UTF-8''${as}`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-store',
      })
      const out = wrapped(res)
      expect(out.headers.get('content-security-policy'), name).toBe("default-src 'none'; sandbox")
      expect(out.headers.get('cache-control'), name).toBe('private, no-store')
      expect(out.headers.get('x-content-type-options'), name).toBe('nosniff')
      expect(out.headers.get('content-disposition'), name).not.toMatch(/inline/)
    }
  })
  it('the filename fallback is ASCII without quotes, backslashes or controls; filename* keeps the name', async () => {
    const up = await upload(personPrincipal(A, 'member'), 'Q1 "stock" \\ €.csv', enc.encode('a,1\n'))
    expect(up.status).toBe(201)
    const file = (await up.json()) as LibraryFile
    expect(file.name).toBe('Q1 "stock"  €.csv')
    const res = await download(personPrincipal(B, 'member'), file.id)
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="Q1 stock  _.csv"; filename*=UTF-8''Q1%20%22stock%22%20%20%E2%82%AC.csv`)
  })
})

/** The rows and objects an upload left (a refused one must leave none). */
const leftovers = async () => ({
  rows: await db.prepare('SELECT COUNT(*) AS n FROM library_uploads').first<number>('n'),
  objects: (await env.FILES.list({ prefix: 'library/' })).objects.length,
})

describe('upload refusals (test 3)', () => {
  it('HTML named .pdf, an SVG, one byte over the cap and a wrong hash leave no row and no object', async () => {
    const before = await leftovers()
    const p = personPrincipal(A, 'member')
    const html = await upload(p, 'report.pdf', enc.encode('<!DOCTYPE html><html><script>alert(1)</script></html>'))
    expect(await html.json()).toEqual({ error: { code: 'invalid', reason: 'type_not_allowed' } })
    const svg = await upload(p, 'logo.svg', enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))
    expect(await svg.json()).toEqual({ error: { code: 'invalid', reason: 'type_not_allowed' } })
    const body = new ReadableStream({ start: ctl => { ctl.enqueue(enc.encode('x')); ctl.close() } })
    const { c } = ctx(stores, p, { method: 'POST', path: '/api/library/uploads' })
    const big = new Request('https://brand.example.test/api/library/uploads', { method: 'POST', headers: { 'X-File-Name': 'big.csv', 'Content-Length': String(20_971_520 + 1) }, body, duplex: 'half' } as RequestInit)
    expect(await (await uploadLibraryFile({ ...c, request: big })).json()).toEqual({ error: { code: 'invalid', reason: 'too_large' } })
    const wrong = await upload(p, 'a.csv', enc.encode('a,1\n'), { 'x-inhouse-sha256': '0'.repeat(64) })
    expect(await wrong.json()).toEqual({ error: { code: 'invalid', reason: 'hash' } })
    expect(await leftovers()).toEqual(before)
  })
  it('an R2 failure mid-stream leaves no row, and the object is deleted', async () => {
    const before = await leftovers()
    const deleted: string[] = []
    const bucket = {
      put: async (_key: string, body: ReadableStream<Uint8Array>) => {
        await body.getReader().read()
        throw new Error('r2 down mid-stream')
      },
      get: async () => null,
      delete: async (key: string) => { deleted.push(key) },
    }
    const failing = { ...stores, library: libraryStore({ db, bucket: bucket as never }) }
    await expect(upload(personPrincipal(A, 'member'), 'a.csv', enc.encode('a,1\n'), {}, failing)).rejects.toThrow('r2 down mid-stream')
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toMatch(/^library\/f_[A-Za-z0-9_-]{22}$/)
    expect(await leftovers()).toEqual(before)
  })
  it("the stored type is the sniffer's, never the request's; a good hash is accepted; the upload writes its lines", async () => {
    const before = await lastLineId(db)
    const bytes = enc.encode('a,1\n') as Uint8Array<ArrayBuffer>
    const res = await upload(personPrincipal(A, 'member'), 'list.csv', bytes, { 'Content-Type': 'text/html', 'x-inhouse-sha256': await sha(bytes) })
    expect(res.status).toBe(201)
    const f = (await res.json()) as LibraryFile
    expect(f).toMatchObject({ type: 'CSV', kind: 'documents', place: 'uploads', from: 'Uploaded by Ann Lee', by: 'Ann Lee', madeByAgent: false, rev: 1, size: '4 B', text: 'a,1\n' })
    expect(await db.prepare('SELECT content_type, state FROM library_uploads WHERE id = ?').bind(f.id).first()).toEqual({ content_type: 'text/csv', state: 'saved' })
    const lines = await linesSince(db, before)
    expect(lines.map(l => [l.action, l.actor_id, l.target_kind, l.target_id, JSON.parse(l.args_json)])).toEqual([
      ['library.uploaded', A, 'file', f.id, { fileId: f.id, contentType: 'text/csv', bytes: 4 }],
    ])
    expect(await db.prepare("SELECT template, actor_id, fields_json FROM activity_lines WHERE source = 'library' AND source_key = ?").bind(`${f.id}|uploaded`).first())
      .toEqual({ template: 'library_uploaded', actor_id: A, fields_json: '{"files":1}' })
  })
  it('a name that leaves nothing after dropping control, bidi and path characters, or over 200, is refused', async () => {
    for (const name of ['/\\', '‮⁦', '\u0000\u0007', 'a'.repeat(201)]) {
      expect(await (await upload(personPrincipal(A, 'member'), name, enc.encode('a,1\n'))).json(), JSON.stringify(name)).toEqual({ error: { code: 'invalid', reason: 'bad_name' } })
    }
    const ok = await upload(personPrincipal(A, 'member'), 'evil‮gpj.csv', enc.encode('a,1\n'))
    expect(((await ok.json()) as LibraryFile).name).toBe('evilgpj.csv')
  })
})

describe('delete and restore (test 4)', () => {
  it('a stale revision fails the batch and changes nothing; delete hides; restore brings it back at rev + 1', async () => {
    const chat = await newChat(A)
    const x = await output(chat, 'x.csv', 'x,1\n', 'text/csv')
    const y = await output(chat, 'y.csv', 'y,1\n', 'text/csv')
    const p = personPrincipal(B, 'member')
    const marks = () => db.prepare('SELECT file_id, rev, deleted_at_ms IS NOT NULL AS deleted FROM library_marks WHERE file_id IN (?, ?) ORDER BY file_id').bind(x, y).all()
    const start = await lastLineId(db)

    // y is stale (rev 2 doesn't exist yet): the whole batch is a conflict with both files as they are.
    const stale = await del(p, [{ id: x, ifRev: 1 }, { id: y, ifRev: 2 }])
    expect(stale.status).toBe(409)
    const body = (await stale.json()) as { error: { code: string; current: { items: LibraryFile[] } } }
    expect(body.error.code).toBe('conflict')
    expect(body.error.current.items.map(f => [f.id, f.rev])).toEqual([[x, 1], [y, 1]])
    expect((await marks()).results).toEqual([])
    expect(await linesSince(db, start)).toEqual([])

    const ok = await del(p, [{ id: x, ifRev: 1 }, { id: y, ifRev: 1 }])
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { items: LibraryFile[] }).items.map(f => [f.id, f.rev])).toEqual([[x, 2], [y, 2]])
    const ids = (await listAll(p)).map(f => f.id)
    expect(ids).not.toContain(x)
    expect(ids).not.toContain(y)
    expect((await download(p, x)).status).toBe(404)
    // A second delete with the old revision is a conflict now; with the new one it changes nothing.
    expect((await del(p, [{ id: x, ifRev: 1 }])).status).toBe(409)
    const again = await del(p, [{ id: x, ifRev: 2 }])
    expect(((await again.json()) as { items: LibraryFile[] }).items[0].rev).toBe(2)

    const back = await restore(personPrincipal(A, 'member'), [{ id: x, ifRev: 2 }])
    expect(back.status).toBe(200)
    expect(((await back.json()) as { items: LibraryFile[] }).items[0].rev).toBe(3)
    expect((await listAll(p)).map(f => f.id)).toContain(x)
    expect((await download(p, x)).status).toBe(200)
    expect((await marks()).results).toEqual([{ file_id: x, rev: 3, deleted: 0 }, { file_id: y, rev: 2, deleted: 1 }].sort((a, b) => (a.file_id < b.file_id ? -1 : 1)))

    const lines = (await linesSince(db, start)).map(l => [l.action, l.actor_id, JSON.parse(l.args_json)])
    expect(lines).toEqual([
      ['library.deleted', B, { fileIds: [x, y] }],
      ['library.restored', A, { fileIds: [x] }],
    ])
    const activity = await db.prepare("SELECT source_key, template, actor_id FROM activity_lines WHERE source = 'library' AND (source_key LIKE ? OR source_key LIKE ?) ORDER BY n").bind(`${x}|%`, `${y}|%`).all()
    expect(activity.results).toEqual([
      { source_key: `${x}|rev2`, template: 'library_deleted', actor_id: B },
      { source_key: `${y}|rev2`, template: 'library_deleted', actor_id: B },
      { source_key: `${x}|rev3`, template: 'library_restored', actor_id: A },
    ])
  })
  it('a restore of a file with no mark answers it as it is; Inhouse may delete; ids twice or over 100 are invalid', async () => {
    const chat = await newChat(A)
    const x = await output(chat, 'x.csv', 'x,1\n', 'text/csv')
    const res = await restore(personPrincipal(C, 'member'), [{ id: x, ifRev: 1 }])
    expect(((await res.json()) as { items: LibraryFile[] }).items[0].rev).toBe(1)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM library_marks WHERE file_id = ?').bind(x).first<number>('n')).toBe(0)
    expect((await del(inhouse, [{ id: x, ifRev: 1 }])).status).toBe(200)
    expect(await db.prepare('SELECT deleted_by FROM library_marks WHERE file_id = ?').bind(x).first<string>('deleted_by')).toBe(INH)
    expect((await del(personPrincipal(A, 'member'), [{ id: x, ifRev: 2 }, { id: x, ifRev: 2 }])).status).toBe(400)
    const many = Array.from({ length: 101 }, () => ({ id: newFileId(), ifRev: 1 }))
    expect((await del(personPrincipal(A, 'member'), many)).status).toBe(400)
  })
  it('of two first deletes racing on one file, one wins and the other is a conflict', async () => {
    const chat = await newChat(A)
    const x = await output(chat, 'x.csv', 'x,1\n', 'text/csv')
    const [r1, r2] = await Promise.all([del(personPrincipal(A, 'member'), [{ id: x, ifRev: 1 }]), del(personPrincipal(B, 'member'), [{ id: x, ifRev: 1 }])])
    expect([r1.status, r2.status].sort()).toEqual([200, 409])
    expect(await db.prepare('SELECT rev FROM library_marks WHERE file_id = ?').bind(x).first<number>('rev')).toBe(2)
    expect(await db.prepare("SELECT COUNT(*) AS n FROM activity_lines WHERE source = 'library' AND source_key LIKE ?").bind(`${x}|%`).first<number>('n')).toBe(1)
  })
})

describe('the chat-title rule (test 5, OC 2)', () => {
  it("the owner sees the chat's title and link; anyone else sees who made it, no title, no link", async () => {
    const chat = await newChat(A, 'Refunds for Ann only')
    const x = await output(chat, 'x.csv', 'x,1\n', 'text/csv')
    const find = async (p: Principal) => (await listAll(p)).find(f => f.id === x)!
    expect(await find(personPrincipal(A, 'member'))).toMatchObject({ from: 'Chat: Refunds for Ann only', link: { to: 'chat', id: chat }, by: 'Inhouse agent', madeByAgent: true, place: 'chats' })
    for (const p of [personPrincipal(B, 'admin'), personPrincipal(C, 'member'), inhouse]) {
      const f = await find(p)
      expect(f.from).toBe('From a chat by Ann Lee')
      expect(f.link).toBeUndefined()
      expect(JSON.stringify(f)).not.toContain('Refunds for Ann only')
    }
    // The chat deleted: the output stays, and the owner has no link to open.
    await db.prepare('UPDATE chats SET deleted_at_ms = 9 WHERE id = ?').bind(chat).run()
    const own = await find(personPrincipal(A, 'member'))
    expect(own.from).toBe('Chat: Refunds for Ann only')
    expect(own.link).toBeUndefined()
    expect((await download(personPrincipal(C, 'member'), x)).status).toBe(200)
  })
  it("a routine run's output links to Routines; an image carries its download URL", async () => {
    const routine = await newChat('m_system', 'Morning check')
    const r = await output(routine, 'r.csv', 'r,1\n', 'text/csv')
    const png = await output(routine, 'i.png', 'body', 'image/png')
    const listed = await listAll(personPrincipal(C, 'member'))
    expect(listed.find(f => f.id === r)).toMatchObject({ place: 'routines', link: { to: 'routines' }, from: 'From a routine', madeByAgent: true })
    expect(listed.find(f => f.id === png)).toMatchObject({ kind: 'images', type: 'PNG', src: `/api/library/${png}/download` })
  })
})
