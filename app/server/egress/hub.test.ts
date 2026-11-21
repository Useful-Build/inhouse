// The egress's `hub` route (P4 H1) against a fake ReadGateway. Expected bodies are literals written here, never built by
// the code under test. Ways it can fail, written down first:
//  1. the run token reaches a response body, a header or a log line; the hub's data or message reaches a log line, or
//     the hub's text reaches anything but the `tools/call` answer it belongs to (a binding failure's text included);
//  2. a JSON-RPC request is answered with the wrong shape or code (version negotiation, a notification, ping, a batch,
//     bad JSON, bad params, an unknown method, a hub error, a throwing or malformed binding);
//  3. a listed tool carries `_meta` (so `anthropic/alwaysLoad` could load it upfront) or isn't marked read only;
//  4. the scope the hub sees takes anything from the request body, or isn't exactly the grant's run and member;
//  5. a GET, DELETE or other path reaches the hub; a body over 64 KiB is read whole.
import { fc, it } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import type { CallerScope, HubErrorCode, HubResult, ToolInfo } from '../../hub/index/contract.ts'
import type { RunGrant } from '../do/brand-agent/tokens.ts'
import { handleHub, type HubEgressLog, type HubRouteDeps, type ReadGatewayLike } from './hub.ts'

const GRANT: RunGrant = {
  turnId: 't_turn1', runId: 'r_run1', chatId: 'chat-a', memberId: 'm_alice', sessionId: '00000000-0000-4000-8000-00000000000a',
  model: 'claude-sonnet-5-5', sideModel: 'claude-haiku-5-5', expiresAtMs: 4_102_444_800_000,
}
const ERROR_CODES: HubErrorCode[] = [
  'invalid_args', 'unknown_tool', 'write_refused', 'not_configured', 'credentials_rejected', 'scope_mismatch', 'key_unavailable',
  'upstream_unavailable', 'upstream_rejected', 'upstream_version_mismatch', 'rate_limited', 'result_too_large', 'internal',
]
const TOOLS: ToolInfo[] = [
  { name: 'orders_search', connector: 'shopify', description: 'Search orders.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  { name: 'products_get', connector: 'shopify', description: 'Get a product.', inputSchema: { type: 'object', additionalProperties: false } },
]

interface Fake {
  deps: HubRouteDeps
  scopes: CallerScope[]
  calls: { name: string; args: unknown }[]
  logs: HubEgressLog[]
  list: () => Promise<unknown>
  call: () => Promise<unknown>
}
function fake(): Fake {
  let n = 0
  const f: Fake = {
    scopes: [], calls: [], logs: [],
    list: async () => ({ ok: true, value: TOOLS }),
    call: async () => ({ ok: true, value: { data: { count: 2 } } }),
    deps: undefined as unknown as HubRouteDeps,
  }
  const hub: ReadGatewayLike = {
    listTools: async scope => {
      f.scopes.push(scope)
      return (await f.list()) as HubResult<ToolInfo[]>
    },
    callTool: async (scope, name, args) => {
      f.scopes.push(scope)
      f.calls.push({ name, args })
      return (await f.call()) as HubResult<{ data: unknown }>
    },
  }
  f.deps = { hub, now: () => 1_800_000_000_000, requestId: () => `req-${++n}`, log: e => void f.logs.push(e) }
  return f
}

const rpc = (body: unknown, init: { method?: string; headers?: Record<string, string>; path?: string } = {}) =>
  new Request(`http://egress.internal${init.path ?? '/hub/'}`, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: (init.method ?? 'POST') === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  })
const call = async (f: Fake, body: unknown, init?: Parameters<typeof rpc>[1], grant = GRANT) => {
  const res = await handleHub(rpc(body, init), grant, f.deps)
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, body: text === '' ? null : (JSON.parse(text) as unknown) }
}

describe('JSON-RPC mapping against literal pairs (failure 2)', () => {
  it('initialize: a supported version is answered with itself, an unsupported one with 2025-11-25', async () => {
    const f = fake()
    expect((await call(f, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } })).body).toEqual({
      jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'apps', version: '1.0.0' } },
    })
    expect((await call(f, { jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '1999-01-01' } })).body).toEqual({
      jsonrpc: '2.0', id: 'a', result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'apps', version: '1.0.0' } },
    })
    expect((await call(f, { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })).body).toEqual({
      jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'initialize needs params.protocolVersion' },
    })
    expect(f.scopes).toEqual([])
  })

  it('a notification is 202 with no body; ping is {}', async () => {
    const f = fake()
    const n = await call(f, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect([n.status, n.text]).toEqual([202, ''])
    expect((await call(f, { jsonrpc: '2.0', id: 3, method: 'ping' })).body).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
  })

  it('tools/list: each ToolInfo as name, description, inputSchema and a read-only hint; a cursor is ignored', async () => {
    const f = fake()
    expect((await call(f, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { cursor: 'x' } })).body).toEqual({
      jsonrpc: '2.0', id: 4, result: { tools: [
        { name: 'orders_search', description: 'Search orders.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
        { name: 'products_get', description: 'Get a product.', inputSchema: { type: 'object', additionalProperties: false }, annotations: { readOnlyHint: true } },
      ] },
    })
  })

  it('tools/list: a hub error is -32603 naming the code only', async () => {
    const f = fake()
    f.list = async () => ({ ok: false, error: { code: 'not_configured', message: 'Shopify is not connected.' } })
    expect((await call(f, { jsonrpc: '2.0', id: 5, method: 'tools/list' })).body).toEqual({ jsonrpc: '2.0', id: 5, error: { code: -32603, message: 'hub: not_configured' } })
  })

  it('tools/call ok: the data as JSON text', async () => {
    const f = fake()
    expect((await call(f, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'orders_search', arguments: { q: 'late' } } })).body).toEqual({
      jsonrpc: '2.0', id: 6, result: { content: [{ type: 'text', text: '{"count":2}' }] },
    })
    expect(f.calls).toEqual([{ name: 'orders_search', args: { q: 'late' } }])
    // No arguments: the hub gets {}.
    await call(f, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'products_get' } })
    expect(f.calls[1]).toEqual({ name: 'products_get', args: {} })
  })

  it.each(ERROR_CODES)('tools/call %s: a tool execution error with the code and the hub message', async code => {
    const f = fake()
    f.call = async () => ({ ok: false, error: { code, message: 'Fixed text.' } })
    expect((await call(f, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'orders_search' } })).body).toEqual({
      jsonrpc: '2.0', id: 8, result: { content: [{ type: 'text', text: `${code}: Fixed text.` }], isError: true },
    })
  })

  it('tools/call rate_limited with retryAfterMs: the wait in whole seconds, rounded up', async () => {
    const f = fake()
    f.call = async () => ({ ok: false, error: { code: 'rate_limited', message: 'Shopify is busy.', retryAfterMs: 2_100 } })
    expect((await call(f, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'orders_search' } })).body).toEqual({
      jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text: 'rate_limited: Shopify is busy. (retry after 3 s)' }], isError: true },
    })
  })

  it('a throwing or malformed binding: internal error, never its text; logged binding_failed', async () => {
    for (const bad of [async () => { throw new Error('binding exploded') }, async () => ({ ok: 'yes' }), async () => ({ ok: false, error: { code: 'nope', message: 'x' } })]) {
      const f = fake()
      f.call = bad
      f.list = bad
      expect((await call(f, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'orders_search' } })).body).toEqual({
        jsonrpc: '2.0', id: 10, result: { content: [{ type: 'text', text: 'internal: internal error' }], isError: true },
      })
      expect((await call(f, { jsonrpc: '2.0', id: 11, method: 'tools/list' })).body).toEqual({ jsonrpc: '2.0', id: 11, error: { code: -32603, message: 'hub: internal' } })
      expect(f.logs.map(l => l.code)).toEqual(['binding_failed', 'binding_failed'])
    }
  })

  it('unknown method, bad params, a batch, bad JSON', async () => {
    const f = fake()
    expect((await call(f, { jsonrpc: '2.0', id: 12, method: 'resources/list' })).body).toEqual({ jsonrpc: '2.0', id: 12, error: { code: -32601, message: 'Method not found' } })
    const badParams = { code: -32602, message: 'tools/call needs params.name (a string) and params.arguments (an object, if given)' }
    expect((await call(f, { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { arguments: {} } })).body).toEqual({ jsonrpc: '2.0', id: 13, error: badParams })
    expect((await call(f, { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'x', arguments: [1] } })).body).toEqual({ jsonrpc: '2.0', id: 14, error: badParams })
    expect((await call(f, { jsonrpc: '2.0', id: 15, method: 'tools/call', params: 'x' })).body).toEqual({ jsonrpc: '2.0', id: 15, error: { code: -32602, message: 'params must be an object' } })
    const batch = await call(f, [{ jsonrpc: '2.0', id: 16, method: 'ping' }])
    expect([batch.status, batch.body]).toEqual([400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported: send one message per POST' } }])
    const bad = await call(f, '{"jsonrpc":')
    expect([bad.status, bad.body]).toEqual([400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }])
    expect(f.scopes).toEqual([])
  })
})

describe('the HTTP edges (failure 5)', () => {
  it('GET and DELETE are 405; another path is 404; a non-JSON body is 415; none reaches the hub', async () => {
    const f = fake()
    for (const method of ['GET', 'DELETE']) {
      const r = await call(f, null, { method })
      expect([r.status, r.headers.get('Allow'), r.body]).toEqual([405, 'POST', { error: 'method' }])
    }
    for (const path of ['/hub', '/hub/x', '/hubx/']) expect((await call(f, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { path })).status).toBe(404)
    expect((await call(f, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect(f.scopes).toEqual([])
  })

  it('a body over 64 KiB is 413 (declared or streamed); exactly 64 KiB is read', async () => {
    const f = fake()
    const pad = (n: number) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(n) } })
    const base = pad(0).length
    expect((await call(f, pad(64 * 1024 - base))).status).toBe(200)
    expect((await call(f, pad(64 * 1024 - base + 1))).status).toBe(413)
    const streamed = new Request('http://egress.internal/hub/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: new Blob([pad(70_000)]).stream(), duplex: 'half',
    } as RequestInit)
    expect((await handleHub(streamed, GRANT, f.deps)).status).toBe(413)
  })

  it('every answer is application/json and no-store, and carries no hub header', async () => {
    const f = fake()
    for (const body of [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'orders_search' } }, '[]']) {
      const r = await call(f, body)
      expect([r.headers.get('content-type'), r.headers.get('cache-control')]).toEqual(['application/json', 'no-store'])
    }
  })
})

describe('no _meta, read-only hint (failure 3)', () => {
  const toolInfo = fc.record({
    name: fc.string({ minLength: 1, maxLength: 40 }),
    connector: fc.string({ maxLength: 20 }),
    description: fc.string({ maxLength: 80 }),
    inputSchema: fc.dictionary(fc.string({ maxLength: 10 }), fc.jsonValue({ maxDepth: 2 })),
  })
  it.prop([fc.array(toolInfo, { maxLength: 12 })])('every listed tool is read only and has no _meta', async tools => {
    const f = fake()
    f.list = async () => ({ ok: true, value: tools })
    const r = (await call(f, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body as { result: { tools: Record<string, unknown>[] } }
    expect(r.result.tools).toHaveLength(tools.length)
    for (const t of r.result.tools) {
      expect(Object.keys(t).sort()).toEqual(['annotations', 'description', 'inputSchema', 'name'])
      expect(t.annotations).toEqual({ readOnlyHint: true })
      expect(JSON.stringify(t.annotations)).not.toContain('_meta')
    }
  })
})

describe('the scope the hub sees (failure 4)', () => {
  const id = fc.stringMatching(/^[a-z0-9_-]{1,30}$/)
  it.prop([id, id, id, fc.constantFrom('tools/list', 'tools/call')])('exactly the grant run and member, whatever the body says', async (runId, memberId, other, method) => {
    const f = fake()
    const grant = { ...GRANT, runId, memberId }
    const params = { name: 'orders_search', arguments: { runId: other, principalId: other, scope: { kind: 'server', job: other } }, runId: other, principalId: other, scope: { kind: 'server' }, chatId: other }
    await call(f, { jsonrpc: '2.0', id: 1, method, params, runId: other, scope: { kind: 'server', job: other } }, undefined, grant)
    expect(f.scopes).toEqual([{ kind: 'run', runId, principalId: memberId, requestId: 'req-1' }])
  })

  it('a fresh request id per call', async () => {
    const f = fake()
    await call(f, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    await call(f, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'orders_search' } })
    expect(f.scopes.map(s => (s as { requestId: string }).requestId)).toEqual(['req-1', 'req-2'])
  })
})

describe('the canary sweep (failure 1)', () => {
  let printed: string[] = []
  beforeEach(() => {
    printed = []
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')))
  })
  afterEach(() => vi.restoreAllMocks())

  type Outcome = 'ok' | HubErrorCode | 'throw' | 'malformed'
  const outcomes: Outcome[] = ['ok', ...ERROR_CODES, 'throw', 'malformed']
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'orders_search', arguments: { q: 'x' } } },
    { jsonrpc: '2.0', id: 5, method: 'nope' },
    '{bad json',
    [{ jsonrpc: '2.0', id: 6, method: 'ping' }],
  ]
  const canary = fc.stringMatching(/^[a-z0-9]{24}$/).map(s => `canary_${s}`)

  it.prop([canary, canary, fc.constantFrom(...outcomes)], { numRuns: 60 })('the token is nowhere; the hub text only in the tools/call answer, never a log', async (token, hubCanary, outcome) => {
    fc.pre(token !== hubCanary)
    const f = fake()
    // The dispatch is the egress's; this handler gets the request as the runner sent it, token header included.
    f.deps.log = e => console.log(e)
    const answer = async () => {
      if (outcome === 'throw') throw new Error(`exploded ${token} ${hubCanary}`)
      if (outcome === 'malformed') return { ok: true, value: { data: hubCanary }, extra: hubCanary, error: hubCanary, broken: 1 } as unknown as object
      if (outcome === 'ok') return { ok: true, value: { data: { note: hubCanary } } }
      return { ok: false, error: { code: outcome, message: `Fixed text ${hubCanary}.`, retryAfterMs: 1_000 } }
    }
    f.call = answer
    f.list = async () => {
      const a = (await answer()) as { ok: boolean }
      return a.ok ? { ok: true, value: [{ ...TOOLS[0]!, description: 'Search orders.' }] } : a
    }
    const seen: string[] = []
    for (const body of requests) {
      const r = await call(f, body, { headers: { 'x-inhouse-run-token': token } })
      const headers = JSON.stringify([...r.headers])
      expect(r.text + headers).not.toContain(token)
      expect(headers).not.toContain(hubCanary)
      if (r.text.includes(hubCanary)) seen.push((body as { method?: string }).method ?? '')
    }
    for (const big of ['x'.repeat(70_000)]) {
      const r = await call(f, JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: big } }), { headers: { 'x-inhouse-run-token': token } })
      expect(r.status).toBe(413)
      expect(r.text).not.toContain(token)
    }
    const r405 = await call(f, null, { method: 'GET', headers: { 'x-inhouse-run-token': token } })
    expect(r405.text + JSON.stringify([...r405.headers])).not.toContain(token)
    // The hub's text reaches the model only through the tools/call answer it belongs to: data on ok, the fixed message
    // on a hub error. Never on a throw or a malformed answer, never through tools/list.
    expect(seen).toEqual(outcome === 'throw' || outcome === 'malformed' ? [] : ['tools/call'])
    expect(printed.length).toBeGreaterThan(0)
    for (const line of printed) {
      expect(line).not.toContain(token)
      expect(line).not.toContain(hubCanary)
    }
  })
})
