// Chat files (p3-design sections 3 and 8.5, routes 39 to 41). The chat is seeded straight into D1 (no route makes one yet:
// W1's chat routes are still PR0's 503), so these run on the local test build and skip on a deployed one, as db.ts does.
// Oracles: the matrix and design 8.5 (owner only for an attachment, another member's chat is 404, the Admin is no
// exception, Inhouse needs a live grant, the download's headers, HTML and SVG are never stored). Outputs (any person on the
// brand, BD11) need a file a container run saved, so they wait for PR 2 and the Q2 deployment.
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call, endLiveGrants, expectError, me } from './kit.ts'
import { writeSql } from './db.ts'

const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
const inhouse = actor('inhouse')
const smoke = actor('smoke')
test.describe.configure({ mode: 'serial' })

const chatIds: string[] = []
async function seedChat(request: APIRequestContext, who: typeof dana): Promise<string> {
  const id = `e2e-att-${randomUUID().slice(0, 12)}`
  const now = Date.now()
  writeSql('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, ?, ?, ?)', id, (await me(request, who)).memberId, 'Attachment spec', now, now)
  chatIds.push(id)
  return id
}
const upload = (request: APIRequestContext, who: typeof dana, chatId: string, name: string, body: string | Buffer, extra: Record<string, string> = {}) =>
  call(request, who, 'POST', `/api/chats/${chatId}/attachments`, { bytes: Buffer.from(body), headers: { 'X-File-Name': encodeURIComponent(name), ...extra } })

test.beforeAll(async ({ request }) => { await endLiveGrants(request) })
test.afterAll(async ({ request }) => {
  await endLiveGrants(request)
  for (const id of chatIds) {
    writeSql('DELETE FROM chat_files WHERE chat_id = ?', id)
    writeSql('DELETE FROM chats WHERE id = ?', id)
  }
})

test('the owner uploads a CSV, sees it listed first-hand and downloads the same bytes with the safe headers', async ({ request }) => {
  const chatId = await seedChat(request, dana)
  const bytes = Buffer.from('sku,qty\nmug,12\n')
  const up = await upload(request, dana, chatId, 'stock list.csv', bytes)
  expect(up.status, up.text).toBe(201)
  expect(up.json).toEqual({
    fileId: expect.stringMatching(/^f_[A-Za-z0-9_-]{22}$/), kind: 'input', name: 'stock list.csv', bytes: bytes.length,
    contentType: expect.stringMatching(/^text\/csv/), atMs: expect.any(Number), path: expect.stringMatching(/^inputs\/f_[A-Za-z0-9_-]{22}-stock list\.csv$/),
  })
  expect(up.json.path).toBe(`inputs/${up.json.fileId}-stock list.csv`)

  const list = await call(request, dana, 'GET', `/api/chats/${chatId}/files`)
  expect(list.status, list.text).toBe(200)
  expect(list.json).toEqual({ items: [up.json] })

  const got = await call(request, dana, 'GET', `/api/files/${up.json.fileId}`)
  expect(got.status, got.text).toBe(200)
  expect(got.bytes.equals(bytes)).toBe(true)
  expect(got.headers['content-type']).toMatch(/^text\/csv/)
  expect(got.headers['content-disposition']).toMatch(/^attachment;/)
  expect(got.headers['x-content-type-options']).toBe('nosniff')
  expect(got.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
  expect(got.headers['cache-control']).toBe('private, no-cache')
})

test('two uploads with one name never collide: each has its own path', async ({ request }) => {
  const chatId = await seedChat(request, dana)
  const a = await upload(request, dana, chatId, 'same.csv', 'a,1\n')
  const b = await upload(request, dana, chatId, 'same.csv', 'b,2\n')
  expect([a.status, b.status]).toEqual([201, 201])
  expect(a.json.path).not.toBe(b.json.path)
  const list = await call(request, dana, 'GET', `/api/chats/${chatId}/files`)
  expect(list.json.items).toHaveLength(2)
})

test('another member, the Admin and smoke get 404 on someone else\'s chat and its input file', async ({ request }) => {
  const chatId = await seedChat(request, dana)
  const up = await upload(request, dana, chatId, 'private.csv', 'x,1\n')
  expect(up.status).toBe(201)
  for (const who of [leo, admin]) {
    expectError(await upload(request, who, chatId, 'mine.csv', 'y,2\n'), 404, 'not_found')
    expectError(await call(request, who, 'GET', `/api/chats/${chatId}/files`), 404, 'not_found')
    expectError(await call(request, who, 'GET', `/api/files/${up.json.fileId}`), 404, 'not_found')
  }
  expectError(await call(request, smoke, 'GET', `/api/files/${up.json.fileId}`), 403, 'forbidden')
  // Nothing the others sent landed in the chat.
  expect((await call(request, dana, 'GET', `/api/chats/${chatId}/files`)).json.items).toHaveLength(1)
})

test('a chat that does not exist is 404 for an upload and a list', async ({ request }) => {
  expectError(await upload(request, dana, 'e2e-att-no-such-chat', 'a.csv', 'a,1\n'), 404, 'not_found')
  expectError(await call(request, dana, 'GET', '/api/chats/e2e-att-no-such-chat/files'), 404, 'not_found')
  expectError(await call(request, dana, 'GET', '/api/files/f_AAAAAAAAAAAAAAAAAAAAAA'), 404, 'not_found')
})

test('Inhouse is refused without a live grant and reads the list and the file under one', async ({ request }) => {
  const chatId = await seedChat(request, dana)
  const up = await upload(request, dana, chatId, 'for-support.csv', 'z,3\n')
  expect(up.status).toBe(201)
  expectError(await call(request, inhouse, 'GET', `/api/chats/${chatId}/files`), 403, 'forbidden', 'grant_required')
  expectError(await call(request, inhouse, 'GET', `/api/files/${up.json.fileId}`), 403, 'forbidden', 'grant_required')
  const grant = await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })
  expect(grant.status, grant.text).toBe(200)
  const list = await call(request, inhouse, 'GET', `/api/chats/${chatId}/files`)
  expect(list.status, list.text).toBe(200)
  expect(list.json.items.map((i: { fileId: string }) => i.fileId)).toEqual([up.json.fileId])
  const got = await call(request, inhouse, 'GET', `/api/files/${up.json.fileId}`)
  expect(got.status, got.text).toBe(200)
  expect(got.bytes.toString()).toBe('z,3\n')
  // Even under a grant Inhouse can't upload into a member's chat: route 39 is for the two member roles.
  expectError(await upload(request, inhouse, chatId, 'x.csv', 'x\n'), 403, 'forbidden')
})

test('HTML and SVG are never stored, and a bad name is refused', async ({ request }) => {
  const chatId = await seedChat(request, dana)
  for (const [name, body] of [['page.html', '<html><script>1</script>'], ['pic.svg', '<svg onload="x"/>']] as const) {
    const r = await upload(request, dana, chatId, name, body)
    expect(r.status, `${name}: ${r.text}`).toBe(400)
    expect(r.json.error.code).toBe('invalid')
  }
  for (const name of ['a/b.csv', '', 'x'.repeat(201) + '.csv']) {
    const r = await upload(request, dana, chatId, name, 'a,1\n')
    expect(r.status, `name ${JSON.stringify(name.slice(0, 20))}: ${r.text}`).toBe(400)
    expect(r.json.error.code).toBe('invalid')
  }
  const noHeader = await call(request, dana, 'POST', `/api/chats/${chatId}/attachments`, { bytes: Buffer.from('a,1\n') })
  expect(noHeader.status, noHeader.text).toBe(400)
  expect((await call(request, dana, 'GET', `/api/chats/${chatId}/files`)).json.items).toEqual([])
})

test('a file over the 20 MiB cap is refused and nothing is kept', async ({ request }) => {
  const chatId = await seedChat(request, dana)
  const r = await upload(request, dana, chatId, 'big.csv', Buffer.alloc(20 * 1024 * 1024 + 1, 0x61))
  expect(r.status, r.text.slice(0, 200)).toBe(400)
  expect(r.json.error.code).toBe('invalid')
  expect((await call(request, dana, 'GET', `/api/chats/${chatId}/files`)).json.items).toEqual([])
})
