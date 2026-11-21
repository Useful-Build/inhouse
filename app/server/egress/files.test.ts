// The egress's files route (p3-design 8.5) on the real D1 and R2, and the scope property extended to files (acceptance
// 6). Ways it can fail, written down first:
//  1. a PUT outside `outputs/` is kept; a refused PUT (hash, type, size) keeps its slot or its row;
//  2. a pending output is listed or served before `confirm`;
//  3. chat A's token reads, lists or writes chat B's files, whatever path or header it sends;
//  4. a race for a turn's last slot gives two saves.
import { fc } from '@fast-check/vitest'
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { createRunTokens } from '../do/brand-agent/tokens.ts'
import { fileStore } from '../files-io/store.ts'
import { handleEgress } from './index.ts'
import { egressRequest, FakeEgressRpc, GRANT, harness } from './testing/harness.ts'

const db = env.DB
const files = fileStore({ db, bucket: env.FILES })
const enc = new TextEncoder()
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map(x => x.toString(16).padStart(2, '0')).join('')
let n = 0
const uniq = () => `${++n}-${Math.random().toString(36).slice(2, 8)}`

beforeAll(async () => {
  await db.prepare("INSERT OR IGNORE INTO members (id, kind, role, status, name, email_norm, created_at_ms) VALUES ('m_egress_files', 'person', 'member', 'active', 'Ada', 'egress-files@example.com', 1)").run()
})
const newChat = async () => {
  const id = `chat-${uniq()}`
  await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, 'm_egress_files', 'Files', 1, 1)").bind(id).run()
  return id
}
const setup = async () => {
  const grant = { ...GRANT, chatId: await newChat(), turnId: `t_${uniq()}` }
  const h = await harness({ files, bucket: env.FILES, newFileId: () => `f_e_${uniq()}` }, grant)
  return { grant, h }
}
const putFile = async (h: Awaited<ReturnType<typeof harness>>, path: string, body: string, hash?: string) =>
  handleEgress(egressRequest(`/files/${path}`, { method: 'PUT', body, headers: { 'x-inhouse-sha256': hash ?? (await sha(body)), 'content-type': 'text/csv' } }), h.deps)
const outputsOf = async (turnId: string) => (await db.prepare("SELECT COUNT(*) AS n FROM chat_files WHERE turn_id = ? AND kind = 'output'").bind(turnId).first<number>('n'))

describe('PUT (failure 1)', () => {
  it('only under outputs/; a wrong hash, a refused type or an oversized body frees its slot', async () => {
    const { grant, h } = await setup()
    expect((await putFile(h, 'inputs/x.csv', 'a,1\n')).status).toBe(403)
    expect((await putFile(h, 'outputs/t.csv', 'a,1\n', 'a'.repeat(64))).status).toBe(400)
    expect((await putFile(h, 'outputs/p.html', '<html><script>1</script>')).status).toBe(415)
    const big = 'x'.repeat(20_971_521)
    expect((await putFile(h, 'outputs/big.txt', big)).status).toBe(413)
    expect((await putFile(h, 'outputs/..%2Fescape.csv', 'a,1\n')).status).toBe(400)
    expect(await outputsOf(grant.turnId)).toBe(0)
    const ok = await putFile(h, 'outputs/sub%20dir/t%231.csv', 'a,1\n')
    expect(ok.status).toBe(400)
    const good = await putFile(h, 'outputs/sub%20dir/t1.csv', 'a,1\n')
    expect(good.status).toBe(201)
    expect(await good.json()).toEqual({ path: 'outputs/sub dir/t1.csv', bytes: 4, contentType: 'text/csv' })
    expect(await outputsOf(grant.turnId)).toBe(1)
  })
})

describe('an R2 write that fails (failure 1)', () => {
  it('answers 502 save_failed and frees the slot', async () => {
    const { grant, h } = await setup()
    h.deps.files = { ...files, putBytes: async () => { throw new Error('r2 down') } }
    const res = await putFile(h, 'outputs/z.csv', 'z,1\n')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'save_failed' })
    expect(await outputsOf(grant.turnId)).toBe(0)
  })
  it('a body without its declared length, or a length that lies, is refused and frees the slot', async () => {
    const { grant, h } = await setup()
    const sha1 = await sha('a,1\n')
    for (const headers of [{ 'content-length': '3' }, { 'content-length': '9' }]) {
      const res = await handleEgress(egressRequest('/files/outputs/l.csv', { method: 'PUT', body: 'a,1\n', headers: { 'x-inhouse-sha256': sha1, ...headers } }), h.deps)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'length_mismatch' })
    }
    expect(await outputsOf(grant.turnId)).toBe(0)
  })
})

describe('a streamed PUT (p3-design 8.5, a streamed size)', () => {
  const MiB3 = 3_145_728
  const SHA_3MIB_C = 'e5a3d280947668d629845cc4cba971906a04d63724069bb00bf3899ca547c603'
  const stream = (total: number) => {
    let at = 0
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (at >= total) return c.close()
        const len = Math.min(65_536, total - at)
        at += len
        c.enqueue(new Uint8Array(len).fill(0x63))
      },
    }, { highWaterMark: 0 })
  }
  const put = (h: Awaited<ReturnType<typeof harness>>, path: string, body: ReadableStream<Uint8Array>, declared: number, hash: string) =>
    // egressRequest's bodies are strings; a stream body goes on a copy of its request.
    handleEgress(new Request(egressRequest(`/files/${path}`, { method: 'PUT', headers: { 'x-inhouse-sha256': hash, 'content-length': String(declared) } }), { body }), h.deps)
  it('3 MiB: the row records the literal hash and size, pending; R2 holds the bytes with that checksum', async () => {
    const { grant, h } = await setup()
    const res = await put(h, 'outputs/big.csv', stream(MiB3), MiB3, SHA_3MIB_C)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ path: 'outputs/big.csv', bytes: MiB3, contentType: 'text/csv' })
    const row = await db.prepare("SELECT bytes, sha256, content_type, state, r2_key FROM chat_files WHERE turn_id = ? AND kind = 'output'").bind(grant.turnId).first<{ r2_key: string }>()
    expect(row).toMatchObject({ bytes: MiB3, sha256: SHA_3MIB_C, content_type: 'text/csv', state: 'pending' })
    const head = await env.FILES.head(row!.r2_key)
    expect(head?.size).toBe(MiB3)
    expect([...new Uint8Array(head!.checksums.sha256!)].map(x => x.toString(16).padStart(2, '0')).join('')).toBe(SHA_3MIB_C)
  })
  it('short, long or wrong-hash 3 MiB bodies: 400 with their code, the slot freed, nothing in R2', async () => {
    const { grant, h } = await setup()
    const cases: [ReadableStream<Uint8Array>, number, string, string][] = [
      [stream(MiB3 - 1), MiB3, SHA_3MIB_C, 'length_mismatch'],
      [stream(MiB3 + 1), MiB3, SHA_3MIB_C, 'length_mismatch'],
      [stream(MiB3), MiB3, 'b'.repeat(64), 'hash'],
    ]
    for (const [body, declared, hash, error] of cases) {
      const res = await put(h, 'outputs/big.csv', body, declared, hash)
      expect([res.status, await res.json()]).toEqual([400, { error }])
    }
    expect(await outputsOf(grant.turnId)).toBe(0)
    expect((await env.FILES.list({ prefix: `files/${grant.chatId}/` })).objects).toEqual([])
  })
})

describe('pending until confirm (failure 2)', () => {
  it('a saved output is listed and served only after confirm', async () => {
    const { grant, h } = await setup()
    await putFile(h, 'outputs/r.csv', 'q,9\n')
    const list = async () => (await handleEgress(egressRequest('/files/', { method: 'GET' }), h.deps)).json()
    expect(await list()).toEqual({ files: [] })
    expect((await handleEgress(egressRequest('/files/outputs/r.csv', { method: 'GET' }), h.deps)).status).toBe(404)
    await files.confirm(grant.chatId, grant.turnId, 'outputs/r.csv', await sha('q,9\n'), 5)
    expect(await list()).toEqual({ files: [{ path: 'outputs/r.csv', bytes: 4 }] })
    const got = await handleEgress(egressRequest('/files/outputs/r.csv', { method: 'GET' }), h.deps)
    expect(await got.text()).toBe('q,9\n')
    expect(got.headers.get('content-type')).toBe('text/csv')
  })
})

describe('the last slot (failure 4)', () => {
  it('two concurrent PUTs for the last of 20 slots: exactly one 201, the other 409', async () => {
    const { grant, h } = await setup()
    for (let i = 0; i < 19; i++) expect((await putFile(h, `outputs/${i}.csv`, `${i},1\n`)).status).toBe(201)
    const statuses = (await Promise.all([putFile(h, 'outputs/a.csv', 'a,1\n'), putFile(h, 'outputs/b.csv', 'b,1\n')])).map(r => r.status).sort()
    expect(statuses).toEqual([201, 409])
    expect(await outputsOf(grant.turnId)).toBe(20)
  })
})

describe('scope on the real run tokens, files too (failure 3, acceptance 6)', () => {
  it("chat A's token never reads, lists or writes chat B's files", async () => {
    await runInDurableObject(env.BRAND_AGENT.getByName('w3-files-scope'), async (_i, state) => {
      const now = 1_800_000_000_000
      const tokens = createRunTokens(state.storage.sql, () => now)
      const chatA = await newChat()
      const chatB = await newChat()
      const base = { runId: 'r_f', model: 'claude-sonnet-5-5', sideModel: 'claude-haiku-5-5', sessionId: GRANT.sessionId }
      const tokenA = await tokens.mint({ ...base, turnId: 't_fa', chatId: chatA, memberId: 'm_a' }, now)
      const tokenB = await tokens.mint({ ...base, turnId: 't_fb', chatId: chatB, memberId: 'm_b' }, now)
      const h = await harness({ files, bucket: env.FILES, rpc: new FakeEgressRpc(tokens, () => now), newFileId: () => `f_s_${uniq()}` })
      const marker = 'secret,of-b\n'
      expect((await handleEgress(egressRequest('/files/outputs/b.csv', { method: 'PUT', body: marker, token: tokenB, headers: { 'x-inhouse-sha256': await sha(marker) } }), h.deps)).status).toBe(201)
      await files.confirm(chatB, 't_fb', 'outputs/b.csv', await sha(marker), now)
      const rowsB = async () => (await db.prepare('SELECT * FROM chat_files WHERE chat_id = ? ORDER BY id').bind(chatB).all()).results
      const before = await rowsB()
      const op = fc.record({
        method: fc.constantFrom('GET', 'PUT'),
        path: fc.constantFrom('/files/', '/files/outputs/b.csv', `/files/${encodeURIComponent(`../${chatB}`)}/outputs/b.csv`, '/files/outputs/new.csv'),
        headers: fc.dictionary(fc.constantFrom('x-chat-id', 'x-inhouse-chat'), fc.constant(chatB)),
      })
      await fc.assert(fc.asyncProperty(fc.array(op, { maxLength: 6 }), async ops => {
        for (const o of ops) {
          const body = o.method === 'PUT' ? 'from,a\n' : undefined
          const headers = o.method === 'PUT' ? { ...o.headers, 'x-inhouse-sha256': await sha('from,a\n') } : o.headers
          const res = await handleEgress(egressRequest(o.path, { method: o.method, body, headers, token: tokenA }), h.deps)
          expect(await res.text()).not.toContain('of-b')
        }
        expect(await rowsB()).toEqual(before)
      }), { numRuns: 25 })
    })
  })
})
