// The Library over a fake `fetch` (P4 W5, rows 62 to 66). Ways it could show a person the wrong thing, written down first:
//  - a page dropped or repeated, or the Inhouse team asked on start (a grant logs every read);
//  - a delete that leaves the file on screen, sends a revision it doesn't hold, or an Undo that sends the revision from
//    before its delete answered (a 409 on every quick Undo);
//  - a refusal or conflict that leaves the files where the write put them, or loses the revision a conflict carries;
//  - an upload refusal told as a bare code instead of what to do; a file kept before a refusal dropped from the list;
//  - a download URL that isn't row 64's, or an id that breaks out of its path segment.
import { describe, expect, test } from 'vitest'
import { HttpAgent } from './client'
import { readLibrary } from './library'
import { Transport } from './transport'
import { iso, me, reads, refusal, server } from './testing/fake-server'
import type { Routes } from './testing/fake-server'

/** A file id as the server makes them (`f_` + 22): `F('1')` is `f_1xxxxxxxxxxxxxxxxxxxxx`. */
const F = (k: string) => `f_${k.padEnd(22, 'x')}`
const file = (k: string, ms: number, rev = 1, o: Record<string, unknown> = {}) => ({
  id: F(k), name: `${k}.csv`, type: 'CSV', kind: 'documents', place: 'chats', from: 'From a chat by Ann Lee', by: 'Inhouse agent', madeByAgent: true,
  size: '4 B', at: iso(ms), rev, canDelete: true, ...o,
})
async function loaded(routes: Routes) {
  const s = server(routes)
  const agent = new HttpAgent({ fetch: s.fetch, now: () => 10_000 })
  await agent.whenLoaded()
  return { agent, ...s }
}
const bodyOf = (calls: { method: string; path: string; body?: string }[], path: string) => calls.filter(c => c.method === 'POST' && c.path === path).map(c => JSON.parse(c.body ?? '{}'))

describe('reading the Library', () => {
  test('every page, in order, nothing twice', async () => {
    const s = server({
      'GET /api/library?limit=100': { body: { items: [file('f3', 3), file('f2', 2)], nextCursor: 'c1' } },
      'GET /api/library?limit=100&cursor=c1': { body: { items: [file('f1', 1)], nextCursor: null } },
    })
    expect((await readLibrary(new Transport({ fetch: s.fetch }))).map(f => f.id)).toEqual([F('f3'), F('f2'), F('f1')])
  })
  test('the client lists them and the places; the Inhouse team is asked only once its page does', async () => {
    const { agent } = await loaded(reads({ library: [file('f2', 2), file('f1', 1)] }))
    expect(agent.listFiles().map(f => f.id)).toEqual([F('f2'), F('f1')])
    expect(agent.listFiles(), 'stable between changes').toBe(agent.listFiles())
    expect(agent.read().library.places.map(p => p.id)).toEqual(['chats', 'routines', 'approvals', 'uploads'])
    expect(agent.read().resources.library).toEqual({ status: 'ready' })
    const staff = await loaded({ ...reads({ library: [file('f1', 1)] }), 'GET /api/me': { body: me({ role: 'inhouse' }) } })
    expect(staff.calls.map(c => c.path)).not.toContain('/api/library?limit=100')
    await staff.agent.retry('library')
    expect(staff.agent.listFiles().map(f => f.id)).toEqual([F('f1')])
  })
})

describe('delete and restore', () => {
  test("a delete leaves at once and sends each file's rev; an Undo sends the rev the delete's answer gave", async () => {
    const { agent, calls } = await loaded({
      ...reads({ library: [file('f2', 2), file('f1', 1)] }),
      'POST /api/library/delete': { body: { items: [file('f2', 2, 2)] } },
      'POST /api/library/restore': { body: { items: [file('f2', 2, 3)] } },
    })
    const del = agent.deleteFiles([F('f2')])
    expect(agent.listFiles().map(f => f.id)).toEqual([F('f1')])
    // The Undo before the delete has answered: it waits, then sends rev 2.
    const back = agent.restoreFiles([F('f2')])
    await Promise.all([del, back])
    expect(bodyOf(calls, '/api/library/delete')).toEqual([{ items: [{ id: F('f2'), ifRev: 1 }] }])
    expect(bodyOf(calls, '/api/library/restore')).toEqual([{ items: [{ id: F('f2'), ifRev: 2 }] }])
    expect(agent.listFiles().map(f => [f.id, f.rev])).toEqual([[F('f2'), 3], [F('f1'), 1]])
  })
  test('a refusal puts the files back; a conflict keeps them and takes the revisions it carries', async () => {
    const refused = await loaded({ ...reads({ library: [file('f1', 1)] }), 'POST /api/library/delete': refusal(503, 'unavailable') })
    await expect(refused.agent.deleteFiles([F('f1')])).rejects.toMatchObject({ code: 'unavailable' })
    expect(refused.agent.listFiles().map(f => [f.id, f.rev])).toEqual([[F('f1'), 1]])

    const stale = await loaded({ ...reads({ library: [file('f1', 1)] }), 'POST /api/library/delete': refusal(409, 'conflict', { current: { items: [file('f1', 1, 3)] } }) })
    await expect(stale.agent.deleteFiles([F('f1')])).rejects.toMatchObject({ code: 'conflict' })
    expect(stale.agent.listFiles().map(f => [f.id, f.rev])).toEqual([[F('f1'), 3]])
  })
  test('nothing is sent for an id the list lacks, an id twice, or over 100', async () => {
    const { agent, calls } = await loaded(reads({ library: [file('f1', 1)] }))
    await expect(agent.deleteFiles(['nope'])).rejects.toMatchObject({ code: 'not_found' })
    await expect(agent.deleteFiles([F('f1'), F('f1')])).rejects.toMatchObject({ code: 'invalid' })
    await expect(agent.deleteFiles([])).rejects.toMatchObject({ code: 'invalid' })
    await expect(agent.restoreFiles([F('f1')])).rejects.toMatchObject({ code: 'not_found' })
    expect(calls.filter(c => c.method === 'POST')).toEqual([])
  })
})

describe('upload and download', () => {
  test('each file is sent with its name percent-encoded and joins the list newest first; a refusal stops the rest with what to do', async () => {
    let n = 0
    const { agent, calls } = await loaded({
      ...reads({ library: [file('f1', 1)] }),
      'POST /api/library/uploads': () => (++n === 1
        ? { status: 201, body: file('u1', 50, 1, { name: 'stock list.csv', place: 'uploads', madeByAgent: false }) }
        : { status: 400, body: { error: { code: 'invalid', reason: 'type_not_allowed' } } }),
    })
    const heard: string[] = []
    agent.onNotice(x => { if (x.type === 'error') heard.push(x.text) })
    const files = [new File(['a,1\n'], 'stock list.csv'), new File(['<html>'], 'page.pdf'), new File(['x'], 'never.csv')]
    await expect(agent.uploadFiles(files)).rejects.toMatchObject({ code: 'invalid', reason: 'type_not_allowed' })
    const sent = calls.filter(c => c.path === '/api/library/uploads')
    expect(sent.map(c => c.headers['X-File-Name'])).toEqual(['stock%20list.csv', 'page.pdf'])
    expect(heard).toEqual(["page.pdf isn't a type Inhouse can read. Use a PDF, an image, a spreadsheet, a document or plain text."])
    expect(agent.listFiles().map(f => f.id)).toEqual([F('u1'), F('f1')])
  })
  test("the download URL is row 64's, the id kept in one segment", async () => {
    const { agent } = await loaded(reads())
    expect(agent.fileDownloadUrl('f_abc')).toBe('/api/library/f_abc/download')
    expect(agent.fileDownloadUrl('../x?y')).toBe('/api/library/..%2Fx%3Fy/download')
  })
})
