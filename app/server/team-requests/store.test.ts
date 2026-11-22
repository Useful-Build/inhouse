// Requests to the Inhouse team (P6a W3): the store, routes 80 to 83 (handlers called with the access matrix's role rule
// applied by the real matrix in the last block) and the two tools. Ways it can fail, written first:
//  1. the 50th-open cap lets a 51st through, or counts withdrawn and done ones;
//  2. a retried create (its reply lost after the batch committed) makes a second request;
//  3. a stale `ifRev`, or a request that already left `open`, changes anything or writes an audit line;
//  4. a Member withdraws another's request, or the withdraw owner check is missing; the Inhouse team withdraws;
//  5. an unknown id answers anything but 404 before the owner rule;
//  6. an audit line holds the request's text or subject;
//  7. a routine's run (`m_system`) files a request.
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { accessMatrix } from '../access-matrix.ts'
import { createTeamRequest, listTeamRequests, setTeamRequestStatus, withdrawTeamRequest } from '../api/team-requests.ts'
import { openStores } from '../db/stores.ts'
import { ctx, lastLineId, personPrincipal, reqId } from '../db/test-support.ts'
import { TOOL_HANDLERS } from '../mcp/tools/index.ts'
import type { ToolResult, ToolScope } from '../mcp/server/tool.ts'
import { NEEDS_PERSON_TEXT } from '../mcp/tools/team/index.ts'
import { createRequest } from './store.ts'

const db = env.DB
const stores = openStores(env)
const ALEX = 'm_w3_alex'
const SAM = 'm_w3_sam'
const ADMIN = 'm_w3_admin'
const TEXT = 'Please connect our Zebra Ledger tool so the agent can read invoices.'
const SUBJECT = 'zebra-ledger'
const NOW = 1_800_000_000_000
const at = (actorId: string) => ({ actorId, requestId: reqId(), nowMs: NOW })
const inhouse = { kind: 'inhouse', memberId: 'm_w3_ih', subject: 's_i', grant: null, requestId: 'r', expMs: 4_102_444_800_000 } as const

beforeAll(async () => {
  for (const [id, role] of [[ALEX, 'member'], [SAM, 'member'], [ADMIN, 'admin']] as const) {
    await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', ?, 'active', 'Test person', 0) ON CONFLICT (id) DO NOTHING").bind(id, role).run()
  }
  await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES ('m_w3_ih', 'inhouse', NULL, 'active', 'Inhouse', 0) ON CONFLICT (id) DO NOTHING").run()
})
/** The audit log is append-only: each test reads only the lines after its own start. */
let from = 0
beforeEach(async () => {
  await db.prepare('DELETE FROM team_requests').run()
  from = await lastLineId(db)
})

const auditLines = async () => (await db.prepare("SELECT actor_id, action, target_kind, target_id, args_json FROM audit_log WHERE action LIKE 'team_request.%' AND id > ? ORDER BY id").bind(from).all<Record<string, string>>()).results
let uniq = 0
/** A request with its own subject unless one is given: the same person, kind and subject is the same request. */
const make = async (by = ALEX, over: { kind?: 'tool' | 'job'; subject?: string; text?: string } = {}) => {
  const o = await createRequest(db, { kind: over.kind ?? 'tool', subject: over.subject ?? `subject-${++uniq}`, text: over.text ?? TEXT }, at(by))
  if ('refused' in o) throw new Error('refused')
  return o.ok
}
const route = async (h: typeof createTeamRequest, principal: Parameters<typeof ctx>[1], init: Parameters<typeof ctx>[2]) => {
  const { c } = ctx(stores, principal, init)
  const res = await h(c as never)
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}
const person = (id: string, role: 'member' | 'admin' = 'member') => personPrincipal(id, role)

describe('create and list (the store)', () => {
  it('makes an open request at rev 1 with one audit line that has the id and kind and no text', async () => {
    const r = await make(ALEX, { subject: SUBJECT })
    expect([r.status, r.rev, r.requested_by, r.kind, r.subject, r.text]).toEqual(['open', 1, ALEX, 'tool', SUBJECT, TEXT])
    const lines = await auditLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ actor_id: ALEX, action: 'team_request.created', target_kind: 'team_request', target_id: r.id })
    expect(JSON.parse(lines[0]!.args_json)).toEqual({ requestId: r.id, kind: 'tool' })
    expect(JSON.stringify(lines)).not.toContain('Zebra')
    expect(JSON.stringify(lines)).not.toContain(SUBJECT)
  })
  it('lists newest first, with an optional status filter, at most 200', async () => {
    const a = await make(ALEX, { text: 'first' })
    await db.prepare('UPDATE team_requests SET created_at_ms = created_at_ms + 10 WHERE id <> ?').bind(a.id).run()
    const b = await make(SAM, { text: 'second' })
    await db.prepare('UPDATE team_requests SET created_at_ms = created_at_ms + 10 WHERE id = ?').bind(b.id).run()
    const { listRequests, withdraw } = await import('./store.ts')
    expect((await listRequests(db)).map(r => r.text)).toEqual(['second', 'first'])
    await withdraw(db, { id: a.id, ifRev: 1 }, at(ALEX))
    expect((await listRequests(db, 'open')).map(r => r.text)).toEqual(['second'])
    expect((await listRequests(db, 'withdrawn')).map(r => r.text)).toEqual(['first'])
  })
  it('refuses the 51st open request; done, declined and withdrawn ones do not count', async () => {
    const ids: string[] = []
    for (let i = 0; i < 50; i++) ids.push((await make(ALEX, { text: `request ${i}` })).id)
    expect(await createRequest(db, { kind: 'job', text: 'one too many' }, at(ALEX))).toEqual({ refused: 'request_limit' })
    expect((await auditLines()).length).toBe(50)
    const { setStatus } = await import('./store.ts')
    await setStatus(db, { id: ids[0]!, status: 'done', ifRev: 1 }, at('m_w3_ih'))
    const again = await createRequest(db, { kind: 'job', text: 'now there is room' }, at(ALEX))
    expect('ok' in again).toBe(true)
    expect(await createRequest(db, { kind: 'job', text: 'full again' }, at(ALEX))).toEqual({ refused: 'request_limit' })
  })
  it('is idempotent by what it asks: a retry whose first batch committed (reply lost), with a fresh request id, makes no second request', async () => {
    const lossy = { prepare: (s: string) => db.prepare(s), batch: async (st: D1PreparedStatement[]) => { await db.batch(st); throw new Error('reply lost') } } as unknown as D1Database
    await expect(createRequest(lossy, { kind: 'tool', subject: SUBJECT, text: TEXT }, at(ALEX))).rejects.toThrow('reply lost')
    const retry = await createRequest(db, { kind: 'tool', subject: SUBJECT, text: TEXT }, at(ALEX))
    expect('ok' in retry && retry.created).toBe(false)
    expect((await db.prepare('SELECT COUNT(*) AS n FROM team_requests').first<number>('n'))).toBe(1)
    expect((await auditLines()).length).toBe(1)
  })
  it('the same person, kind and subject answers the open one; another person, kind or subject, or one that left open, makes a new one', async () => {
    const { setStatus } = await import('./store.ts')
    const first = await make(ALEX, { subject: 'ledger' })
    const again = await createRequest(db, { kind: 'tool', subject: 'ledger', text: 'different words, same ask' }, at(ALEX))
    expect('ok' in again && [again.ok.id, again.created]).toEqual([first.id, false])
    for (const other of [
      await createRequest(db, { kind: 'tool', subject: 'ledger', text: TEXT }, at(SAM)),
      await createRequest(db, { kind: 'job', subject: 'ledger', text: TEXT }, at(ALEX)),
      await createRequest(db, { kind: 'tool', subject: 'other', text: TEXT }, at(ALEX)),
    ]) expect('ok' in other && other.created).toBe(true)
    await setStatus(db, { id: first.id, status: 'done', ifRev: 1 }, at('m_w3_ih'))
    const reopened = await createRequest(db, { kind: 'tool', subject: 'ledger', text: TEXT }, at(ALEX))
    expect('ok' in reopened && [reopened.created, reopened.ok.id === first.id]).toEqual([true, false])
    expect((await auditLines()).length).toBe(6)
  })
  it('with no subject, the same words from the same person are the same request; other words are not', async () => {
    const a = await createRequest(db, { kind: 'bug', text: 'It broke' }, at(ALEX))
    const b = await createRequest(db, { kind: 'bug', text: 'It broke' }, at(ALEX))
    const c = await createRequest(db, { kind: 'bug', text: 'It broke again' }, at(ALEX))
    expect([('ok' in a && a.created), ('ok' in b && b.created), ('ok' in c && c.created)]).toEqual([true, false, true])
  })
})

describe('status and withdraw (the store)', () => {
  it('done moves open to done, bumps rev, writes one status line; a second answer, a stale rev and withdraw-after-done conflict with the row as it is', async () => {
    const { setStatus, withdraw } = await import('./store.ts')
    const r = await make()
    const o = await setStatus(db, { id: r.id, status: 'done', ifRev: 1 }, at('m_w3_ih'))
    expect('ok' in o && [o.ok.status, o.ok.rev]).toEqual(['done', 2])
    const before = (await auditLines()).length
    for (const refused of [
      await setStatus(db, { id: r.id, status: 'declined', ifRev: 2 }, at('m_w3_ih')),
      await setStatus(db, { id: r.id, status: 'done', ifRev: 1 }, at('m_w3_ih')),
      await withdraw(db, { id: r.id, ifRev: 2 }, at(ALEX)),
    ]) expect('conflict' in refused && [refused.conflict.status, refused.conflict.rev]).toEqual(['done', 2])
    expect((await auditLines()).length).toBe(before)
    const last = (await auditLines()).at(-1)!
    expect(JSON.parse(last.args_json)).toEqual({ requestId: r.id, status: 'done' })
  })
  it('a stale ifRev on an open request conflicts and changes nothing', async () => {
    const { setStatus } = await import('./store.ts')
    const r = await make()
    const o = await setStatus(db, { id: r.id, status: 'declined', ifRev: 7 }, at('m_w3_ih'))
    expect('conflict' in o && o.conflict.status).toBe('open')
    expect((await auditLines()).length).toBe(1)
  })
  it('withdraw is the requester only: another person is refused not_owner with no write and no line', async () => {
    const { withdraw } = await import('./store.ts')
    const r = await make(ALEX)
    expect(await withdraw(db, { id: r.id, ifRev: 1 }, at(SAM))).toEqual({ refused: 'not_owner' })
    expect(await withdraw(db, { id: r.id, ifRev: 1 }, at(ADMIN))).toEqual({ refused: 'not_owner' })
    expect((await auditLines()).length).toBe(1)
    const o = await withdraw(db, { id: r.id, ifRev: 1 }, at(ALEX))
    expect('ok' in o && o.ok.status).toBe('withdrawn')
    expect(JSON.parse((await auditLines()).at(-1)!.args_json)).toEqual({ requestId: r.id, status: 'withdrawn' })
  })
  it('an unknown id is not_found before the owner rule, on both', async () => {
    const { setStatus, withdraw } = await import('./store.ts')
    const id = 'tr_AAAAAAAAAAAAAAAAAAAAAA'
    expect(await withdraw(db, { id, ifRev: 1 }, at(SAM))).toEqual({ refused: 'not_found' })
    expect(await setStatus(db, { id, status: 'done', ifRev: 1 }, at('m_w3_ih'))).toEqual({ refused: 'not_found' })
    expect((await auditLines()).length).toBe(0)
  })
})

describe('routes 80 to 83 (handlers)', () => {
  it('81 creates (201), trims, and refuses a body past the bounds or with extra fields (400)', async () => {
    const ok = await route(createTeamRequest, person(ALEX), { method: 'POST', path: '/api/team-requests', body: { kind: 'tool', subject: '  zebra  ', text: '  hi  ' } })
    expect([ok.status, ok.body.subject, ok.body.text, ok.body.mine, ok.body.status, ok.body.rev]).toEqual([201, 'zebra', 'hi', true, 'open', 1])
    for (const body of [
      { kind: 'tool', text: '' }, { kind: 'tool', text: '   ' }, { kind: 'tool', text: 'x'.repeat(1001) }, { kind: 'tool', subject: 'x'.repeat(65), text: 'a' },
      { kind: 'tool', subject: '', text: 'a' }, { kind: 'skill', text: 'a' }, { kind: 'tool', text: 'a', extra: 1 },
    ]) expect((await route(createTeamRequest, person(ALEX), { method: 'POST', path: '/api/team-requests', body })).status, JSON.stringify(body).slice(0, 40)).toBe(400)
    expect((await route(createTeamRequest, person(ALEX), { method: 'POST', path: '/api/team-requests', body: { kind: 'tool', text: 'x'.repeat(1000) } })).status).toBe(201)
    expect((await route(createTeamRequest, person(ALEX), { method: 'POST', path: '/api/team-requests', body: { kind: 'tool', subject: 'x'.repeat(64), text: 'a' } })).status).toBe(201)
  })
  it('81 at 50 open answers 403 request_limit', async () => {
    for (let i = 0; i < 50; i++) await make(ALEX, { text: `r${i}` })
    const r = await route(createTeamRequest, person(SAM), { method: 'POST', path: '/api/team-requests', body: { kind: 'job', text: 'more' } })
    expect([r.status, r.body.error.reason]).toEqual([403, 'request_limit'])
  })
  it('80 lists with `mine` per reader and a status filter; an unknown filter or parameter is 400', async () => {
    const r = await make(ALEX)
    const a = await route(listTeamRequests, person(ALEX), { path: '/api/team-requests' })
    const s = await route(listTeamRequests, person(SAM), { path: '/api/team-requests?status=open' })
    const i = await route(listTeamRequests, inhouse, { path: '/api/team-requests' })
    expect([a.body.items[0].id, a.body.items[0].mine, s.body.items[0].mine, i.body.items[0].mine]).toEqual([r.id, true, false, false])
    expect((await route(listTeamRequests, person(ALEX), { path: '/api/team-requests?status=done' })).body.items).toEqual([])
    // The Inhouse team gets no member ids, on the list or on its own answer; a person gets `requestedBy`.
    expect(JSON.stringify(i.body)).not.toContain(ALEX)
    expect(i.body.items[0]).not.toHaveProperty('requestedBy')
    expect(a.body.items[0].requestedBy).toBe(ALEX)
    const answered = await route(setTeamRequestStatus, inhouse, { method: 'PUT', path: `/api/team-requests/${r.id}/status`, params: { id: r.id }, body: { status: 'done', ifRev: 1 } })
    expect(JSON.stringify(answered.body)).not.toContain(ALEX)
    for (const p of ['/api/team-requests?status=x', '/api/team-requests?foo=1', '/api/team-requests?status=open&status=done']) expect((await route(listTeamRequests, person(ALEX), { path: p })).status, p).toBe(400)
  })
  it('82 the Inhouse team answers; a stale rev is 409 with the request; an unknown id and a malformed one are 404', async () => {
    const r = await make(ALEX)
    const path = `/api/team-requests/${r.id}/status`
    const stale = await route(setTeamRequestStatus, inhouse, { method: 'PUT', path, params: { id: r.id }, body: { status: 'done', ifRev: 9 } })
    expect([stale.status, stale.body.error.current.status]).toEqual([409, 'open'])
    const done = await route(setTeamRequestStatus, inhouse, { method: 'PUT', path, params: { id: r.id }, body: { status: 'declined', ifRev: 1 } })
    expect([done.status, done.body.status, done.body.rev]).toEqual([200, 'declined', 2])
    expect((await route(setTeamRequestStatus, inhouse, { method: 'PUT', path, params: { id: 'tr_AAAAAAAAAAAAAAAAAAAAAA' }, body: { status: 'done', ifRev: 1 } })).status).toBe(404)
    expect((await route(setTeamRequestStatus, inhouse, { method: 'PUT', path, params: { id: 'nope' }, body: { status: 'done', ifRev: 1 } })).status).toBe(404)
    expect((await route(setTeamRequestStatus, inhouse, { method: 'PUT', path, params: { id: r.id }, body: { status: 'withdrawn', ifRev: 2 } })).status).toBe(400)
  })
  it('83 a Member cannot withdraw another request (the owner rule); the owner can; an unknown id is 404 before the owner rule', async () => {
    const r = await make(ALEX)
    const path = `/api/team-requests/${r.id}/withdrawn`
    // The matrix's owner rule (`requireObject`, which the test context throws on, as api.ts turns into 403 not_owner).
    await expect(route(withdrawTeamRequest, person(SAM), { method: 'PUT', path, params: { id: r.id }, body: { ifRev: 1 } })).rejects.toThrow('refused: not_owner')
    expect((await db.prepare('SELECT status FROM team_requests WHERE id = ?').bind(r.id).first<string>('status'))).toBe('open')
    const gone = await route(withdrawTeamRequest, person(SAM), { method: 'PUT', path, params: { id: 'tr_AAAAAAAAAAAAAAAAAAAAAA' }, body: { ifRev: 1 } })
    expect(gone.status).toBe(404)
    const mine = await route(withdrawTeamRequest, person(ALEX), { method: 'PUT', path, params: { id: r.id }, body: { ifRev: 1 } })
    expect([mine.status, mine.body.status]).toEqual([200, 'withdrawn'])
    expect((await route(withdrawTeamRequest, person(ALEX), { method: 'PUT', path, params: { id: r.id }, body: { ifRev: 2 } })).status).toBe(409)
  })
})

describe('the access matrix rows (who may call each route)', () => {
  const row = (method: string, pattern: string) => accessMatrix.find(r => r.method === method && r.pattern === pattern)!
  it('Admin cannot decline, Member cannot set done, the Inhouse team cannot withdraw or create', () => {
    expect(row('PUT', '/api/team-requests/:id/status').allow).toEqual(['inhouse'])
    expect(row('PUT', '/api/team-requests/:id/withdrawn').allow).toEqual(['member', 'admin'])
    expect(row('POST', '/api/team-requests').allow).toEqual(['member', 'admin'])
    expect(row('GET', '/api/team-requests').allow).toEqual(['member', 'admin', 'inhouse'])
  })
})

describe('the tools', () => {
  let n = 0
  const scope = (memberId: string, requestId = `req-w3-tool-${++n}`): ToolScope => ({ memberId, chatId: 'c_w3', runId: 'r_AAAAAAAAAAAAAAAAAAAAAA', turnId: 't_AAAAAAAAAAAAAAAAAAAAAA', nowMs: NOW, requestId })
  const call = async (name: string, args: Record<string, unknown>, s: ToolScope): Promise<ToolResult> => {
    const h = TOOL_HANDLERS.get(name)!
    return h.call(h.input.parse(args), s, { db })
  }
  it('team_request_create files it, says who reads it, and answers the request id; a retry with a fresh request id is the same request', async () => {
    const s = scope(ALEX)
    const a = await call('team_request_create', { kind: 'tool', subject: SUBJECT, text: TEXT }, s)
    expect(a.isError).toBeUndefined()
    expect(a.content[0]!.text).toContain('Sent to the Inhouse team')
    expect(a.content[0]!.text).not.toContain('working day')
    // A real retry is a fresh tool call with a fresh request id: still the same request.
    const b = await call('team_request_create', { kind: 'tool', subject: SUBJECT, text: TEXT }, scope(ALEX))
    expect(b.structuredContent!.request_id).toBe(a.structuredContent!.request_id)
    expect((await db.prepare('SELECT COUNT(*) AS n FROM team_requests').first<number>('n'))).toBe(1)
  })
  it('a different request on a subject that already has an open one of the person\'s is told so, quoting the first words, never "Sent"', async () => {
    const first = await call('team_request_create', { kind: 'tool', subject: SUBJECT, text: 'Connect Zebra Ledger please' }, scope(ALEX))
    expect(first.structuredContent).toMatchObject({ created: true })
    const second = await call('team_request_create', { kind: 'tool', subject: SUBJECT, text: 'Actually, connect it read-only' }, scope(ALEX))
    expect(second.isError).toBeUndefined()
    expect(second.content[0]!.text).toContain('already an open request')
    expect(second.content[0]!.text).toContain('Connect Zebra Ledger please')
    expect(second.content[0]!.text).not.toContain('Sent to the Inhouse team')
    expect(second.structuredContent).toMatchObject({ created: false, text: 'Connect Zebra Ledger please' })
    expect((await db.prepare('SELECT COUNT(*) AS n FROM team_requests').first<number>('n'))).toBe(1)
  })
  it('a same-words resend says it is already with the team, not "Sent"', async () => {
    await call('team_request_create', { kind: 'tool', subject: SUBJECT, text: TEXT }, scope(ALEX))
    const again = await call('team_request_create', { kind: 'tool', subject: SUBJECT, text: TEXT }, scope(ALEX))
    expect(again.isError).toBeUndefined()
    expect(again.content[0]!.text).toContain('already with the Inhouse team')
    expect(again.content[0]!.text).not.toContain('Sent to the Inhouse team')
    expect(again.structuredContent).toMatchObject({ created: false })
  })
  it('a routine\'s run (m_system) gets the literal refusal and writes nothing', async () => {
    const r = await call('team_request_create', { kind: 'tool', text: TEXT }, scope('m_system'))
    expect([r.isError, r.content[0]!.text]).toEqual([true, 'A request to the Inhouse team needs a person. Tell the person in the summary instead.'])
    expect(NEEDS_PERSON_TEXT).toBe(r.content[0]!.text)
    expect((await db.prepare('SELECT COUNT(*) AS n FROM team_requests').first<number>('n'))).toBe(0)
    // The list is refused the same way: a routine has no person whose requests to show.
    const l = await call('team_request_list', {}, scope('m_system'))
    expect([l.isError, l.content[0]!.text]).toEqual([true, NEEDS_PERSON_TEXT])
  })
  it('the 51st is refused with request_limit; text and subject bounds are the schema', async () => {
    for (let i = 0; i < 50; i++) await make(ALEX, { text: `r${i}` })
    const r = await call('team_request_create', { kind: 'job', text: 'more' }, scope(SAM))
    expect([r.isError, r.structuredContent]).toEqual([true, { error: 'request_limit' }])
    const h = TOOL_HANDLERS.get('team_request_create')!
    expect(h.input.safeParse({ kind: 'tool', text: '' }).success).toBe(false)
    expect(h.input.safeParse({ kind: 'tool', text: 'x'.repeat(1001) }).success).toBe(false)
    expect(h.input.safeParse({ kind: 'tool', subject: 'x'.repeat(65), text: 'a' }).success).toBe(false)
    expect(h.input.safeParse({ kind: 'tool', text: 'a', extra: 1 }).success).toBe(false)
  })
  it('team_request_list answers newest first with yours marked, filtered by status', async () => {
    await make(ALEX, { text: 'mine' })
    const l = await call('team_request_list', { status: 'open' }, scope(ALEX))
    expect((l.structuredContent!.requests as { yours: boolean; text: string }[]).map(r => [r.text, r.yours])).toEqual([['mine', true]])
    const other = await call('team_request_list', {}, scope(SAM))
    expect((other.structuredContent!.requests as { yours: boolean }[])[0]!.yours).toBe(false)
    expect((await call('team_request_list', { status: 'done' }, scope(ALEX))).content[0]!.text).toBe('No requests to the Inhouse team.')
  })
})
