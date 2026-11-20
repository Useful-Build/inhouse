// Routes 39 to 41 (p3-design 3 and 8.5) on the real migrations, D1 and R2. Expected headers are literals. Ways they can
// fail, written down first:
//  1. an upload to another person's chat is kept, or answers anything but 404; a bad name or type is kept;
//  2. a person lists another's chat files; Inhouse under a grant can't;
//  3. an input downloads to someone who isn't its chat's owner (or Inhouse); an output doesn't download to a colleague;
//  4. a download goes out without `attachment`, the sandbox CSP or private caching, or with a sniffed type.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Principal } from '../auth/principal.ts'
import { openStores } from '../db/stores.ts'
import { ctx, personPrincipal } from '../db/test-support.ts'
import { newFileId } from '../files-io/bytes.ts'
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
const call = async (handler: typeof getFile, principal: Principal, init: { method: string; path: string; params: Record<string, string>; bytes?: string; name?: string }) => {
  const { c } = ctx(stores, principal, { method: init.method, path: init.path, params: init.params })
  // ctx's gate applies the owner rule to everyone; the matrix passes Inhouse under a grant (its own tests prove that).
  if (principal.kind === 'inhouse') c.access = { requireObject: () => undefined }
  const headers = new Headers()
  if (init.name !== undefined) headers.set('X-File-Name', init.name)
  const request = new Request(`https://brand.example.test${init.path}`, { method: init.method, headers, body: init.bytes === undefined ? undefined : enc.encode(init.bytes) })
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
