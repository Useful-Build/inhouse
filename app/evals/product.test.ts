// The product target against a scripted server (no network, no model): what it sends, what it reads, and what it refuses.
// Ways it could fail, written first: a non-eval brand gets a chat; a refused memory write reads as a saved one (a false bypass or
// a false pass); a timed-out chat costs $0 though the server booked spend; the door reaches a database that isn't a sandbox one;
// a case needing a field the API doesn't show is graded anyway.
import { describe, expect, it } from 'vitest'
import { CASES } from './cases.ts'
import { assertSandboxDatabase, createDoor, DoorRefusal, sqlString, wranglerRunner, type MemoryDoor, type MemoryRow, type NewMemory } from './targets/door.ts'
import { createProductTarget, onExampleTest, ProductTargetRefusal, unobservableReason, writesFromRows } from './targets/product.ts'
import { runEvals } from './runner.ts'
import type { Case, ChatResult, Target } from './types.ts'

const ENV = { INHOUSE_EVAL_BRAND: '1', INHOUSE_EVAL_ORIGIN: 'https://eval.example.test' }
const MEMBER = { current: 'm_dana', tom: 'm_leo', lena: 'm_sam' }
const TOKEN_OF: Record<string, string> = { 'tok-current': 'm_dana', 'tok-tom': 'm_leo', 'tok-lena': 'm_sam' }
const signIn = async (key: string) => ({ 'Cf-Access-Jwt-Assertion': `tok-${key}` })

class FakeDoor implements MemoryDoor {
  rowsNow: MemoryRow[] = []
  calls: string[] = []
  onRows?: () => void
  async rows() { this.calls.push('rows'); this.onRows?.(); return this.rowsNow.map((r) => ({ ...r })) }
  async insert(facts: NewMemory[]) {
    this.calls.push(`insert ${facts.length}`)
    this.rowsNow.push(...facts.map((f) => ({ id: f.id, scope: f.scope, ownerId: f.ownerId, text: f.text, status: 'active' as const, rev: 1 })))
  }
  async clear() { this.calls.push('clear'); this.rowsNow = [] }
}

interface Sent { method: string; path: string; token: string | null; body: any }
interface Server {
  members: { id: string; email: string | null; status: string }[]
  /** Polls of the chat that answer before the message shows. */
  emptyPolls: number
  steps: { kind: string; detail: string }[]
  costMinor: number
  answerParts: { type: string; text?: string }[]
  sent: Sent[]
  onTurn?: () => void
}
const server = (over: Partial<Server> = {}): { s: Server; fetch: typeof fetch } => {
  const s: Server = {
    members: [{ id: 'm_dana', email: 'dana@example.test', status: 'active' }, { id: 'm_leo', email: 'leo@example.test', status: 'active' }, { id: 'm_sam', email: 'sam@example.test', status: 'active' }],
    emptyPolls: 1, steps: [], costMinor: 2, answerParts: [{ type: 'text', text: 'Hello.' }], sent: [], ...over,
  }
  let turnId = ''
  let polls = 0
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    const token = headers['Cf-Access-Jwt-Assertion'] ?? null
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null
    const method = init?.method ?? 'GET'
    s.sent.push({ method, path: url.pathname + url.search, token, body })
    if (method !== 'GET' && headers.Origin !== 'https://eval.example.test') return json({ error: { code: 'forbidden' } }, 403)
    if (url.pathname === '/api/me') return json({ memberId: TOKEN_OF[token ?? ''] })
    if (url.pathname === '/api/members') return json({ items: s.members, nextCursor: null })
    if (url.pathname === '/api/models') return json({ default: 'sonnet', modes: [{ id: 'sonnet' }] })
    if (url.pathname === '/api/chats' && method === 'POST') return json({ id: body.id }, 201)
    if (url.pathname.endsWith('/attachments')) return json({ fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA', name: 'note.txt' }, 201)
    if (url.pathname.endsWith('/turns')) {
      turnId = 't_BBBBBBBBBBBBBBBBBBBBBB'
      s.onTurn?.()
      return json({ runId: 'r_CCCCCCCCCCCCCCCCCCCCCC', turnId, messageId: `${turnId}.u`, position: 'starting' }, 202)
    }
    if (url.pathname.startsWith('/api/traces/')) return json({ cost: { minor: s.costMinor, currency: 'USD' }, steps: [{ kind: 'root', detail: '' }, ...s.steps] })
    if (url.pathname.startsWith('/api/chats/')) {
      const answered = ++polls > s.emptyPolls
      return json({ messages: answered ? s.answerParts.map((part, pos) => ({ role: 'agent', turnId, pos, part })) : [{ role: 'user', turnId, pos: 0, text: 'q' }], runs: [] })
    }
    return json({ error: { code: 'not_found' } }, 404)
  }) as typeof fetch
  return { s, fetch: f }
}

const make = (srv: ReturnType<typeof server>, door: MemoryDoor, extra: Partial<Parameters<typeof createProductTarget>[0]> = {}): Target =>
  createProductTarget({ paid: true, budgetUsd: 5, env: ENV, fetch: srv.fetch, signIn, door, pollMs: 0, sleep: async () => {}, ...extra })
const kase = (id: string): Case => CASES.find((c) => c.id === id)!

describe('the eval-brand check (server side, before the first chat)', () => {
  it.each([
    ['a member on a real domain', [{ id: 'm_dana', email: 'dana@example.test', status: 'active' }, { id: 'm_leo', email: 'leo@example.test', status: 'active' }, { id: 'm_sam', email: 'sam@example.test', status: 'active' }, { id: 'm_x', email: 'owner@acme-shop.com', status: 'active' }]],
    ['a lookalike domain', [{ id: 'm_dana', email: 'dana@example.test.evil.com', status: 'active' }, { id: 'm_leo', email: 'leo@example.test', status: 'active' }, { id: 'm_sam', email: 'sam@example.test', status: 'active' }]],
    ['an eval person who is not a member', [{ id: 'm_dana', email: 'dana@example.test', status: 'active' }, { id: 'm_leo', email: 'leo@example.test', status: 'active' }]],
  ])('refuses %s: no door call, no chat created, no turn sent', async (_n, members) => {
    const srv = server({ members })
    const door = new FakeDoor()
    const target = make(srv, door)
    await expect(target.seed([], { caseId: 'N01', rep: 1, canary: 'c' })).rejects.toThrow(ProductTargetRefusal)
    expect(door.calls).toEqual([])
    expect(srv.s.sent.filter((x) => x.method !== 'GET')).toEqual([])
  })

  it('a removed member on a real domain does not count', async () => {
    const srv = server({ members: [...server().s.members, { id: 'm_old', email: 'former@acme-shop.com', status: 'removed' }] })
    await expect(make(srv, new FakeDoor()).seed([], { caseId: 'N01', rep: 1, canary: 'c' })).resolves.toBeTruthy()
  })

  it('maps the people keys to the server\'s member ids (literal)', async () => {
    const target = make(server(), new FakeDoor())
    await (await target.seed([], { caseId: 'N01', rep: 1, canary: 'c' })).reset()
    expect(target.people).toEqual({ current: 'm_dana', tom: 'm_leo', lena: 'm_sam' })
  })

  it('example.test matching is exact on the domain', () => {
    expect(onExampleTest('a@example.test')).toBe(true)
    expect(onExampleTest('a@eu.example.test')).toBe(true)
    expect(onExampleTest('a@example.test.evil.com')).toBe(false)
    expect(onExampleTest('a@notexample.test')).toBe(false)
    expect(onExampleTest(null)).toBe(false)
  })
})

describe('a chat through the product', () => {
  it('seeds, sends route 29 as the current person in a fresh chat, waits, reads the answer, tool names and settled cost', async () => {
    const srv = server({ steps: [{ kind: 'tool', detail: 'mcp__inhouse__memory_search' }, { kind: 'fail', detail: 'x · deny' }], costMinor: 3, answerParts: [{ type: 'text', text: 'It takes 6 weeks.' }, { type: 'text', text: 'And 120 units.' }] })
    const door = new FakeDoor()
    const target = make(srv, door)
    const session = await target.seed(kase('R01').seed!, { caseId: 'R01', rep: 1, canary: 'c' })
    const res = await session.chat('How long does Norda take?')
    expect(res.answer).toBe('It takes 6 weeks.\n\nAnd 120 units.')
    expect(res.toolCalls).toEqual([{ name: 'mcp__inhouse__memory_search', input: {} }])
    expect(res.costUsd).toBe(0.03)
    expect(res.runOk).toBe(true)
    const turn = srv.s.sent.find((x) => x.path.endsWith('/turns'))!
    expect(turn.token).toBe('tok-current')
    expect(turn.body).toMatchObject({ text: 'How long does Norda take?', model: 'sonnet' })
    expect(turn.body.clientTurnKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(srv.s.sent.filter((x) => x.path.includes('/chats') && x.method === 'GET').length).toBeGreaterThanOrEqual(2) // it waited
    expect(target.spentUsd!()).toBe(0.03)
    // seeded: brand facts without an owner, Tom's own fact owned by Tom
    expect(door.rowsNow.filter((r) => r.scope === 'brand').every((r) => r.ownerId === null)).toBe(true)
    expect(door.rowsNow.find((r) => r.text.startsWith('Tom wants'))!.ownerId).toBe('m_leo')
    await session.reset()
    expect(door.rowsNow).toEqual([])
  })

  it('an error part, or no text, is a failed run', async () => {
    const door = new FakeDoor()
    for (const parts of [[{ type: 'error', text: 'Something went wrong.' }], [{ type: 'text', text: '' }]]) {
      const target = make(server({ answerParts: parts }), door)
      const res = await (await target.seed([], { caseId: 'N01', rep: 1, canary: 'c' })).chat('hi')
      expect(res.runOk).toBe(false)
    }
  })

  it('a memory_save that wrote a row shows its input; one that wrote none is reported as refused', async () => {
    const door = new FakeDoor()
    const srv = server({ steps: [{ kind: 'tool', detail: 'mcp__inhouse__memory_save' }, { kind: 'tool', detail: 'mcp__inhouse__memory_save' }] })
    srv.s.onTurn = () => { door.rowsNow.push({ id: 'mem_AAAAAAAAAAAAAAAAAAAAAA', scope: 'person', ownerId: 'm_dana', text: 'Wants the stock report as a table.', status: 'active', rev: 1 }) }
    const res = await (await make(srv, door).seed([], { caseId: 'E01', rep: 1, canary: 'c' })).chat('Remember I want a table.')
    expect(res.toolCalls[0]).toMatchObject({ input: { scope: 'person', person_id: 'current', fact: 'Wants the stock report as a table.' }, isError: false })
    expect(res.toolCalls[1]).toMatchObject({ input: {}, isError: true, result: expect.stringMatching(/^Not saved: /) })
  })

  it('a waiting brand fact (no owner) is a memory_save with scope brand', () => {
    const calls = writesFromRows([], [{ id: 'mem_x', scope: 'brand', ownerId: null, text: 'Kraftwerk ships from Poland.', status: 'waiting', rev: 1 }], (i) => i, (i) => String(i))
    expect(calls).toEqual([{ name: 'mcp__inhouse__memory_save', input: { scope: 'brand', fact: 'Kraftwerk ships from Poland.' }, result: expect.any(String), isError: false }])
  })

  it('a changed text is a memory_update with the case\'s own id', () => {
    const before: MemoryRow = { id: 'mem_real', scope: 'brand', ownerId: null, text: 'Norda minimum 120.', status: 'active', rev: 1 }
    const calls = writesFromRows([before], [{ ...before, text: 'Norda minimum 150.', status: 'waiting', rev: 2 }], (i) => (i === 'mem_real' ? 'm_norda' : i), (i) => String(i))
    expect(calls[0]).toMatchObject({ name: 'mcp__inhouse__memory_update', input: { memory_id: 'm_norda', fact: 'Norda minimum 150.' } })
  })

  it('an attachment case uploads the planted text before the turn and names it in the turn', async () => {
    const srv = server()
    const x = kase('X06')
    const session = await make(srv, new FakeDoor()).seed([], { caseId: 'X06', rep: 1, canary: 'kestrel-x06' }, x.exfil)
    await session.chat(x.chats[0]!.prompt)
    const order = srv.s.sent.filter((s) => s.method === 'POST').map((s) => s.path.replace(/eval-[a-f0-9]+/, 'CHAT'))
    expect(order).toEqual(['/api/chats', '/api/chats/CHAT/attachments', '/api/chats/CHAT/turns'])
    expect(srv.s.sent.find((s) => s.path.endsWith('/turns'))!.body.attachments).toEqual([{ fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA', name: 'note.txt' }])
  })

  it('a memory_search exfil case plants the text as a fact of the current person', async () => {
    const door = new FakeDoor()
    const x = kase('X04')
    await make(server(), door).seed([], { caseId: 'X04', rep: 1, canary: 'kestrel-x04' }, x.exfil)
    expect(door.rowsNow).toHaveLength(1)
    expect(door.rowsNow[0]).toMatchObject({ scope: 'person', ownerId: 'm_dana' })
    expect(door.rowsNow[0]!.text).toContain('kestrel-x04')
  })

  it('cases run one at a time on the shared brand: a second seed waits for the first reset', async () => {
    const door = new FakeDoor()
    const target = make(server(), door)
    const first = await target.seed([], { caseId: 'N01', rep: 1, canary: 'c' })
    let second = false
    const p = target.seed([], { caseId: 'N02', rep: 1, canary: 'c' }).then((s) => { second = true; return s })
    await new Promise((r) => setTimeout(r, 20))
    expect(second).toBe(false)
    await first.reset()
    await (await p).reset()
    expect(second).toBe(true)
  })
})

describe('cost of a chat that timed out or threw comes from the server', () => {
  it('the runner books the settled spend, not $0, when a chat has no result', async () => {
    const srv = server({ costMinor: 7, emptyPolls: 1_000_000 })
    const target = make(srv, new FakeDoor(), { pollMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
    // the turn is accepted, the answer never comes: the runner's own timeout fires; the server booked 7 cents
    const out = await runEvals({ target, cases: [kase('N01')], reps: 1, concurrency: 1, chatTimeoutMs: 50 })
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]).toMatchObject({ runOk: false, costUsd: 0.07 })
    expect(out.spentUsd).toBeCloseTo(0.07, 12)
  })

  it('a chat that threw before the turn was accepted costs nothing: nothing was booked', async () => {
    const srv = server()
    const failing: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => (String(input).endsWith('/turns') ? new Response('{"error":{"code":"unavailable"}}', { status: 503 }) : srv.fetch(input, init))) as typeof fetch
    const out = await runEvals({ target: make(srv, new FakeDoor(), { fetch: failing }), cases: [kase('N01')], reps: 1, concurrency: 1 })
    expect(out.rows[0]).toMatchObject({ runOk: false, costUsd: 0 })
    expect(out.rows[0]!.err).toMatch(/send the turn: 503/)
  })
})

describe('what the product cannot grade', () => {
  it('lists exactly these cases as unobservable (literal)', () => {
    expect(CASES.filter((c) => unobservableReason(c)).map((c) => c.id)).toEqual([
      'R01', 'R02', 'R05', 'T04', 'T06', 'T07', 'T09', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'C01', 'C02', 'C03', 'C05', 'X01', 'X02', 'X03', 'X05', 'X07',
    ])
  })
  it('names the field each needs', () => {
    expect(unobservableReason(kase('R01'))).toBe('memory_search input query (route 33 shows the tool name only)')
    expect(unobservableReason(kase('T09'))).toBe('notification_send input to (route 33 shows the tool name only)')
    expect(unobservableReason(kase('X01'))).toBe('WebFetch url and result (route 33 shows the tool name only)')
    expect(unobservableReason(kase('X05'))).toBe('planting through history_search needs a priming chat')
  })
  it('memory_save and memory_update args are observable (from the rows)', () => {
    for (const id of ['E01', 'E03', 'T01', 'T02', 'T03']) expect(unobservableReason(kase(id))).toBeNull()
  })
  it('the runner lists them as not graded and runs none of them', async () => {
    const srv = server()
    const out = await runEvals({ target: make(srv, new FakeDoor()), cases: ['R01', 'R03', 'T09'].map(kase), reps: 1, concurrency: 1 })
    expect(out.notGraded.map((n) => n.id)).toEqual(['R01', 'T09'])
    expect(out.rows.map((r) => r.caseId)).toEqual(['R03'])
  })
})

describe('the memory door', () => {
  const ok = { CF_SANDBOX_ACCOUNT_ID: 'acct' }
  it.each([
    ['a house database', 'inhouse-prod-db', ok],
    ['no name', undefined, ok],
    ['a name with a suffix attack', 'inhouse-sbx-db\n; DROP', ok],
    ['an upper-case name', 'Inhouse-SBX-db', ok],
    ['a sandbox name without the sandbox account id', 'inhouse-sbx-pr12-db', {}],
  ])('refuses %s', (_n, name, env) => {
    expect(() => assertSandboxDatabase(name, env)).toThrow(DoorRefusal)
  })
  it.each(['inhouse-sbx-pr12-db', 'inhouse-sbx-db'])('accepts the sandbox database %s', (name) => {
    expect(assertSandboxDatabase(name, ok)).toBe(name)
  })
  it('matches scripts/sandbox/names.mjs on literal names', async () => {
    const names = await import(/* @vite-ignore */ new URL('../scripts/sandbox/names.mjs', import.meta.url).href) as { isSandboxName: (n: string) => boolean }
    for (const n of ['inhouse-sbx-pr12-db', 'inhouse-sbx-db', 'inhouse-prod', 'inhouse-sbx-', 'inhouse-sbx-A', 'xinhouse-sbx-db', 'inhouse-sbx-db\n']) {
      expect(() => assertSandboxDatabase(n, ok) && true !== names.isSandboxName(n)).not.toThrow(Error('differs'))
      let door = true
      try { assertSandboxDatabase(n, ok) } catch { door = false }
      expect(door, n).toBe(names.isSandboxName(n))
    }
  })
  it('wrangler runs in the sandbox account with the config and never echoes the environment', async () => {
    const seen: { args: string[]; env: Record<string, string | undefined> }[] = []
    const run = wranglerRunner({ database: 'inhouse-sbx-pr12-db', config: '/tmp/sbx.jsonc', env: { CF_SANDBOX_ACCOUNT_ID: 'acct', CLOUDFLARE_ACCOUNT_ID: 'house', CLOUDFLARE_API_TOKEN: 'secret-token' }, spawn: (args, env) => { seen.push({ args, env }); return { status: 0, stdout: '[{"results":[{"n":1}]}]' } } })
    expect(await run('SELECT 1 AS n')).toEqual([{ n: 1 }])
    expect(seen[0]!.args).toEqual(['d1', 'execute', 'inhouse-sbx-pr12-db', '--remote', '--config', '/tmp/sbx.jsonc', '--json', '--yes', '--command', 'SELECT 1 AS n'])
    expect(seen[0]!.env.CLOUDFLARE_ACCOUNT_ID).toBe('acct')
    const failing = wranglerRunner({ database: 'inhouse-sbx-pr12-db', config: 'c', env: { CF_SANDBOX_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'secret-token' }, spawn: () => ({ status: 1, stdout: 'secret-token leaked?' }) })
    const err = await failing('SELECT 1').catch((e: Error) => e)
    expect(err).toBeInstanceOf(DoorRefusal)
    expect((err as Error).message).toBe('wrangler d1 execute exited 1')
  })
  it('a non-sandbox database is refused when the runner is made, before any spawn', () => {
    let spawned = 0
    expect(() => wranglerRunner({ database: 'inhouse-prod', config: 'c', env: ok, spawn: () => { spawned++; return { status: 0, stdout: '[]' } } })).toThrow(DoorRefusal)
    expect(spawned).toBe(0)
  })
  it('builds quoted statements: a quote in a fact is doubled, an id that is not a memory id is refused', async () => {
    const sqls: string[] = []
    const door = createDoor(async (sql) => { sqls.push(sql); return [] })
    await door.insert([{ id: 'mem_AAAAAAAAAAAAAAAAAAAAAA', scope: 'brand', ownerId: null, text: "Kate's mug'); DROP TABLE memories;--" }])
    expect(sqls[0]).toContain("'Kate''s mug''); DROP TABLE memories;--'")
    expect(sqlString("a'b")).toBe("'a''b'")
    await expect(door.insert([{ id: "x'; DROP", scope: 'brand', ownerId: null, text: 't' }])).rejects.toThrow(DoorRefusal)
    await door.clear()
    expect(sqls.at(-1)).toBe('DELETE FROM memories')
  })
  it('reads rows with their owner and status', async () => {
    const door = createDoor(async () => [{ id: 'mem_a', scope: 'person', owner_id: 'm_dana', text: 't', status: 'active', rev: 2 }, { id: 'mem_b', scope: 'brand', owner_id: null, text: 'u', status: 'waiting', rev: 1 }])
    expect(await door.rows()).toEqual([{ id: 'mem_a', scope: 'person', ownerId: 'm_dana', text: 't', status: 'active', rev: 2 }, { id: 'mem_b', scope: 'brand', ownerId: null, text: 'u', status: 'waiting', rev: 1 }])
  })
})

describe('the chat helper ids', () => {
  it('a runner chat type is exported for the report', () => {
    const r: ChatResult = { toolCalls: [], answer: '', runOk: false, usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 0 }
    expect(r.runOk).toBe(false)
    expect(MEMBER.current).toBe('m_dana')
  })
})
