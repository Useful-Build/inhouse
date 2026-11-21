// The Library (P4 W5 routes 62 to 66, acceptance 7; p4-w5.md sections 1 to 4): what it lists to whom, the only byte path and
// its headers, the upload's refusals, delete and restore against `ifRev`, and that a chat's attachment never reaches it.
// The expected answers are written here from the brief's tables. Uploads and downloads run on any build (the API alone);
// the chat-attachment cases seed a chat into the local D1; the chat-output cases play the scripted model's `write-output`
// scenario in a container, so they run on the multi-config test build only (`needsWatchBuild`, which gates both).
import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, allPages, call, endLiveGrants, expectConflict, expectError, imageBytes, me } from './kit.ts'
import type { Actor, Reply } from './kit.ts'
import { auditMax, expectOneLine, writeSql } from './db.ts'
import { answerOf, createChat, send } from './chat-kit.ts'
import { needsWatchBuild } from './watch-kit.ts'
import { caseFor } from './cases.ts'

const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
const inhouse = actor('inhouse')

const run = randomBytes(5).toString('hex')
const NO_FILE = 'f_AAAAAAAAAAAAAAAAAAAAAA'

interface File_ { id: string; name: string; type: string; kind: string; place: string; from: string; by: string; madeByAgent: boolean; size: string; rev: number; canDelete?: boolean; link?: { to: string; id?: string }; text?: string; src?: string; at: { ms: number } }

/** An upload; `extra`'s `Content-Type` is the type the request claims (the server must ignore it), the rest are headers. */
const upload = (request: APIRequestContext, who: Actor, name: string | null, body: string | Buffer, extra: Record<string, string> = {}): Promise<Reply> => {
  const { 'Content-Type': claimed, ...headers } = extra
  return call(request, who, 'POST', '/api/library/uploads', {
    bytes: Buffer.from(body), ...(claimed === undefined ? {} : { contentType: claimed }), headers: { ...(name === null ? {} : { 'X-File-Name': encodeURIComponent(name) }), ...headers },
  })
}
const page = async (request: APIRequestContext, who: Actor, query = ''): Promise<{ items: File_[]; nextCursor: string | null }> => {
  const r = await call(request, who, 'GET', `/api/library${query}`)
  expect(r.status, r.text).toBe(200)
  return r.json
}
const ids = async (request: APIRequestContext, who: Actor, query = '') => (await allPages<File_>(request, who, '/api/library' + query, 100)).items.map(f => f.id)
const write = (request: APIRequestContext, who: Actor, to: 'delete' | 'restore', items: { id: string; ifRev: number }[]) => call(request, who, 'POST', `/api/library/${to}`, { json: { items } })

test.describe('uploads, listing and the byte path', () => {
  test.describe.configure({ mode: 'serial' })
  const CSV = 'sku,qty\nmug,12\n'
  let csv: File_

  test.beforeAll(async ({ request }) => { await endLiveGrants(request) })
  test.afterAll(async ({ request }) => { await endLiveGrants(request) })

  test('without a JWT, or with a garbage one, every Library route is 401', async ({ request }) => {
    for (const key of ['GET /api/library', 'POST /api/library/uploads', 'GET /api/library/:id/download', 'POST /api/library/delete', 'POST /api/library/restore']) {
      const [method, pattern] = key.split(' ') as [string, string]
      const c = caseFor({ method, pattern })
      for (const token of [null, 'not-a-jwt']) {
        const r = await call(request, dana, method, c.path, { token, ...(c.json === undefined ? {} : { json: c.json }) })
        expectError(r, 401, 'unauthorized')
      }
    }
  })

  test('a Member uploads a CSV: it is kept as the sniffer saw it, listed as the team\'s, with a text preview, and the audit and Activity lines say who', async ({ request }) => {
    const local = !process.env.E2E_TEST_BUILD_REMOTE
    const mark = local ? auditMax() : 0
    const r = await upload(request, dana, `E2E stock list ${run}.csv`, CSV, { 'Content-Type': 'text/html' })
    expect(r.status, r.text).toBe(201)
    csv = r.json
    expect(csv).toMatchObject({
      name: `E2E stock list ${run}.csv`, type: 'CSV', kind: 'documents', place: 'uploads', from: 'Uploaded by Dana Kim', by: 'Dana Kim',
      madeByAgent: false, size: '15 B', rev: 1, canDelete: true, text: CSV,
    })
    expect(csv.id).toMatch(/^f_[A-Za-z0-9_-]{22}$/)
    expect(csv.link, 'an upload has no link').toBeUndefined()
    const feed = await call(request, dana, 'GET', '/api/activity?limit=10')
    expect(feed.json.items.map((l: { text: string }) => l.text), 'Activity names the uploader, not the file').toContain('Dana Kim added 1 file to the Library')
    expect(JSON.stringify(feed.json)).not.toContain(run)
    if (local) {
      const line = expectOneLine(mark, 'library.uploaded', (await me(request, dana)).memberId as string, [run])
      expect(JSON.parse(line.args_json)).toMatchObject({ fileId: csv.id, contentType: 'text/csv', bytes: 15 })
    }
  })

  test('every person sees it, in newest-first pages that hold it once; Inhouse needs a live grant, and can read but not upload', async ({ request }) => {
    for (const who of [dana, leo, admin]) expect((await ids(request, who)), 'listed to everyone').toContain(csv.id)
    const small = await allPages<File_>(request, leo, '/api/library', 1)
    const all = await allPages<File_>(request, leo, '/api/library', 100)
    expect(small.items.map(f => f.id)).toEqual(all.items.map(f => f.id))
    const times = all.items.map(f => f.at.ms)
    expect(times, 'newest first').toEqual([...times].sort((a, b) => b - a))
    expect(new Set(small.items.map(f => f.id)).size).toBe(small.items.length)

    expectError(await call(request, inhouse, 'GET', '/api/library'), 403, 'forbidden', 'grant_required')
    expect((await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })).status).toBe(201)
    const read = await call(request, inhouse, 'GET', '/api/library')
    expect(read.status, `a 503 here means support.access lacks the route pattern (PR0 #237): ${read.text}`).toBe(200)
    expectError(await upload(request, inhouse, 'by-inhouse.csv', 'a,1\n'), 403, 'forbidden')
    await endLiveGrants(request)
    for (const q of ['?cursor=not*a*cursor', '?limit=0', '?limit=101', '?deleted=2', '?other=1']) {
      const bad = await call(request, dana, 'GET', `/api/library${q}`)
      expect(bad.status, q).toBe(400)
      expect(bad.json.error.code).toBe('invalid')
    }
  })

  test('the download is the file\'s bytes as an attachment, never inline: nosniff, a sandboxing CSP, the stored type and a safe filename', async ({ request }) => {
    for (const who of [dana, leo, admin]) {
      const got = await call(request, who, 'GET', `/api/library/${csv.id}/download`)
      expect(got.status, got.text).toBe(200)
      expect(got.bytes.toString()).toBe(CSV)
      expect(got.headers['content-type']).toMatch(/^text\/csv/)
      expect(got.headers['content-length']).toBe(String(CSV.length))
      expect(got.headers['content-disposition']).toBe(`attachment; filename="E2E stock list ${run}.csv"; filename*=UTF-8''E2E%20stock%20list%20${run}.csv`)
      expect(got.headers['x-content-type-options']).toBe('nosniff')
      expect(got.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
      expect(got.headers['cache-control']).toBe('private, no-store')
    }
    expect((await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })).status).toBe(201)
    expect((await call(request, inhouse, 'GET', `/api/library/${csv.id}/download`)).status, 'Inhouse reads the bytes under a grant').toBe(200)
    await endLiveGrants(request)
  })

  test('an unknown or malformed id answers 404 with no body bytes of a file', async ({ request }) => {
    for (const id of [NO_FILE, 'f_short', 'not-a-file-id', 'c_e2eNobodyAAAAAAAAAAAAA']) {
      const r = await call(request, dana, 'GET', `/api/library/${id}/download`)
      expectError(r, 404, 'not_found')
    }
  })

  test('the stored type is the sniffer\'s, never the request\'s: PNG bytes sent as text/html are a PNG image served from the download URL', async ({ request }) => {
    const r = await upload(request, dana, `E2E picture ${run}.png`, imageBytes('image/png', 64), { 'Content-Type': 'text/html' })
    expect(r.status, r.text).toBe(201)
    expect(r.json).toMatchObject({ type: 'PNG', kind: 'images', src: `/api/library/${r.json.id}/download` })
    const got = await call(request, leo, 'GET', `/api/library/${r.json.id}/download`)
    expect(got.headers['content-type']).toMatch(/^image\/png/)
    expect(got.headers['content-disposition']).toMatch(/^attachment;/)
  })

  test('filenames: control, bidi and path characters are dropped, a non-ASCII name falls back to ASCII with the full name in filename*, and a bad name is refused', async ({ request }) => {
    const messy = await upload(request, dana, `E2E ../evil\u202egnp ${run}.csv`, 'a,1\n')
    expect(messy.status, messy.text).toBe(201)
    expect(messy.json.name).toBe(`E2E ..evilgnp ${run}.csv`)
    const accent = await upload(request, dana, `résumé ${run}.csv`, 'a,1\n')
    expect(accent.status, accent.text).toBe(201)
    const got = await call(request, dana, 'GET', `/api/library/${accent.json.id}/download`)
    expect(got.headers['content-disposition']).toBe(`attachment; filename="r_sum_ ${run}.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9%20${run}.csv`)
    expect((await upload(request, dana, null, 'a,1\n')).status, 'no X-File-Name').toBe(400)
    expect((await upload(request, dana, 'x'.repeat(201) + '.csv', 'a,1\n')).status, '201 characters').toBe(400)
    expect((await upload(request, dana, '\u202e/\\', 'a,1\n')).status, 'nothing left after dropping').toBe(400)
    const broken = await call(request, dana, 'POST', '/api/library/uploads', { bytes: Buffer.from('a,1\n'), headers: { 'X-File-Name': '%E0%A4%A' } })
    expect(broken.status, 'not percent-encoded UTF-8').toBe(400)
  })

  test('refusals keep nothing: HTML named .pdf, an SVG, an empty file, a wrong or malformed hash', async ({ request }) => {
    const before = await ids(request, dana)
    const cases: [string, Reply][] = [
      ['html named pdf', await upload(request, dana, `E2E fake ${run}.pdf`, '<html><script>1</script></html>')],
      ['svg', await upload(request, dana, `E2E pic ${run}.svg`, '<svg onload="x"/>')],
      ['empty', await upload(request, dana, `E2E empty ${run}.csv`, '')],
      ['wrong sha256', await upload(request, dana, `E2E hash ${run}.csv`, 'a,1\n', { 'x-inhouse-sha256': '0'.repeat(64) })],
      ['malformed sha256', await upload(request, dana, `E2E hash2 ${run}.csv`, 'a,1\n', { 'x-inhouse-sha256': 'xyz' })],
    ]
    for (const [what, r] of cases) {
      expect(r.status, `${what}: ${r.text}`).toBe(400)
      expect(r.json.error.code, what).toBe('invalid')
    }
    expect(await ids(request, dana), 'a refusal leaves no row').toEqual(before)
  })

  test('a file over the 20 MiB cap by one byte is refused and nothing is kept', async ({ request }) => {
    // As attachments.spec.ts: wrangler dev's proxy drops the connection of a client still sending after an early refusal, so
    // only a deployed test build runs this; locally the library's own unit test proves the cap.
    test.skip(!process.env.E2E_TEST_BUILD_REMOTE, "wrangler dev's proxy drops an early refusal of a large body; covered by the library unit tests locally")
    const before = await ids(request, dana)
    const r = await upload(request, dana, `E2E big ${run}.csv`, Buffer.alloc(20 * 1024 * 1024 + 1, 0x61))
    expect(r.status, r.text.slice(0, 200)).toBe(400)
    expect(r.json.error.code).toBe('invalid')
    expect(await ids(request, dana)).toEqual(before)
  })

  test('delete and restore: a stale revision fails the whole batch and changes nothing; a deleted file leaves the list and the download and shows only in the trash', async ({ request }) => {
    const other = (await upload(request, leo, `E2E other ${run}.csv`, 'o,1\n')).json as File_
    // One unknown id fails the batch (404) and the known one stays as it was.
    expectError(await write(request, dana, 'delete', [{ id: csv.id, ifRev: 1 }, { id: NO_FILE, ifRev: 1 }]), 404, 'not_found')
    expect((await page(request, dana)).items.find(f => f.id === csv.id)?.rev).toBe(1)
    // A duplicate id, no id, and more than 100 are refused before anything changes.
    for (const items of [[{ id: csv.id, ifRev: 1 }, { id: csv.id, ifRev: 1 }], [], Array.from({ length: 101 }, () => ({ id: csv.id, ifRev: 1 }))]) {
      expect((await write(request, dana, 'delete', items)).status).toBe(400)
    }
    // A stale revision on one of two files: 409 with both as they are, and neither changed.
    const stale = await write(request, leo, 'delete', [{ id: csv.id, ifRev: 1 }, { id: other.id, ifRev: 7 }])
    const current = expectConflict(stale) as { items: File_[] }
    expect(current.items.map(f => [f.id, f.rev]).sort()).toEqual([[csv.id, 1], [other.id, 1]].sort())
    expect(await ids(request, dana)).toEqual(expect.arrayContaining([csv.id, other.id]))

    const gone = await write(request, leo, 'delete', [{ id: csv.id, ifRev: 1 }])
    expect(gone.status, gone.text).toBe(200)
    expect(gone.json.items[0]).toMatchObject({ id: csv.id, rev: 2 })
    expect(await ids(request, dana)).not.toContain(csv.id)
    const trash = (await allPages<File_>(request, dana, '/api/library?deleted=1', 100)).items.find(f => f.id === csv.id)
    expect(trash, 'the trash lists it').toMatchObject({ id: csv.id, rev: 2 })
    expect(trash?.text, 'the trash holds no contents').toBeUndefined()
    expectError(await call(request, dana, 'GET', `/api/library/${csv.id}/download`), 404, 'not_found')
    // Deleting it again with the old revision is a conflict, not a second delete.
    expectConflict(await write(request, dana, 'delete', [{ id: csv.id, ifRev: 1 }]))

    const back = await write(request, dana, 'restore', [{ id: csv.id, ifRev: 2 }])
    expect(back.status, back.text).toBe(200)
    expect(back.json.items[0]).toMatchObject({ id: csv.id, rev: 3 })
    expect(await ids(request, leo)).toContain(csv.id)
    expect((await call(request, leo, 'GET', `/api/library/${csv.id}/download`)).bytes.toString()).toBe(CSV)
    // A restore of a file that was never deleted is a no-op that answers the file as it is.
    const noop = await write(request, dana, 'restore', [{ id: other.id, ifRev: 1 }])
    expect(noop.status, noop.text).toBe(200)
    expect(noop.json.items[0]).toMatchObject({ id: other.id, rev: 1 })
    // Inhouse under a grant may delete and restore too (route patterns in PR0 #237); the delete is audited and Activity says who.
    expect((await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })).status).toBe(201)
    const byInhouse = await write(request, inhouse, 'delete', [{ id: other.id, ifRev: 1 }])
    expect(byInhouse.status, `a 503 here means support.access lacks the write pattern (PR0 #237): ${byInhouse.text}`).toBe(200)
    await endLiveGrants(request)
    expect((await write(request, dana, 'restore', [{ id: other.id, ifRev: 2 }])).status).toBe(200)
  })
})

test.describe('what a chat makes and what a person attaches', () => {
  test.describe.configure({ mode: 'serial', timeout: 600_000 })
  needsWatchBuild()
  let danaId: string

  test.beforeAll(async ({ request }) => {
    await endLiveGrants(request)
    danaId = (await me(request, dana)).memberId as string
  })
  test.afterAll(async ({ request }) => {
    await endLiveGrants(request)
  })

  test('a chat\'s attachment is never listed, served or deleted through the Library, by anyone else or by its owner', async ({ request }) => {
    const chat = `e2e-lib-${run}`
    const now = Date.now()
    writeSql('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, ?, ?, ?)', chat, danaId, 'Private attachment chat', now, now)
    const att = await call(request, dana, 'POST', `/api/chats/${chat}/attachments`, { bytes: Buffer.from('secret,1\n'), headers: { 'X-File-Name': encodeURIComponent(`E2E private ${run}.csv`) } })
    expect(att.status, att.text).toBe(201)
    const id = att.json.fileId as string
    for (const who of [dana, leo, admin]) {
      expect(await ids(request, who), 'an input is never listed').not.toContain(id)
      expectError(await call(request, who, 'GET', `/api/library/${id}/download`), 404, 'not_found')
      expectError(await write(request, who, 'delete', [{ id, ifRev: 1 }]), 404, 'not_found')
    }
    expectError(await call(request, leo, 'GET', `/api/files/${id}`), 404, 'not_found')
    expect((await call(request, dana, 'GET', `/api/files/${id}`)).bytes.toString(), 'the owner still has it through route 41').toBe('secret,1\n')
    writeSql('DELETE FROM chat_files WHERE chat_id = ?', chat)
    writeSql('DELETE FROM chats WHERE id = ?', chat)
  })

  test('an agent-made file is the team\'s: only its chat\'s owner sees the chat\'s title and link; a Library delete withdraws it from route 41 for everyone but the owner; restoring reopens it', async ({ request }) => {
    const chat = await createChat(request, dana, undefined, `E2E output chat ${run}`)
    const sent = await send(request, dana, chat, 'scenario:write-output save the table')
    await answerOf(request, dana, chat, sent.turnId)
    const files = await call(request, dana, 'GET', `/api/chats/${chat}/files`)
    expect(files.status, files.text).toBe(200)
    const output = (files.json.items as { fileId: string; kind: string; name: string }[]).find(f => f.kind === 'output' && f.name === 'table.csv')
    expect(output, 'the turn saved outputs/table.csv').toBeTruthy()
    const id = output!.fileId

    const own = (await page(request, dana)).items.find(f => f.id === id) ?? (await allPages<File_>(request, dana, '/api/library', 100)).items.find(f => f.id === id)
    expect(own).toMatchObject({ place: 'chats', from: `Chat: E2E output chat ${run}`, by: 'Inhouse agent', madeByAgent: true, link: { to: 'chat', id: chat } })
    for (const who of [leo, admin]) {
      const theirs = (await allPages<File_>(request, who, '/api/library', 100)).items.find(f => f.id === id)
      expect(theirs, 'listed to everyone').toMatchObject({ place: 'chats', from: 'From a chat by Dana Kim', madeByAgent: true })
      expect(theirs?.link, 'no link, no title for anyone but the owner').toBeUndefined()
      expect(JSON.stringify(theirs)).not.toContain('E2E output chat')
    }
    const viaLibrary = await call(request, leo, 'GET', `/api/library/${id}/download`)
    expect(viaLibrary.status, viaLibrary.text).toBe(200)
    expect(viaLibrary.bytes.toString()).toBe('sku,qty\nA1,3\n')
    expect((await call(request, leo, 'GET', `/api/files/${id}`)).status, 'route 41 serves an output to any person').toBe(200)

    const gone = await write(request, leo, 'delete', [{ id, ifRev: 1 }])
    expect(gone.status, gone.text).toBe(200)
    expectError(await call(request, leo, 'GET', `/api/files/${id}`), 404, 'not_found')
    expectError(await call(request, admin, 'GET', `/api/files/${id}`), 404, 'not_found')
    expect((await call(request, dana, 'GET', `/api/files/${id}`)).status, 'the owner still sees it in the chat').toBe(200)
    expectError(await call(request, dana, 'GET', `/api/library/${id}/download`), 404, 'not_found')
    const back = await write(request, dana, 'restore', [{ id, ifRev: gone.json.items[0].rev }])
    expect(back.status, back.text).toBe(200)
    expect((await call(request, leo, 'GET', `/api/files/${id}`)).status, 'a restore reopens it').toBe(200)
  })
})
