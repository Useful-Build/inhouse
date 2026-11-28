// The SDK wrapper (connectors/mcp/sdk.ts, Stage 1 M4-C1, N36) against M4-F's fixture servers, in plain Node. Every count
// is read from the fixtures' own request log (what reached the server), never from the wrapper's record alone.
// Ways it can fail (N53's plants for C1, each turns a test here red): `auto` dropped (the modern fixture answers the
// 2025 handshake with -32022, so "both eras" fails); a redirect followed (/moved/mcp would reach /open/mcp); a write POST
// sent twice (the lossy write count); the SDK left to list and retry on HeaderMismatch (the header-drift write count and
// its "no tools/list"); any console line (the spies); the stream read to its end (the open-stream deadline).
// Control for all of them: a lost read is sent once more.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpFixtures } from '../../../test/upstreams/mcp/index'
import { MODERN_KEY } from '../../../test/upstreams/mcp/modern'
import { fixtures, LEGACY, MODERN, signIn } from '../../testing/fixtures/kit'
import { mcpFetch, type WireEvent } from '../../oauth/http'
import { clientOptions, EraCache, ERA_TTL_MS, sdkCallTool, sdkListTools, transportOptions, type McpTarget, type SdkDeps } from './sdk'

let fx: McpFixtures
let clock: number
let deps: SdkDeps
const CONSOLE = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
let spies: ReturnType<typeof vi.spyOn>[]

beforeEach(() => {
  fx = fixtures()
  clock = 1_000_000
  deps = { upstream: fx.fetch, now: () => clock, eras: new EraCache(), timeoutMs: 2_000 }
  spies = CONSOLE.map(m => vi.spyOn(console, m).mockImplementation(() => {}))
})

afterEach(() => {
  // No console output from the hub or the SDK in any test here (N36): a connect, a call and every planted bad answer.
  for (const [i, s] of spies.entries()) expect(s, `console.${CONSOLE[i]}`).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

const target = (endpoint: string, extra: Partial<McpTarget> = {}): McpTarget => ({ endpoint, generation: 1, credential: null, ...extra })
/** The JSON-RPC methods (and other HTTP methods) that reached a fixture endpoint, in order. */
const wire = (url: string) => {
  const u = new URL(url)
  return fx.log.for(u.host, u.pathname).map(e => (e.method === 'POST' ? (e.rpc ?? 'POST') : e.method))
}
const calls = (url: string) => wire(url).filter(m => m === 'tools/call').length
const def = (name: string, inputSchema: Record<string, unknown> = { type: 'object' }) => ({ name, inputSchema: inputSchema as { type: 'object' } })
const REGION = def('region_lookup', { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, query: { type: 'string' } }, required: ['region'] })
const WRITE = def('notes_write', { type: 'object', properties: { folder: { type: 'string', 'x-mcp-header': 'Folder' }, text: { type: 'string' } }, required: ['folder', 'text'] })

describe('both eras answer a list and a call', () => {
  it('modern (2026-07-28): a probe, every page, then a call on the cached era with no probe', async () => {
    const url = `${MODERN}/open/mcp`
    const list = await sdkListTools(deps, target(url))
    expect(list).toMatchObject({ kind: 'ok', era: 'modern' })
    expect(list.kind === 'ok' && list.tools.map(t => t.name)).toEqual(['notes_search', 'notes_read', 'notes_write', 'region_lookup'])
    expect(wire(url)).toEqual(['server/discover', 'tools/list', 'tools/list'])
    const out = await sdkCallTool(deps, target(url), { tool: REGION, args: { region: 'Zürich' }, mode: 'read' })
    expect(out).toMatchObject({ kind: 'ok', era: 'modern', session: null, dropped: 0 })
    expect(out.kind === 'ok' && JSON.parse(out.result.content[0]!.text)).toEqual({ region: 'Zürich', warehouse: 'WH-ZÜRICH' })
    // The cached era: no second probe. `Mcp-Param-Region` was mirrored from the confirmed definition (the fixture checks it).
    expect(wire(url)).toEqual(['server/discover', 'tools/list', 'tools/list', 'tools/call'])
  })

  it('legacy (2025-11-25): the probe falls back to initialize, and a read keeps its session', async () => {
    const url = `${LEGACY}/mcp`
    const list = await sdkListTools(deps, target(url))
    expect(list).toMatchObject({ kind: 'ok', era: 'legacy' })
    expect(list.kind === 'ok' && list.tools.map(t => t.name)).toEqual(['notes_search', 'notes_read', 'notes_write', 'region_lookup'])
    expect(wire(url)).toEqual(['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/list'])
    const out = await sdkCallTool(deps, target(url), { tool: def('notes_search'), args: { query: 'fern' }, mode: 'read' })
    expect(out).toMatchObject({ kind: 'ok', era: 'legacy', session: { endpoint: url, generation: 1, protocolVersion: '2025-11-25' } })
    expect(out.kind === 'ok' && JSON.parse(out.result.content[0]!.text)).toEqual([expect.objectContaining({ id: 'n1' })])
    // The cached era skips the probe; the call starts its own session.
    expect(wire(url).slice(5)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    const again = await sdkCallTool(deps, target(url), { tool: def('notes_search'), args: { query: 'kestrel' }, mode: 'read', session: out.kind === 'ok' ? out.session : null })
    expect(again).toMatchObject({ kind: 'ok', session: out.kind === 'ok' ? out.session : null })
    expect(wire(url).slice(8)).toEqual(['tools/call'])
  })

  it('legacy over an event stream (/sse/mcp)', async () => {
    const url = `${LEGACY}/sse/mcp`
    expect(await sdkListTools(deps, target(url))).toMatchObject({ kind: 'ok', era: 'legacy' })
    expect(await sdkCallTool(deps, target(url), { tool: def('notes_read'), args: { id: 'n2' }, mode: 'read' })).toMatchObject({ kind: 'ok' })
  })

  it("pins the options whose SDK defaults are wrong for the hub: 'auto' (default 'legacy') and 'throw' (default 'reauthorize')", () => {
    expect(clientOptions(1).versionNegotiation?.mode).toBe('auto')
    expect(clientOptions(1).inputRequired).toEqual({ autoFulfill: false })
    expect(clientOptions(1).capabilities).toEqual({})
    const t = transportOptions(async () => new Response(null), null)
    expect(t.onInsufficientScope).toBe('throw')
    expect(t.reconnectionOptions?.maxRetries).toBe(0)
    expect('authProvider' in t).toBe(false)
  })
})

describe('a modern error is never followed by initialize', () => {
  it('a probe answered -32020 (a proxy plant rewrites Mcp-Method) stops there: no initialize leaves', async () => {
    const url = `${MODERN}/open/mcp`
    const proxied: SdkDeps = {
      ...deps,
      upstream: req => {
        const headers = new Headers(req.headers)
        if (headers.get('Mcp-Method') === 'server/discover') headers.set('Mcp-Method', 'tools/list')
        return fx.fetch(new Request(req, { headers }))
      },
    }
    const out = await sdkListTools(proxied, target(url))
    expect(out).toMatchObject({ kind: 'error', reason: 'header_mismatch', sent: 'no' })
    expect(wire(url)).toEqual(['server/discover'])
    // The SDK did ask for the 2025 handshake (its classifier reads -32020 as "not a probe answer"); our fetch refused it.
    expect(out.wire.map(e => [e.rpc, e.fate])).toContainEqual(['initialize', 'refused'])
    // Control: without the plant the same endpoint lists.
    expect(await sdkListTools(deps, target(url))).toMatchObject({ kind: 'ok', era: 'modern' })
  })

  it("a stale 'legacy' verdict on a modern server: its -32022 ends the call, drops the cache, and the next call probes", async () => {
    const url = `${MODERN}/open/mcp`
    deps.eras.set(url, 1, { kind: 'legacy' }, clock + ERA_TTL_MS)
    const out = await sdkCallTool(deps, target(url), { tool: def('notes_search'), args: { query: 'fern' }, mode: 'read' })
    expect(out).toMatchObject({ kind: 'error', reason: 'version', sent: 'no' })
    expect(wire(url)).toEqual(['initialize'])
    expect(deps.eras.get(url, 1, clock)).toBeNull()
    expect(await sdkCallTool(deps, target(url), { tool: def('notes_search'), args: { query: 'fern' }, mode: 'read' })).toMatchObject({ kind: 'ok', era: 'modern' })
    expect(wire(url)).toEqual(['initialize', 'server/discover', 'tools/call'])
  })
})

describe('the era cache', () => {
  it('is re-probed after a planted change (setToolsVersion): the refresh goes to the wire and sees the new definition', async () => {
    const url = `${MODERN}/changing/mcp?c=sdk`
    const before = await sdkListTools(deps, target(url))
    expect(await sdkCallTool(deps, target(url), { tool: def('notes_read'), args: { id: 'n1' }, mode: 'read' })).toMatchObject({ kind: 'ok' })
    expect(wire(url)).toEqual(['server/discover', 'tools/list', 'tools/list', 'tools/call'])
    expect(fx.setToolsVersion(url, 2)).toBe(true)
    const after = await sdkListTools(deps, target(url))
    expect(wire(url).slice(4)).toEqual(['server/discover', 'tools/list', 'tools/list'])
    const desc = (l: typeof before) => (l.kind === 'ok' ? l.tools.find(t => t.name === 'notes_read')?.description : null)
    expect(desc(before)).toBe('Read one note by id.')
    expect(desc(after)).toMatch(/^Read one note by id\. UPSTREAM TEXT/)
  })

  it('is bound to the credential generation and expires with the ttl', async () => {
    const url = `${MODERN}/open/mcp`
    await sdkListTools(deps, target(url))
    const read = (generation: number) => sdkCallTool(deps, target(url, { generation }), { tool: def('notes_read'), args: { id: 'n1' }, mode: 'read' })
    await read(1)
    expect(wire(url).slice(3)).toEqual(['tools/call'])
    // A new generation (a changed binding or credential) is a new verdict: probed first.
    await read(2)
    expect(wire(url).slice(4)).toEqual(['server/discover', 'tools/call'])
    // The fixture's discover says ttlMs 3600000 (capped at ERA_TTL_MS): past it, probed again.
    clock += ERA_TTL_MS
    await read(2)
    expect(wire(url).slice(6)).toEqual(['server/discover', 'tools/call'])
  })
})

describe('streams', () => {
  it('the open-stream fixture answers inside the deadline: read to the matching answer, then closed', async () => {
    const url = `${MODERN}/stream-open/mcp`
    const slow: SdkDeps = { ...deps, timeoutMs: 5_000 }
    const started = performance.now()
    expect(await sdkListTools(slow, target(url))).toMatchObject({ kind: 'ok' })
    expect(await sdkCallTool(slow, target(url), { tool: def('notes_read'), args: { id: 'n1' }, mode: 'read' })).toMatchObject({ kind: 'ok' })
    // Four answers (discover, two pages, the call), each left open by the server: far under one deadline in all.
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(fx.modern.streamsCancelled).toBe(4)
  })
})

describe('a GET never leaves the hub', () => {
  it("the SDK's standing-stream GET after a 2025 handshake is answered here with 405", async () => {
    const url = `${LEGACY}/mcp`
    const out = await sdkListTools(deps, target(url))
    expect(out.wire.filter(e => e.method === 'GET')).toEqual([{ method: 'GET', rpc: null, id: null, fate: 'local', status: 405 }])
    expect(fx.log.entries.filter(e => e.method !== 'POST')).toEqual([])
  })

  it('a GET or DELETE through the adapter is answered locally; another URL is refused before anything is sent', async () => {
    const record: WireEvent[] = []
    const f = mcpFetch(fx.fetch, { endpoint: `${LEGACY}/mcp`, credential: null, allow: new Set(['tools/list']), maxCalls: 0, record })
    expect((await f(`${LEGACY}/mcp`, { method: 'GET' })).status).toBe(405)
    expect((await f(`${LEGACY}/mcp`, { method: 'DELETE', headers: { 'Mcp-Session-Id': 'x' } })).status).toBe(405)
    await expect(f(`${LEGACY}/other/mcp`, { method: 'POST', body: '{}' })).rejects.toThrow()
    await expect(f(`${LEGACY}/mcp?x=1`, { method: 'POST', body: '{}' })).rejects.toThrow()
    // A method off the operation's list, and a notification nobody needs, never leave either.
    await expect(f(`${LEGACY}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })).rejects.toThrow()
    expect((await f(`${LEGACY}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }) })).status).toBe(202)
    expect(fx.log.entries).toEqual([])
    expect(record.map(e => e.fate)).toEqual(['local', 'local', 'blocked', 'blocked', 'refused', 'local'])
  })

  it('a redirect is never followed (/moved/mcp answers 308 to /open/mcp)', async () => {
    const out = await sdkListTools(deps, target(`${MODERN}/moved/mcp`))
    expect(out).toMatchObject({ kind: 'error', reason: 'unavailable' })
    // One probe, answered 308: neither followed nor read as a 2025 server (no initialize leaves after it).
    expect(fx.log.entries.map(e => `${e.path} ${e.rpc} ${e.status}`)).toEqual(['/moved/mcp server/discover 308'])
    expect(out.wire.map(e => [e.rpc, e.fate])).toContainEqual(['initialize', 'refused'])
    // The SDK never even tried to follow it (its same-origin follower saw no Location).
    expect(out.wire.filter(e => e.fate === 'blocked')).toEqual([])
  })

  it("every request leaves with redirect: 'manual' and our credential only", async () => {
    const seen: { redirect: string; auth: string | null; key: string | null }[] = []
    const spy = (req: Request) => {
      seen.push({ redirect: req.redirect, auth: req.headers.get('Authorization'), key: req.headers.get('X-Api-Key') })
      return fx.fetch(req)
    }
    const key = { header: 'X-Api-Key', value: MODERN_KEY }
    expect(await sdkListTools({ ...deps, upstream: spy }, target(`${MODERN}/key/mcp`, { credential: key }))).toMatchObject({ kind: 'ok' })
    expect(seen.length).toBeGreaterThan(0)
    for (const s of seen) expect(s).toEqual({ redirect: 'manual', auth: null, key: MODERN_KEY })
  })
})

describe('one wire-count test per recovery branch', () => {
  it('control: a lost read is sent once more (2 POSTs), with a new id, and answers', async () => {
    const url = `${MODERN}/lossy/mcp`
    await sdkListTools(deps, target(url))
    const out = await sdkCallTool(deps, target(url), { tool: def('notes_read'), args: { id: 'n3' }, mode: 'read' })
    expect(out).toMatchObject({ kind: 'ok' })
    expect(calls(url)).toBe(2)
    const ids = fx.modern.calls.map(c => c.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('a lost write is 1 POST: sent unknown, never re-sent (the write landed once)', async () => {
    const url = `${MODERN}/lossy/mcp`
    await sdkListTools(deps, target(url))
    const out = await sdkCallTool(deps, target(url), { tool: WRITE, args: { folder: 'ops', text: 'x' }, mode: 'write' })
    expect(out).toMatchObject({ kind: 'error', reason: 'lost', sent: 'unknown' })
    expect(calls(url)).toBe(1)
    expect(out.wire.filter(e => e.fate !== 'sent')).toEqual([])
    expect(fx.modern.writes).toHaveLength(1)
  })

  it('a HeaderMismatch on a write is 1 POST, and the SDK neither lists nor retries', async () => {
    const url = `${MODERN}/header-drift/mcp`
    await sdkListTools(deps, target(url))
    const before = wire(url).length
    const out = await sdkCallTool(deps, target(url), { tool: WRITE, args: { folder: 'ops', text: 'x' }, mode: 'write' })
    expect(out).toMatchObject({ kind: 'error', reason: 'header_mismatch', sent: 'unknown' })
    expect(wire(url).slice(before)).toEqual(['tools/call'])
    expect(fx.modern.writes).toHaveLength(0)
    // The SDK didn't try either (our fetch would have refused a tools/list or a second call; it saw neither).
    expect(out.wire.filter(e => e.fate !== 'sent')).toEqual([])
  })

  it('a HeaderMismatch on a read is not retried either (the confirmed definition is what we send)', async () => {
    const url = `${MODERN}/header-drift/mcp`
    await sdkListTools(deps, target(url))
    const before = wire(url).length
    expect(await sdkCallTool(deps, target(url), { tool: REGION, args: { region: 'eu' }, mode: 'read' })).toMatchObject({ kind: 'error', reason: 'header_mismatch' })
    expect(wire(url).slice(before)).toEqual(['tools/call'])
  })

  it('a 401 on a write is 1 POST: no sign-in, no retry, sent unknown', async () => {
    const url = `${MODERN}/key/mcp`
    const key = { header: 'X-Api-Key', value: MODERN_KEY }
    expect(await sdkListTools(deps, target(url, { credential: key }))).toMatchObject({ kind: 'ok' })
    fx.revokeKey('modern')
    const before = wire(url).length
    const out = await sdkCallTool(deps, target(url, { credential: key }), { tool: WRITE, args: { folder: 'ops', text: 'x' }, mode: 'write' })
    expect(out).toMatchObject({ kind: 'error', reason: 'unauthorized', sent: 'unknown' })
    expect(wire(url).slice(before)).toEqual(['tools/call'])
    expect(fx.log.entries.filter(e => e.host !== new URL(MODERN).host)).toEqual([])
  })

  it('a 401 on a read comes back as it is (core.ts renews and calls again): 1 POST', async () => {
    const url = `${MODERN}/key/mcp`
    await sdkListTools(deps, target(url, { credential: { header: 'X-Api-Key', value: MODERN_KEY } }))
    const before = wire(url).length
    const out = await sdkCallTool(deps, target(url, { credential: { header: 'X-Api-Key', value: 'wrong' } }), { tool: def('notes_read'), args: { id: 'n1' }, mode: 'read' })
    expect(out).toMatchObject({ kind: 'error', reason: 'unauthorized' })
    expect(wire(url).slice(before)).toEqual(['tools/call'])
  })

  it('a reused 2025 session the server no longer knows: a read starts a new session and is sent once more', async () => {
    const url = `${LEGACY}/mcp`
    const first = await sdkCallTool(deps, target(url), { tool: def('notes_read'), args: { id: 'n1' }, mode: 'read' })
    expect(first.kind).toBe('ok')
    const session = first.kind === 'ok' ? first.session! : null
    fx.legacy.sessions.clear()
    const before = wire(url).length
    const out = await sdkCallTool(deps, target(url), { tool: def('notes_read'), args: { id: 'n2' }, mode: 'read', session })
    expect(out).toMatchObject({ kind: 'ok' })
    expect(out.kind === 'ok' && out.session?.id).not.toBe(session?.id)
    expect(wire(url).slice(before)).toEqual(['tools/call', 'initialize', 'notifications/initialized', 'tools/call'])
  })

  it('a write on a 2025 server starts its own session, whatever session it is offered', async () => {
    const url = `${LEGACY}/mcp`
    const first = await sdkCallTool(deps, target(url), { tool: def('notes_read'), args: { id: 'n1' }, mode: 'read' })
    const before = wire(url).length
    const out = await sdkCallTool(deps, target(url), { tool: WRITE, args: { folder: 'ops', text: 'x' }, mode: 'write', session: first.kind === 'ok' ? first.session : null })
    expect(out).toMatchObject({ kind: 'ok', session: null })
    expect(wire(url).slice(before)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    expect(fx.legacy.writes).toHaveLength(1)
  })

  it('a 403 insufficient_scope is 1 POST and starts no sign-in (onInsufficientScope: throw)', async () => {
    const url = `${MODERN}/as/std/mcp`
    const s = await signIn(fx, 'std', { scope: 'notes:read' })
    const bearer = { header: 'Authorization', value: `Bearer ${s.access}` }
    expect(await sdkListTools(deps, target(url, { credential: bearer }))).toMatchObject({ kind: 'ok' })
    fx.log.clear()
    const out = await sdkCallTool(deps, target(url, { credential: bearer }), { tool: WRITE, args: { folder: 'ops', text: 'x' }, mode: 'write' })
    expect(out).toMatchObject({ kind: 'error', reason: 'insufficient_scope', sent: 'unknown' })
    expect(fx.log.entries.map(e => `${e.host} ${e.rpc ?? e.method}`)).toEqual([`${new URL(MODERN).host} tools/call`])
  })
})

describe('input_required (2026-07-28 basic/patterns/mrtr)', () => {
  const url = `${MODERN}/input/mcp`
  const TOPIC = def('ask_state', { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] })

  it('state only, on a read: retried once at once, echoing the state, on a new id', async () => {
    await sdkListTools(deps, target(url))
    const out = await sdkCallTool(deps, target(url), { tool: TOPIC, args: { topic: 'stock' }, mode: 'read' })
    expect(out).toMatchObject({ kind: 'ok' })
    expect(out.kind === 'ok' && JSON.parse(out.result.content[0]!.text)).toEqual({ topic: 'stock', rounds: 2 })
    expect(calls(url)).toBe(2)
    expect(fx.modern.violations).toEqual([])
  })

  it('with a question: needs_input, 1 POST, nothing answered', async () => {
    await sdkListTools(deps, target(url))
    const out = await sdkCallTool(deps, target(url), { tool: { ...TOPIC, name: 'ask_user_anyway' }, args: { topic: 'stock' }, mode: 'read' })
    expect(out).toMatchObject({ kind: 'error', reason: 'needs_input', sent: 'unknown' })
    expect(calls(url)).toBe(1)
  })

  it('a tool that needs a capability we never declared is refused by the server (-32021): rejected, 1 POST', async () => {
    await sdkListTools(deps, target(url))
    expect(await sdkCallTool(deps, target(url), { tool: { ...TOPIC, name: 'ask_user' }, args: { topic: 'stock' }, mode: 'read' })).toMatchObject({ kind: 'error', reason: 'rejected' })
    expect(calls(url)).toBe(1)
  })

  it('state only, on a write: 1 POST and no follow-up', async () => {
    await sdkListTools(deps, target(url))
    expect(await sdkCallTool(deps, target(url), { tool: TOPIC, args: { topic: 'stock' }, mode: 'write' })).toMatchObject({ kind: 'error', reason: 'needs_input', sent: 'unknown' })
    expect(calls(url)).toBe(1)
  })
})

describe('planted bad answers write nothing to the console and carry no upstream text', () => {
  const plant = (answer: (req: Request) => Response | Promise<Response>): SdkDeps => ({ ...deps, upstream: async req => (new URL(req.url).pathname === '/open/mcp' && (await req.clone().text()).includes('"tools/') ? answer(req) : fx.fetch(req)) })
  const SECRET = 'UPSTREAM-RAW-BODY-c41e'
  const cases: [string, (req: Request) => Response | Promise<Response>, string][] = [
    ['a body that is not JSON', () => new Response(`<html>${SECRET}</html>`, { status: 200, headers: { 'Content-Type': 'application/json' } }), 'malformed'],
    ['an HTML error page', () => new Response(`<html>${SECRET}</html>`, { status: 502, headers: { 'Content-Type': 'text/html' } }), 'unavailable'],
    ['a JSON-RPC error with upstream text', async req => Response.json({ jsonrpc: '2.0', id: ((await req.json()) as { id: number }).id, error: { code: -32603, message: SECRET, data: { secret: SECRET } } }), 'rejected'],
    ['a tool list with a broken x-mcp-header', async req => Response.json({ jsonrpc: '2.0', id: ((await req.json()) as { id: number }).id, result: { resultType: 'complete', ttlMs: 0, cacheScope: 'public', tools: [{ name: 'bad', description: SECRET, inputSchema: { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'Bad Name' } } } }] } }), 'ok'],
    ['an answer over the byte cap', () => new Response(JSON.stringify({ pad: SECRET.repeat(1000) }), { status: 200, headers: { 'Content-Type': 'application/json' } }), 'too_large'],
    ['a 401 with a challenge', () => new Response(SECRET, { status: 401, headers: { 'WWW-Authenticate': `Bearer error="invalid_token", error_description="${SECRET}"` } }), 'unauthorized'],
  ]
  it.each(cases)('%s', async (_name, answer, reason) => {
    const d = { ...plant(answer), maxBytes: 4_096 }
    const out = await sdkListTools(d, target(`${MODERN}/open/mcp`))
    expect(reason === 'ok' ? out.kind : out.kind === 'error' && out.reason).toBe(reason)
    if (reason !== 'ok') expect(JSON.stringify(out)).not.toContain(SECRET)
    const call = await sdkCallTool(d, target(`${MODERN}/open/mcp`), { tool: def('notes_read'), args: { id: 'n1' }, mode: 'read' })
    expect(JSON.stringify(call)).not.toContain(SECRET)
  })
})
