// Route 76, `POST /api/ops/test-fakes` (fakes-hook.ts), and its ops (test-fakes.ts). The route through the whole /api/*
// path (server/api.ts) with the real route table, access matrix, sign-in and BrandAgent; the ops on runTestFakes with
// the real D1 and stand-in hub bindings (the hub side is hub/testing/fakes.workers.test.ts). Ways it can fail, written
// down first:
//  1. it answers anything but 404 outside the test build (compiled out, compiled in but not switched on, or the eval
//     build), or runs an op there;
//  2. the guard moved: a person (member or admin) reaches it, or the release token's POST passes without the Origin;
//  3. a malformed body, an unknown op (runnerEnv included) or a malformed op is not a 400, or acts anyway;
//  4. a hub op doesn't reach ConnectGateway.testFakes as it was sent, with a server scope, or a hub refusal isn't mapped
//     (invalid_args 400, the deployable hub's not_configured 502, a dead binding 502);
//  5. `hub` builds its own scope instead of the egress route's (a run scope with the grant's ids), or loses the
//     binding's raw HubResult; `callTool` without a name runs;
//  6. `notify` acts for someone who isn't an active person on the brand, or doesn't run notification_send's own handler;
//  7. `prompt`, `systemNotice`, `logs` and `transcripts` don't answer what their real functions and stores answer;
//  8. the off stand-in runs an op instead of refusing, or carries the canary.
// Expected bodies and statuses are literals here.
import { env as baseEnv } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import { routes } from '../routes.ts'
import type { Route } from '../routes.ts'
import { compiledIn, testFakesHandler } from './fakes-hook.ts'
import { installLogCapture, runTestFakes, TEST_FAKES_CANARY, type TestFakesEnv } from './test-fakes.ts'
import { runTestFakes as offRun, TEST_FAKES_CANARY as OFF_CANARY } from './test-fakes-off.ts'
import { accessMatrix } from '../access-matrix.ts'
import { authenticate, checkAccess, checkOrigin } from '../auth/index.ts'
import { mintPerson, mintService } from '../auth/test-issuer-mint.ts'
import { BRAND, RELEASE_ID, TEAM, authEnv, fakeStores, issuer } from '../testing/auth-fixtures.ts'
import type { Issuer } from '../testing/auth-fixtures.ts'
import { NO_APPS_LINE } from '../prompt/connected.ts'

let good: Issuer
beforeAll(async () => { good = await issuer() })
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
const db = (baseEnv as unknown as { DB: D1Database }).DB

function setup(mode?: { compiled: boolean; flag: string | undefined }) {
  const s = fakeStores({ people: { member: { role: 'member' }, admin: { role: 'admin' } }, grant: null })
  const table: readonly Route[] = mode === undefined ? routes
    : routes.map(r => (r.method === 'POST' && r.pattern === '/api/ops/test-fakes' ? { ...r, handler: testFakesHandler(mode.compiled) } : r))
  const parts: ApiParts = {
    authenticate: (r, e, st, n, id) => authenticate(r, e, st, n, id, good.keys),
    checkOrigin, checkAccess, stores: () => s.stores, routes: table, accessMatrix,
  }
  const env = { ...baseEnv, ...authEnv() } as Env & { INHOUSE_TEST_BUILD?: string }
  if (mode !== undefined) {
    if (mode.flag === undefined) delete env.INHOUSE_TEST_BUILD
    else env.INHOUSE_TEST_BUILD = mode.flag
  }
  return (init: RequestInit = {}) => api(parts, new Request(`${BRAND.origin}/api/ops/test-fakes`, { method: 'POST', ...init }), env, ctx, 'req-1')
}
const release = async () => ({ 'Cf-Access-Jwt-Assertion': await mintService({ key: good.key.privateJwk, iss: TEAM, aud: BRAND.aud, clientId: RELEASE_ID }), Origin: BRAND.origin, 'Content-Type': 'application/json' })
const person = async (who: 'member' | 'admin') => ({
  'Cf-Access-Jwt-Assertion': await mintPerson({ key: good.key.privateJwk, iss: TEAM, aud: BRAND.aud, sub: who, email: `${who}@example.test` }),
  Origin: BRAND.origin,
})
const bodyOf = async (r: Response) => JSON.parse(await r.text())
const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  return vi.spyOn(console, 'log').mockImplementation(() => {})
}
const hookLines = (log: ReturnType<typeof quiet>) => log.mock.calls.filter(([e]) => (e as { event?: unknown })?.event === 'test_fakes')
/** An op the BrandAgent answers without the hub: an invalid system notice (sendSystemNotice refuses it, writing nothing). */
const NOTICE_INVALID = JSON.stringify({ op: 'systemNotice', notice: { key: 'k' } })

describe('route 76 outside the test build (failure 1)', () => {
  it('product build (this test\'s own compile, both defines false): 404 to the release token, no op', async () => {
    const log = quiet()
    const res = await setup()({ headers: await release(), body: NOTICE_INVALID })
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: { code: 'not_found' } })
    expect(hookLines(log)).toEqual([])
    vi.restoreAllMocks()
  })

  it('compiled in but not switched on (no INHOUSE_TEST_BUILD, or not "1"): 404, no op', async () => {
    const log = quiet()
    for (const flag of [undefined, '0', 'true']) {
      const res = await setup({ compiled: true, flag })({ headers: await release(), body: NOTICE_INVALID })
      expect(res.status, String(flag)).toBe(404)
    }
    expect(hookLines(log)).toEqual([])
    vi.restoreAllMocks()
  })
})

describe('which builds compile the hook in (failure 1, Opus 6)', () => {
  it('the test build only: never the eval build (deployed), never the product build', () => {
    // [__INHOUSE_TEST_BUILD__, __INHOUSE_EVAL_BUILD__] as vite.config.ts sets them per mode: product, product-test, product-eval.
    expect(compiledIn(false, false)).toBe(false)
    expect(compiledIn(true, false)).toBe(true)
    expect(compiledIn(true, true)).toBe(false)
    expect(compiledIn(false, true)).toBe(false)
  })
})

describe('route 76 in the test build (failures 2 and 3)', () => {
  it('release only, with the brand Origin; answers the op through the BrandAgent', async () => {
    const log = quiet()
    const call = setup({ compiled: true, flag: '1' })
    const h = await release()
    const res = await call({ headers: h, body: NOTICE_INVALID })
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({ ok: false, error: 'invalid_args' })
    expect(hookLines(log)).toEqual([[{ event: 'test_fakes', op: 'systemNotice', canary: 'inhouse-test-fakes-canary-6b2f90d4' }]])
    for (const who of ['member', 'admin'] as const) {
      const r = await call({ headers: await person(who), body: NOTICE_INVALID })
      expect(r.status, who).toBe(403)
      expect((await bodyOf(r)).error.code, who).toBe('forbidden')
    }
    const { Origin: _o, ...noOrigin } = h
    expect(await bodyOf(await call({ headers: noOrigin, body: NOTICE_INVALID }))).toEqual({ error: { code: 'forbidden', reason: 'bad_origin' } })
    expect(hookLines(log)).toHaveLength(1)
    vi.restoreAllMocks()
  })

  it('a body that isn\'t JSON, isn\'t { op }, names an unknown op or a malformed one: 400 invalid', async () => {
    quiet()
    const call = setup({ compiled: true, flag: '1' })
    const h = await release()
    expect(await bodyOf(await call({ headers: h, body: '{nope' }))).toEqual({ error: { code: 'invalid', detail: 'the body is not JSON' } })
    for (const body of ['null', '[]', '"state"', '{}', '{"op":3}']) {
      const r = await call({ headers: h, body })
      expect(r.status, body).toBe(400)
      expect(await bodyOf(r), body).toEqual({ error: { code: 'invalid', detail: 'the body is { op, ... }' } })
    }
    for (const body of [{ op: 'runnerEnv', needles: ['x'] }, { op: 'nope' }, { op: 'prompt', extra: 1 }, { op: 'notify', as: {} , args: {} }, { op: 'hub', method: 'deleteAll' }]) {
      const r = await call({ headers: h, body: JSON.stringify(body) })
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect((await bodyOf(r)).error.code).toBe('invalid')
    }
    vi.restoreAllMocks()
  })
})

// ---------- the ops, on runTestFakes ----------

type Sent = { scope: unknown; op: unknown }
function hubConnect(answer: (op: unknown) => unknown) {
  const sent: Sent[] = []
  return {
    sent,
    binding: {
      testFakes: async (scope: unknown, op: unknown) => { sent.push({ scope, op }); return answer(op) },
      listAccounts: async () => ({ ok: true, value: [] }),
    },
  }
}
const envWith = (over: Partial<TestFakesEnv>): TestFakesEnv => ({ DB: db, ...over })
let n = 0
const uniq = () => `${Date.now().toString(36)}${++n}`
async function person_(status: 'active' | 'removed' = 'active', kind: 'person' | 'inhouse' = 'person'): Promise<string> {
  const id = `m_${uniq()}`
  await db.prepare('INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, ?, ?, ?, ?, 1)').bind(id, kind, kind === 'person' ? 'member' : null, status, 'Test Person').run()
  return id
}

describe('hub ops are forwarded to ConnectGateway.testFakes (failure 4)', () => {
  it('state, reset, set, alarm, var and seed go as they are, with a server scope; ok answers its value; state adds serverDay', async () => {
    quiet()
    const h = hubConnect(op => ({ ok: true, value: { echoed: op } }))
    const ops = [{ op: 'reset' }, { op: 'set', mcp: { sameToken: true } }, { op: 'alarm', accountId: 'slack:workspace' }, { op: 'var', name: 'SLACK_PRIVATE_SEARCH', value: 'on' }, { op: 'seed', slack: { messages: [{ channel: 'C0TEST0001', text: 'x' }] } }]
    for (const op of ops) expect(await runTestFakes(op, envWith({ HUB_CONNECT: h.binding }))).toEqual({ status: 200, body: { echoed: op } })
    const state = await runTestFakes({ op: 'state' }, envWith({ HUB_CONNECT: h.binding }))
    expect(state).toEqual({ status: 200, body: { echoed: { op: 'state' }, serverDay: new Date().toISOString().slice(0, 10) } })
    expect(h.sent.map(s => s.op)).toEqual([...ops, { op: 'state' }])
    for (const s of h.sent) expect(s.scope).toMatchObject({ kind: 'server', job: 'test-fakes' })
    vi.restoreAllMocks()
  })

  it('maps the hub\'s refusals: invalid_args 400, not_configured 502 hub_not_test_build, another code 502, a dead binding 502', async () => {
    quiet()
    const answer = (error: unknown) => runTestFakes({ op: 'state' }, envWith({ HUB_CONNECT: hubConnect(() => ({ ok: false, error })).binding }))
    expect(await answer({ code: 'invalid_args', message: 'invalid arguments: mcp.x' })).toEqual({ status: 400, body: { error: { code: 'invalid', detail: 'invalid arguments: mcp.x' } } })
    expect(await answer({ code: 'not_configured', message: 'connector not configured: testFakes' })).toEqual({ status: 502, body: { error: { code: 'hub_not_test_build' } } })
    expect(await answer({ code: 'internal', message: 'internal error' })).toEqual({ status: 502, body: { error: { code: 'hub_error', detail: 'internal' } } })
    const dead = { testFakes: async () => { throw new Error('binding') } }
    expect(await runTestFakes({ op: 'state' }, envWith({ HUB_CONNECT: dead }))).toEqual({ status: 502, body: { error: { code: 'hub_unreachable' } } })
    vi.restoreAllMocks()
  })
})

describe('hub: the egress route\'s own handler with a run scope (failure 5)', () => {
  const tool = { name: 'notes_search', connector: 'notes', description: 'Search notes', inputSchema: { type: 'object' } }
  it('listTools: the raw HubResult; the scope is a run built from the grant', async () => {
    quiet()
    const scopes: unknown[] = []
    const HUB = { listTools: async (s: unknown) => { scopes.push(s); return { ok: true, value: [tool] } }, callTool: async () => { throw new Error('no') } }
    const r = await runTestFakes({ op: 'hub', method: 'listTools' }, envWith({ HUB }))
    expect(r).toEqual({ status: 200, body: { ok: true, value: [tool] } })
    expect(scopes).toHaveLength(1)
    expect(scopes[0]).toMatchObject({ kind: 'run', principalId: 'm_test_fakes' })
    expect(Object.keys(scopes[0] as object).sort()).toEqual(['kind', 'principalId', 'requestId', 'runId'])
    vi.restoreAllMocks()
  })

  it('callTool: name and args reach the hub; a refusal comes back raw; no name is 400; a dead binding is 502', async () => {
    quiet()
    const calls: unknown[] = []
    const HUB = { listTools: async () => ({ ok: true, value: [] }), callTool: async (s: unknown, name: string, args: unknown) => { calls.push({ s, name, args }); return { ok: false, error: { code: 'write_refused', message: 'writes are refused' } } } }
    const r = await runTestFakes({ op: 'hub', method: 'callTool', name: 'notes_delete', args: { id: 'n1' } }, envWith({ HUB }))
    expect(r).toEqual({ status: 200, body: { ok: false, error: { code: 'write_refused', message: 'writes are refused' } } })
    expect(calls).toMatchObject([{ s: { kind: 'run', principalId: 'm_test_fakes' }, name: 'notes_delete', args: { id: 'n1' } }])
    expect(await runTestFakes({ op: 'hub', method: 'callTool' }, envWith({ HUB }))).toEqual({ status: 400, body: { error: { code: 'invalid', detail: 'callTool needs name' } } })
    expect(calls).toHaveLength(1)
    const dead = { listTools: async () => { throw new Error('binding') }, callTool: async () => { throw new Error('binding') } }
    expect(await runTestFakes({ op: 'hub', method: 'listTools' }, envWith({ HUB: dead }))).toEqual({ status: 502, body: { error: { code: 'binding_failed' } } })
    vi.restoreAllMocks()
  })
})

describe('notify: notification_send as an active person on the brand (failure 6)', () => {
  const args = (to: string) => ({ to: { members: [to] }, title: 'Stock check', text: 'R&D restock is in', format: 'message' })
  it('an unknown, removed or Inhouse member id: 400 unknown_member, nothing written', async () => {
    quiet()
    const removed = await person_('removed')
    const inhouse = await person_('active', 'inhouse')
    for (const memberId of ['m_nobody', removed, inhouse]) {
      expect(await runTestFakes({ op: 'notify', as: { memberId }, args: args(memberId) }, envWith({})), memberId).toEqual({ status: 400, body: { error: { code: 'unknown_member' } } })
    }
    vi.restoreAllMocks()
  })

  it('a real member: the tool\'s CallToolResult, the bell posted for the named member', async () => {
    quiet()
    const me = await person_()
    const r = await runTestFakes({ op: 'notify', as: { memberId: me }, args: args(me) }, envWith({}))
    expect(r.status).toBe(200)
    const result = (r.body as { result: { content: { text: string }[]; structuredContent: { recipients: unknown[] } } }).result
    expect(result.structuredContent.recipients).toEqual([{ to: me, kind: 'bell', outcome: 'posted' }])
    expect(result.content[0]!.text).toBe(`${me}: sent`)
    vi.restoreAllMocks()
  })

  it('a chat that isn\'t the member\'s, or a run or turn that isn\'t that chat\'s: refused before any send (Opus 5)', async () => {
    quiet()
    const me = await person_()
    const other = await person_()
    // Ids shaped like the server's (`r_` and `t_` plus 22 characters): notification_send checks the run id's shape.
    const id22 = (p: string, word: string) => `${p}_${word.padEnd(22, '0')}`
    const R_MINE = id22('r', 'MINE'), T_MINE = id22('t', 'MINE'), R_THEIRS = id22('r', 'THEIRS'), T_THEIRS = id22('t', 'THEIRS')
    const mine = `c_${uniq()}`
    const theirs = `c_${uniq()}`
    for (const [id, owner] of [[mine, me], [theirs, other]]) {
      await db.prepare('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, ?, 1, 1)').bind(id, owner, 'A chat').run()
    }
    await db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, at_ms) VALUES (?, ?, ?, ?, 0, 'user', 1)").bind(`msg_${uniq()}`, mine, R_MINE, T_MINE).run()
    await db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, at_ms) VALUES (?, ?, ?, ?, 0, 'user', 1)").bind(`msg_${uniq()}`, theirs, R_THEIRS, T_THEIRS).run()
    const send = (as: Record<string, string>) => runTestFakes({ op: 'notify', as: { memberId: me, ...as }, args: args(me) }, envWith({}))
    expect(await send({ chatId: theirs })).toEqual({ status: 400, body: { error: { code: 'chat_not_members' } } })
    expect(await send({ chatId: 'c_nowhere' })).toEqual({ status: 400, body: { error: { code: 'chat_not_members' } } })
    expect(await send({ chatId: mine, runId: R_THEIRS })).toEqual({ status: 400, body: { error: { code: 'run_not_chats' } } })
    expect(await send({ chatId: mine, runId: R_MINE, turnId: T_THEIRS })).toEqual({ status: 400, body: { error: { code: 'turn_not_chats' } } })
    const ok = await send({ chatId: mine, runId: R_MINE, turnId: T_MINE })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect((ok.body as { result: { structuredContent: { recipients: unknown[] } } }).result.structuredContent.recipients).toEqual([{ to: me, kind: 'bell', outcome: 'posted' }])
    vi.restoreAllMocks()
  })

  it('arguments that don\'t fit notification_send: the tool\'s own invalid_arguments refusal', async () => {
    quiet()
    const me = await person_()
    const r = await runTestFakes({ op: 'notify', as: { memberId: me }, args: { to: {} } }, envWith({}))
    expect(r.status).toBe(200)
    expect((r.body as { result: { isError: boolean; structuredContent: unknown } }).result).toMatchObject({ isError: true, structuredContent: { error: 'invalid_arguments' } })
    vi.restoreAllMocks()
  })
})

describe('prompt, systemNotice and logs (failure 7)', () => {
  it('prompt: the string turnSystemPrompt builds now (no apps connected here)', async () => {
    quiet()
    const r = await runTestFakes({ op: 'prompt' }, envWith({ HUB_CONNECT: hubConnect(() => null).binding }))
    expect(r.status).toBe(200)
    expect((r.body as { prompt: string }).prompt).toContain(NO_APPS_LINE)
    vi.restoreAllMocks()
  })

  it('systemNotice: sendSystemNotice\'s own answer, refusal and bell', async () => {
    quiet()
    expect(await runTestFakes({ op: 'systemNotice', notice: { key: 'k' } }, envWith({}))).toEqual({ status: 200, body: { ok: false, error: 'invalid_args' } })
    const me = await person_()
    const r = await runTestFakes({ op: 'systemNotice', notice: { key: `w5:${uniq()}`, source: 'approvals', kind: 'approval_waiting', to: { members: [me] }, link: { kind: 'today' } } }, envWith({}))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, recipients: [{ kind: 'bell', to: me, outcome: 'posted' }] })
    vi.restoreAllMocks()
  })

  it('logs: this isolate\'s lines as strings from `since`, and the hub\'s through the binding', async () => {
    installLogCapture()
    const h = hubConnect(() => ({ ok: true, value: { lines: ['{"event":"hub_call"}'], next: 1 } }))
    const first = (await runTestFakes({ op: 'logs' }, envWith({ HUB_CONNECT: h.binding }))).body as { next: { product: number } }
    console.log({ event: 'w5_probe', value: 'canary-x' })
    console.error('plain text line')
    const r = await runTestFakes({ op: 'logs', since: { product: first.next.product, hub: 0 } }, envWith({ HUB_CONNECT: h.binding }))
    expect(r.status).toBe(200)
    // The two lines written above, then the hook's own line for this second call, then the hub's.
    expect(r.body).toEqual({
      lines: [
        { worker: 'product', line: JSON.stringify({ event: 'w5_probe', value: 'canary-x' }) },
        { worker: 'product', line: 'plain text line' },
        { worker: 'product', line: JSON.stringify({ event: 'test_fakes', op: 'logs', canary: TEST_FAKES_CANARY }) },
        { worker: 'hub', line: '{"event":"hub_call"}' },
      ],
      next: { product: first.next.product + 3, hub: 1 },
    })
    expect(h.sent.map(s => s.op)).toEqual([{ op: 'logs' }, { op: 'logs', since: 0 }])
  })
})

describe('transcripts (failure 7)', () => {
  it('answers every object under sessions/ as text, and nothing else in the bucket', async () => {
    const FILES = (baseEnv as unknown as { FILES: R2Bucket }).FILES
    const tag = uniq()
    await FILES.put(`sessions/w5-${tag}/a.jsonl`, '{"type":"user","text":"hello"}\n')
    await FILES.put(`sessions/w5-${tag}/b.jsonl`, '{"type":"assistant","text":"hi"}\n')
    await FILES.put(`files/w5-${tag}/c.txt`, 'not a transcript')
    const r = await runTestFakes({ op: 'transcripts' }, envWith({ FILES }))
    expect(r.status).toBe(200)
    const texts = (r.body as { texts: string[] }).texts
    expect(texts).toContain('{"type":"user","text":"hello"}\n')
    expect(texts).toContain('{"type":"assistant","text":"hi"}\n')
    expect(texts).not.toContain('not a transcript')
    expect(await runTestFakes({ op: 'transcripts' }, envWith({}))).toEqual({ status: 502, body: { error: { code: 'no_session_store' } } })
  })
})

describe('the off stand-in (failure 8)', () => {
  it('throws without running an op, and carries no canary', () => {
    expect(() => offRun({ op: 'state' }, envWith({}))).toThrow('The test-fakes hook is not in this build.')
    expect(OFF_CANARY).toBe('')
  })
})
