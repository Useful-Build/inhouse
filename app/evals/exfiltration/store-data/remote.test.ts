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
//     another model; the eval lease outlives a failed start or a failed run.
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createMorningDoor } from '../../morning-check/door.ts'
import { hostOf as morningHost } from '../../morning-check/expected.ts'
import { MORNING_CHECK_CAP } from '../../morning-check/remote.ts'
import { ROUTINE_ID } from '../../morning-check/runner.ts'
import { DoorRefusal, EVAL_DB, type RunSql } from '../../targets/door.ts'
import { EVAL_CAP } from '../../targets/product.ts'
import { storeDataMode } from './args.ts'
import { STORE_DATA_CASES, hostOf } from './cases.ts'
import { gradedSession, STORE_DATA_CAP, STORE_DATA_SHOPS, storeDataReader } from './remote.ts'
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
function api(objects: Record<string, string>, o: { perPage?: number; listStatus?: number; getStatus?: (k: string) => number; redirect?: boolean; throws?: string; extraKeys?: string[] } = {}) {
  const calls: { url: string; method: string; headers: Record<string, string>; redirect: RequestRedirect | undefined }[] = []
  const listBase = `${R2_API_BASE}/accounts/${ACCOUNT}/r2/buckets/${EVAL_BUCKET}/objects`
  const doFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect })
    if (o.throws) throw new Error(o.throws)
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
    expect(await r.canarySeen(CHAT, CANARY)).toBe(true)
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET', 'GET'])
    const list = new URL(calls[0]!.url)
    expect(list.origin + list.pathname).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${EVAL_BUCKET}/objects`)
    expect(list.searchParams.get('prefix')).toBe(`sessions/${CHAT}/`)
    expect(calls[1]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${EVAL_BUCKET}/objects/${key('000000000000001-000001')}`)
    for (const c of calls) {
      expect(c.headers).toEqual({ Authorization: `Bearer ${TOKEN}` })
      expect(c.redirect, 'a redirect is never followed').toBe('manual')
      expect(c.url).not.toContain(TOKEN)
    }
  })
  it('reads a subagent\'s transcript too, its subpath percent-encoded in the GET path as the key holds it', async () => {
    const sub = `s/${encodeURIComponent('agent one/x')}`
    const { calls, doFetch } = api({ [key('000000000000001-000001', sub)]: `["${CANARY}"]` })
    expect(await createTranscriptReader({ env: ENV, bucket: EVAL_BUCKET, fetch: doFetch }).canarySeen(CHAT, CANARY)).toBe(true)
    expect(calls[1]!.url.endsWith(`/s/${encodeURIComponent(encodeURIComponent('agent one/x'))}/000000000000001-000001.json`)).toBe(true)
  })
  it('no object under the chat is observed "not exposed" (false), and objects without the canary too', async () => {
    expect(await createTranscriptReader({ env: ENV, bucket: EVAL_BUCKET, fetch: api({}).doFetch }).canarySeen(CHAT, CANARY)).toBe(false)
    const other = api({ [key('000000000000001-000001')]: '[{"type":"user"}]', [key('000000000000001-000001', 'm', 'rc_ZZZZZZZZZZZZZZZZZZZZZZ')]: `["${CANARY}"]` })
    expect(await createTranscriptReader({ env: ENV, bucket: EVAL_BUCKET, fetch: other.doFetch }).canarySeen(CHAT, CANARY), 'another chat\'s object is never read').toBe(false)
    expect(other.calls.map(c => c.url).filter(u => u.includes('rc_ZZZ'))).toEqual([])
  })
  it('pages the list with its cursor', async () => {
    const objects = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [key(`00000000000000${i}-00000${i}`), i === 4 ? `["${CANARY}"]` : '[]']))
    const { calls, doFetch } = api(objects, { perPage: 2 })
    expect(await createTranscriptReader({ env: ENV, bucket: EVAL_BUCKET, fetch: doFetch }).canarySeen(CHAT, CANARY)).toBe(true)
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
  const transcripts = { canarySeen: async (chat: string, canary: string) => { asked.push([chat, canary]); return true } }
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
