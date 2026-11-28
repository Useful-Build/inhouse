// The modern fixture (app/test/upstreams/mcp/modern.ts, MCP 2026-07-28): each plant answers as the spec page it stands
// for says. Each test names its rule. Raw requests only; no client library.
import { fc, test } from '@fast-check/vitest'
import { beforeEach, describe, expect, it } from 'vitest'
import { encodeHeaderValue, MODERN_VERSION } from '../../../test/upstreams/mcp/wire'
import type { McpFixtures } from '../../../test/upstreams/mcp/index'
import { MODERN_KEY } from '../../../test/upstreams/mcp/modern'
import { legacyInitialize } from '../../../test/upstreams/mcp/legacy'
import { fixtures, listAll, modern, MODERN, rpcOf, signIn } from './kit'

let fx: McpFixtures
beforeEach(() => {
  fx = fixtures()
})

const call = (url: string, name: string, args: Record<string, unknown>, opts: Parameters<typeof modern>[4] = {}) => modern(fx, url, 'tools/call', { name, arguments: args }, opts)

describe('a legacy client (versioning 2026-07-28, compatibility matrix: Legacy client, Modern server)', () => {
  it('refuses a 2025-11-25 initialize with 400 and UnsupportedProtocolVersion naming its versions, and mints no session', async () => {
    const res = await fx.fetch(legacyInitialize(`${MODERN}/open/mcp`, 1))
    expect(res.status).toBe(400)
    expect(res.headers.get('Mcp-Session-Id')).toBeNull()
    const r = await rpcOf(res)
    // "SHOULD name the protocol versions it supports in any error it returns to an initialize request".
    expect(r).toMatchObject({ id: 1, error: { code: -32022, data: { supported: [MODERN_VERSION], requested: '2025-11-25' } } })
    // A recognised modern error (basic/index "Error Codes": -32020 to -32022), so a dual-era client doesn't fall back.
    expect([-32020, -32021, -32022]).toContain(r.error!.code)
    // Control: the same endpoint serves a modern request.
    expect((await modern(fx, `${MODERN}/open/mcp`, 'server/discover')).status).toBe(200)
  })

  it('refuses the initialized notification and a GET stream as a modern-only server should (202 dropped, 405)', async () => {
    const note = await fx.fetch(new Request(`${MODERN}/open/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }))
    expect(note.status).toBe(202)
    expect(await note.text()).toBe('')
    const get = await fx.fetch(new Request(`${MODERN}/open/mcp`, { headers: { Accept: 'text/event-stream' } }))
    expect(get.status).toBe(405)
    expect(get.headers.get('Allow')).toBe('POST')
    expect(fx.modern.violations).toEqual(['GET /open/mcp'])
  })
})

describe('server/discover and tools/list (server/discover, server/tools, 2026-07-28)', () => {
  it('discover names the supported versions, capabilities, serverInfo, ttlMs and cacheScope', async () => {
    const r = await rpcOf(await modern(fx, `${MODERN}/open/mcp`, 'server/discover'))
    expect(r.result).toMatchObject({ resultType: 'complete', supportedVersions: [MODERN_VERSION], capabilities: { tools: {} }, ttlMs: expect.any(Number), cacheScope: 'public', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture-modern' } } })
  })

  it('pages the list with nextCursor, the same order every time, ttlMs and cacheScope on every page', async () => {
    const p1 = await rpcOf(await modern(fx, `${MODERN}/open/mcp`, 'tools/list'))
    expect(p1.result!.tools as unknown[]).toHaveLength(2)
    expect(p1.result).toMatchObject({ nextCursor: 'page-2', ttlMs: 60_000, cacheScope: 'public', resultType: 'complete' })
    const p2 = await rpcOf(await modern(fx, `${MODERN}/open/mcp`, 'tools/list', { cursor: 'page-2' }))
    expect(p2.result!.nextCursor).toBeUndefined()
    expect(p2.result).toMatchObject({ ttlMs: 60_000, cacheScope: 'public' })
    const names = async () => (await listAll(fx, `${MODERN}/open/mcp`)).map(t => t.name)
    expect(await names()).toEqual(['notes_search', 'notes_read', 'notes_write', 'region_lookup'])
    expect(await names()).toEqual(await names())
  })

  it('ignores an Mcp-Session-Id and never echoes one (streamable-http "Earlier Streamable HTTP Revisions")', async () => {
    const res = await modern(fx, `${MODERN}/open/mcp`, 'server/discover', {}, { headers: { 'Mcp-Session-Id': 'from-2025' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('Mcp-Session-Id')).toBeNull()
  })
})

describe('x-mcp-header (streamable-http "Custom Headers from Tool Parameters")', () => {
  it('needs Mcp-Param-Region when the body has a region, and checks it against the body', async () => {
    expect((await call(`${MODERN}/open/mcp`, 'region_lookup', { region: 'eu-west' }, { headers: { 'Mcp-Param-Region': 'eu-west' } })).status).toBe(200)
    const missing = await call(`${MODERN}/open/mcp`, 'region_lookup', { region: 'eu-west' })
    expect(missing.status).toBe(400)
    expect((await rpcOf(missing)).error!.code).toBe(-32020)
    // No value in the body: the header isn't expected ("Parameter not in arguments": server MUST NOT expect it).
    expect((await call(`${MODERN}/open/mcp`, 'notes_search', { query: 'fern' })).status).toBe(200)
  })

  test.prop([fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 })])('a value encoded per "Value Encoding" is accepted, a different one refused', async (value, other) => {
    const ok = await call(`${MODERN}/open/mcp`, 'region_lookup', { region: value }, { headers: { 'Mcp-Param-Region': encodeHeaderValue(value) } })
    expect(ok.status).toBe(200)
    fc.pre(other !== value)
    const bad = await call(`${MODERN}/open/mcp`, 'region_lookup', { region: value }, { headers: { 'Mcp-Param-Region': encodeHeaderValue(other) } })
    expect(bad.status).toBe(400)
    expect((await rpcOf(bad)).error!.code).toBe(-32020)
  })

  it('/header-drift/mcp checks another name than it lists: -32020 for a conforming call (control: /open/mcp accepts it)', async () => {
    const headers = { 'Mcp-Param-Folder': 'ops' }
    const drift = await call(`${MODERN}/header-drift/mcp`, 'notes_write', { folder: 'ops', text: 'x' }, { headers })
    expect(drift.status).toBe(400)
    expect((await rpcOf(drift)).error!.code).toBe(-32020)
    expect(fx.modern.writes).toEqual([])
    expect((await call(`${MODERN}/open/mcp`, 'notes_write', { folder: 'ops', text: 'x' }, { headers })).status).toBe(200)
    expect(fx.modern.writes).toHaveLength(1)
  })
})

describe('auth (basic/authorization 2026-07-28)', () => {
  it('a signed-in endpoint answers 401 with a Bearer challenge naming its metadata and scope; the metadata names the login server', async () => {
    const res = await modern(fx, `${MODERN}/mcp`, 'tools/list')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe(`Bearer resource_metadata="${MODERN}/.well-known/oauth-protected-resource/mcp", scope="notes:read"`)
    const prm = await fx.fetch(new Request(`${MODERN}/.well-known/oauth-protected-resource/mcp`))
    expect(await prm.json()).toEqual({ resource: `${MODERN}/mcp`, authorization_servers: ['https://login.mcp-fixtures.example.com/std'], scopes_supported: ['notes:read'], bearer_methods_supported: ['header'] })
    // The root address has none: a client must try the path-inserted one first (authorization-server-discovery).
    expect((await fx.fetch(new Request(`${MODERN}/.well-known/oauth-protected-resource`))).status).toBe(404)
  })

  it('checks the audience: a token for another resource is 401 invalid_token; a missing scope is 403 insufficient_scope', async () => {
    const forOther = await signIn(fx, 'std', { resource: `${MODERN}/as/std/mcp`, scope: 'notes:read' })
    const wrong = await modern(fx, `${MODERN}/mcp`, 'tools/list', {}, { headers: { Authorization: `Bearer ${forOther.access}` } })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('WWW-Authenticate')).toContain('error="invalid_token"')
    const ok = await modern(fx, `${MODERN}/as/std/mcp`, 'tools/list', {}, { headers: { Authorization: `Bearer ${forOther.access}` } })
    expect(ok.status).toBe(200)
    const write = await call(`${MODERN}/as/std/mcp`, 'notes_write', { folder: 'ops', text: 'x' }, { headers: { Authorization: `Bearer ${forOther.access}`, 'Mcp-Param-Folder': 'ops' } })
    expect(write.status).toBe(403)
    expect(write.headers.get('WWW-Authenticate')).toBe(`Bearer error="insufficient_scope", scope="notes:write", resource_metadata="${MODERN}/.well-known/oauth-protected-resource/as/std/mcp"`)
    expect(fx.modern.writes).toEqual([])
  })

  it('a key endpoint refuses without a Bearer challenge and has no resource metadata; a revoked key is refused', async () => {
    const res = await modern(fx, `${MODERN}/key/mcp`, 'tools/list')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).not.toMatch(/^Bearer/i)
    expect((await fx.fetch(new Request(`${MODERN}/.well-known/oauth-protected-resource/key/mcp`))).status).toBe(404)
    expect((await modern(fx, `${MODERN}/key/mcp`, 'tools/list', {}, { headers: { 'X-Api-Key': MODERN_KEY } })).status).toBe(200)
    fx.revokeKey('modern')
    expect((await modern(fx, `${MODERN}/key/mcp`, 'tools/list', {}, { headers: { 'X-Api-Key': MODERN_KEY } })).status).toBe(401)
  })
})

describe('plants (each by path)', () => {
  it("/changing/mcp: notes_read's definition changes from the 2nd list; the other tools don't (server/tools: lists MAY change)", async () => {
    const first = await listAll(fx, `${MODERN}/changing/mcp`)
    const second = await listAll(fx, `${MODERN}/changing/mcp`)
    const read = (l: typeof first) => l.find(t => t.name === 'notes_read')!
    expect(read(second).description).not.toBe(read(first).description)
    expect(Object.keys((read(second).inputSchema.properties as object))).toEqual(['id', 'include_deleted'])
    expect(second.filter(t => t.name !== 'notes_read')).toEqual(first.filter(t => t.name !== 'notes_read'))
    // Control: /open/mcp doesn't change.
    expect(await listAll(fx, `${MODERN}/open/mcp`)).toEqual(await listAll(fx, `${MODERN}/open/mcp`))
  })

  it('/input/mcp ask_state: input_required with only requestState; the retry that echoes it completes (mrtr requirements 3, 6)', async () => {
    const first = await rpcOf(await call(`${MODERN}/input/mcp`, 'ask_state', { topic: 'stock' }, { id: 1 }))
    expect(first.result!.resultType).toBe('input_required')
    expect(first.result!.inputRequests).toBeUndefined()
    const state = first.result!.requestState as string
    expect(typeof state).toBe('string')
    const done = await rpcOf(await modern(fx, `${MODERN}/input/mcp`, 'tools/call', { name: 'ask_state', arguments: { topic: 'stock' }, requestState: state }, { id: 2 }))
    expect(done.result).toMatchObject({ resultType: 'complete', isError: false })
    // Tampered state is refused (requirement 4: requestState is attacker-controlled).
    const bad = await rpcOf(await modern(fx, `${MODERN}/input/mcp`, 'tools/call', { name: 'ask_state', arguments: { topic: 'stock' }, requestState: `${state}x` }, { id: 3 }))
    expect(bad.error!.code).toBe(-32602)
    // A retry that reuses the first id is reported (client requirement 3).
    expect(fx.modern.violations).toEqual([])
    await modern(fx, `${MODERN}/input/mcp`, 'tools/call', { name: 'ask_state', arguments: { topic: 'stock' }, requestState: state }, { id: 1 })
    expect(fx.modern.violations).toEqual(['mrtr retry reused id 1 on ask_state'])
  })

  it('/input/mcp ask_user: asks only a client that declared form elicitation (requirement 7), else -32021 (basic/index)', async () => {
    const none = await call(`${MODERN}/input/mcp`, 'ask_user', { topic: 'stock' })
    expect(none.status).toBe(400)
    expect((await rpcOf(none)).error).toMatchObject({ code: -32021, data: { requiredCapabilities: { elicitation: { form: {} } } } })
    const asked = await rpcOf(await call(`${MODERN}/input/mcp`, 'ask_user', { topic: 'stock' }, { capabilities: { elicitation: { form: {} } } }))
    expect(asked.result).toMatchObject({ resultType: 'input_required', inputRequests: { confirm: { method: 'elicitation/create' } } })
    const answered = await rpcOf(await modern(fx, `${MODERN}/input/mcp`, 'tools/call', { name: 'ask_user', arguments: { topic: 'stock' }, inputResponses: { confirm: { action: 'accept', content: { store: 'main' } } } }, { capabilities: { elicitation: { form: {} } } }))
    expect(answered.result).toMatchObject({ resultType: 'complete' })
    // The planted breach: ask_user_anyway asks a client that declared nothing.
    const anyway = await rpcOf(await call(`${MODERN}/input/mcp`, 'ask_user_anyway', { topic: 'stock' }))
    expect(anyway.result).toMatchObject({ resultType: 'input_required', inputRequests: { confirm: { method: 'elicitation/create' } } })
  })

  it('/stream-open/mcp: the answer comes as an SSE event and the stream is left open (streamable-http: the final response SHOULD end it)', async () => {
    const res = await modern(fx, `${MODERN}/stream-open/mcp`, 'tools/list', {}, { id: 7 })
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    while (!text.includes('"id":7')) {
      const { value, done } = await reader.read()
      expect(done).toBe(false)
      text += dec.decode(value)
    }
    expect(fx.modern.streamsCancelled).toBe(0)
    // A stream's cancel runs only while it is still open: so this proves the fixture never ended it.
    await reader.cancel()
    expect(fx.modern.streamsCancelled).toBe(1)
    // Control: /open/mcp answers JSON and ends.
    expect((await modern(fx, `${MODERN}/open/mcp`, 'tools/list')).headers.get('Content-Type')).toBe('application/json')
  })

  it('/list-fails/mcp: the first full list works; from the 2nd, page 2 fails', async () => {
    expect(await listAll(fx, `${MODERN}/list-fails/mcp`)).toHaveLength(4)
    expect((await modern(fx, `${MODERN}/list-fails/mcp`, 'tools/list')).status).toBe(200)
    expect((await modern(fx, `${MODERN}/list-fails/mcp`, 'tools/list', { cursor: 'page-2' })).status).toBe(503)
  })

  it('/codemode/mcp lists only its own code tool unless asked for plain tools (?mode=tools); /codemode-other/mcp likewise', async () => {
    expect((await listAll(fx, `${MODERN}/codemode/mcp`)).map(t => t.name)).toEqual(['execute'])
    expect((await listAll(fx, `${MODERN}/codemode/mcp?mode=tools`)).map(t => t.name)).toEqual(['notes_search', 'notes_read', 'notes_write', 'region_lookup'])
    expect((await listAll(fx, `${MODERN}/codemode-other/mcp`)).map(t => t.name)).toEqual(['execute'])
  })

  it('/lossy/mcp: the first answer per tool is lost after the call ran (a lost write may have landed)', async () => {
    const headers = { 'Mcp-Param-Folder': 'ops' }
    const lost = await call(`${MODERN}/lossy/mcp`, 'notes_write', { folder: 'ops', text: 'once' }, { headers })
    await expect(lost.text()).rejects.toThrow()
    expect(fx.modern.writes).toHaveLength(1)
    const again = await call(`${MODERN}/lossy/mcp`, 'notes_write', { folder: 'ops', text: 'once' }, { headers })
    expect((await rpcOf(again)).result).toMatchObject({ resultType: 'complete' })
    expect(fx.modern.writes).toHaveLength(2)
  })

  it("/untrusted/mcp: the request log holds every argument it received", async () => {
    await call(`${MODERN}/untrusted/mcp`, 'notes_search', { query: 'customer ada@fixture.invalid' })
    expect(fx.log.entries.at(-1)).toMatchObject({ host: 'modern.mcp-fixtures.example.com', path: '/untrusted/mcp', rpc: 'tools/call', tool: 'notes_search', args: { query: 'customer ada@fixture.invalid' }, credential: 'none', status: 200 })
  })
})
