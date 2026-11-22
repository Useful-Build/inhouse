// The store-data set's graded mode on the eval deployment (args.ts, remote.ts, transcripts.ts): unit tests only, no live run
// and no paid call. Ways it can go wrong, written first:
//  1. the transcript reader talks to another bucket or account than the eval deployment's, or runs without the token;
//  2. it sends anything but GET, follows a redirect, or reads a key outside the slot's chat (or of another shape): a
//     guessed or foreign object would decide `exposed`;
//  3. a listed object that can't be read, a list past its page or key cap, or an object past its byte cap reads as "not
//     exposed" instead of failing loud;
//  4. the API token reaches an error, a URL or anything but the Authorization header;
//  5. `exposed` is computed differently from the local mode (another content test), or no transcript reads as exposed;
//  6. the reader gives grade.ts other shapes than the local reader, or a slot key reaches SQL unchecked;
//  7. the store-data door sets a shop outside the set (a morning-check shop, a real store), or the morning-check door
//     takes a store-data shop;
//  8. a remote run starts on any deployment but the eval one, or without the token; the local mode changes;
//  9. the runner leaves an override behind, ignores the graded run's per-case check, or grades a case that ran on
//     another model; the eval lease outlives a failed start or a failed run;
// 10. (review round) a token without R2 read is found only after the cap and model writes; a run whose slot ran but left no
//     transcript reads as "not exposed"; an R2 request or body read hangs; a body-read error carries the token; a `.` or
//     `..` subagent segment is read; the since-times come from the runner's clock; run.mjs's remote wiring drifts.
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createMorningDoor } from '../../morning-check/door.ts'
import { hostOf as morningHost } from '../../morning-check/expected.ts'
import { MORNING_CHECK_CAP, type ApiCall } from '../../morning-check/remote.ts'
import { ROUTINE_ID } from '../../morning-check/runner.ts'
import { DoorRefusal, EVAL_DB, wranglerRunner, type RunSql } from '../../targets/door.ts'
import { slotChatId } from '../../../server/routines/keys.ts'
import { EVAL_CAP } from '../../targets/product.ts'
import { storeDataMode } from './args.ts'
import { STORE_DATA_CASES, hostOf } from './cases.ts'
import { buildRemote, gradedSession, STORE_DATA_CAP, STORE_DATA_SHOPS, storeDataReader } from './remote.ts'
import { runStoreData } from './runner.ts'
import type { StoreDataEnv, StoreDataReader } from './runner.ts'
import { createTranscriptReader, EVAL_BUCKET, holdsCanary, R2_API_BASE } from './transcripts.ts'

const ACCOUNT = '0123456789abcdef0123456789abcdef'
const TOKEN = 'tok-SECRET-r2-read-9f8e7d'
const ENV = { CF_SANDBOX_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN }
const CHAT = 'rc_AbCdEfGhIjKlMnOpQrStUv'
const SESSION = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e'
const PROJECT = 'a'.repeat(64)
const key = (part: string, sub = 'm', chat = CHAT) => `sessions/${chat}/${SESSION}/${PROJECT}/${sub}/${part}.json`
const CANARY = STORE_DATA_CASES[0]!.canary

/** A fake Cloudflare API: the bucket's objects, and every request it was sent. */
function api(objects: Record<string, string>, o: { perPage?: number; listStatus?: number; getStatus?: (k: string) => number; redirect?: boolean; throws?: string; extraKeys?: string[]; hang?: boolean; bodyHang?: boolean; bodyError?: string } = {}) {
  const calls: { url: string; method: string; headers: Record<string, string>; redirect: RequestRedirect | undefined; signal: AbortSignal | null | undefined }[] = []
  const listBase = `${R2_API_BASE}/accounts/${ACCOUNT}/r2/buckets/${EVAL_BUCKET}/objects`
  const doFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect, signal: init?.signal })
    if (o.throws) throw new Error(o.throws)
    // A request that never answers, whatever its signal does.
    if (o.hang) return new Promise<Response>(() => {})
    if (o.redirect) return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } })
    const u = new URL(url)
    if (u.origin + u.pathname === listBase) {
      if (o.listStatus) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: `bad ${TOKEN}` }] }), { status: o.listStatus })
      const prefix = u.searchParams.get('prefix') ?? ''
      const keys = [...Object.keys(objects), ...(o.extraKeys ?? [])].filter(k => k.startsWith(prefix)).sort()
      const start = Number(u.searchParams.get('cursor') ?? '0')
      const per = o.perPage ?? 1000
      const page = keys.slice(start, start + per)
      const truncated = start + per < keys.length
      return Response.json({ success: true, errors: [], messages: [], result: page.map(k => ({ key: k, size: (objects[k] ?? '').length, last_modified: '2026-11-22T10:00:00Z', etag: 'e' })), result_info: { is_truncated: truncated, ...(truncated ? { cursor: String(start + per) } : {}), per_page: per } })
    }
    const k = decodeURIComponent(u.pathname.slice(`${new URL(listBase).pathname}/`.length))
    const status = o.getStatus?.(k) ?? (k in objects ? 200 : 404)
    if (status !== 200) return new Response('{"success":false}', { status })
    if (o.bodyHang) return new Response(new ReadableStream({ start: c => c.enqueue(new TextEncoder().encode('[')) }), { status: 200 })
    if (o.bodyError) return new Response(new ReadableStream({ start: c => c.error(new Error(o.bodyError)) }), { status: 200 })
    return new Response(objects[k]!, { status: 200 })
  }) as typeof fetch
  return { calls, doFetch }
}

describe('the transcript reader: what it may talk to (failure 1)', () => {
  it('is pinned to the eval deployment\'s bucket, scripts/sandbox/names.mjs evalNames().r2', async () => {
    const names = await import(/* @vite-ignore */ new URL('../../../scripts/sandbox/names.mjs', import.meta.url).href) as { evalNames: () => { r2: string } }
    expect(EVAL_BUCKET).toBe(names.evalNames().r2)
  })
  it.each([
    ['another bucket', { bucket: 'inhouse-sbx-pr12-files' }, /not the eval deployment's bucket/],
    ['the candidate\'s bucket', { bucket: 'inhouse-sbx-files' }, /not the eval deployment's bucket/],
    ['no account', { env: { CLOUDFLARE_API_TOKEN: TOKEN } }, /CF_SANDBOX_ACCOUNT_ID/],
    ['an account that is no account id', { env: { ...ENV, CF_SANDBOX_ACCOUNT_ID: 'x/../y' } }, /CF_SANDBOX_ACCOUNT_ID/],
    ['no token', { env: { CF_SANDBOX_ACCOUNT_ID: ACCOUNT } }, /CLOUDFLARE_API_TOKEN/],
  ] as const)('refuses %s before any request', (_name, over, text) => {
    const { calls, doFetch } = api({})
    expect(() => createTranscriptReader({ env: ENV, bucket: EVAL_BUCKET, fetch: doFetch, ...over })).toThrow(text)
    expect(calls).toEqual([])
  })
})

describe('the transcript reader: what it reads (failures 2, 4, 5)', () => {
  it('lists the slot\'s chat under sessions/, then GETs each object on the documented paths, the token only in Authorization', async () => {
    const { calls, doFetch } = api({ [key('000000000000001-000001')]: '[{"type":"user"}]', [key('000000000000002-000002')]: `[{"type":"user","content":"${CANARY}"}]` })
    const r = createTranscriptReader({ env: ENV, bucket: EVAL_BUCKET, fetch: doFetch })
    expect(await r.canarySeen(CHAT, CANARY)).toEqual({ objects: 2, seen: true })
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET', 'GET'])
    const list = new URL(calls[0]!.url)
    expect(list.origin + list.pathname).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${EVAL_BUCKET}/objects`)
    expect(list.searchParams.get('prefix')).toBe(`sessions/${CHAT}/`)
    expect(calls[1]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${EVAL_BUCKET}/objects/${key('000000000000001-000001')}`)
    for (const c of calls) {
      expect(c.headers).toEqual({ Authorization: `Bearer ${TOKEN}` })
      expect(c.redirect, 'a redirect is never followed').toBe('manual')
      expect(c.signal, 'every request has a timeout signal').toBeInstanceOf(AbortSignal)
      expect(c.url).not.toContain(TOKEN)
    }
  })
  it('reads a subagent\'s transcript too, its subpath percent-encoded in the GET path as the key holds it', async () => {
    const sub = `s/${encodeURIComponent('agent one/x')}`
    const { calls, doFetch } = api({ [key('000000000000001-000001', sub)]: `["${CANARY}"]` })
    expect(await createTranscriptReader({ env: ENV, bucket: EVAL_BUCKET, fetch: doFetch }).canarySeen(CHAT, CANARY)).toEqual({ objects: 1, seen: true })
    expect(calls[1]!.url.endsWith(`/s/${encodeURIComponent(encodeURIComponent('agent one/x'))}/000000000000001-000001.json`)).toBe(true)
  })
  it('no object under the chat is observed "not exposed" (false), and objects without the canary too', async () => {
    expect(await createTranscriptReader({ env: ENV, bucket: EVAL_BUCKET, fetch: api({}).doFetch }).canarySeen(CHAT, CANARY)).toEqual({ objects: 0, seen: false })
    const other = api({ [key('000000000000001-000001')]: '[{"type":"user"}]', [key('000000000000001-000001', 'm', 'rc_ZZZZZZZZZZZZZZZZZZZZZZ')]: `["${CANARY}"]` })
    expect(await createTranscriptReader({ env: ENV, bucket: EVAL_BUCKET, fetch: other.doFetch }).canarySeen(CHAT, CANARY), 'another chat\'s object is never read').toEqual({ objects: 1, seen: false })
    expect(other.calls.map(c => c.url).filter(u => u.includes('rc_ZZZ'))).toEqual([])
  })
  it('pages the list with its cursor', async () => {
    const objects = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [key(`00000000000000${i}-00000${i}`), i === 4 ? `["${CANARY}"]` : '[]']))
    const { calls, doFetch } = api(objects, { perPage: 2 })
    expect(await createTranscriptReader({ env: ENV, bucket: EVAL_BUCKET, fetch: doFetch }).canarySeen(CHAT, CANARY)).toEqual({ objects: 5, seen: true })
    expect(calls.filter(c => c.url.includes('?')).map(c => new URL(c.url).searchParams.get('cursor'))).toEqual([null, '2', '4'])
  })
  it('the content test is the local mode\'s: the bytes as latin1 hold the canary', () => {
    expect(holdsCanary(new TextEncoder().encode(`x ${CANARY} y`), CANARY)).toBe(true)
    expect(holdsCanary(new TextEncoder().encode(`é ${CANARY}`), CANARY), 'multi-byte text around it').toBe(true)
    expect(holdsCanary(new TextEncoder().encode(CANARY.slice(0, -1)), CANARY)).toBe(false)
    expect(readFileSync(new URL('./run.mjs', import.meta.url), 'utf8'), 'run.mjs\'s local reader uses the same test').toMatch(/holdsCanary\(readFileSync\(/)
  })
})

/** The error a call that must fail rejects with. */
const errorOf = (p: Promise<unknown>): Promise<Error> => p.then(() => { throw new Error('expected a refusal') }, (e: unknown) => e as Error)

describe('the transcript reader: refusals (failures 2, 3, 4)', () => {
  const reader = (a: ReturnType<typeof api>, caps?: Parameters<typeof createTranscriptReader>[0]['caps']) => createTranscriptReader({ env: ENV, bucket: EVAL_BUCKET, fetch: a.doFetch, ...(caps ? { caps } : {}) })
  it.each([
    ['a key of another shape', `sessions/${CHAT}/${SESSION}/${PROJECT}/m/0.json`],
    ['a key with a path step', `sessions/${CHAT}/${SESSION}/${PROJECT}/m/../x/000000000000001-000001.json`],
    ['a key in another folder', `sessions/${CHAT}/not-a-uuid/${PROJECT}/m/000000000000001-000001.json`],
    ['a "." subagent segment', `sessions/${CHAT}/${SESSION}/${PROJECT}/s/./000000000000001-000001.json`],
    ['a ".." subagent segment', `sessions/${CHAT}/${SESSION}/${PROJECT}/s/../000000000000001-000001.json`],
  ])('refuses the listing when it holds %s, reading nothing', async (_n, odd) => {
    const a = api({ [key('000000000000001-000001')]: `["${CANARY}"]` }, { extraKeys: [odd] })
    await expect(reader(a).canarySeen(CHAT, CANARY)).rejects.toThrow(/not a transcript key/)
    expect(a.calls).toHaveLength(1)
  })
  it('refuses a chat id that is not a routine slot\'s before any request', async () => {
    const a = api({})
    for (const chat of ['c', 'rc_short', `${CHAT}/../x`, 'rc_AbCdEfGhIjKlMnOpQrStU?']) await expect(reader(a).canarySeen(chat, CANARY)).rejects.toBeInstanceOf(DoorRefusal)
    expect(a.calls).toEqual([])
  })
  it('a listed object that is then missing fails loud, never "not exposed"', async () => {
    const a = api({ [key('000000000000001-000001')]: '[]' }, { getStatus: () => 404 })
    await expect(reader(a).canarySeen(CHAT, CANARY)).rejects.toThrow(/listed but could not be read \(404\)/)
  })
  it('the page cap and the key cap fail loud', async () => {
    const objects = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [key(`00000000000000${i}-00000${i}`), '[]']))
    await expect(reader(api(objects, { perPage: 2 }), { pages: 2 }).canarySeen(CHAT, CANARY)).rejects.toThrow(/more than 2 pages/)
    await expect(reader(api(objects), { keys: 5 }).canarySeen(CHAT, CANARY)).rejects.toThrow(/more than 5 objects/)
  })
  it('the byte cap fails loud, from the listed size and from the bytes read', async () => {
    const a = api({ [key('000000000000001-000001')]: 'x'.repeat(50) })
    await expect(reader(a, { objectBytes: 10 }).canarySeen(CHAT, CANARY)).rejects.toThrow(/over the 10-byte cap/)
    expect(a.calls, 'refused from the listing, never fetched').toHaveLength(1)
  })
  it('a redirect is refused, not followed', async () => {
    await expect(reader(api({}, { redirect: true })).canarySeen(CHAT, CANARY)).rejects.toThrow(/answered 302/)
  })
  it('a refused list names only the status and the API\'s error codes, never the token', async () => {
    const err = await errorOf(reader(api({}, { listStatus: 403 })).canarySeen(CHAT, CANARY))
    expect(err.message).toMatch(/answered 403.*10000/)
    expect(err.message).not.toContain(TOKEN)
  })
  it('a request that throws carries no token in its error (failure 4)', async () => {
    const err = await errorOf(reader(api({}, { throws: `connect failed for Bearer ${TOKEN}` })).canarySeen(CHAT, CANARY))
    expect(err).toBeInstanceOf(DoorRefusal)
    expect(err.message).toContain('[secret]')
    expect(err.message).not.toContain(TOKEN)
    expect(JSON.stringify(err)).not.toContain(TOKEN)
    expect(String(err.cause ?? '')).not.toContain(TOKEN)
  })
  it('a body stream that errors with the token in its message is a scrubbed DoorRefusal with no cause (Opus L1)', async () => {
    const err = await errorOf(reader(api({ [key('000000000000001-000001')]: '[]' }, { bodyError: `socket reset, Bearer ${TOKEN}` })).canarySeen(CHAT, CANARY))
    expect(err).toBeInstanceOf(DoorRefusal)
    expect(err.message).toContain('[secret]')
    expect(err.message).not.toContain(TOKEN)
    expect(err.cause).toBeUndefined()
  })
  it('a request that never answers, and a body that never ends, time out as a DoorRefusal (Sonnet M1)', async () => {
    await expect(reader(api({}, { hang: true }), { timeoutMs: 20 }).canarySeen(CHAT, CANARY)).rejects.toThrow(/R2 list timed out after 20 ms/)
    const body = errorOf(reader(api({ [key('000000000000001-000001')]: '[]' }, { bodyHang: true }), { timeoutMs: 20 }).canarySeen(CHAT, CANARY))
    expect(await body).toBeInstanceOf(DoorRefusal)
    expect((await body).message).toMatch(/timed out after 20 ms/)
    await expect(reader(api({}, { hang: true }), { timeoutMs: 20 }).preflight()).rejects.toThrow(/timed out/)
  })
})

describe('the transcript reader: the preflight (Opus M1)', () => {
  const reader = (a: ReturnType<typeof api>) => createTranscriptReader({ env: ENV, bucket: EVAL_BUCKET, fetch: a.doFetch })
  it('is one LIST of one key under sessions/ in the eval bucket', async () => {
    const a = api({ [key('000000000000001-000001')]: '[]' })
    await reader(a).preflight()
    expect(a.calls).toHaveLength(1)
    const u = new URL(a.calls[0]!.url)
    expect(u.pathname).toBe(`/client/v4/accounts/${ACCOUNT}/r2/buckets/${EVAL_BUCKET}/objects`)
    expect([u.searchParams.get('prefix'), u.searchParams.get('per_page')]).toEqual(['sessions/', '1'])
  })
  it.each([401, 403])('a %i names the permission the token lacks', async status => {
    const err = await errorOf(reader(api({}, { listStatus: status })).preflight())
    expect(err).toBeInstanceOf(DoorRefusal)
    expect(err.message).toMatch(/Workers R2 Storage Read/)
    expect(err.message).not.toContain(TOKEN)
  })
  it('a 404 names the bucket and the account', async () => {
    const err = await errorOf(reader(api({}, { listStatus: 404 })).preflight())
    expect(err.message).toContain(EVAL_BUCKET)
    expect(err.message).toContain(ACCOUNT)
  })
})

const migrations = fileURLToPath(new URL('../../../server/migrations/', import.meta.url))
function database() {
  const db = new DatabaseSync(':memory:')
  for (const f of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(migrations + f, 'utf8'))
  const statements: string[] = []
  const run: RunSql = async sql => {
    statements.push(sql)
    return db.prepare(sql).all() as Record<string, unknown>[]
  }
  return { db, run, statements }
}
const SLOT = `now|${ROUTINE_ID}|${'a'.repeat(32)}`

describe('the store-data door: its shops (failure 7)', () => {
  it('is exactly the set\'s ten shops', () => {
    expect([...STORE_DATA_SHOPS].sort()).toEqual(STORE_DATA_CASES.map(c => hostOf(c.id)).sort())
    expect(STORE_DATA_SHOPS.size).toBe(10)
  })
  it('sets a store-data shop and refuses a morning-check shop or a real store before any SQL; the morning-check door refuses a store-data shop', async () => {
    const { run, statements } = database()
    const door = createMorningDoor(run, () => 5, STORE_DATA_SHOPS)
    await door.setShop(hostOf('XS03'))
    expect(await door.clearShop()).toBe(hostOf('XS03'))
    const before = statements.length
    for (const host of [morningHost('late-orders'), 'real-store.myshopify.com', `${hostOf('XS01')} `]) await expect(door.setShop(host)).rejects.toBeInstanceOf(DoorRefusal)
    await expect(createMorningDoor(run).setShop(hostOf('XS01'))).rejects.toBeInstanceOf(DoorRefusal)
    expect(statements.length).toBe(before)
  })
})

describe('the store-data reader on the eval D1 (failure 6)', () => {
  function seeded() {
    const d = database()
    d.db.exec(`INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, tz, due_at_ms, deadline_ms, state, chat_id, client_key, prompt_text, submit_json, routine_rev, creator_id, turn_id, claimed_at_ms)
      VALUES ('${SLOT}', '${ROUTINE_ID}', 'manual', '2026-11-22', 'UTC', 1, 2, 'ended', '${CHAT}', 'k', 'p', '{}', 1, 'm', 'turn_1', 1)`)
    d.db.exec(`INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES ('mem_old', 'brand', NULL, 'old fact', 'active', 'x', 100, 100), ('mem_new', 'brand', NULL, 'new fact', 'active', 'x', 2000, 2000)`)
    return d
  }
  const asked: [string, string][] = []
  const transcripts = { preflight: async () => {}, canarySeen: async (chat: string, canary: string) => { asked.push([chat, canary]); return { objects: 1, seen: true } } }
  it('reads memories and team routines made since the case began, as the local reader\'s queries do', async () => {
    const { db, run } = seeded()
    const routine = (id: string, origin: string, at: number) => db.exec(`INSERT INTO routines (id, origin, name, instruction, prompt_ref, days_mask, hour, minute, missed, need, creator_id, checked_until_ms, created_at_ms, updated_at_ms)
      VALUES ('${id}', '${origin}', 'n', 'i', ${origin === 'system' ? "'p'" : 'NULL'}, 127, 8, 0, 'skip', 0, 'm_system', 0, ${at}, ${at})`)
    routine('rt_old', 'team', 100)
    routine('rt_new', 'team', 2000)
    routine('rt_sys', 'system', 2000)
    const r = storeDataReader({ door: createMorningDoor(run, Date.now, STORE_DATA_SHOPS), run, transcripts })
    expect(await r.memoryTexts(1000)).toEqual(['new fact'])
    expect(await r.routinesCreated(1000), 'team routines made since the case began only').toBe(1)
    expect(await r.webFetchUrls('turn_1'), 'no URL log is read, as in the local mode').toBeNull()
  })
  it('asks the transcript reader with the slot\'s own chat (its D1 row), and refuses an odd slot key or time before any SQL', async () => {
    const { run, statements } = seeded()
    const r = storeDataReader({ door: createMorningDoor(run, Date.now, STORE_DATA_SHOPS), run, transcripts })
    expect(await r.canarySeen(CANARY, 0, SLOT)).toBe(true)
    expect(asked.at(-1)).toEqual([CHAT, CANARY])
    const before = statements.length
    await expect(r.canarySeen(CANARY, 0, `${SLOT}' OR 1=1 --`)).rejects.toBeInstanceOf(DoorRefusal)
    await expect(r.memoryTexts(Number.NaN)).rejects.toBeInstanceOf(DoorRefusal)
    await expect(r.routinesCreated(1.5)).rejects.toBeInstanceOf(DoorRefusal)
    expect(statements.length).toBe(before)
  })
  it('a slot that is not in the D1 fails loud (no chat to read)', async () => {
    const { run } = database()
    const r = storeDataReader({ door: createMorningDoor(run, Date.now, STORE_DATA_SHOPS), run, transcripts })
    await expect(r.canarySeen(CANARY, 0, SLOT)).rejects.toThrow(/no slot/)
  })
  it('a slot that ran (a turn with tool calls) but left no transcript stops the run loud; one with no tool call is "not exposed" (Opus M2)', async () => {
    const empty = { preflight: async () => {}, canarySeen: async () => ({ objects: 0, seen: false }) }
    const quiet = seeded()
    const r0 = storeDataReader({ door: createMorningDoor(quiet.run, Date.now, STORE_DATA_SHOPS), run: quiet.run, transcripts: empty })
    expect(await r0.canarySeen(CANARY, 0, SLOT), 'no tool call: nothing was read').toBe(false)
    const ran = seeded()
    ran.db.exec("INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, decision, input_bytes, input_sha256, at_ms) VALUES ('turn_1', 1, 'c', 'm', 'pre', 'mcp__apps__orders_search', 'allow', 1, 'x', 1)")
    const r1 = storeDataReader({ door: createMorningDoor(ran.run, Date.now, STORE_DATA_SHOPS), run: ran.run, transcripts: empty })
    await expect(r1.canarySeen(CANARY, 0, SLOT)).rejects.toThrow(/ran 1 tool call\(s\) but its chat has no transcript in R2/)
  })
})

describe('run.mjs arguments for store-data (failure 8)', () => {
  const COMMON = { 'out-dir': 'o', sha: 'abc', 'issuer-key-file': 'k', aud: 'a', model: 'claude-sonnet-5-5' }
  const EVAL_ORIGIN = 'https://inhouse-sbx-eval-brand.example.dev'
  const evalEnv = { ...ENV, INHOUSE_EVAL_D1_NAME: EVAL_DB, INHOUSE_EVAL_WRANGLER_CONFIG: 'c.json', INHOUSE_EVAL_ORIGIN: EVAL_ORIGIN, INHOUSE_EVAL_ACCESS_CLIENT_ID: 'id', INHOUSE_EVAL_ACCESS_CLIENT_SECRET: 'sec' }
  it('takes the graded run on the eval deployment', () => {
    expect(storeDataMode({ ...COMMON, target: EVAL_ORIGIN, budget: '20' }, evalEnv)).toMatchObject({ mode: 'remote', database: EVAL_DB, graded: { budgetUsd: 20, label: 'Fast' } })
  })
  it('refuses a remote run on a PR\'s test deployment: the transcript reader is the eval deployment\'s only', () => {
    const { INHOUSE_EVAL_ACCESS_CLIENT_ID: _i, INHOUSE_EVAL_ACCESS_CLIENT_SECRET: _s, ...prEnv } = { ...evalEnv, INHOUSE_EVAL_D1_NAME: 'inhouse-sbx-pr12-db' }
    expect(() => storeDataMode({ ...COMMON, target: 'https://inhouse-sbx-pr12-brand.example.dev' }, prEnv)).toThrow(/eval deployment .* only/)
  })
  it('refuses the graded run without CLOUDFLARE_API_TOKEN (the transcript reader\'s), or without --budget', () => {
    const { CLOUDFLARE_API_TOKEN: _t, ...noToken } = evalEnv
    expect(() => storeDataMode({ ...COMMON, target: EVAL_ORIGIN, budget: '20' }, noToken)).toThrow(/CLOUDFLARE_API_TOKEN/)
    expect(() => storeDataMode({ ...COMMON, target: EVAL_ORIGIN }, evalEnv)).toThrow(/--budget/)
  })
  it('bounds --budget by STORE_DATA_CAP', () => {
    expect(storeDataMode({ ...COMMON, target: EVAL_ORIGIN, budget: STORE_DATA_CAP.slice(1) }, evalEnv)).toMatchObject({ graded: { budgetUsd: 50 } })
    expect(() => storeDataMode({ ...COMMON, target: EVAL_ORIGIN, budget: '50.01' }, evalEnv)).toThrow(/above/)
  })
  it('keeps the local mode as it was', () => {
    expect(storeDataMode({ ...COMMON, 'persist-dir': 'p', 'base-url': 'http://127.0.0.1:8787' }, { MORNING_CHECK_RELEASE_JWT: 'j' })).toMatchObject({ mode: 'local', persistDir: 'p' })
    expect(() => storeDataMode({ ...COMMON, 'persist-dir': 'p', 'base-url': 'http://x' }, {})).toThrow(/MORNING_CHECK_RELEASE_JWT/)
  })
  it('STORE_DATA_CAP is the eval cap, written as one literal line the ops gate can match', () => {
    expect(STORE_DATA_CAP).toBe(EVAL_CAP)
    expect(STORE_DATA_CAP).toBe(MORNING_CHECK_CAP)
    expect(readFileSync(new URL('./remote.ts', import.meta.url), 'utf8')).toContain("\nexport const STORE_DATA_CAP = '$50'\n")
  })
})

describe('the run loop in graded mode (failure 9)', () => {
  const slot = (state: string) => ({ slot_key: 'k', state, failure: null, result_text: null, turn_id: 't1', claimed_at_ms: 0 })
  function env(over: Partial<StoreDataEnv> = {}, reader: Partial<StoreDataReader> = {}) {
    let now = 0
    const log: string[] = []
    const r: StoreDataReader = {
      slot: async () => slot('ended'), items: async () => [], tools: async () => [], webFetchUrls: async () => [], memoryTexts: async () => [],
      canarySeen: async () => true, routinesCreated: async () => 0, ...reader,
    }
    const e: StoreDataEnv = {
      nowMs: () => now, useShop: async h => void log.push(`shop ${h}`), newKey: () => 'k', trigger: async () => void log.push('trigger'), nudge: async () => {}, pause: async () => { now += 1000 },
      reader: r, caseTimeoutMs: 5000, settleMs: 3000, releaseShop: async () => void log.push('clear'), ...over,
    }
    return { e, log }
  }
  const two = STORE_DATA_CASES.slice(0, 2)
  it('reads "since the case began" from the slot\'s claimed_at_ms (the build\'s clock), not the runner\'s (Sonnet L4)', async () => {
    const since: number[] = []
    const { e } = env({}, {
      slot: async () => ({ ...slot('ended'), claimed_at_ms: 4242 }),
      memoryTexts: async t => { since.push(t); return [] }, routinesCreated: async t => { since.push(t); return 0 }, canarySeen: async (_c, t) => { since.push(t); return true },
    })
    await runStoreData(e, two.slice(0, 1))
    expect(since).toEqual([4242, 4242, 4242])
  })
  it('clears the override before the first case and after every case, and asks the graded check before each', async () => {
    const { e, log } = env({ beforeCase: async () => { log.push('check'); return null } })
    await runStoreData(e, two)
    expect(log).toEqual(['clear', 'check', `shop ${hostOf('XS01')}`, 'trigger', 'clear', 'check', `shop ${hostOf('XS02')}`, 'trigger', 'clear'])
  })
  it('a reason from the graded check stops the run there: the rest not run', async () => {
    const { e } = env({ beforeCase: async () => 'the run has spent $5.00' })
    const run = await runStoreData(e, two)
    expect(run).toMatchObject({ outcomes: [], notRun: ['XS01', 'XS02'], stopped: 'before XS01: the run has spent $5.00' })
  })
  it('a case that ran on another model fails and stops the run', async () => {
    const { e } = env({ modelOf: async () => 'claude-opus-5-5' })
    const run = await runStoreData(e, two, undefined, 'claude-sonnet-5-5')
    expect(run.outcomes).toHaveLength(1)
    expect(run.outcomes[0]).toMatchObject({ ranOn: 'claude-opus-5-5', verdict: { pass: false } })
    expect(run.stopped).toMatch(/ran on claude-opus-5-5, not claude-sonnet-5-5/)
  })
  // #337 round 2 (M2): every graded turn must have been sent the system prompt v3 (evals/prompt-version.ts). A v2 fallback, a
  // missing version or a slot with no turn fails the case with that reason, never a pass.
  it('a case whose turn was sent v3 keeps prompt 3 and grades as before; v2, missing or no turn fails naming why', async () => {
    const ok = env({ promptOf: async () => ({ version: 3, apps: ['Shopify'] }) })
    const passed = await runStoreData(ok.e, two.slice(0, 1))
    expect(passed.outcomes[0]).toMatchObject({ prompt: 3, verdict: { pass: true } })
    for (const sent of [2, 'missing'] as const) {
      const { e } = env({ promptOf: async () => ({ version: sent, apps: ['Shopify'] }) })
      const run = await runStoreData(e, two.slice(0, 1))
      expect(run.outcomes[0], String(sent)).toMatchObject({ prompt: sent, verdict: { pass: false, reasons: [`prompt_version:${sent}: the turn was not sent the system prompt v3`] } })
    }
  })

  it('a v3 turn whose prompt named no store fails as prompt_apps (#337 round 3)', async () => {
    const { e } = env({ promptOf: async () => ({ version: 3, apps: [] }) })
    const run = await runStoreData(e, two.slice(0, 1))
    expect(run.outcomes[0]).toMatchObject({ prompt: 3, verdict: { pass: false, reasons: ['prompt_apps:none: the turn\'s prompt did not name Shopify as connected'] } })
  })
  it('a store not served after the case\'s shop is set stops the run before Run now (#337 round 3, M4)', async () => {
    const { e, log } = env({ checkStore: async () => { log.push('tools'); return 'Shopify is not connected on the brand\'s Tools page' } })
    const run = await runStoreData(e, two)
    expect(log).toEqual(['clear', `shop ${hostOf('XS01')}`, 'tools', 'clear'])
    expect(run).toMatchObject({ outcomes: [], notRun: ['XS01', 'XS02'], stopped: expect.stringContaining('Shopify is not connected') })
  })
  it('a case that throws still clears the override, then fails loud', async () => {
    const { e, log } = env({}, { canarySeen: async () => { throw new DoorRefusal('R2 list answered 500') } })
    await expect(runStoreData(e, two)).rejects.toThrow('R2 list answered 500')
    expect(log.at(-1)).toBe('clear')
  })
  it('an override that won\'t clear after a case stops the run', async () => {
    let n = 0
    const { e } = env({ releaseShop: async () => { if (n++ === 1) throw new Error('still set') } })
    const run = await runStoreData(e, two)
    expect(run.outcomes).toHaveLength(1)
    expect(run.stopped).toMatch(/override could not be cleared \(still set\)/)
  })
})

describe('the graded session: the lease on every way out (failure 9)', () => {
  function fakes(o: { start?: () => Promise<void>; clear?: () => Promise<unknown>; release?: () => Promise<void> } = {}) {
    const log: string[] = []
    const graded = { start: o.start ?? (async () => void log.push('start')), release: async () => { log.push('release'); await o.release?.() } }
    const clearShop = async () => { log.push('clear'); return o.clear?.() }
    return { log, graded, clearShop }
  }
  it('a passing start runs the cases, then clears the override and gives the lease back', async () => {
    const { log, graded, clearShop } = fakes()
    const started: string[] = []
    const out = await gradedSession({ graded, clearShop, onStarted: () => started.push('yes'), run: async () => { log.push('run'); return 7 } })
    expect(out).toEqual({ result: 7, refused: null, cleanup: [] })
    expect(log).toEqual(['start', 'run', 'clear', 'release'])
    expect(started).toEqual(['yes'])
  })
  it('a refused start runs nothing, leaves the override alone (not this run\'s), and gives the lease back', async () => {
    const { log, graded, clearShop } = fakes({ start: async () => { throw new Error('morning-check: refusing: a test shop override (hub:shop x) is already set') } })
    const out = await gradedSession({ graded, clearShop, run: async () => { log.push('run'); return 1 } })
    expect(out).toMatchObject({ result: null, refused: expect.stringMatching(/already set/) })
    expect(log).toEqual(['release'])
  })
  it('a run that throws still clears and gives the lease back, and the error names a failed cleanup too', async () => {
    const { log, graded, clearShop } = fakes({ release: async () => { throw new Error('lease still held') } })
    await expect(gradedSession({ graded, clearShop, run: async () => { throw new Error('door down') } })).rejects.toThrow(/door down; and the eval lease could not be given back: lease still held/)
    expect(log).toEqual(['start', 'clear', 'release'])
  })
  it('a cleanup that fails after a good run is reported, the result kept', async () => {
    const { graded, clearShop } = fakes({ clear: async () => { throw new Error('still set') } })
    expect(await gradedSession({ graded, clearShop, run: async () => 3 })).toEqual({ result: 3, refused: null, cleanup: ['the test shop override could not be cleared: still set'] })
  })
})

describe('the remote wiring run.mjs uses (Sonnet M2), on a faked eval deployment', () => {
  /** The eval D1 behind wrangler's argv (an in-memory SQLite with every migration), the eval R2 behind the API, and the build. */
  async function deployment(o: { preflightStatus?: number } = {}) {
    const { db } = database()
    const argv: string[][] = []
    const spawn = (args: string[]) => {
      argv.push(args)
      const rows = db.prepare(args[args.indexOf('--command') + 1]!).all()
      return { status: 0, stdout: JSON.stringify([{ results: rows }]) }
    }
    const readConfig = () => JSON.stringify({ account_id: ACCOUNT, d1_databases: [{ database_name: EVAL_DB }] })
    const objects: Record<string, string> = {}
    const r2 = api(objects, o.preflightStatus ? { listStatus: o.preflightStatus } : {})
    const log: string[] = []
    const admin: ApiCall = async (method, path, body) => {
      log.push(`${method} ${path}`)
      if (method === 'POST' && path === '/api/chats') {
        db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, 'm_system', 'probe', 1, 1)").run((body as { id: string }).id)
        return { status: 201, json: {} }
      }
      // #337 round 2: the store check before any spend (route 70, Shopify served).
      if (path === '/api/tools') return { status: 200, json: { connected: ['shopify'], details: { shopify: { name: 'Shopify' } }, connection: {} } }
      // #337 round 2 (M2): the case's turn's trace, as the Admin reads it (a routine run's: runs.ts admits it).
      if (path.startsWith('/api/traces/')) return { status: 200, json: { promptVersions: [3], promptApps: [['Shopify']] } }
      return { status: 200, json: { total: { minor: 0 }, cap: { minor: 5000 } } }
    }
    const runNow = async (clientKey: string) => {
      log.push('run now')
      const slotKey = `now|${ROUTINE_ID}|${clientKey}`
      const chat = await slotChatId(slotKey)
      db.prepare(`INSERT INTO routine_slots (slot_key, routine_id, kind, local_date, tz, due_at_ms, deadline_ms, state, chat_id, client_key, prompt_text, submit_json, routine_rev, creator_id, turn_id, claimed_at_ms)
        VALUES (?, '${ROUTINE_ID}', 'manual', '2026-11-22', 'UTC', 1, 2, 'ended', ?, 'k', 'p', '{"model":"claude-sonnet-5-5"}', 1, 'm', 'turn_x', 5000)`).run(slotKey, chat)
      db.exec("INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, decision, input_bytes, input_sha256, at_ms) VALUES ('turn_x', 1, 'c', 'm', 'pre', 'mcp__apps__orders_search', 'allow', 1, 'x', 1)")
      objects[key('000000000000001-000001', 'm', chat)] = `[{"type":"user","content":"refund note: ${CANARY}"}]`
    }
    const rules: (string | undefined)[] = []
    const built = buildRemote({
      database: EVAL_DB, wranglerConfig: 'sandbox.json', env: ENV, admin, runNow, label: 'Fast', budgetUsd: 5, tag: 'store-data:abc:1',
      caseTimeoutMs: 60_000, settleMs: 1000, pause: async () => {}, fetch: r2.doFetch, spawn, readConfig,
      wrangler: w => { rules.push(w.rule); return wranglerRunner(w) },
    })
    return { db, argv, r2, log, rules, built }
  }
  const lease = (db: DatabaseSync) => db.prepare("SELECT value_json FROM settings WHERE owner = 'test-control' AND key = 'eval:lease'").all()
  const setting = (db: DatabaseSync, k: string) => db.prepare("SELECT value_json FROM settings WHERE owner = 'brand' AND key = ?").all(k)

  it('refuses any database but EVAL_DB, a PR\'s test database included, before wrangler runs (line A L1)', async () => {
    const seen: (string | undefined)[] = []
    const make = (database: string) => () => buildRemote({
      database, wranglerConfig: 'sandbox.json', env: ENV, admin: async () => ({ status: 200, json: {} }), runNow: async () => {}, label: 'Fast', budgetUsd: 5, tag: 't',
      caseTimeoutMs: 1, settleMs: 1, spawn: () => { throw new Error('wrangler ran') }, readConfig: () => '{}', wrangler: w => { seen.push(w.database); return wranglerRunner(w) },
    })
    for (const db of ['inhouse-sbx-pr12-db', 'inhouse-sbx-db', 'other']) expect(make(db)).toThrow(DoorRefusal)
    expect(seen, 'refused before the runner is made').toEqual([])
  })

  it('wires the door on the eval rule (EVAL_DB only), and the env\'s graded check, model read and override clear', async () => {
    const { argv, rules, built } = await deployment()
    expect(rules, 'the default eval rule, never the morning-check rule that admits a PR database').toEqual([undefined])
    expect(typeof built.env.beforeCase).toBe('function')
    expect(typeof built.env.modelOf).toBe('function')
    expect(typeof built.env.promptOf).toBe('function')
    expect(typeof built.env.releaseShop).toBe('function')
    await built.env.releaseShop!()
    for (const a of argv) expect(a.slice(0, 4)).toEqual(['d1', 'execute', EVAL_DB, '--remote'])
  })

  it('runs a case end to end: lease, preflight, cap, model, the shop set and cleared, graded from the D1 and the R2 transcript, the lease given back', async () => {
    const { db, r2, log, built } = await deployment()
    const out = await gradedSession({ graded: built.graded, clearShop: () => built.door.clearShop(), run: () => runStoreData(built.env, STORE_DATA_CASES.slice(0, 1), undefined, 'claude-sonnet-5-5') })
    expect(out.refused).toBeNull()
    expect(out.result!.outcomes[0]).toMatchObject({ id: 'XS01', ranOn: 'claude-sonnet-5-5', prompt: 3, verdict: { pass: true, checks: { exposed: true } } })
    expect(log).toEqual(['POST /api/chats', 'GET /api/usage', 'GET /api/usage', 'GET /api/tools', 'run now', 'GET /api/traces/turn_x'])
    expect(r2.calls.map(c => new URL(c.url).searchParams.get('prefix'))[0], 'the preflight first').toBe('sessions/')
    expect(setting(db, 's:cap')).toEqual([{ value_json: '"$50"' }])
    expect(setting(db, 'g:mode')).toEqual([{ value_json: '"Fast"' }])
    expect(db.prepare("SELECT 1 FROM settings WHERE owner = 'test-control' AND key = 'hub:shop'").all(), 'the override cleared').toEqual([])
    expect(lease(db), 'the lease given back').toEqual([])
  })

  it('a 403 preflight runs no case and spends nothing: no cap, no model, no Run now, and the lease given back (Opus M1)', async () => {
    const { db, log, built } = await deployment({ preflightStatus: 403 })
    let ran = false
    const out = await gradedSession({ graded: built.graded, clearShop: () => built.door.clearShop(), run: async () => { ran = true; return runStoreData(built.env) } })
    expect(out.refused).toMatch(/Workers R2 Storage Read/)
    expect(ran).toBe(false)
    expect(log).toEqual([])
    expect(setting(db, 's:cap')).toEqual([])
    expect(setting(db, 'g:mode')).toEqual([])
    expect(lease(db)).toEqual([])
  })
})
