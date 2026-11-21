// Routes 39 to 41 (p3-design 3 and 8.5) on the real migrations, D1 and R2. Expected headers are literals. Ways they can
// fail, written down first:
//  1. an upload to another person's chat is kept, or answers anything but 404; a bad name or type is kept;
//  2. a person lists another's chat files; Inhouse under a grant can't;
//  3. an input downloads to someone who isn't its chat's owner (or Inhouse); an output doesn't download to a colleague;
//  4. a download goes out without `attachment`, the sandbox CSP or private caching, or with a sniffed type.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Principal } from '../auth/principal.ts'
import { openStores } from '../db/stores.ts'
import { ctx, personPrincipal } from '../db/test-support.ts'
import { newFileId } from '../files-io/bytes.ts'
import { TYPE_EXTENSIONS, downloadName } from '../files-io/caps.ts'
import { fileStore } from '../files-io/store.ts'
import { getFile, listChatFiles, uploadAttachment } from './attachments.ts'

const db = env.DB
const stores = openStores(env)
const files = fileStore({ db, bucket: env.FILES })
const enc = new TextEncoder()
let n = 0
const uniq = () => `${++n}-${Math.random().toString(36).slice(2, 8)}`
const OWNER = 'm_att_owner'
const OTHER = 'm_att_other'
const inhouse: Principal = { kind: 'inhouse', memberId: 'm_att_inhouse', subject: 's-inh', grant: null, requestId: 'r-inh', expMs: 4_102_444_800_000 }

beforeAll(async () => {
  for (const [id, email] of [[OWNER, 'att-owner@example.com'], [OTHER, 'att-other@example.com']]) {
    await db.prepare("INSERT OR IGNORE INTO members (id, kind, role, status, name, email_norm, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Pat', ?, 1)").bind(id, email).run()
  }
})
const newChat = async (owner = OWNER) => {
  const id = `chat-${uniq()}`
  await db.prepare('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, ?, 1, 1)').bind(id, owner, 'Files').run()
  return id
}

/** A handler call with a raw body and headers (ctx's JSON body doesn't fit an upload). */
const call = async (handler: typeof getFile, principal: Principal, init: { method: string; path: string; params: Record<string, string>; bytes?: string; name?: string }, s: typeof stores = stores) => {
  const { c } = ctx(s, principal, { method: init.method, path: init.path, params: init.params })
  // ctx's gate applies the owner rule to everyone; the matrix passes Inhouse under a grant (its own tests prove that).
  if (principal.kind === 'inhouse') c.access = { requireObject: () => undefined }
  const headers = new Headers()
  if (init.name !== undefined) headers.set('X-File-Name', init.name)
  const body = init.bytes === undefined ? undefined : enc.encode(init.bytes)
  if (body !== undefined) headers.set('Content-Length', String(body.length))
  const request = new Request(`https://brand.example.test${init.path}`, { method: init.method, headers, body })
  return handler({ ...c, request } as never)
}
const upload = (chatId: string, bytes: string, name: string, who = OWNER) =>
  call(uploadAttachment, personPrincipal(who, 'member'), { method: 'POST', path: `/api/chats/${chatId}/attachments`, params: { id: chatId }, bytes, name })

describe('route 39 (failure 1)', () => {
  it("keeps an attachment in the owner's chat; another person's chat is 404; bad names and types are 400", async () => {
    const chatId = await newChat()
    const res = await upload(chatId, 'sku,qty\nA1,3\n', encodeURIComponent('stock list.csv'))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { fileId: string; path: string; name: string; kind: string; contentType: string; bytes: number }
    expect(body).toMatchObject({ kind: 'input', name: 'stock list.csv', contentType: 'text/csv', bytes: 13 })
    expect(body.path).toBe(`inputs/${body.fileId}-stock list.csv`)
    expect((await upload(chatId, 'x', 'a.txt', OTHER)).status).toBe(404)
    expect((await upload('chat-missing', 'x', 'a.txt')).status).toBe(404)
    for (const name of ['a%2Fb.txt', '..', 'a%23b.txt', '', 'x'.repeat(201), '%E0%A4%A']) {
      const r = await upload(chatId, 'x', name)
      expect(r.status, name).toBe(400)
    }
    expect((await upload(chatId, '<html><script>1</script>', 'page.html')).status).toBe(400)
    expect((await upload(chatId, '<svg onload="x"/>', 'pic.svg')).status).toBe(400)
  })
})

describe('route 40 (failure 2)', () => {
  it("the owner's list; another person's is 404; Inhouse under a grant passes", async () => {
    const chatId = await newChat()
    await upload(chatId, '# a', 'a.md')
    const list = (p: Principal) => call(listChatFiles, p, { method: 'GET', path: `/api/chats/${chatId}/files`, params: { id: chatId } })
    const own = await list(personPrincipal(OWNER, 'member'))
    expect(own.status).toBe(200)
    expect(((await own.json()) as { items: { name: string }[] }).items.map(i => i.name)).toEqual(['a.md'])
    expect((await list(personPrincipal(OTHER, 'admin'))).status).toBe(404)
    expect((await list(inhouse)).status).toBe(200)
  })
})

describe('route 41 (failures 3, 4)', () => {
  it('an input to its owner and Inhouse only; an output to any person on the brand; literal download headers', async () => {
    const chatId = await newChat()
    const upRes = await upload(chatId, 'sku,qty\n', encodeURIComponent('stock "Q1".csv'))
    expect(upRes.status).toBe(201)
    const up = (await upRes.json()) as { fileId: string }
    const get = (p: Principal, fileId: string) => call(getFile, p, { method: 'GET', path: `/api/files/${fileId}`, params: { fileId } })
    expect((await get(personPrincipal(OTHER, 'admin'), up.fileId)).status).toBe(404)
    expect((await get(inhouse, up.fileId)).status).toBe(200)
    const res = await get(personPrincipal(OWNER, 'member'), up.fileId)
    expect(res.status).toBe(200)
    expect(Object.fromEntries(res.headers)).toEqual({
      'content-type': 'text/csv',
      'content-length': '8',
      'content-disposition': `attachment; filename="stock _Q1_.csv"; filename*=UTF-8''stock%20%22Q1%22.csv`,
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-cache',
    })
    expect(await res.text()).toBe('sku,qty\n')

    // An output another person on the brand may download.
    const turnId = `t_${uniq()}`
    const id = newFileId()
    await files.reserveOutput({ id, chatId, turnId, path: 'outputs/r.csv', name: 'r.csv', r2Key: `files/${chatId}/${id}`, nowMs: 1 }, 20)
    const bytes = enc.encode('r,1\n') as Uint8Array<ArrayBuffer>
    const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('')
    await files.putBytes(`files/${chatId}/${id}`, bytes, h, 'text/csv')
    await files.completeOutput(id, { contentType: 'text/csv', bytes: 4, sha256: h })
    expect((await get(personPrincipal(OTHER, 'member'), id)).status).toBe(404)
    await files.confirm(chatId, turnId, 'outputs/r.csv', h, 2)
    const colleague = await get(personPrincipal(OTHER, 'member'), id)
    expect(colleague.status).toBe(200)
    expect(await colleague.text()).toBe('r,1\n')
    expect((await get(personPrincipal(OWNER, 'member'), 'f_not_a_real_id')).status).toBe(404)
  })
})

/** Saves an output named by `path` with these bytes as `type` (bypassing the sniffer: what a stored row could hold). */
async function savedOutput(chatId: string, path: string, body: string, type: string): Promise<string> {
  const turnId = `t_${uniq()}`
  const id = newFileId()
  const bytes = enc.encode(body) as Uint8Array<ArrayBuffer>
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('')
  await files.reserveOutput({ id, chatId, turnId, path, name: path.split('/').pop()!, r2Key: `files/${chatId}/${id}`, nowMs: 1 }, 20)
  await files.putBytes(`files/${chatId}/${id}`, bytes, h, type)
  await files.completeOutput(id, { contentType: type, bytes: bytes.length, sha256: h })
  await files.confirm(chatId, turnId, path, h, 2)
  return id
}
const get = (p: Principal, fileId: string) => call(getFile, p, { method: 'GET', path: `/api/files/${fileId}`, params: { fileId } })

describe('route 41: the download name (round 1, the high)', () => {
  it('a text body named as markup or a program downloads with .txt added; its stored path is unchanged', async () => {
    const chatId = await newChat()
    const cases: [string, string][] = [
      ['page.html', 'page.html.txt'], ['pic.svg', 'pic.svg.txt'], ['run.js', 'run.js.txt'], ['a.hta', 'a.hta.txt'], ['b.bat', 'b.bat.txt'],
      ['notes.txt', 'notes.txt'], ['README', 'README.txt'],
    ]
    for (const [name, expected] of cases) {
      const id = await savedOutput(chatId, `outputs/${name}`, 'plain text', 'text/plain')
      const res = await get(personPrincipal(OWNER, 'member'), id)
      expect(res.headers.get('content-disposition'), name).toBe(`attachment; filename="${expected}"; filename*=UTF-8''${expected}`)
      expect((await db.prepare('SELECT path FROM chat_files WHERE id = ?').bind(id).first<string>('path')), name).toBe(`outputs/${name}`)
    }
  })
  // The extension lists of design 8.5's types, written here apart from caps.ts.
  const EXT: Record<string, string[]> = {
    'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'], 'text/csv': ['csv'],
    'text/plain': ['txt'], 'text/markdown': ['md', 'markdown'], 'application/json': ['json'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  }
  it("caps.ts's extension table is exactly this one", () => {
    expect(TYPE_EXTENSIONS).toEqual(EXT)
  })
  it('a name in capitals keeps its extension when it is the type\'s (REPORT.PDF), and is never lower-cased', () => {
    expect(downloadName('REPORT.PDF', 'application/pdf')).toBe('REPORT.PDF')
    expect(downloadName('Photo.JPEG', 'image/jpeg')).toBe('Photo.JPEG')
    expect(downloadName('NOTES.HTML', 'text/plain')).toBe('NOTES.HTML.txt')
    // The last extension decides, not the first.
    expect(downloadName('report.v2.pdf', 'application/pdf')).toBe('report.v2.pdf')
    expect(downloadName('data.2026.csv', 'text/csv')).toBe('data.2026.csv')
  })
  const RISKY = ['html', 'svg', 'js', 'hta', 'bat', 'cmd', 'ps1', 'vbs', 'lnk', 'exe', 'msi', 'jar', 'scr']
  test.prop([fc.constantFrom(...Object.keys(EXT)), fc.string({ minLength: 1, maxLength: 20 }), fc.constantFrom(...RISKY), fc.boolean()])(
    'every allowed type: a name ending in a risky extension (any case) never downloads with it last',
    (type, stem, risky, upper) => {
      const out = downloadName(`${stem}.${upper ? risky.toUpperCase() : risky}`, type)
      const ext = out.slice(out.lastIndexOf('.') + 1).toLowerCase()
      expect(RISKY).not.toContain(ext)
      expect(EXT[type]).toContain(ext)
    },
  )
  test.prop([fc.constantFrom(...Object.keys(EXT)), fc.string({ minLength: 1, maxLength: 40 })])('every allowed type: the download name ends in one of its own extensions', (type, name) => {
    const out = downloadName(name, type)
    const ext = out.slice(out.lastIndexOf('.') + 1).toLowerCase()
    expect(out.lastIndexOf('.')).toBeGreaterThan(0)
    expect(EXT[type]).toContain(ext)
    expect(out.startsWith(name)).toBe(true)
  })
})

describe('route 41: refusals (round 1)', () => {
  it('a file in a deleted chat, a stored type off the allowed list, and a service principal are 404', async () => {
    const chatId = await newChat()
    const ok = await savedOutput(chatId, 'outputs/ok.csv', 'a,1\n', 'text/csv')
    const html = await savedOutput(chatId, 'outputs/x.html', '<html>', 'text/html')
    expect((await get(personPrincipal(OWNER, 'member'), ok)).status).toBe(200)
    expect((await get(personPrincipal(OWNER, 'member'), html)).status).toBe(404)
    expect((await get({ kind: 'service', name: 'smoke', memberId: 'm_smoke', requestId: 'r-s' }, ok)).status).toBe(404)
    await db.prepare('UPDATE chats SET deleted_at_ms = 5 WHERE id = ?').bind(chatId).run()
    expect((await get(personPrincipal(OWNER, 'member'), ok)).status).toBe(404)
  })
})

describe('route 39: the name as stored, and the declared length (round 2)', () => {
  it('a 230-byte name is kept; 231 is refused (inputs/<fileId>-<name> is one 255-byte segment)', async () => {
    const chatId = await newChat()
    // f_ + 22 + '-' = 25 bytes of the segment, so 230 are left for the name. '€' is 3 bytes, so these stay under the
    // 200-character cap: 75 × 3 + 'a.csv' = 230 bytes in 80 characters; 'ab.csv' makes 231.
    expect(new TextEncoder().encode(`${'€'.repeat(75)}a.csv`).length).toBe(230)
    expect((await upload(chatId, 'a,1\n', encodeURIComponent(`${'€'.repeat(75)}a.csv`))).status).toBe(201)
    expect((await upload(chatId, 'a,1\n', encodeURIComponent(`${'€'.repeat(75)}ab.csv`))).status).toBe(400)
  })
  it('a file declared one byte over the 20 MiB cap is refused too_large before any byte is read, and nothing is kept', async () => {
    const chatId = await newChat()
    const { c } = ctx(stores, personPrincipal(OWNER, 'member'), { method: 'POST', path: `/api/chats/${chatId}/attachments`, params: { id: chatId } })
    const body = new ReadableStream({ start: ctl => { ctl.enqueue(enc.encode('x')); ctl.close() } })
    const request = new Request(`https://brand.example.test/api/chats/${chatId}/attachments`, { method: 'POST', headers: { 'X-File-Name': 'big.csv', 'Content-Length': String(20 * 1024 * 1024 + 1) }, body, duplex: 'half' } as RequestInit)
    expect(request.headers.get('content-length')).toBe(String(20 * 1024 * 1024 + 1))
    const res = await uploadAttachment({ ...c, request } as never)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: { code: 'invalid', reason: 'too_large' } })
    expect(request.body?.locked, 'the body was never opened for reading').toBe(false)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM chat_files WHERE chat_id = ?').bind(chatId).first<number>('n')).toBe(0)
  })
  it('a body with no Content-Length is refused length_required, and nothing is kept', async () => {
    const chatId = await newChat()
    const { c } = ctx(stores, personPrincipal(OWNER, 'member'), { method: 'POST', path: `/api/chats/${chatId}/attachments`, params: { id: chatId } })
    const body = new ReadableStream({ start: ctl => { ctl.enqueue(enc.encode('a,1\n')); ctl.close() } })
    const request = new Request(`https://brand.example.test/api/chats/${chatId}/attachments`, { method: 'POST', headers: { 'X-File-Name': 'a.csv' }, body, duplex: 'half' } as RequestInit)
    expect(request.headers.get('content-length')).toBeNull()
    const res = await uploadAttachment({ ...c, request } as never)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: { code: 'invalid', reason: 'length_required' } })
    expect(await db.prepare('SELECT COUNT(*) AS n FROM chat_files WHERE chat_id = ?').bind(chatId).first<number>('n')).toBe(0)
  })
})

describe('route 39: an R2 write that fails (round 1)', () => {
  it('keeps no row', async () => {
    const chatId = await newChat()
    const failing = { ...stores, files: fileStore({ db, bucket: { put: async () => { throw new Error('r2 down') }, get: async () => null } as never }) }
    await expect(call(uploadAttachment, personPrincipal(OWNER, 'member'), { method: 'POST', path: `/api/chats/${chatId}/attachments`, params: { id: chatId }, bytes: 'a,1\n', name: 'a.csv' }, failing)).rejects.toThrow('r2 down')
    expect(await db.prepare('SELECT COUNT(*) AS n FROM chat_files WHERE chat_id = ?').bind(chatId).first<number>('n')).toBe(0)
  })
})
