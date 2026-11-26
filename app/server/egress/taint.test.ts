// Unit tests for the fetch leak check (M1-G, N8): expiry, row cap, per-result cap, capture on /hub/, /mcp/ and text
// /files/, failed capture (fail closed), failed check (fail closed), and end-to-end hub-read -> webfetch refusal on real D1.
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { HubResult, ToolInfo } from '../../hub/index/contract.ts'
import { fileStore } from '../files-io/store.ts'
import type { HubRouteDeps, ReadGatewayLike } from './hub.ts'
import { handleEgress } from './index.ts'
import { extractTokens, isTextLikeContentType, TAINT_MAX_TOKENS_PER_RESULT, TAINT_TTL_MS, taintStore } from './taint.ts'
import { egressRequest, GRANT, harness } from './testing/harness.ts'
import { handleWebFetch, type FetchRecord } from './webfetch.ts'

const db = env.DB
const HASH_KEY = 'taint-unit-test-hash-key-0123456789'
const BASE_NOW = 1_800_000_000_000

beforeAll(async () => {
  await db
    .prepare(
      "INSERT OR IGNORE INTO members (id, kind, role, status, name, email_norm, created_at_ms) VALUES ('m_taint_test', 'person', 'member', 'active', 'Ada', 'taint-test@example.com', 1)",
    )
    .run()
})

beforeEach(async () => {
  await db.prepare('DELETE FROM egress_taint').run()
})

describe('token extraction (high signal only)', () => {
  it('ignores years, short numbers, and plain words', () => {
    const text = 'In 2026 our shipping-policy allows 45 days for returns on ceramic-coffee-mug items, code 1234567.'
    expect(extractTokens(text)).toEqual([])
  })

  it('caps at 500 tokens per result, highest signal first (emails, #orders, 8+ digits, 12+ mixed)', () => {
    const mixed = Array.from({ length: 600 }, (_, i) => `tok_mixed_${String(i).padStart(6, '0')}`)
    const text = `${mixed.join(' ')} #1042 9876543210 alice@example.com`
    const tokens = extractTokens(text)
    expect(tokens).toHaveLength(TAINT_MAX_TOKENS_PER_RESULT)
    expect(tokens[0]).toBe('alice@example.com')
    expect(tokens[1]).toBe('#1042')
    expect(tokens[2]).toBe('9876543210')
  })

  it('classifies text-like content types accurately', () => {
    expect(isTextLikeContentType('text/csv')).toBe(true)
    expect(isTextLikeContentType('text/plain; charset=utf-8')).toBe(true)
    expect(isTextLikeContentType('text/markdown')).toBe(true)
    expect(isTextLikeContentType('application/json')).toBe(true)
    expect(isTextLikeContentType('application/problem+json')).toBe(true)
    expect(isTextLikeContentType('image/png')).toBe(false)
    expect(isTextLikeContentType('application/pdf')).toBe(false)
  })
})

describe('expiry and row cap', () => {
  it('expires tokens after 7 days and evicts expired rows on next capture', async () => {
    let now = BASE_NOW
    const store = taintStore(db, HASH_KEY, () => now)
    await store.capture('Customer email is secret.buyer@example.com')
    const leakUrl = new URL('https://docs.example.com/check?e=secret.buyer%40example.com')

    expect(await store.checkUrl(leakUrl)).toBe(true)

    // Just before 7 days: still refused.
    now = BASE_NOW + TAINT_TTL_MS
    expect(await store.checkUrl(leakUrl)).toBe(true)

    // Past 7 days: no longer refused even before eviction.
    now = BASE_NOW + TAINT_TTL_MS + 1
    expect(await store.checkUrl(leakUrl)).toBe(false)

    // Next capture evicts the expired row.
    await store.capture('New order #9911')
    const count = await db.prepare('SELECT COUNT(*) AS n FROM egress_taint').first<number>('n')
    expect(count).toBe(1)
  })

  it('enforces the row cap by evicting the oldest rows first in a bounded delete', async () => {
    let now = BASE_NOW
    const store = taintStore(db, HASH_KEY, () => now, { maxRows: 5, evictBatch: 10 })

    // Insert 4 older tokens at t = BASE_NOW.
    await store.capture('old1@example.com old2@example.com old3@example.com old4@example.com')
    // Insert 3 newer tokens at t = BASE_NOW + 1000 (total 7 > maxRows 5 -> 2 oldest evicted).
    now = BASE_NOW + 1000
    await store.capture('new1@example.com new2@example.com new3@example.com')

    const count = await db.prepare('SELECT COUNT(*) AS n FROM egress_taint').first<number>('n')
    expect(count).toBe(5)

    // All 3 newer tokens must still be present.
    for (const email of ['new1@example.com', 'new2@example.com', 'new3@example.com']) {
      expect(await store.checkUrl(new URL(`https://docs.example.com/?e=${encodeURIComponent(email)}`))).toBe(true)
    }
    // Exactly 2 of the 4 older tokens survived.
    let oldRemaining = 0
    for (const email of ['old1@example.com', 'old2@example.com', 'old3@example.com', 'old4@example.com']) {
      if (await store.checkUrl(new URL(`https://docs.example.com/?e=${encodeURIComponent(email)}`))) oldRemaining++
    }
    expect(oldRemaining).toBe(2)
  })
})

describe('fail closed on capture and check failures', () => {
  it('a failed capture on /hub/ answers 500 and never leaks the tool result to the container', async () => {
    const h = await harness()
    const fakeHub: ReadGatewayLike = {
      listTools: async () => ({ ok: true, value: [{ name: 'orders_search', connector: 'shopify', description: 'Orders', inputSchema: {} }] satisfies ToolInfo[] }),
      callTool: async () => ({ ok: true, value: { data: { order: '#1042', email: 'anna@example.com' } } }) satisfies HubResult<{ data: unknown }>,
    }
    const hubDeps: HubRouteDeps = { hub: fakeHub, stage: async () => 1, now: () => BASE_NOW, requestId: () => 'req-1', log: () => undefined }
    const deps = Object.assign({}, h.deps, { hub: hubDeps })

    const res = await handleEgress(
      egressRequest('/hub/', {
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orders_search', arguments: {} } },
        headers: { 'content-type': 'application/json' },
      }),
      deps,
      { captureTaint: async () => { throw new Error('d1 down') } },
    )
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).not.toContain('anna@example.com')
    expect(h.logs.some(l => l.event === 'egress_taint_capture_failed' && l.route === 'hub')).toBe(true)
  })

  it('a failed capture on /mcp/ answers 500 and never leaks the tool result', async () => {
    const h = await harness({
      mcp: async () => Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Customer email secret@example.com' }] } }),
    })
    const res = await handleEgress(
      egressRequest('/mcp/', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call' }, headers: { 'content-type': 'application/json' } }),
      h.deps,
      { captureTaint: async () => { throw new Error('d1 down') } },
    )
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('secret@example.com')
    expect(h.logs.some(l => l.event === 'egress_taint_capture_failed' && l.route === 'mcp')).toBe(true)
  })

  it('a failed capture on a text-like /files/ GET answers 500; a binary file skips capture', async () => {
    const files = fileStore({ db, bucket: env.FILES })
    const chatId = `chat-taint-${crypto.randomUUID()}`
    await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, 'm_taint_test', 'Taint', 1, 1)").bind(chatId).run()
    const grant = { ...GRANT, chatId, turnId: `t_${crypto.randomUUID()}` }
    const h = await harness({ files, bucket: env.FILES }, grant)

    // Save a text/csv file directly in chat_files + R2.
    const csvBytes = new TextEncoder().encode('email,order\nprivate@example.com,#4099\n')
    const csvKey = `files/${chatId}/f_csv_1`
    await env.FILES.put(csvKey, csvBytes)
    await db
      .prepare(
        "INSERT INTO chat_files (id, chat_id, turn_id, kind, path, name, content_type, bytes, sha256, r2_key, state, created_at_ms) VALUES ('f_csv_1', ?, ?, 'input', 'inputs/orders.csv', 'orders.csv', 'text/csv', ?, '00', ?, 'saved', 1)",
      )
      .bind(chatId, grant.turnId, csvBytes.byteLength, csvKey)
      .run()

    // Failing capture -> 500, body not leaked.
    const failRes = await handleEgress(egressRequest('/files/inputs/orders.csv', { method: 'GET' }), h.deps, {
      captureTaint: async () => { throw new Error('d1 down') },
    })
    expect(failRes.status).toBe(500)
    expect(await failRes.text()).not.toContain('private@example.com')

    // Working capture -> 200 and tokens are stored.
    const store = taintStore(db, HASH_KEY, () => BASE_NOW)
    const okRes = await handleEgress(egressRequest('/files/inputs/orders.csv', { method: 'GET' }), h.deps, {
      captureTaint: text => store.capture(text).then(() => undefined),
    })
    expect(okRes.status).toBe(200)
    expect(await okRes.text()).toContain('private@example.com')
    expect(await store.checkUrl(new URL('https://docs.example.com/?o=%234099'))).toBe(true)

    // Binary file (image/png): capture is never called, even if captureTaint would throw.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const pngKey = `files/${chatId}/f_png_1`
    await env.FILES.put(pngKey, pngBytes)
    await db
      .prepare(
        "INSERT INTO chat_files (id, chat_id, turn_id, kind, path, name, content_type, bytes, sha256, r2_key, state, created_at_ms) VALUES ('f_png_1', ?, ?, 'input', 'inputs/logo.png', 'logo.png', 'image/png', ?, '00', ?, 'saved', 1)",
      )
      .bind(chatId, grant.turnId, pngBytes.byteLength, pngKey)
      .run()

    const pngRes = await handleEgress(egressRequest('/files/inputs/logo.png', { method: 'GET' }), h.deps, {
      captureTaint: async () => { throw new Error('must not be called for binary') },
    })
    expect(pngRes.status).toBe(200)
  })

  it('a failed leak check refuses the fetch with leak before DNS or page request', async () => {
    const networkCalls: string[] = []
    const logs: Record<string, unknown>[] = []
    const records: FetchRecord[] = []
    const later: Promise<unknown>[] = []
    const res = await handleWebFetch(new Request('https://docs.example.com/clean'), {
      hostList: async () => 'docs.example.com',
      checkLeak: async () => { throw new Error('d1 unreachable') },
      fetch: (async (input: RequestInfo | URL) => {
        networkCalls.push(String(input))
        return new Response('ok')
      }) as typeof fetch,
      log: e => { logs.push(e) },
      record: async r => { records.push(r) },
      noteRecordFailure: async () => undefined,
      waitUntil: p => { later.push(p) },
    })
    await Promise.all(later)
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('WebFetch refused: leak')
    expect(networkCalls).toEqual([])
    expect(logs.some(l => l.event === 'webfetch_leak_check_failed')).toBe(true)
    expect(records).toEqual([{ host: 'docs.example.com', verdict: 'refused', code: 'leak' }])
  })
})

describe('end-to-end on real D1: /hub/ read then WebFetch to a listed host', () => {
  it('refuses a listed-host fetch carrying the order id from the hub read before DNS or fetch', async () => {
    const store = taintStore(db, HASH_KEY, () => BASE_NOW)
    const h = await harness()
    const fakeHub: ReadGatewayLike = {
      listTools: async () => ({ ok: true, value: [{ name: 'orders_search', connector: 'shopify', description: 'Orders', inputSchema: {} }] satisfies ToolInfo[] }),
      callTool: async () => ({ ok: true, value: { data: { orders: [{ id: 'gid://shopify/Order/5550000001001', name: '#1001' }] } } }),
    }
    const hubDeps: HubRouteDeps = { hub: fakeHub, stage: async () => 1, now: () => BASE_NOW, requestId: () => 'req-e2e', log: () => undefined }
    const deps = Object.assign({}, h.deps, { hub: hubDeps })

    const hubRes = await handleEgress(
      egressRequest('/hub/', {
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orders_search', arguments: { first: 1 } } },
        headers: { 'content-type': 'application/json' },
      }),
      deps,
      { captureTaint: text => store.capture(text).then(() => undefined) },
    )
    expect(hubRes.status).toBe(200)

    const networkCalls: string[] = []
    const fetchRes = await handleWebFetch(new Request('https://docs.example.com/lookup?order=5550000001001'), {
      hostList: async () => 'docs.example.com',
      checkLeak: u => store.checkUrl(u),
      fetch: (async (input: RequestInfo | URL) => {
        networkCalls.push(String(input))
        return new Response('ok')
      }) as typeof fetch,
      log: () => undefined,
      record: async () => undefined,
      noteRecordFailure: async () => undefined,
      waitUntil: () => undefined,
    })
    expect(fetchRes.status).toBe(403)
    expect(await fetchRes.text()).toBe('WebFetch refused: leak')
    expect(networkCalls).toEqual([])
  })
})
