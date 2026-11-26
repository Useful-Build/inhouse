// Unit tests for the fetch leak check (M1-G, N8): token extraction, JSON-aware capture, catalogue vs customer data
// (decision L2), URL decoding, digest domain separation, expiry, row cap, per-result cap, capture on /hub/, /mcp/ and
// text /files/, failed capture (fail closed), failed check (fail closed), and end-to-end hub-read -> webfetch refusal
// on real D1.
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { HubResult, ToolInfo } from '../../hub/index/contract.ts'
import { fileStore } from '../files-io/store.ts'
import type { HubRouteDeps, ReadGatewayLike } from './hub.ts'
import { handleEgress, type EgressOptions } from './index.ts'
import {
  digestToken, extractTokens, extractUrlTokens, isTextLikeContentType, MAX_URL_CANDIDATES, resultTokens, TAINT_MAX_TOKENS_PER_RESULT,
  TAINT_TTL_MS, taintStore, type TaintStore,
} from './taint.ts'
import { egressRequest, GRANT, harness } from './testing/harness.ts'
import { handleWebFetch, type FetchRecord } from './webfetch.ts'

const db = env.DB
const HASH_KEY = 'taint-unit-test-hash-key-0123456789'
const BASE_NOW = 1_800_000_000_000

/** A hub tools/call answer as the egress sends it: the tool's data JSON-encoded inside `result.content[0].text`. */
const hubBody = (data: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } })
/** An MCP tools/call answer: plain text once JSON-encoded. */
const mcpBody = (text: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })
const capturing = (store: TaintStore): EgressOptions => ({ captureTaint: (body, source) => store.capture(body, source).then(() => undefined) })
const leaks = (store: TaintStore, url: string) => store.checkUrl(new URL(url))

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
  it('ignores years, short numbers, plain words and ISO timestamps', () => {
    const text = 'In 2026 our shipping-policy allows 45 days for returns on ceramic-coffee-mug items, code 1234567, since 2026-11-20T10:00:00Z (20261120T101500Z).'
    expect(extractTokens(text)).toEqual([])
    expect(resultTokens(hubBody({ processedAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-19T16:43:37.123Z' }), { route: 'hub' })).toEqual([])
  })

  it('caps at 500 tokens per result, highest signal first (emails, #orders, 8+ digits, 12+ mixed)', () => {
    const mixed = Array.from({ length: 600 }, (_, i) => `tok_mixed_${String(i).padStart(6, '0')}`)
    const text = `${mixed.join(' ')} #1042 9876543210 alice@example.com`
    const tokens = extractTokens(text)
    expect(tokens).toHaveLength(TAINT_MAX_TOKENS_PER_RESULT)
    expect(tokens.slice(0, 3)).toEqual(['alice@example.com', '#1042', '9876543210'])
  })

  it('finds an email after 160 KB of local-part characters with no @ (timing: evals/exfiltration/leak-check-timing.test.ts)', () => {
    expect(extractTokens(`${'a.b_c%d+e-f'.repeat(14_600)} alice@example.com`)).toEqual(['alice@example.com'])
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

describe('JSON-aware capture (escapes never glue characters onto a token)', () => {
  const note = 'Call back:\nalice@example.com\t(ref 5550000001001)\r\n"ord_AbC123def456"'

  it('a double-encoded hub result, a single-encoded MCP result and a JSON file all give the clean tokens', () => {
    const want = ['alice@example.com', '5550000001001', 'ord_abc123def456']
    expect(resultTokens(hubBody({ note }), { route: 'hub' })).toEqual(want)
    expect(resultTokens(mcpBody(note), { route: 'mcp' })).toEqual(want)
    expect(resultTokens(JSON.stringify({ rows: [{ note }] }), { route: 'files', contentType: 'application/json; charset=utf-8' })).toEqual(want)
  })

  it('reads a body that is not JSON, and a text file, as raw text', () => {
    expect(resultTokens('event: message\ndata: alice@example.com', { route: 'mcp' })).toEqual(['alice@example.com'])
    expect(resultTokens('email,order\nprivate@example.com,#4099\n', { route: 'files', contentType: 'text/csv' })).toEqual(['private@example.com', '#4099'])
  })

  it('keeps a JSON number past 2^53 exactly', () => {
    expect(resultTokens('{"id": 12345678901234567891}', { route: 'mcp' })).toEqual(['12345678901234567891'])
  })

  it('refuses a URL with the email after the JSON-escaped capture', async () => {
    const store = taintStore(db, HASH_KEY, () => BASE_NOW)
    await store.capture(hubBody({ note }), { route: 'hub' })
    expect(await leaks(store, 'https://docs.example.com/?e=alice@example.com')).toBe(true)
    expect(await leaks(store, 'https://docs.example.com/?e=nalice@example.com&ref=x')).toBe(false)
  })
})

describe('catalogue data is not tainted, customer and order data is (decision L2)', () => {
  const PRODUCT = {
    items: [{
      id: 'gid://shopify/Product/8123456789012', title: 'Moss Glaze Mug 350ml Edition2024', handle: 'moss-glaze-mug-350ml', status: 'active',
      variants: [{ id: 'gid://shopify/ProductVariant/44012345678901', sku: 'MOSSMUG350SLATE01', title: 'Slate', price: { minor: 2400, currency: 'USD' } }],
    }],
    nextCursor: null,
  }
  const ORDER = {
    id: 'gid://shopify/Order/5550000001042', name: '#1042', processedAt: '2026-11-20T10:00:00Z',
    customer: { id: 'gid://shopify/Customer/7770000004242', displayName: 'Anna Kowalski', email: 'anna.k@example.net', phone: '+15550104242' },
    lineItems: [{ title: 'Moss Glaze Mug 350ml Edition2024', sku: 'MOSSMUG350SLATE01', variant: { id: 'gid://shopify/ProductVariant/44012345678901' } }],
  }

  async function readThroughHub(store: TaintStore, tool: string, data: unknown) {
    const h = await harness()
    const fakeHub: ReadGatewayLike = {
      listTools: async () => ({ ok: true, value: [{ name: tool, connector: 'shopify', description: tool, inputSchema: {} }] satisfies ToolInfo[] }),
      callTool: async () => ({ ok: true, value: { data } }) satisfies HubResult<{ data: unknown }>,
    }
    const hub: HubRouteDeps = { hub: fakeHub, stage: async () => 1, now: () => BASE_NOW, requestId: () => 'req-l2', log: () => undefined }
    const res = await handleEgress(
      egressRequest('/hub/', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } }, headers: { 'content-type': 'application/json' } }),
      { ...h.deps, hub },
      capturing(store),
    )
    expect(res.status).toBe(200)
  }

  it('after reading a product, its storefront page, its id, ?variant=<id> and its sku stay fetchable', async () => {
    const store = taintStore(db, HASH_KEY, () => BASE_NOW)
    await readThroughHub(store, 'products_search', PRODUCT)
    for (const url of [
      'https://shop.example.com/products/moss-glaze-mug-350ml?variant=44012345678901',
      'https://shop.example.com/products/8123456789012',
      'https://shop.example.com/search?q=Moss+Glaze+Mug+350ml+Edition2024&sku=MOSSMUG350SLATE01',
    ]) expect(await leaks(store, url), url).toBe(false)
  })

  it("after reading an order, a URL with the customer's email, the order number, the order id or the customer id is refused", async () => {
    const store = taintStore(db, HASH_KEY, () => BASE_NOW)
    await readThroughHub(store, 'order_get', ORDER)
    for (const url of [
      'https://docs.example.com/?e=anna.k%40example.net',
      'https://docs.example.com/?o=%231042',
      'https://docs.example.com/o/5550000001042',
      'https://docs.example.com/c#7770000004242',
      'https://docs.example.com/?p=15550104242',
    ]) expect(await leaks(store, url), url).toBe(true)
    // The order's own product line stays catalogue data.
    expect(await leaks(store, 'https://shop.example.com/products/moss-glaze-mug-350ml?variant=44012345678901&sku=MOSSMUG350SLATE01')).toBe(false)
  })

  it('the catalogue fields rule is the hub\'s only: the same fields in a JSON file are captured', () => {
    expect(resultTokens(JSON.stringify({ sku: 'MOSSMUG350SLATE01' }), { route: 'files', contentType: 'application/json' })).toEqual(['mossmug350slate01'])
    expect(resultTokens(hubBody({ title: 'Ask anna.k@example.net about MOSSMUG350SLATE01' }), { route: 'hub' })).toEqual(['anna.k@example.net'])
  })
})

describe('URL decoding', () => {
  const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const hex = (s: string) => [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, '0')).join('')

  it('percent-decodes base64url and hex output too', () => {
    expect(extractUrlTokens(new URL(`https://d.example.com/p/${b64url('alice%40example.com')}`))).toContain('alice@example.com')
    expect(extractUrlTokens(new URL(`https://d.example.com/?h=${hex('alice%2540example.com')}`))).toContain('alice@example.com')
  })

  it('decodes base64 and hex after + becomes a space in a query', () => {
    const q = `hi+${b64url('alice@example.com')}`
    expect(extractUrlTokens(new URL(`https://d.example.com/?q=${q}`))).toContain('alice@example.com')
    expect(extractUrlTokens(new URL(`https://d.example.com/?q=hi+${hex('5550000001001')}`))).toContain('5550000001001')
  })

  it('matches an order number followed by letters or _', () => {
    for (const s of ['#1001a', '#1001_x', '%231001a', '%231001-x']) expect(extractUrlTokens(new URL(`https://d.example.com/?o=${s}`)), s).toContain('#1001')
    expect(extractUrlTokens(new URL('https://d.example.com/x#1001_x'))).toContain('#1001')
  })

  it('finds tokens with adjacent characters: sub-runs, email suffixes and prefixes, base64 offsets 0-3 and hex offset 1', () => {
    const tokens = (u: string) => extractUrlTokens(new URL(u))
    expect(tokens('https://d.example.com/x-ord_AbC123def456-y')).toContain('ord_abc123def456')
    expect(tokens('https://d.example.com/x_ord-AbC123def456_y.z')).toContain('ord-abc123def456')
    expect(tokens('https://d.example.com/?e=x.alice@example.com.y')).toContain('alice@example.com')
    expect(tokens('https://d.example.com/?e=x-alice@example.com-y')).toContain('alice@example.com')
    for (const pre of ['', 'a', 'ab', 'abc']) {
      for (const post of ['', 'Z', 'ZZ', 'ZZZ']) expect(tokens(`https://d.example.com/p/${pre}${b64url('alice@example.com')}${post}`), `${pre}|${post}`).toContain('alice@example.com')
    }
    expect(tokens(`https://d.example.com/?h=f${hex('5550000001001')}e`)).toContain('5550000001001')
    expect(tokens(`https://${hex('5550000001001').slice(0, 10)}.${hex('5550000001001').slice(10)}.example.com/`)).toContain('5550000001001')
  })

  it('refuses a URL with more than MAX_URL_CANDIDATES candidate tokens (fail closed)', async () => {
    const store = taintStore(db, HASH_KEY, () => BASE_NOW)
    const noisy = Array.from({ length: MAX_URL_CANDIDATES + 10 }, (_, i) => `t${String(i).padStart(11, '0')}`).join('/')
    expect(extractUrlTokens(new URL(`https://d.example.com/${noisy}`)).length).toBeGreaterThan(MAX_URL_CANDIDATES)
    expect(await leaks(store, `https://d.example.com/${noisy}`)).toBe(true)
  })
})

describe('digest', () => {
  it('is domain-separated from a plain HMAC of the token under the same key (the audit log\'s hashes)', async () => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(HASH_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const mac = async (s: string) => [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(s))).subarray(0, 16)]
      .map(b => b.toString(16).padStart(2, '0')).join('')
    const d = await digestToken(HASH_KEY, 'alice@example.com')
    expect(d).toMatch(/^[0-9a-f]{32}$/)
    expect(d).not.toBe(await mac('alice@example.com'))
    expect(d).toBe(await mac('egress-taint/v1\0alice@example.com'))
  })
})

describe('expiry and row cap', () => {
  it('expires tokens after 7 days and evicts expired rows on next capture', async () => {
    let now = BASE_NOW
    const store = taintStore(db, HASH_KEY, () => now)
    await store.capture('Customer email is secret.buyer@example.com', { route: 'mcp' })
    const leakUrl = 'https://docs.example.com/check?e=secret.buyer%40example.com'

    expect(await leaks(store, leakUrl)).toBe(true)
    now = BASE_NOW + TAINT_TTL_MS
    expect(await leaks(store, leakUrl)).toBe(true)
    now = BASE_NOW + TAINT_TTL_MS + 1
    expect(await leaks(store, leakUrl)).toBe(false)

    await store.capture('New order #9911', { route: 'mcp' })
    expect(await db.prepare('SELECT COUNT(*) AS n FROM egress_taint').first<number>('n')).toBe(1)
  })

  it('a re-sighted token is refreshed, so it outlives its first sighting by 7 days', async () => {
    let now = BASE_NOW
    const store = taintStore(db, HASH_KEY, () => now)
    await store.capture('again@example.com', { route: 'mcp' })
    now = BASE_NOW + TAINT_TTL_MS - 1
    await store.capture('again@example.com', { route: 'mcp' })
    now = BASE_NOW + TAINT_TTL_MS + 1_000
    expect(await leaks(store, 'https://docs.example.com/?e=again@example.com')).toBe(true)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM egress_taint').first<number>('n')).toBe(1)
  })

  it('enforces the row cap by evicting the oldest rows first in a bounded delete', async () => {
    let now = BASE_NOW
    const store = taintStore(db, HASH_KEY, () => now, { maxRows: 5, evictBatch: 10 })
    await store.capture('old1@example.com old2@example.com old3@example.com old4@example.com', { route: 'mcp' })
    now = BASE_NOW + 1000
    await store.capture('new1@example.com new2@example.com new3@example.com', { route: 'mcp' })

    expect(await db.prepare('SELECT COUNT(*) AS n FROM egress_taint').first<number>('n')).toBe(5)
    for (const email of ['new1@example.com', 'new2@example.com', 'new3@example.com']) {
      expect(await leaks(store, `https://docs.example.com/?e=${encodeURIComponent(email)}`)).toBe(true)
    }
    let oldRemaining = 0
    for (const email of ['old1@example.com', 'old2@example.com', 'old3@example.com', 'old4@example.com']) {
      if (await leaks(store, `https://docs.example.com/?e=${encodeURIComponent(email)}`)) oldRemaining++
    }
    expect(oldRemaining).toBe(2)
  })

  it('counts rows only when the rowid span passes the cap, and keeps the cap after refresh churn', async () => {
    const sql: string[] = []
    const watched = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') return (q: string) => { sql.push(q); return target.prepare(q) }
        const v = Reflect.get(target, prop) as unknown
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    })
    let now = BASE_NOW
    const store = taintStore(watched, HASH_KEY, () => now, { maxRows: 6, evictBatch: 10 })
    await store.capture('a1@example.com a2@example.com a3@example.com', { route: 'mcp' })
    // Re-reading the same tokens refreshes them and never counts: the span stays at 3.
    for (let i = 1; i <= 3; i++) {
      now = BASE_NOW + i
      await store.capture('a1@example.com a2@example.com a3@example.com', { route: 'mcp' })
    }
    expect(sql.filter(q => q.includes('COUNT(*)'))).toEqual([])
    // Four new tokens: the span passes 6, an exact count runs and the oldest row goes.
    now = BASE_NOW + 10
    await store.capture('b1@example.com b2@example.com b3@example.com b4@example.com', { route: 'mcp' })
    expect(sql.filter(q => q.includes('COUNT(*)'))).toHaveLength(1)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM egress_taint').first<number>('n')).toBe(6)
  })
})

describe('fail closed on capture and check failures', () => {
  const failing: EgressOptions = { captureTaint: async () => { throw new Error('d1 down') } }

  it('a failed capture on /hub/ answers 500 and never leaks the tool result to the container', async () => {
    const h = await harness()
    const fakeHub: ReadGatewayLike = {
      listTools: async () => ({ ok: true, value: [{ name: 'orders_search', connector: 'shopify', description: 'Orders', inputSchema: {} }] satisfies ToolInfo[] }),
      callTool: async () => ({ ok: true, value: { data: { order: '#1042', email: 'anna@example.com' } } }) satisfies HubResult<{ data: unknown }>,
    }
    const hubDeps: HubRouteDeps = { hub: fakeHub, stage: async () => 1, now: () => BASE_NOW, requestId: () => 'req-1', log: () => undefined }
    const res = await handleEgress(
      egressRequest('/hub/', {
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orders_search', arguments: {} } },
        headers: { 'content-type': 'application/json' },
      }),
      { ...h.deps, hub: hubDeps },
      failing,
    )
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('anna@example.com')
    expect(h.logs.some(l => l.event === 'egress_taint_capture_failed' && l.route === 'hub')).toBe(true)
  })

  it('a failed capture on /mcp/ answers 500 and never leaks the tool result', async () => {
    const h = await harness({
      mcp: async () => Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Customer email secret@example.com' }] } }),
    })
    const res = await handleEgress(egressRequest('/mcp/', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call' }, headers: { 'content-type': 'application/json' } }), h.deps, failing)
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('secret@example.com')
    expect(h.logs.some(l => l.event === 'egress_taint_capture_failed' && l.route === 'mcp')).toBe(true)
  })

  it('a failed capture on a text-like /files/ GET answers 500; JSON files are parsed; a binary file skips capture', async () => {
    const files = fileStore({ db, bucket: env.FILES })
    const chatId = `chat-taint-${crypto.randomUUID()}`
    await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, 'm_taint_test', 'Taint', 1, 1)").bind(chatId).run()
    const grant = { ...GRANT, chatId, turnId: `t_${crypto.randomUUID()}` }
    const h = await harness({ files, bucket: env.FILES }, grant)
    const put = async (id: string, path: string, contentType: string, bytes: Uint8Array) => {
      const key = `files/${chatId}/${id}`
      await env.FILES.put(key, bytes)
      await db
        .prepare(
          "INSERT INTO chat_files (id, chat_id, turn_id, kind, path, name, content_type, bytes, sha256, r2_key, state, created_at_ms) VALUES (?, ?, ?, 'input', ?, ?, ?, ?, '00', ?, 'saved', 1)",
        )
        .bind(id, chatId, grant.turnId, path, path.split('/').pop(), contentType, bytes.byteLength, key)
        .run()
    }
    await put('f_csv_1', 'inputs/orders.csv', 'text/csv', new TextEncoder().encode('email,order\nprivate@example.com,#4099\n'))

    const failRes = await handleEgress(egressRequest('/files/inputs/orders.csv', { method: 'GET' }), h.deps, failing)
    expect(failRes.status).toBe(500)
    expect(await failRes.text()).not.toContain('private@example.com')

    const store = taintStore(db, HASH_KEY, () => BASE_NOW)
    const okRes = await handleEgress(egressRequest('/files/inputs/orders.csv', { method: 'GET' }), h.deps, capturing(store))
    expect(okRes.status).toBe(200)
    expect(await okRes.text()).toContain('private@example.com')
    expect(await leaks(store, 'https://docs.example.com/?o=%234099')).toBe(true)

    // A JSON file is parsed: the escaped newline doesn't glue `n` onto the email.
    await put('f_json_1', 'inputs/people.json', 'application/json', new TextEncoder().encode(JSON.stringify({ note: 'x\nbob@example.org' })))
    expect((await handleEgress(egressRequest('/files/inputs/people.json', { method: 'GET' }), h.deps, capturing(store))).status).toBe(200)
    expect(await leaks(store, 'https://docs.example.com/?e=bob@example.org')).toBe(true)

    await put('f_png_1', 'inputs/logo.png', 'image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
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
    const hubRes = await handleEgress(
      egressRequest('/hub/', {
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orders_search', arguments: { first: 1 } } },
        headers: { 'content-type': 'application/json' },
      }),
      { ...h.deps, hub: hubDeps },
      capturing(store),
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
