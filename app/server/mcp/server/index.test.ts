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
import { QUESTIONS_ON } from '../../questions/switch.ts'

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
  // P6a brand skills (master plan standing decision 6).
  'skill_save',
]
const THE_6 = ['memory_search', 'memory_save', 'approval_request', 'question_ask', 'history_search', 'notification_send']
const BUILT = ['memory_search', 'memory_save', 'memory_update', 'memory_forget', 'memory_list', 'history_search', 'history_read',
  // P4 W2: the routine tools.
  'routine_create', 'routine_list', 'routine_update', 'routine_delete', 'routine_run_now',
  // P5 W4: notification_send.
  'notification_send',
  // P6a W3: the Inhouse team tools.
  'team_request_create', 'team_request_list',
  // P6a brand skills.
  'skill_save',
  // Stage 1 M2-E: the approval tools (their own tests: tools/approvals/tools.test.ts).
  'approval_request', 'approval_get', 'approval_list', 'approval_withdraw']

/** `extra`: more of the handler's deps (Stage 1 M2-Q's `questions`). */
type Extra = { questions?: boolean }
const post = (body: string, headers: Record<string, string> = {}, scope = SCOPE, extra: Extra = {}) =>
  handleMcp(new Request('http://egress.internal/mcp/', { method: 'POST', body, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }), scope, { db, now: () => NOW, ...extra })
const rpc = async (msg: unknown, headers: Record<string, string> = {}, scope = SCOPE, extra: Extra = {}) => {
  const res = await post(JSON.stringify(msg), headers, scope, extra)
  const text = await res.text()
  return { status: res.status, body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>), type: res.headers.get('Content-Type') }
}
const call = async (name: string, args: unknown, scope = SCOPE, extra: Extra = {}) => {
  const r = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, {}, scope, extra)
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
  it('with questions on: exactly the 20, in order, the six marked always-load, each with an object input schema', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {}, SCOPE, { questions: true })
    const tools = (body as { result: { tools: { name: string; description: string; inputSchema: { type: string }; _meta?: Record<string, unknown>; annotations: Record<string, unknown> }[] } }).result.tools
    expect(tools.map(t => t.name)).toEqual(THE_20)
    expect(tools.filter(t => t._meta?.['anthropic/alwaysLoad'] === true).map(t => t.name)).toEqual(THE_6)
    expect(Object.keys((tools.find(t => t.name === 'question_ask')!.inputSchema as unknown as { properties: Record<string, unknown> }).properties).sort()).toEqual(['options', 'question'])
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

describe('questions on (Stage 1 M2-H) and the off switch kept (M2-Q)', () => {
  it("as the egress builds it (`questions: QUESTIONS_ON`), the product build's list has all 20, question_ask included", async () => {
    // vitest.config.ts defines the product build's flags.
    expect(QUESTIONS_ON).toBe(true)
    const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {}, SCOPE, { questions: QUESTIONS_ON })
    expect((body as { result: { tools: { name: string }[] } }).result.tools.map(t => t.name)).toEqual(THE_20)
  })

  it('off (false or absent): no question_ask (the other 19 as with questions on), and a call to it asks nothing', async () => {
    for (const extra of [{ questions: false }, {}]) {
      const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {}, SCOPE, extra)
      const names = (body as { result: { tools: { name: string }[] } }).result.tools.map(t => t.name)
      expect(names).toEqual(THE_20.filter(n => n !== 'question_ask'))
      const before = await db.prepare('SELECT COUNT(*) AS n FROM questions').first<number>('n')
      const r = await call('question_ask', { question: 'Which?', options: ['A', 'B'] }, SCOPE, extra)
      expect(r.structuredContent).toEqual({ error: 'not_available_yet' })
      expect(await db.prepare('SELECT COUNT(*) AS n FROM questions').first<number>('n')).toBe(before)
    }
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
  it('history covers own chats only; notifications go to the bell, a listed channel by the Slack post rule, never email', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const d = Object.fromEntries((body as { result: { tools: { name: string; description: string }[] } }).result.tools.map(t => [t.name, t.description]))
    expect(d.history_search).not.toMatch(/routine|run\b|activity/i)
    expect(d.history_read).not.toMatch(/routine|run\b/i)
    // P5 W4's description (p5-w4.md section 2): the bell for members; since M2-N (Q3 = A) a listed channel's post follows the
    // same rule as any Slack post (a person's OK unless a standing permission covers it), and no stage is named; email named
    // only to rule it out. It never promises a post goes out on its own.
    expect(d.notification_send).toContain('reaches their bell in the app (never a Slack DM, never email)')
    expect(d.notification_send).toContain("`to.channels` takes the names of channels the brand's admin listed: each post follows the same rule as any Slack post, so it waits for a person's OK in Approvals unless a standing permission covers that channel (then it posts after a short hold), and it's refused while Slack posts are off.")
    expect(d.notification_send).not.toMatch(/reaches the bell for now|posts (?:right away|at once|immediately)/)
    expect(d.notification_send).not.toMatch(/\b(?:Watch|Act|Run|stage)\b/)
    expect(d.notification_send.replace('never email', '')).not.toMatch(/email/i)
  })
})

describe('a stored Watch stage changes nothing here (M2-F; it was the P8a S switch)', () => {
  it("memory_save and team_request_create run with Watch stored", async () => {
    await db.prepare("DELETE FROM settings WHERE owner = 'brand' AND key = 'stage'").run()
    await db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 'stage', '\"Watch\"', 1, 0, 'm_x', 'r-watch')").run()
    const saved = await call('memory_save', { scope: 'brand', text: 'We restock on Fridays at Watch.' })
    expect(saved.isError).toBeFalsy()
    const memberId = 'm_watch_requester'
    await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Avery Example', ?)").bind(memberId, NOW).run()
    const team = await call('team_request_create', { kind: 'tool', text: 'Connect our helpdesk' }, { ...SCOPE, memberId })
    expect(team.isError).toBeFalsy()
    expect(team.structuredContent).toMatchObject({ created: true, text: 'Connect our helpdesk' })
  })
})
