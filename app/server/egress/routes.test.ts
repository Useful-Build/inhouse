// The store, events, audit and MCP routes (p3-design 8.4-8.7), and the scope property on W1's real run tokens
// (acceptance 6). Expected keys and answers are literals. Ways it can fail, written down first:
//  1. a token reads or writes another chat's store, whatever session id, project key, subpath or header it sends;
//  2. the main transcript and a subagent's share keys, or a load mixes them or misses a page past 1,000 parts;
//  3. a load over 64 MB answers anything but 413;
//  4. an events batch for another turn is ingested, the Runner isn't touched after ingest, a closed `events` route
//     or an ended turn answers anything but 410;
//  5. an audit post for another turn is written; the token header reaches the MCP handler;
//  6. a cross-chat or cross-turn call (a live token naming another session or turn) is refused without a log line, or
//     with more than one, or with an id or the body in it; an in-scope call logs anything (acceptance 6).
import { fc } from '@fast-check/vitest'
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createRunTokens } from '../do/brand-agent/tokens.ts'
import { handleEgress } from './index.ts'
import { STORE_LOAD_MAX_BYTES } from './store.ts'
import { egressRequest, FakeEgressRpc, GRANT, harness, TOKEN } from './testing/harness.ts'

const bucket = env.FILES
const KEY = { projectKey: '/work/project', sessionId: GRANT.sessionId }
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('')
let u = 0
const uniqGrant = () => ({ ...GRANT, chatId: `chat-${++u}`, turnId: `t_${u}` })
const post = async (h: Awaited<ReturnType<typeof harness>>, path: string, body: unknown, token?: string) => handleEgress(egressRequest(path, { body, token }), h.deps)

describe('the store (failures 2, 3)', () => {
  it('writes the main transcript and a subagent transcript under disjoint keys, and loads each alone', async () => {
    const g = uniqGrant()
    const h = await harness({ bucket }, g)
    const part = (n: number) => `${String(n).padStart(15, '0')}-000001`
    expect((await post(h, '/store/append', { key: KEY, entries: [{ type: 'user', uuid: 'u1' }], part: part(1) })).status).toBe(200)
    expect((await post(h, '/store/append', { key: { ...KEY, subpath: 'agents/a b/1' }, entries: [{ type: 'sub', uuid: 's1' }], part: part(1) })).status).toBe(200)
    expect((await post(h, '/store/append', { key: KEY, entries: [{ type: 'assistant', uuid: 'u2' }], part: part(2) })).status).toBe(200)
    const project = await sha('/work/project')
    const keys = (await bucket.list({ prefix: `sessions/${g.chatId}/` })).objects.map(o => o.key).sort()
    expect(keys).toEqual([
      `sessions/${g.chatId}/${g.sessionId}/${project}/m/${part(1)}.json`,
      `sessions/${g.chatId}/${g.sessionId}/${project}/m/${part(2)}.json`,
      `sessions/${g.chatId}/${g.sessionId}/${project}/s/agents%2Fa%20b%2F1/${part(1)}.json`,
    ])
    expect(await (await post(h, '/store/load', { key: KEY })).json()).toEqual({ entries: [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'u2' }] })
    expect(await (await post(h, '/store/load', { key: { ...KEY, subpath: 'agents/a b/1' } })).json()).toEqual({ entries: [{ type: 'sub', uuid: 's1' }] })
    expect(await (await post(h, '/store/load', { key: { ...KEY, subpath: 'never' } })).json()).toEqual({ entries: null })
    expect(await (await post(h, '/store/list-subkeys', { key: KEY })).json()).toEqual({ subkeys: ['agents/a b/1'] })
    // The same part again overwrites (the SDK's retry), never adds a copy.
    await post(h, '/store/append', { key: KEY, entries: [{ type: 'user', uuid: 'u1' }], part: part(1) })
    expect(((await (await post(h, '/store/load', { key: KEY })).json()) as { entries: unknown[] }).entries).toHaveLength(2)
  })

  it('pages R2 past 1,000 parts, in part order', async () => {
    const g = uniqGrant()
    const h = await harness({ bucket }, g)
    const project = await sha('/work/project')
    const n = 1003
    await Promise.all(Array.from({ length: n }, (_, i) => bucket.put(`sessions/${g.chatId}/${g.sessionId}/${project}/m/${String(i).padStart(15, '0')}-000000.json`, JSON.stringify([{ type: 'x', uuid: `e${i}` }]))))
    const body = (await (await post(h, '/store/load', { key: KEY })).json()) as { entries: { uuid: string }[] }
    expect(body.entries.map(e => e.uuid)).toEqual(Array.from({ length: n }, (_, i) => `e${i}`))
  })

  it('a load over 64 MB is 413 (a fake bucket lists sizes; no 64 MB written)', async () => {
    const g = uniqGrant()
    const objects = [{ key: 'a', size: STORE_LOAD_MAX_BYTES - 10 }, { key: 'b', size: 11 }]
    const fake = {
      list: async ({ prefix }: { prefix: string }) => ({ objects: objects.map(o => ({ ...o, key: `${prefix}${o.key}.json` })), truncated: false, delimitedPrefixes: [] }),
      get: async () => { throw new Error('a refused load reads nothing') },
    }
    const h = await harness({ bucket: fake as never }, g)
    const res = await post(h, '/store/load', { key: KEY })
    expect(res.status).toBe(413)
    objects[1]!.size = 10
    const ok = await harness({ bucket: { ...fake, get: async () => ({ text: async () => '[]' }) } as never }, g)
    expect((await post(ok, '/store/load', { key: KEY })).status).toBe(200)
  })

  it('a stored part that is not a JSON array errors the streamed load, never splices it in', async () => {
    const g = uniqGrant()
    const fake = {
      list: async ({ prefix }: { prefix: string }) => ({ objects: [{ key: `${prefix}a.json`, size: 7 }], truncated: false, delimitedPrefixes: [] }),
      get: async () => ({ text: async () => '{"x":1}' }),
    }
    const h = await harness({ bucket: fake as never }, g)
    const res = await post(h, '/store/load', { key: KEY })
    await expect(res.text()).rejects.toThrow()
  })

  it("another session's key is 403 scope", async () => {
    const h = await harness({ bucket }, uniqGrant())
    const other = { ...KEY, sessionId: '00000000-0000-4000-8000-0000000000bb' }
    for (const [path, body] of [['/store/append', { key: other, entries: [], part: '000000000000001-000001' }], ['/store/load', { key: other }], ['/store/list-subkeys', { key: { projectKey: 'p', sessionId: other.sessionId } }]] as const) {
      const res = await post(h, path, body)
      expect(res.status, path).toBe(403)
      expect(await res.json()).toEqual({ error: 'scope' })
    }
  })
})

describe('scope on the real run tokens (failure 1, acceptance 6)', () => {
  const sessionA = '00000000-0000-4000-8000-0000000000a1'
  const sessionB = '00000000-0000-4000-8000-0000000000b1'
  it("chat A's token never reads or writes chat B's store, whatever it sends", async () => {
    await runInDurableObject(env.BRAND_AGENT.getByName('w3-scope'), async (_i, state) => {
      const now = 1_800_000_000_000
      const tokens = createRunTokens(state.storage.sql, () => now)
      const base = { runId: 'r_s', memberId: 'm_a', model: 'claude-sonnet-5-5', sideModel: 'claude-haiku-5-5' }
      const chatA = `scope-a-${Date.now()}`
      const chatB = `scope-b-${Date.now()}`
      const tokenA = await tokens.mint({ ...base, turnId: 't_a', chatId: chatA, sessionId: sessionA }, now)
      const tokenB = await tokens.mint({ ...base, turnId: 't_b', chatId: chatB, sessionId: sessionB, memberId: 'm_b' }, now)
      const rpc = new FakeEgressRpc(tokens, () => now)
      const h = await harness({ bucket, rpc })
      // Chat B's store holds a marker.
      await handleEgress(egressRequest('/store/append', { body: { key: { projectKey: 'p', sessionId: sessionB }, entries: [{ type: 'secret-of-b', uuid: 'b' }], part: '000000000000001-000001' }, token: tokenB }), h.deps)
      const snapshotB = async () => {
        const list = await bucket.list({ prefix: `sessions/${chatB}/` })
        return Promise.all(list.objects.map(async o => [o.key, await (await bucket.get(o.key))!.text()]))
      }
      const before = await snapshotB()
      expect(before).toHaveLength(1)

      const ids = fc.constantFrom(sessionA, sessionB, '00000000-0000-4000-8000-0000000000c1')
      const op = fc.record({
        path: fc.constantFrom('/store/append', '/store/load', '/store/list-subkeys'),
        sessionId: ids,
        projectKey: fc.constantFrom('p', '../p', `sessions/${chatB}`, chatB),
        subpath: fc.option(fc.constantFrom('a', '../../m', `../${chatB}`, '%2e%2e'), { nil: undefined }),
        extraHeaders: fc.dictionary(fc.constantFrom('x-chat-id', 'x-inhouse-chat', 'x-session-id'), fc.constantFrom(chatB, sessionB)),
      })
      await fc.assert(fc.asyncProperty(fc.array(op, { maxLength: 8 }), async ops => {
        for (const o of ops) {
          const key = { projectKey: o.projectKey, sessionId: o.sessionId, ...(o.subpath === undefined ? {} : { subpath: o.subpath }) }
          const body = o.path === '/store/append' ? { key, entries: [{ type: 'from-a' }], part: '000000000000002-000001' } : o.path === '/store/load' ? { key } : { key: { projectKey: o.projectKey, sessionId: o.sessionId } }
          const res = await handleEgress(egressRequest(o.path, { body, token: tokenA, headers: o.extraHeaders }), h.deps)
          const text = await res.text()
          expect(text).not.toContain('secret-of-b')
          if (o.sessionId !== sessionA) expect(res.status).toBe(403)
        }
        expect(await snapshotB()).toEqual(before)
        const written = (await bucket.list({ prefix: 'sessions/' })).objects.map(o => o.key).filter(k => !k.startsWith(`sessions/${chatB}/`) && k.includes(sessionA))
        for (const k of written) expect(k.startsWith(`sessions/${chatA}/${sessionA}/`)).toBe(true)
      }), { numRuns: 40 })
    })
  })
})

// P3 acceptance item 6, the refusal itself: a run token the BrandAgent no longer honours (its turn revoked, or a token
// it never minted) is refused before any route runs: 401 and one `egress_refused` line naming the route and why. A
// live token for chat A naming chat B's session is not a refused token: it's 403 `scope`, logged as one
// `egress_refused` line with why `scope`.
describe('a refused run token on the session and files routes (acceptance 6)', () => {
  const sessionA = '00000000-0000-4000-8000-0000000000a2'
  const sessionB = '00000000-0000-4000-8000-0000000000b2'
  it("chat A's revoked or unknown token against chat B's session and files: 401 and egress_refused; a live one is 403 scope", async () => {
    await runInDurableObject(env.BRAND_AGENT.getByName('w3-refused'), async (_i, state) => {
      const now = 1_800_000_000_000
      const tokens = createRunTokens(state.storage.sql, () => now)
      const base = { runId: 'r_r', model: 'claude-sonnet-5-5', sideModel: 'claude-haiku-5-5' }
      const chatA = `refused-a-${Date.now()}`
      const chatB = `refused-b-${Date.now()}`
      const tokenA = await tokens.mint({ ...base, turnId: 't_ra', chatId: chatA, sessionId: sessionA, memberId: 'm_a' }, now)
      await tokens.mint({ ...base, turnId: 't_rb', chatId: chatB, sessionId: sessionB, memberId: 'm_b' }, now)
      const h = await harness({ bucket, rpc: new FakeEgressRpc(tokens, () => now) })
      const onB = (token: string) => [
        egressRequest('/store/load', { body: { key: { projectKey: 'p', sessionId: sessionB } }, token }),
        egressRequest('/store/append', { body: { key: { projectKey: 'p', sessionId: sessionB }, entries: [{ type: 'from-a' }], part: '000000000000001-000001' }, token }),
        egressRequest('/files/', { method: 'GET', token, headers: { 'x-chat-id': chatB } }),
        egressRequest('/files/outputs/b.csv', { method: 'GET', token, headers: { 'x-chat-id': chatB } }),
      ]

      // Live: the store's own scope answers (403), one `scope` line per call, never a token refusal.
      const live = await Promise.all(onB(tokenA).slice(0, 2).map(async r => (await handleEgress(r, h.deps)).status))
      expect(live).toEqual([403, 403])
      expect(h.logs).toEqual([
        { event: 'egress_refused', route: 'store', why: 'scope', runner: 'runner-0' },
        { event: 'egress_refused', route: 'store', why: 'scope', runner: 'runner-0' },
      ])
      h.logs.length = 0

      // Revoked (the turn ended): every route answers 401 before it runs, one line each.
      tokens.revokeTurn('t_ra', 'turn_ended')
      const revoked = await Promise.all(onB(tokenA).map(async r => {
        const res = await handleEgress(r, h.deps)
        return [res.status, await res.json()]
      }))
      expect(revoked).toEqual([[401, { error: 'refused' }], [401, { error: 'refused' }], [401, { error: 'refused' }], [401, { error: 'refused' }]])
      expect(h.logs).toEqual([
        { event: 'egress_refused', route: 'store', why: 'revoked', runner: 'runner-0' },
        { event: 'egress_refused', route: 'store', why: 'revoked', runner: 'runner-0' },
        { event: 'egress_refused', route: 'files', why: 'revoked', runner: 'runner-0' },
        { event: 'egress_refused', route: 'files', why: 'revoked', runner: 'runner-0' },
      ])

      // A token the BrandAgent never minted: the same 401, why `unknown`.
      h.logs.length = 0
      const unknown = await Promise.all(onB('tok_never_minted_0123456789abcdef').map(async r => (await handleEgress(r, h.deps)).status))
      expect(unknown).toEqual([401, 401, 401, 401])
      expect(h.logs.map(l => [l.route, l.why])).toEqual([['store', 'unknown'], ['store', 'unknown'], ['files', 'unknown'], ['files', 'unknown']])
      // Chat B's store was never written.
      expect((await bucket.list({ prefix: `sessions/${chatB}/` })).objects).toEqual([])
    })
  })
})

describe('a scope refusal is logged once (failure 6, acceptance 6)', () => {
  const other = { projectKey: 'p', sessionId: '00000000-0000-4000-8000-0000000000cc' }
  const entry = { hook: 'PreToolUse', toolName: 'Bash', decision: 'allow', input: { command: 'ls' } }
  const CROSS: [string, string, unknown][] = [
    ['store', '/store/append', { key: other, entries: [{ type: 'x' }], part: '000000000000001-000001' }],
    ['store', '/store/load', { key: other }],
    ['store', '/store/list-subkeys', { key: other }],
    ['events', '/events/', { turnId: 't_other', events: [{ runId: 't_other', seq: 0, type: 'heartbeat' }] }],
    ['audit', '/audit/', { turnId: 't_other', n: 0, entry }],
  ]
  it.each(CROSS)('%s %s: 403 scope and exactly one egress_refused line, with no id or body', async (route, path, body) => {
    const h = await harness({ bucket }, uniqGrant())
    const res = await post(h, path, body)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'scope' })
    expect(h.logs).toEqual([{ event: 'egress_refused', route, why: 'scope', runner: 'runner-0' }])
  })
  it('in-scope calls on the same routes log nothing', async () => {
    const g = uniqGrant()
    const h = await harness({ bucket }, g)
    const key = { projectKey: 'p', sessionId: g.sessionId }
    for (const [path, body] of [
      ['/store/append', { key, entries: [{ type: 'x' }], part: '000000000000001-000001' }],
      ['/store/load', { key }],
      ['/store/list-subkeys', { key }],
      ['/events/', { turnId: g.turnId, events: [{ runId: g.turnId, seq: 0, type: 'heartbeat' }] }],
      ['/audit/', { turnId: g.turnId, n: 0, entry }],
    ] as const) expect((await post(h, path, body)).status, path).toBeLessThan(300)
    expect(h.logs).toEqual([])
  })
})

describe('events and audit (failures 4, 5)', () => {
  const ev = (seq: number, turnId = GRANT.turnId) => ({ runId: turnId, seq, type: 'heartbeat' })
  it('ingests the grant turn then touches the runner, answering the ack', async () => {
    const h = await harness()
    const order: string[] = []
    h.rpc.ingestAnswer = async () => (order.push('ingest'), { ackSeq: 4, stop: false })
    h.deps.touchRunner = async r => void order.push(`touch:${r}`)
    const res = await post(h, '/events/', { turnId: GRANT.turnId, events: [ev(3), ev(4)] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ackSeq: 4, stop: false })
    expect(order).toEqual(['ingest', 'touch:runner-0'])
  })
  it("another turn's batch is 403 and never ingested; a stop ack passes through", async () => {
    const h = await harness()
    expect((await post(h, '/events/', { turnId: 't_other', events: [ev(0, 't_other')] })).status).toBe(403)
    expect(h.rpc.callsOf('ingest')).toEqual([])
    h.rpc.ingestAnswer = { ackSeq: 0, stop: true }
    expect(await (await post(h, '/events/', { turnId: GRANT.turnId, events: [ev(0)] })).json()).toEqual({ ackSeq: 0, stop: true })
  })
  it('an ended turn is 410; a closed events route is 410; an unknown token is 401', async () => {
    const h = await harness()
    h.rpc.ingestAnswer = { gone: true }
    expect((await post(h, '/events/', { turnId: GRANT.turnId, events: [ev(0)] })).status).toBe(410)
    expect(h.touched).toEqual([])
    const closed = await harness()
    closed.rpc.checkRunToken = async () => ({ refused: 'closed' })
    expect((await post(closed, '/events/', { turnId: GRANT.turnId, events: [ev(0)] })).status).toBe(410)
    expect((await post(closed, '/audit/', { turnId: GRANT.turnId, n: 0, entry: { hook: 'PreToolUse', toolName: 'Bash', decision: 'allow', input: {} } })).status).toBe(401)
  })
  it('audit: the redacted row through writeToolCall, then 204; another turn is 403', async () => {
    const h = await harness()
    const entry = { hook: 'PreToolUse', toolName: 'Bash', toolUseId: 'toolu_1', decision: 'allow', input: { command: 'ls' } }
    const res = await post(h, '/audit/', { turnId: GRANT.turnId, n: 7, entry })
    expect(res.status).toBe(204)
    expect(h.rpc.callsOf('writeToolCall').map(c => c.args)).toEqual([[GRANT.turnId, 7, entry]])
    expect((await post(h, '/audit/', { turnId: 't_other', n: 0, entry })).status).toBe(403)
  })
  it('mcp: the grant ids only, the token header stripped', async () => {
    const h = await harness()
    const res = await handleEgress(egressRequest('/mcp/', { body: { jsonrpc: '2.0' }, headers: { 'x-chat-id': 'chat-b' } }), h.deps)
    expect(res.status).toBe(200)
    expect(h.mcpCalls[0]!.scope).toEqual({ memberId: 'm_alice', chatId: 'chat-a', runId: 'r_run1', turnId: 't_turn1' })
    expect(h.mcpCalls[0]!.request.headers.get('x-inhouse-run-token')).toBeNull()
    expect((await handleEgress(egressRequest('/mcp/', { method: 'GET' }), h.deps)).status).toBe(405)
  })
  it('only egress.internal and the six routes', async () => {
    const h = await harness()
    expect((await handleEgress(new Request('http://other.internal/model/v1/messages', { method: 'POST', headers: { 'x-inhouse-run-token': TOKEN } }), h.deps)).status).toBe(404)
    expect((await post(h, '/api/chats', {})).status).toBe(404)
    expect(h.rpc.callsOf('checkRunToken')).toEqual([])
  })
})

describe('the settings the gate reads', () => {
  it("brandSettings reads the brand's tm: keys and t:websearch from D1, nothing else", async () => {
    const { brandSettings } = await import('./index.ts')
    await env.DB.prepare('DELETE FROM settings').run()
    const put = (owner: string, key: string, v: string | boolean) =>
      env.DB.prepare('INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES (?, ?, ?, 1, 0, ?, ?)').bind(owner, key, JSON.stringify(v), 'system', `req-bs-${owner}-${key}`).run()
    await put('brand', 'tm:opus:on', 'off')
    await put('brand', 'tm:opus:effort', 'High')
    await put('brand', 't:webfetch', 'docs.example.com')
    await put('brand', 't:websearch', true)
    await put('m_someone', 'tm:sonnet:on', 'off')
    await put('m_someone', 't:websearch', false)
    expect(await brandSettings(env.DB)).toEqual({ 'tm:opus:on': 'off', 'tm:opus:effort': 'High', 't:websearch': true })
  })
})
