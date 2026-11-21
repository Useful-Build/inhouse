// The `inhouse` MCP server's wire (p3-design section 10). Ways it can fail, written down first:
//  1. a JSON-RPC message answered wrong: an unknown method, bad params, a notification or a client response not 202
//     with no body, a batch or a broken body not refused, GET or DELETE not 405, a foreign Origin or protocol version let
//     through, `initialize` not negotiating (echo a version it speaks, else its newest);
//  2. `tools/list` not exactly the approved 20, or the always-loaded six wrong (names and the six are literals here, from
//     agent-tools, never read from the registry), or a tool without an object input schema;
//  3. an unbuilt tool doing anything but a typed `not_available_yet`; an unknown tool not a protocol error; bad
//     arguments not a tool error the agent can read;
//  4. a routine's run (the system row) saving a "person" fact (A1's ask H);
//  5. a description that promises what P3 doesn't do (history over routine runs; notifications by email).
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { handleMcp } from './index.ts'

const db = env.DB
const NOW = 1_800_000_000_000
const SCOPE = { memberId: 'm_system', chatId: 'c_wire', runId: 'r_AAAAAAAAAAAAAAAAAAAAAA', turnId: 't_AAAAAAAAAAAAAAAAAAAAAA' }

const THE_20 = [
  'memory_search', 'memory_save', 'memory_update', 'memory_forget', 'memory_list',
  'approval_request', 'approval_get', 'approval_list', 'approval_withdraw',
  'question_ask',
  'routine_create', 'routine_list', 'routine_update', 'routine_delete', 'routine_run_now',
  'history_search', 'history_read',
  'notification_send',
  'team_request_create', 'team_request_list',
]
const THE_6 = ['memory_search', 'memory_save', 'approval_request', 'question_ask', 'history_search', 'notification_send']
const BUILT = ['memory_search', 'memory_save', 'memory_update', 'memory_forget', 'memory_list', 'history_search', 'history_read', 'notification_send']

const post = (body: string, headers: Record<string, string> = {}, scope = SCOPE) =>
  handleMcp(new Request('http://egress.internal/mcp/', { method: 'POST', body, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }), scope, { db, now: () => NOW })
const rpc = async (msg: unknown, headers: Record<string, string> = {}, scope = SCOPE) => {
  const res = await post(JSON.stringify(msg), headers, scope)
  const text = await res.text()
  return { status: res.status, body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>), type: res.headers.get('Content-Type') }
}
const call = async (name: string, args: unknown, scope = SCOPE) => {
  const r = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, {}, scope)
  return (r.body as { result: { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text: string }[] } }).result
}

describe('JSON-RPC over POST, literal pairs (failure 1)', () => {
  it('GET and DELETE are 405 with Allow: POST, and nothing else runs', async () => {
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const res = await handleMcp(new Request('http://egress.internal/mcp/', { method }), SCOPE, { db })
      expect(res.status, method).toBe(405)
      expect(res.headers.get('Allow')).toBe('POST')
      expect(await res.text()).toBe('')
    }
  })
  it('refuses any Origin with 403, and an unsupported MCP-Protocol-Version with 400', async () => {
    expect(await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })).toEqual({ status: 403, type: 'application/json', body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Origin not allowed' } } })
    expect(await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '1999-01-01' })).toEqual({ status: 400, type: 'application/json', body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Unsupported MCP-Protocol-Version' } } })
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '2025-11-25' })).status).toBe(200)
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200)
  })
  it('a body that is not JSON is a parse error; a batch, a wrong jsonrpc, a null id or a shapeless message is invalid', async () => {
    const res = await post('{"jsonrpc": "2.0", "id": 1,')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    expect(await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).toEqual({ status: 400, type: 'application/json', body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported: send one message per POST' } } })
    for (const bad of [{ jsonrpc: '1.0', id: 1, method: 'ping' }, { id: 1, method: 'ping' }, 'ping', 42, null, { jsonrpc: '2.0' }, { jsonrpc: '2.0', id: 1 }]) {
      expect(await rpc(bad), JSON.stringify(bad)).toEqual({ status: 400, type: 'application/json', body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } })
    }
    for (const id of [null, 1.5, { a: 1 }, true]) {
      expect((await rpc({ jsonrpc: '2.0', id, method: 'ping' })).body, JSON.stringify(id)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: id must be a string or an integer' } })
    }
  })
  it('a notification and a client response are 202 with no body', async () => {
    expect(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({ status: 202, body: null, type: null })
    expect(await rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } })).toEqual({ status: 202, body: null, type: null })
    expect(await rpc({ jsonrpc: '2.0', id: 9, result: {} })).toEqual({ status: 202, body: null, type: null })
    expect(await rpc({ jsonrpc: '2.0', id: 9, error: { code: 1, message: 'x' } })).toEqual({ status: 202, body: null, type: null })
  })
  it('an unknown method is -32601; params that are not an object are -32602', async () => {
    expect(await rpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).toEqual({ status: 200, type: 'application/json', body: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found: resources/list' } } })
    expect((await rpc({ jsonrpc: '2.0', id: 'x', method: 'tools/list', params: [1] })).body).toEqual({ jsonrpc: '2.0', id: 'x', error: { code: -32602, message: 'params must be an object' } })
  })
  it('ping answers an empty result with the same id', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 'a-1', method: 'ping' })).body).toEqual({ jsonrpc: '2.0', id: 'a-1', result: {} })
  })
  it('initialize echoes a version it speaks, else answers its newest; no version is -32602', async () => {
    const init = async (protocolVersion: unknown) => (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '1' } } })).body
    const result = (v: string) => ({ jsonrpc: '2.0', id: 1, result: { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'inhouse', version: '1.0.0' } } })
    expect(await init('2025-11-25')).toEqual(result('2025-11-25'))
    expect(await init('2025-06-18')).toEqual(result('2025-06-18'))
    expect(await init('2025-03-26')).toEqual(result('2025-03-26'))
    expect(await init('2024-11-05')).toEqual(result('2025-11-25'))
    expect(await init('1.0.0')).toEqual(result('2025-11-25'))
    expect(await init(undefined)).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'initialize needs params.protocolVersion' } })
  })
})

describe('tools/list (failure 2)', () => {
  it('is exactly the 20, in order, the six marked always-load, each with an object input schema', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = (body as { result: { tools: { name: string; description: string; inputSchema: { type: string }; _meta?: Record<string, unknown>; annotations: Record<string, unknown> }[] } }).result.tools
    expect(tools.map(t => t.name)).toEqual(THE_20)
    expect(tools.filter(t => t._meta?.['anthropic/alwaysLoad'] === true).map(t => t.name)).toEqual(THE_6)
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe('object')
      expect(t.description.length, t.name).toBeGreaterThan(30)
      if (!THE_6.includes(t.name)) expect(t._meta, t.name).toBeUndefined()
    }
    expect(tools.filter(t => t.annotations.readOnlyHint === true).map(t => t.name)).toEqual(['memory_search', 'memory_list', 'approval_get', 'approval_list', 'routine_list', 'history_search', 'history_read', 'team_request_list'])
    expect(tools.filter(t => t.annotations.destructiveHint === true).map(t => t.name)).toEqual(['memory_forget', 'approval_withdraw', 'routine_delete'])
    // The built tools take what agent-tools says their parameters hold.
    const props = (name: string) => Object.keys((tools.find(t => t.name === name)!.inputSchema as unknown as { properties: Record<string, unknown> }).properties).sort()
    expect(props('memory_save')).toEqual(['scope', 'text'])
    expect(props('memory_update')).toEqual(['memory_id', 'text'])
    expect(props('memory_forget')).toEqual(['memory_id'])
    expect(props('history_read')).toEqual(['chat_id', 'from_position', 'limit'])
  })
})

describe('tools/call (failure 3)', () => {
  it('every unbuilt tool answers a typed not_available_yet, and writes nothing', async () => {
    const before = await db.prepare('SELECT COUNT(*) AS n FROM memories').first<number>('n')
    for (const name of THE_20.filter(n => !BUILT.includes(n))) {
      const r = await call(name, { anything: 1 })
      expect(r.isError, name).toBe(true)
      expect(r.structuredContent, name).toEqual({ error: 'not_available_yet' })
      expect(r.content[0].text, name).toContain(`${name} isn't available yet`)
    }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM memories').first<number>('n')).toBe(before)
  })
  it('an unknown tool is a protocol error (-32602); bad arguments are a tool error the agent reads', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_delete', arguments: {} } })).body).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'Unknown tool: memory_delete' } })
    expect((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} })).body).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'Unknown tool: (no name)' } })
    for (const args of [{ scope: 'team', text: 'x' }, { scope: 'brand' }, { scope: 'brand', text: '' }, { scope: 'brand', text: 'x'.repeat(501) }, { scope: 'brand', text: 'ok', memberId: 'm_other' }]) {
      const r = await call('memory_save', args)
      expect(r.isError, JSON.stringify(args)).toBe(true)
      expect(r.structuredContent, JSON.stringify(args)).toEqual({ error: 'invalid_arguments' })
    }
  })
})

describe("a routine's run (the system row, A1's ask H) (failure 4)", () => {
  it('never saves a person fact, and still saves a brand fact, waiting', async () => {
    const before = await db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope = 'person'").first<number>('n')
    const r = await call('memory_save', { scope: 'person', text: 'Prefers weekly stock summaries' })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toEqual({ error: 'person_scope_in_routine' })
    expect(await db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope = 'person'").first<number>('n')).toBe(before)
    const ok = await call('memory_save', { scope: 'brand', text: 'Routine checks stock at six' })
    expect(ok.isError).toBeUndefined()
    expect(await db.prepare("SELECT status, created_by FROM memories WHERE text = 'Routine checks stock at six'").first()).toEqual({ status: 'waiting', created_by: 'm_system' })
  })
})

describe('descriptions promise only what P3 does (failure 5)', () => {
  it('history covers own chats only; notifications go to the bell and admin-listed Slack channels, never email', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const d = Object.fromEntries((body as { result: { tools: { name: string; description: string }[] } }).result.tools.map(t => [t.name, t.description]))
    expect(d.history_search).not.toMatch(/routine|run\b|activity/i)
    expect(d.history_read).not.toMatch(/routine|run\b/i)
    expect(d.notification_send).toContain('Sends a notification: to the bell for members; to admin-listed Slack channels from the Act stage.')
    expect(d.notification_send).not.toMatch(/email/i)
  })
})
