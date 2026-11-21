// The chat files store (p3-design 8.5, 0120) on the real migrations, D1 and R2. Byte fixtures are written here, apart
// from the sniffer. Ways it can fail, written down first:
//  1. two PUTs racing for a turn's last output slot both get it, or a freed slot isn't free again;
//  2. a confirm with the wrong hash (or another turn's) saves something; a repeat or a retry after a lost reply saves
//     twice, or leaves two current rows for one path;
//  3. two uploads with one name overwrite each other;
//  4. HTML, SVG, an HTML polyglot, a truncated PNG or a bare zip is kept; a real docx, xlsx, PDF or CSV is refused;
//  5. a listing shows pending or superseded rows, or the wrong order.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { streamFile } from './bytes.ts'
import { fileStore } from './store.ts'

const db = env.DB
const files = fileStore({ db, bucket: env.FILES })
const enc = new TextEncoder()
const bytesOf = (s: string) => enc.encode(s) as Uint8Array<ArrayBuffer>
const sha = async (b: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x => x.toString(16).padStart(2, '0')).join('')
let n = 0
const uniq = () => `${++n}-${Math.random().toString(36).slice(2, 8)}`
const body = (b: Uint8Array<ArrayBuffer>) => new Request('https://files.test/', { method: 'POST', body: b, headers: { 'content-length': String(b.length) } })

beforeAll(async () => {
  await db.prepare("INSERT OR IGNORE INTO members (id, kind, role, status, name, email_norm, created_at_ms) VALUES ('m_files_owner', 'person', 'member', 'active', 'Ada', 'files-owner@example.com', 1)").run()
})
const newChat = async () => {
  const id = `chat-${uniq()}`
  await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, 'm_files_owner', 'Files', 1, 1)").bind(id).run()
  return id
}

/** A stored (uncompressed) zip of these entries: local file headers only, as the sniffer reads them. */
function zip(entries: [string, string][]): Uint8Array<ArrayBuffer> {
  const parts: number[] = []
  for (const [name, data] of entries) {
    const n = enc.encode(name)
    const d = enc.encode(data)
    const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff]
    const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
    parts.push(0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(d.length), ...u32(d.length), ...u16(n.length), ...u16(0), ...n, ...d)
  }
  return new Uint8Array(parts)
}

describe('byte fixtures (failure 4)', () => {
  const cases: [string, Uint8Array<ArrayBuffer>, string, string | null][] = [
    ['HTML', bytesOf('<!DOCTYPE html><html><script>alert(1)</script>'), 'page.txt.html', null],
    ['HTML named csv', bytesOf('<script>alert(1)</script>,a'), 'data.csv', null],
    ['SVG', bytesOf('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'pic.png', null],
    ['HTML with %PDF later', bytesOf('<html><body>%PDF-1.4</body></html>'), 'doc.pdf', null],
    ['PDF with HTML inside', bytesOf('%PDF-1.4\n<html><script>x</script></html>'), 'x.pdf', 'application/pdf'],
    ['truncated PNG magic', new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'a.png', null],
    ['PNG', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), 'a.bin', 'image/png'],
    ['docx', zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:document/>']]), 'report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['xlsx', zip([['[Content_Types].xml', '<Types/>'], ['xl/workbook.xml', '<workbook/>']]), 'sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['bare zip', zip([['a.txt', 'hi']]), 'a.zip', null],
    ['CSV', bytesOf('sku,qty\nA1,3\n'), 'table.csv', 'text/csv'],
    // Named .txt, HTML inside: kept as plain text (served with nosniff and the sandbox CSP, downloaded as notes.txt).
    ['HTML named .txt', bytesOf('<!DOCTYPE html><script>alert(1)</script>'), 'notes.txt', 'text/plain'],
    ['binary', new Uint8Array([1, 2, 0, 4]), 'blob.csv', null],
  ]
  for (const [name, bytes, file, expected] of cases) {
    it(`${name}: ${expected ?? 'refused'}`, async () => {
      const request = new Request('https://files.test/', { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.length) } })
      const r = await streamFile(request, file, { max: 20_971_520, put: body => new Response(body).arrayBuffer() })
      if (expected === null) expect(r).toEqual({ refused: 'type_not_allowed' })
      else expect(r).toEqual({ contentType: expected, sha256: await sha(bytes), bytes: bytes.length })
    })
  }
})

describe('output slots (failure 1)', () => {
  it('two PUTs racing for the last slot: exactly one gets it; a dropped slot is free again', async () => {
    const chatId = await newChat()
    const turnId = `t_${uniq()}`
    const slot = (i: number) => ({ id: `f_slot_${uniq()}_${i}`, chatId, turnId, path: `outputs/${i}.csv`, name: `${i}.csv`, r2Key: `files/${chatId}/${i}`, nowMs: i })
    for (let i = 0; i < 19; i++) expect(await files.reserveOutput(slot(i), 20)).toBe(true)
    const [a, b] = [slot(100), slot(101)]
    const won = await Promise.all([files.reserveOutput(a, 20), files.reserveOutput(b, 20)])
    expect(won.filter(Boolean)).toHaveLength(1)
    expect(await files.reserveOutput(slot(102), 20)).toBe(false)
    await files.dropOutput(won[0] ? a.id : b.id)
    expect(await files.reserveOutput(slot(103), 20)).toBe(true)
    const count = await db.prepare("SELECT COUNT(*) AS n FROM chat_files WHERE turn_id = ? AND kind = 'output'").bind(turnId).first<number>('n')
    expect(count).toBe(20)
  })
})

describe('confirm (failures 2, 5)', () => {
  const put = async (chatId: string, turnId: string, path: string, body: string, nowMs: number) => {
    const id = `f_c_${uniq()}`
    expect(await files.reserveOutput({ id, chatId, turnId, path, name: path.split('/').pop()!, r2Key: `files/${chatId}/${id}`, nowMs }, 20)).toBe(true)
    const h = await sha(bytesOf(body))
    await files.completeOutput(id, { contentType: 'text/csv', bytes: body.length, sha256: h })
    return { id, h }
  }
  it('the wrong hash or turn confirms nothing; the right one saves and supersedes; repeats change nothing', async () => {
    const chatId = await newChat()
    const first = await put(chatId, 't_1', 'outputs/t.csv', 'a,1\n', 10)
    expect(await files.listCurrent(chatId)).toEqual([])
    expect(await files.confirm(chatId, 't_1', 'outputs/t.csv', 'f'.repeat(64), 11)).toBeNull()
    expect(await files.confirm(chatId, 't_other', 'outputs/t.csv', first.h, 11)).toBeNull()
    expect(await files.listCurrent(chatId)).toEqual([])
    expect(await files.confirm(chatId, 't_1', 'outputs/t.csv', first.h, 12)).toMatchObject({ id: first.id, kind: 'output' })
    const second = await put(chatId, 't_2', 'outputs/t.csv', 'a,2\n', 20)
    const saved = await files.confirm(chatId, 't_2', 'outputs/t.csv', second.h, 21)
    expect(saved).toMatchObject({ id: second.id })
    // A retry after a lost reply: the same answer, nothing changed.
    const before = (await db.prepare('SELECT * FROM chat_files WHERE chat_id = ? ORDER BY id').bind(chatId).all()).results
    expect(await files.confirm(chatId, 't_2', 'outputs/t.csv', second.h, 99)).toEqual(saved)
    expect((await db.prepare('SELECT * FROM chat_files WHERE chat_id = ? ORDER BY id').bind(chatId).all()).results).toEqual(before)
    const rows = (await db.prepare('SELECT id, state, replaced_at_ms FROM chat_files WHERE chat_id = ? ORDER BY created_at_ms').bind(chatId).all()).results
    expect(rows).toEqual([{ id: first.id, state: 'saved', replaced_at_ms: 21 }, { id: second.id, state: 'saved', replaced_at_ms: null }])
    expect((await files.listCurrent(chatId)).map(f => f.id)).toEqual([second.id])
  })
})

describe('confirm after a retried PUT (one saved row, the duplicate slot freed)', () => {
  const put = async (chatId: string, turnId: string, path: string, body: string, nowMs: number) => {
    const id = `f_r_${uniq()}`
    expect(await files.reserveOutput({ id, chatId, turnId, path, name: path.split('/').pop()!, r2Key: `files/${chatId}/${id}`, nowMs }, 20)).toBe(true)
    await files.completeOutput(id, { contentType: 'text/csv', bytes: body.length, sha256: await sha(bytesOf(body)) })
    return id
  }
  const rows = async (chatId: string) => (await db.prepare('SELECT id, state FROM chat_files WHERE chat_id = ? ORDER BY created_at_ms').bind(chatId).all()).results
  it('two PUTs of one file, then confirm: the newest is saved, the other dropped; a repeat changes nothing', async () => {
    const chatId = await newChat()
    const a = await put(chatId, 't_r', 'outputs/x.csv', 'x,1\n', 1)
    const b = await put(chatId, 't_r', 'outputs/x.csv', 'x,1\n', 2)
    const h = await sha(bytesOf('x,1\n'))
    expect((await files.confirm(chatId, 't_r', 'outputs/x.csv', h, 3))?.id).toBe(b)
    expect(await rows(chatId)).toEqual([{ id: b, state: 'saved' }])
    expect((await files.confirm(chatId, 't_r', 'outputs/x.csv', h, 4))?.id).toBe(b)
    expect(await rows(chatId)).toEqual([{ id: b, state: 'saved' }])
    void a
  })
  it('a PUT retried after the confirm: confirm answers the saved row, drops the copy, frees its slot', async () => {
    const chatId = await newChat()
    const a = await put(chatId, 't_s', 'outputs/y.csv', 'y,1\n', 1)
    const h = await sha(bytesOf('y,1\n'))
    expect((await files.confirm(chatId, 't_s', 'outputs/y.csv', h, 2))?.id).toBe(a)
    await put(chatId, 't_s', 'outputs/y.csv', 'y,1\n', 3)
    expect((await files.confirm(chatId, 't_s', 'outputs/y.csv', h, 4))?.id).toBe(a)
    expect(await rows(chatId)).toEqual([{ id: a, state: 'saved' }])
    const replaced = await db.prepare('SELECT replaced_at_ms FROM chat_files WHERE id = ?').bind(a).first<number | null>('replaced_at_ms')
    expect(replaced).toBeNull()
  })
})

describe('uploads (failures 3, 5)', () => {
  it('two uploads with one name both survive; inputs list before outputs, newest first', async () => {
    const chatId = await newChat()
    const a = await files.saveInput({ chatId, name: 'notes.md', request: body(bytesOf('# one')), createdBy: 'm_files_owner', nowMs: 1 })
    const b = await files.saveInput({ chatId, name: 'notes.md', request: body(bytesOf('# two')), createdBy: 'm_files_owner', nowMs: 2 })
    if ('refused' in a || 'refused' in b) throw new Error('refused')
    expect(a.path).toBe(`inputs/${a.id}-notes.md`)
    expect(a.path).not.toBe(b.path)
    const out = `f_o_${uniq()}`
    await files.reserveOutput({ id: out, chatId, turnId: 't_u', path: 'outputs/r.csv', name: 'r.csv', r2Key: `files/${chatId}/${out}`, nowMs: 3 }, 20)
    const h = await sha(bytesOf('x,1\n'))
    await files.completeOutput(out, { contentType: 'text/csv', bytes: 4, sha256: h })
    await files.confirm(chatId, 't_u', 'outputs/r.csv', h, 4)
    expect((await files.listCurrent(chatId)).map(f => f.id)).toEqual([b.id, a.id, out])
    expect(await new Response(await files.readBytes(a)).text()).toBe('# one')
    expect(await new Response(await files.readBytes(b)).text()).toBe('# two')
    // An upload's hash is known only once its bytes are in: the row keeps it, R2 its own MD5 (single-part put).
    expect(a.sha256).toBe('440f87a565a26f2760a3506c12b2deb62d46bf97c1c4387526cf1db6237755b1')
    expect((await env.FILES.head(a.r2Key))?.checksums.md5).toBeDefined()
    // The rows, in the order asked.
    expect(await files.inputsOf(chatId, [b.id, a.id])).toEqual({ ok: true, files: [b, a] })
    expect(await files.inputsOf(chatId, [])).toEqual({ ok: true, files: [] })
    expect(await files.inputsOf(chatId, [a.id, out, 'f_missing'])).toEqual({ missing: [out, 'f_missing'] })
    // Another chat's input is not this chat's.
    const other = await newChat()
    const c = await files.saveInput({ chatId: other, name: 'c.md', request: body(bytesOf('# c')), createdBy: 'm_files_owner', nowMs: 6 })
    if ('refused' in c) throw new Error('refused')
    expect(await files.inputsOf(chatId, [a.id, c.id])).toEqual({ missing: [c.id] })
    expect(await files.saveInput({ chatId, name: 'x.html', request: body(bytesOf('<html>')), createdBy: 'm_files_owner', nowMs: 5 })).toEqual({ refused: 'type_not_allowed' })
  })
})
