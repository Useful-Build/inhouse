// The product target against a scripted server (no network, no model): what it sends, what it reads, and what it refuses.
// Ways it could fail, written first: a non-eval brand gets a chat; a refused memory write reads as a saved one (a false bypass or
// a false pass); a timed-out chat costs $0 though the server booked spend; the door reaches a database that isn't a sandbox one;
// a case needing a field the API doesn't show is graded anyway.
import { describe, expect, it } from 'vitest'
import { CASES } from './cases.ts'
import { assertSandboxDatabase, createDoor, DoorRefusal, EVAL_DB, sqlString, wranglerRunner, type MemoryDoor, type MemoryRow, type NewMemory } from './targets/door.ts'
import { createProductTarget, onExampleTest, ProductTargetRefusal, unobservableReason, writesFromRows } from './targets/product.ts'
import { CapReachedError } from './types.ts'
import { runEvals } from './runner.ts'
import { buildReport, renderReadme } from './report.ts'
import type { Case, ChatResult, Target } from './types.ts'

const ENV = { INHOUSE_EVAL_BRAND: '1', INHOUSE_EVAL_ORIGIN: 'https://eval.example.test' }
const MEMBER = { current: 'm_dana', tom: 'm_leo', lena: 'm_sam' }
const TOKEN_OF: Record<string, string> = { 'tok-current': 'm_dana', 'tok-tom': 'm_leo', 'tok-lena': 'm_sam' }
const signIn = async (key: string) => ({ 'Cf-Access-Jwt-Assertion': `tok-${key}` })

class FakeDoor implements MemoryDoor {
  rowsNow: MemoryRow[] = []
  calls: string[] = []
  /** False: this database is not the one the origin answers from (the probe chat isn't in it). */
  holdsProbe = true
  onRows?: () => void
  async hasChat() { this.calls.push('hasChat'); return this.holdsProbe }
  async rows() { this.calls.push('rows'); this.onRows?.(); return this.rowsNow.map((r) => ({ ...r })) }
  async insert(facts: NewMemory[]) {
    this.calls.push(`insert ${facts.length}`)
    this.rowsNow.push(...facts.map((f) => ({ id: f.id, scope: f.scope, ownerId: f.ownerId, text: f.text, status: 'active' as const, rev: 1 })))
  }
  async clear() { this.calls.push('clear'); this.rowsNow = [] }
  async setSpendingCap(cap: string) { this.calls.push(`cap ${cap}`) }
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
  /** The trace read answers this status (200 normally). */
  traceStatus?: number
  /** Every member page names a next cursor (a brand too big to check). */
  endlessMembers?: boolean
  /** How many stops answer 200 (still ending) before one answers 409 turn_ended. */
  stopsBeforeEnded?: number
  /** Every stop answers this status instead. */
  stopStatus?: number
  /** Route 42's cap and the month's spend, in cents (defaults: the $40 cap, nothing spent). */
  capMinor?: number
  spentMinor?: number
  /** The turn ends with no answer but an end row (route 24's `event` with `end`): a failure or a cancel reason. */
  endRow?: { failure?: string; why?: string }
}
const server = (over: Partial<Server> = {}): { s: Server; fetch: typeof fetch } => {
  const s: Server = {
    members: [{ id: 'm_dana', email: 'dana@example.test', status: 'active' }, { id: 'm_leo', email: 'leo@example.test', status: 'active' }, { id: 'm_sam', email: 'sam@example.test', status: 'active' }],
    emptyPolls: 1, steps: [], costMinor: 2, answerParts: [{ type: 'text', text: 'Hello.' }], sent: [], ...over,
  }
  let turnId = ''
  let polls = 0
  let stops = 0
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
    if (url.pathname === '/api/members') return json({ items: s.members, nextCursor: s.endlessMembers ? 'more' : null })
    if (url.pathname.startsWith('/api/turns/') && url.pathname.endsWith('/stop')) {
      const n = stops++
      if (s.stopStatus) return json({ error: { code: 'unavailable' } }, s.stopStatus)
      return n < (s.stopsBeforeEnded ?? 0) ? json({}) : json({ error: { code: 'conflict', reason: 'turn_ended' } }, 409)
    }
    if (url.pathname === '/api/models') return json({ default: 'sonnet', modes: [{ id: 'sonnet' }] })
    if (url.pathname === '/api/usage') return json({ cap: { minor: s.capMinor ?? 4000, currency: 'USD' }, total: { minor: s.spentMinor ?? 0, currency: 'USD' } })
    if (url.pathname === '/api/chats' && method === 'POST') return json({ id: body.id }, 201)
    if (url.pathname.endsWith('/attachments')) return json({ fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA', name: 'note.txt' }, 201)
    if (url.pathname.endsWith('/turns')) {
      turnId = 't_BBBBBBBBBBBBBBBBBBBBBB'
      s.onTurn?.()
      return json({ runId: 'r_CCCCCCCCCCCCCCCCCCCCCC', turnId, messageId: `${turnId}.u`, position: 'starting' }, 202)
    }
    if (url.pathname.startsWith('/api/traces/') && s.traceStatus && s.traceStatus !== 200) return json({ error: { code: 'unavailable' } }, s.traceStatus)
    if (url.pathname.startsWith('/api/traces/')) return json({ cost: { minor: s.costMinor, currency: 'USD' }, steps: [{ kind: 'root', detail: '' }, ...s.steps] })
    if (url.pathname.startsWith('/api/chats/')) {
      const answered = ++polls > s.emptyPolls
      if (answered && s.endRow) return json({ messages: [{ role: 'user', turnId, pos: 0, text: 'q' }, { role: 'event', turnId, pos: 1, text: '', end: { retryQuestion: 'q', ...s.endRow } }], runs: [] })
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

  // (a), the O2 note: the eval brand's own Spending cap is the $40 (decision 18), pinned by the harness every run.
  it('pins the brand\'s Spending cap to $40 through the door, then reads it back on route 42; any other cap refuses', async () => {
    const door = new FakeDoor()
    await (await make(server(), door).seed([], { caseId: 'N01', rep: 1, canary: 'c' })).reset()
    expect(door.calls).toContain('cap $40')
    for (const capMinor of [32000, 3999, 0]) {
      const d = new FakeDoor()
      await expect(make(server({ capMinor }), d).seed([], { caseId: 'N01', rep: 1, canary: 'c' }), String(capMinor)).rejects.toThrow(/Spending cap is not \$40/)
      expect(d.calls.filter((c) => c === 'clear' || c.startsWith('insert'))).toEqual([])
    }
  })

  it('room(): the month\'s spend and the cap from route 42, in dollars', async () => {
    const target = make(server({ spentMinor: 1250 }), new FakeDoor())
    await (await target.seed([], { caseId: 'N01', rep: 1, canary: 'c' })).reset()
    expect(await target.room!()).toEqual({ spentUsd: 12.5, capUsd: 40 })
  })

  // #253 review O3: our $40 layer can't be lifted silently mid-run (a re-seed's $320, a Settings change).
  it('room() refuses whenever the cap is no longer $40', async () => {
    const srv = server()
    const target = make(srv, new FakeDoor())
    await (await target.seed([], { caseId: 'N01', rep: 1, canary: 'c' })).reset()
    srv.s.capMinor = 32000
    await expect(target.room!()).rejects.toThrow(/Spending cap is not \$40/)
  })

  // #253 review O1: a month already at the cap is refused at setup, not on the first chat.
  it('setup refuses a month whose spend has reached the cap', async () => {
    for (const spentMinor of [4000, 4500]) {
      const d = new FakeDoor()
      await expect(make(server({ spentMinor }), d).seed([], { caseId: 'N01', rep: 1, canary: 'c' }), String(spentMinor)).rejects.toThrow(/reached the \$40 cap/)
      expect(d.calls.filter((c) => c === 'clear' || c.startsWith('insert'))).toEqual([])
    }
  })

  it('a brand with more members than the check reads is refused, not passed', async () => {
    const srv = server({ endlessMembers: true })
    const door = new FakeDoor()
    await expect(make(srv, door).seed([], { caseId: 'N01', rep: 1, canary: 'c' })).rejects.toThrow(/more members than the check reads/)
    expect(door.calls).toEqual([])
  })

  it('a database that does not hold the chat the origin just created is refused before any write or clear', async () => {
    const door = new FakeDoor()
    door.holdsProbe = false
    await expect(make(server(), door).seed([], { caseId: 'N01', rep: 1, canary: 'c' })).rejects.toThrow(/not this deployment's database/)
    expect(door.calls).toEqual(['hasChat'])
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
    expect(res.costUsd).toBeCloseTo(0.035, 12) // whole cents, booked at the upper bound: (3 + 0.5) cents
    expect(res.runOk).toBe(true)
    const turn = srv.s.sent.find((x) => x.path.endsWith('/turns'))!
    expect(turn.token).toBe('tok-current')
    expect(turn.body).toMatchObject({ text: 'How long does Norda take?', model: 'sonnet' })
    expect(turn.body.clientTurnKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(srv.s.sent.filter((x) => x.path.includes('/chats') && x.method === 'GET').length).toBeGreaterThanOrEqual(2) // it waited
    expect(target.spentUsd!()).toBeCloseTo(0.035, 12)
    // seeded: brand facts without an owner, Tom's own fact owned by Tom
    expect(door.rowsNow.filter((r) => r.scope === 'brand').every((r) => r.ownerId === null)).toBe(true)
    expect(door.rowsNow.find((r) => r.text.startsWith('Tom wants'))!.ownerId).toBe('m_leo')
    await session.reset()
    expect(door.rowsNow).toEqual([])
  })

  it('a turn the cap fenced (cap_reached, failed or cancelled) throws CapReachedError, so the run stops', async () => {
    for (const endRow of [{ failure: 'cap_reached' }, { why: 'cap_reached' }]) {
      const session = await make(server({ endRow }), new FakeDoor()).seed([], { caseId: 'N01', rep: 1, canary: 'c' })
      await expect(session.chat('hi'), JSON.stringify(endRow)).rejects.toThrow(CapReachedError)
    }
    // Any other end with no answer is a failed run, not a hang.
    const other = await make(server({ endRow: { failure: 'sdk_error' } }), new FakeDoor()).seed([], { caseId: 'N01', rep: 1, canary: 'c' })
    expect(await other.chat('hi')).toMatchObject({ answer: '', runOk: false })
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
    expect(order).toEqual(['/api/chats', '/api/chats', '/api/chats/CHAT/attachments', '/api/chats/CHAT/turns']) // the first is the deployment probe chat
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
    const srv = server({ costMinor: 7, emptyPolls: 1_000_000, stopsBeforeEnded: 2 })
    const target = make(srv, new FakeDoor(), { pollMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
    // the turn is accepted, the answer never comes: the runner's own timeout fires; the server booked 7 cents
    const out = await runEvals({ target, cases: [kase('N01')], reps: 1, concurrency: 1, chatTimeoutMs: 50 })
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]).toMatchObject({ runOk: false })
    expect(out.rows[0]!.costUsd).toBeCloseTo(0.075, 12)
    expect(out.spentUsd).toBeCloseTo(0.075, 12)
  })

  it('the turn is stopped until the server says it ended, and only then is its cost read', async () => {
    const srv = server({ costMinor: 7, emptyPolls: 1_000_000, stopsBeforeEnded: 2 })
    const target = make(srv, new FakeDoor(), { pollMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
    await runEvals({ target, cases: [kase('N01')], reps: 1, concurrency: 1, chatTimeoutMs: 50 })
    const paths = srv.s.sent.map((x) => `${x.method} ${x.path}`)
    const stops = paths.flatMap((p, i) => (p.endsWith('/stop') ? [i] : []))
    const traceReads = paths.flatMap((p, i) => (p.startsWith('GET /api/traces/') ? [i] : []))
    expect(stops).toHaveLength(4) // two 200s (still ending), the 409 that says it ended, then reset()'s own check (409)
    expect(traceReads.length).toBeGreaterThan(0)
    expect(Math.min(...traceReads)).toBeGreaterThan(stops[2]!) // the cost is read only after the 409
    expect(stops[3]!).toBeGreaterThan(Math.max(...traceReads)) // and reset() stops again before it clears
  })

  it('a cost that can\'t be read is "cost unknown" on the row, never a silent $0 that resets the figure', async () => {
    const srv = server({ emptyPolls: 1_000_000, traceStatus: 503, stopsBeforeEnded: 0 })
    const target = make(srv, new FakeDoor(), { pollMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
    const out = await runEvals({ target, cases: [kase('N01')], reps: 1, concurrency: 1, chatTimeoutMs: 50 })
    expect(out.rows[0]!.err).toMatch(/cost unknown: the trace of t_[A-Za-z0-9_-]+ could not be read \(503\)/)
    expect(out.rows[0]!.costUsd).toBe(0)
  })

  it('reset stops the session\'s turns first and throws when it can\'t, so the lock is not released over a live turn', async () => {
    const srv = server({ stopStatus: 500 })
    const door = new FakeDoor()
    const session = await make(srv, door).seed([], { caseId: 'N01', rep: 1, canary: 'c' })
    await session.chat('hi')
    const clears = door.calls.filter((c) => c === 'clear').length
    await expect(session.reset()).rejects.toThrow(/stop turn t_[A-Za-z0-9_-]+: 500/)
    expect(door.calls.filter((c) => c === 'clear').length).toBe(clears) // nothing was cleared under a turn that may still write
  })

  it('a chat that threw before the turn was accepted costs nothing: nothing was booked', async () => {
    const srv = server()
    const failing: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => (String(input).endsWith('/turns') ? new Response('{"error":{"code":"unavailable"}}', { status: 503 }) : srv.fetch(input, init))) as typeof fetch
    const out = await runEvals({ target: make(srv, new FakeDoor(), { fetch: failing }), cases: [kase('N01')], reps: 1, concurrency: 1 })
    expect(out.rows[0]).toMatchObject({ runOk: false, costUsd: 0 })
    expect(out.rows[0]!.err).toMatch(/send the turn: 503/)
  })
})

describe('the product README says what its numbers are', () => {
  it('names the half-cent upper bound and the empty WebSearch input', () => {
    const text = renderReadme(buildReport(CASES, [], { target: 'product', model: 'm', effort: 'e', reps: 1, notRun: [] }), 't')
    expect(text).toMatch(/upper bound \(\+0\.5 cent\)/)
    expect(text).toMatch(/WebSearch call has input `\{\}`.*websearch\.unrequested.*never `websearch\.canary`/)
    expect(renderReadme(buildReport(CASES, [], { target: 'fake', model: 'm', effort: 'e', reps: 1, notRun: [] }), 't')).not.toMatch(/Product target notes/)
  })
})

describe('what the product cannot grade', () => {
  it('lists exactly these cases as unobservable (literal)', () => {
    expect(CASES.filter((c) => unobservableReason(c)).map((c) => c.id)).toEqual([
      'R01', 'R02', 'R05', 'E03', 'T04', 'T06', 'T07', 'T09', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'C01', 'C02', 'C03', 'C05', 'X01', 'X02', 'X03', 'X05', 'X07',
    ])
  })
  it('names the field each needs', () => {
    expect(unobservableReason(kase('R01'))).toBe('memory_search input query (route 33 shows the tool name only)')
    expect(unobservableReason(kase('T09'))).toBe('notification_send input to (route 33 shows the tool name only)')
    expect(unobservableReason(kase('X01'))).toBe('WebFetch url and result (route 33 shows the tool name only)')
    expect(unobservableReason(kase('X05'))).toBe('planting through history_search needs a priming chat')
  })
  it('E03 (a save for Lena) is unobservable: the product saves only for the caller', () => {
    expect(unobservableReason(kase('E03'))).toBe('memory_save person_id (the product saves only for the person asking; it has no person_id)')
  })
  it('memory_save and memory_update args are observable (from the rows)', () => {
    for (const id of ['E01', 'T01', 'T02', 'T03']) expect(unobservableReason(kase(id))).toBeNull()
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
    ['the shared candidate database', 'inhouse-sbx-db', ok],
    ['no name', undefined, ok],
    ['a name with a suffix attack', 'inhouse-sbx-db\n; DROP', ok],
    ['an upper-case name', 'Inhouse-SBX-db', ok],
    ['a sandbox name without the sandbox account id', 'inhouse-sbx-eval-db', {}],
  ])('refuses %s', (_n, name, env) => {
    expect(() => assertSandboxDatabase(name, env)).toThrow(DoorRefusal)
  })
  // (a): only the eval deployment runs the real model with the test issuer and the eval brand marker, so the door takes its
  // database alone; a PR's test deployment runs the scripted model and is never a paid eval's target.
  it('accepts the eval deployment\'s database only', () => {
    expect(assertSandboxDatabase('inhouse-sbx-eval-db', ok)).toBe('inhouse-sbx-eval-db')
    for (const n of ['inhouse-sbx-pr12-db', 'inhouse-sbx-pr7', 'inhouse-sbx-eval', 'inhouse-sbx-eval-files', 'inhouse-sbx-eval-db\n']) expect(() => assertSandboxDatabase(n, ok), n).toThrow(/eval deployment's database/)
  })
  it('takes exactly scripts/sandbox/names.mjs\'s evalNames().d1', async () => {
    const names = await import(/* @vite-ignore */ new URL('../scripts/sandbox/names.mjs', import.meta.url).href) as { evalNames: () => { d1: string } }
    expect(EVAL_DB).toBe(names.evalNames().d1)
  })
  it('setSpendingCap upserts the brand\'s s:cap (its JSON string) and refuses anything but a cap the product reads', async () => {
    const sqls: string[] = []
    const door = createDoor(async (sql) => { sqls.push(sql); return [] })
    await door.setSpendingCap('$40')
    expect(sqls[0]).toMatch(/^INSERT INTO settings \(owner, key, value_json, rev, updated_at_ms, updated_by, req_id\) VALUES \('brand', 's:cap', '"\$40"', 1, \d+, 'eval', 'eval'\) ON CONFLICT \(owner, key\) DO UPDATE SET value_json = excluded\.value_json, rev = settings\.rev \+ 1, updated_at_ms = excluded\.updated_at_ms, updated_by = 'eval', req_id = 'eval'$/)
    for (const bad of ['40', '$0', "$40'; DROP TABLE settings;--", '$100001', '$40.5']) await expect(door.setSpendingCap(bad), bad).rejects.toThrow(DoorRefusal)
    expect(sqls).toHaveLength(1)
  })
  it('wrangler runs in the sandbox account with the config and never echoes the environment', async () => {
    const seen: { args: string[]; env: Record<string, string | undefined> }[] = []
    const run = wranglerRunner({ database: 'inhouse-sbx-eval-db', config: '/tmp/sbx.jsonc', readConfig: () => JSON.stringify({ account_id: 'acct', d1_databases: [{ database_name: 'inhouse-sbx-eval-db' }] }), env: { CF_SANDBOX_ACCOUNT_ID: 'acct', CLOUDFLARE_ACCOUNT_ID: 'house', CLOUDFLARE_API_TOKEN: 'secret-token' }, spawn: (args, env) => { seen.push({ args, env }); return { status: 0, stdout: '[{"results":[{"n":1}]}]' } } })
    expect(await run('SELECT 1 AS n')).toEqual([{ n: 1 }])
    expect(seen[0]!.args).toEqual(['d1', 'execute', 'inhouse-sbx-eval-db', '--remote', '--config', '/tmp/sbx.jsonc', '--json', '--yes', '--command', 'SELECT 1 AS n'])
    expect(seen[0]!.env.CLOUDFLARE_ACCOUNT_ID).toBe('acct')
    const failing = wranglerRunner({ database: 'inhouse-sbx-eval-db', config: 'c', readConfig: () => JSON.stringify({ account_id: 'acct', d1_databases: [{ database_name: 'inhouse-sbx-eval-db' }] }), env: { CF_SANDBOX_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'secret-token' }, spawn: () => ({ status: 1, stdout: 'secret-token leaked?' }) })
    const err = await failing('SELECT 1').catch((e: Error) => e)
    expect(err).toBeInstanceOf(DoorRefusal)
    expect((err as Error).message).toBe('wrangler d1 execute exited 1')
  })
  it.each([
    ['an empty config path', '', JSON.stringify({ account_id: 'acct', d1_databases: [{ database_name: 'inhouse-sbx-eval-db' }] })],
    ['a config for another account', 'c', JSON.stringify({ account_id: 'house', d1_databases: [{ database_name: 'inhouse-sbx-eval-db' }] })],
    ['a config that binds another database', 'c', JSON.stringify({ account_id: 'acct', d1_databases: [{ database_name: 'inhouse-sbx-pr13-db' }] })],
    ['a config that is not JSON', 'c', '{ // jsonc'],
  ])('refuses %s, before any spawn', (_n, config, text) => {
    let spawned = 0
    expect(() => wranglerRunner({ database: 'inhouse-sbx-eval-db', config, readConfig: () => text, env: ok, spawn: () => { spawned++; return { status: 0, stdout: '[]' } } })).toThrow(DoorRefusal)
    expect(spawned).toBe(0)
  })
  it('hasChat asks for exactly that chat id and refuses an id that is not one', async () => {
    const sqls: string[] = []
    const door = createDoor(async (sql) => { sqls.push(sql); return sql.includes('eval-probe-1') ? [{ one: 1 }] : [] })
    expect(await door.hasChat('eval-probe-1')).toBe(true)
    expect(await door.hasChat('eval-probe-2')).toBe(false)
    expect(sqls[0]).toBe("SELECT 1 AS one FROM chats WHERE id = 'eval-probe-1'")
    await expect(door.hasChat("x'; DROP TABLE chats;--")).rejects.toThrow(DoorRefusal)
  })
  it('one absolute config path goes to the check and to wrangler', async () => {
    const read: string[] = []
    const argv: string[][] = []
    const run = wranglerRunner({ database: 'inhouse-sbx-eval-db', config: 'rel/sbx.jsonc', readConfig: (f) => { read.push(f); return JSON.stringify({ account_id: 'acct', d1_databases: [{ database_name: 'inhouse-sbx-eval-db' }] }) }, env: ok, spawn: (a) => { argv.push(a); return { status: 0, stdout: '[]' } } })
    await run('SELECT 1')
    expect(read).toHaveLength(1)
    expect(read[0]!.startsWith('/')).toBe(true)
    expect(read[0]!.endsWith('/rel/sbx.jsonc')).toBe(true)
    expect(argv[0]![argv[0]!.indexOf('--config') + 1]).toBe(read[0])
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

// #253 review S2: the results README says the cap stopped the run, and why.
describe('the README and the cap', () => {
  it('names the cap stop', () => {
    const report = buildReport(CASES, [], { target: 'product', model: 'm', effort: 'e', reps: 1, notRun: [] })
    const text = renderReadme(report, 't', { capStop: { caseId: 'R07', rep: 2, why: 'would cross the cap', spentUsd: 39.9, capUsd: 40, estimateUsd: 0.25 } })
    expect(text).toContain('Stopped by the brand\'s Spending cap at R07 r2: would cross the cap ($39.90 spent of $40.00, the case needs about $0.25).')
    expect(renderReadme(report, 't')).not.toMatch(/Spending cap at/)
  })
})
