// Team requests (P6a acceptance 8, routes 80 to 83). Oracles are the plan's text, written out here and never read from the
// server's rows: Members and Admins create and read the brand's requests; the Inhouse team lists them (without a grant:
// a request is addressed to it), creates none, and is the only one who sets `done` or `declined` (route 82, from open);
// only the requester withdraws their own open request (route 83), the Admin and the Inhouse team can't; an unknown id is
// 404 wherever the matrix lets the caller in; text is 1 to 1000; at most 50 open at a time; each write leaves one audit
// line (`team_request.created { requestId, kind }`, `team_request.status { requestId, status }`) that never holds the text,
// and a refused write leaves none. The audit reads need the local D1; the rest runs on a deployed build too.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call, endLiveGrants, expectConflict, expectError, me } from './kit.ts'
import type { Actor, Reply } from './kit.ts'
import { auditAfter, auditMax, expectOneLine } from './db.ts'
import { needsLocalD1 } from './watch-kit.ts'

const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
const inhouse = actor('inhouse')
test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36)
let n = 0
/** A request text no other request in this run, or in an earlier one, says. */
const words = (what: string): string => `E2E ${what} ${stamp}-${++n}`
const ID = /^tr_[A-Za-z0-9_-]{22}$/

interface Rec { id: string; kind: string; subject: string | null; text: string; mine: boolean; status: string; rev: number; requestedBy?: string; at: { ms: number }; updatedAt: { ms: number } }

/** A 403 `forbidden`; its reason (`not_owner` and the like) is the handler's wording, not what these cases pin. */
const expectForbidden = (r: Reply): void => expect([r.status, r.json?.error?.code], r.text).toEqual([403, 'forbidden'])

const create = (request: APIRequestContext, who: Actor, json: unknown) => call(request, who, 'POST', '/api/team-requests', { json })
async function made(request: APIRequestContext, who: Actor, over: Record<string, unknown> = {}): Promise<Rec> {
  const r = await create(request, who, { kind: 'job', text: words('request'), ...over })
  expect(r.status, r.text).toBe(201)
  return r.json as Rec
}
async function list(request: APIRequestContext, who: Actor, query = ''): Promise<Rec[]> {
  const r = await call(request, who, 'GET', `/api/team-requests${query}`)
  expect(r.status, r.text).toBe(200)
  return r.json.items as Rec[]
}
const setStatus = (request: APIRequestContext, who: Actor, id: string, status: string, ifRev: number) => call(request, who, 'PUT', `/api/team-requests/${id}/status`, { json: { status, ifRev } })
const withdraw = (request: APIRequestContext, who: Actor, id: string, ifRev: number) => call(request, who, 'PUT', `/api/team-requests/${id}/withdrawn`, { json: { ifRev } })

/** The Inhouse team declines every open request, so a spec starts and ends with none open (the cap counts the whole brand). */
async function closeAllOpen(request: APIRequestContext): Promise<void> {
  for (const r of await list(request, inhouse, '?status=open')) {
    const done = await setStatus(request, inhouse, r.id, 'declined', r.rev)
    expect(done.status, done.text).toBe(200)
  }
}

test.beforeAll(async ({ request }) => {
  await endLiveGrants(request)
  await closeAllOpen(request)
})
test.afterAll(async ({ request }) => { await closeAllOpen(request) })

test('a Member and an Admin create a request; the Inhouse team can\'t; the record says what was asked, trimmed', async ({ request }) => {
  const text = words('connect the tool')
  const r = await create(request, dana, { kind: 'tool', subject: ' klaviyo ', text: `  ${text}  ` })
  expect(r.status, r.text).toBe(201)
  expect(r.json).toMatchObject({ kind: 'tool', subject: 'klaviyo', text, mine: true, status: 'open', rev: 1 })
  expect(r.json.id).toMatch(ID)
  const byAdmin = await create(request, admin, { kind: 'bug', text: words('admin bug') })
  expect(byAdmin.status, byAdmin.text).toBe(201)
  expect(byAdmin.json).toMatchObject({ kind: 'bug', subject: null, mine: true, status: 'open', rev: 1 })
  expectForbidden(await create(request, inhouse, { kind: 'job', text: words('from the team') }))
  for (const kind of ['job', 'change', 'feedback']) expect((await create(request, leo, { kind, text: words(kind) })).status, kind).toBe(201)
})

test('every request kind the client sends is accepted, and nothing else is', async ({ request }) => {
  for (const kind of ['tool', 'job', 'change', 'bug', 'feedback']) expect((await create(request, dana, { kind, text: words(kind) })).status, kind).toBe(201)
  for (const kind of ['skill', 'Tool', '', 'withdrawn']) expect((await create(request, dana, { kind, text: words('bad kind') })).status, `kind ${JSON.stringify(kind)}`).toBe(400)
})

test('bounds: the text is 1 to 1000 characters, the subject 1 to 64, the body exactly { kind, subject?, text }', async ({ request }) => {
  const pad = (len: number) => `${words('x')} `.padEnd(len, 'y').slice(0, len)
  const bad: [string, unknown][] = [
    ['empty text', { kind: 'job', text: '' }],
    ['blank text', { kind: 'job', text: '   \n ' }],
    ['text of 1001', { kind: 'job', text: pad(1001) }],
    ['no text', { kind: 'job' }],
    ['no kind', { text: words('no kind') }],
    ['text that isn\'t text', { kind: 'job', text: 5 }],
    ['subject of 65', { kind: 'tool', subject: 's'.repeat(65), text: words('subject') }],
    ['blank subject', { kind: 'tool', subject: '  ', text: words('subject') }],
    ['an extra key', { kind: 'job', text: words('extra'), status: 'done' }],
    ['an empty body', {}],
  ]
  for (const [what, json] of bad) {
    const r = await create(request, dana, json)
    expect([r.status, r.json?.error?.code], what).toEqual([400, 'invalid'])
  }
  const top = await create(request, dana, { kind: 'job', text: pad(1000) })
  expect(top.status, '1000 characters is allowed').toBe(201)
  expect(top.json.text).toHaveLength(1000)
  expect((await create(request, dana, { kind: 'tool', subject: 's'.repeat(64), text: words('subject') })).status, 'a 64-character subject is allowed').toBe(201)
  expect((await create(request, dana, { kind: 'job', text: 'a' })).status, 'one character is allowed').toBe(201)
  // Not JSON at all.
  const raw = await call(request, dana, 'POST', '/api/team-requests', { bytes: Buffer.from('not json'), contentType: 'application/json' })
  expect(raw.status, raw.text).toBe(400)
})

test('the list is the brand\'s, newest first: each reader sees which are theirs; the Inhouse team reads without a grant', async ({ request }) => {
  const first = await made(request, dana, { text: words('older') })
  const second = await made(request, leo, { text: words('newer') })
  for (const [who, mineFirst, mineSecond] of [[dana, true, false], [leo, false, true], [admin, false, false], [inhouse, false, false]] as [Actor, boolean, boolean][]) {
    const items = await list(request, who)
    const a = items.findIndex(x => x.id === first.id)
    const b = items.findIndex(x => x.id === second.id)
    expect(a, 'both are listed').toBeGreaterThanOrEqual(0)
    expect(b).toBeGreaterThanOrEqual(0)
    expect(b, 'newest first').toBeLessThan(a)
    expect(items[a]!.text).toBe(first.text)
    expect([items[a]!.mine, items[b]!.mine]).toEqual([mineFirst, mineSecond])
    for (let i = 1; i < items.length; i++) expect(items[i - 1]!.at.ms, 'newest first throughout').toBeGreaterThanOrEqual(items[i]!.at.ms)
    expect(items.length).toBeLessThanOrEqual(200)
  }
})

test('the list filters by status, and refuses an unknown status or any other query', async ({ request }) => {
  const r = await made(request, dana, { text: words('to filter') })
  expect((await list(request, dana, '?status=open')).map(x => x.id)).toContain(r.id)
  expect((await list(request, dana, '?status=open')).every(x => x.status === 'open')).toBe(true)
  const w = await withdraw(request, dana, r.id, 1)
  expect(w.status, w.text).toBe(200)
  expect((await list(request, dana, '?status=open')).map(x => x.id)).not.toContain(r.id)
  expect((await list(request, dana, '?status=withdrawn')).map(x => x.id)).toContain(r.id)
  for (const q of ['?status=nope', '?status=', '?limit=5', '?status=open&status=done', '?view=nope', '?view=window&status=open']) {
    const bad = await call(request, dana, 'GET', `/api/team-requests${q}`)
    expect([bad.status, bad.json?.error?.code], q).toEqual([400, 'invalid'])
  }
  expectError(await call(request, dana, 'GET', '/api/team-requests', { token: null }), 401, 'unauthorized')
})

test("the team window lists open, done, declined and withdrawn with the reader's permissions", async ({ request }) => {
  const done = await made(request, dana)
  const declined = await made(request, dana)
  const withdrawn = await made(request, dana)
  const open = await made(request, dana)
  expect((await setStatus(request, inhouse, done.id, 'done', done.rev)).status).toBe(200)
  expect((await setStatus(request, inhouse, declined.id, 'declined', declined.rev)).status).toBe(200)
  expect((await withdraw(request, dana, withdrawn.id, withdrawn.rev)).status).toBe(200)
  const ids = [done.id, declined.id, withdrawn.id, open.id]

  for (const who of [dana, leo, admin, inhouse]) {
    const items = await list(request, who, '?view=window')
    expect(ids.map(id => items.find(item => item.id === id)?.status)).toEqual(['done', 'declined', 'withdrawn', 'open'])
    for (const item of items.filter(item => ids.includes(item.id))) {
      expect(item.mine).toBe(who === dana)
      if (who === inhouse) expect(item).not.toHaveProperty('requestedBy')
    }
  }
  expect((await list(request, dana, '?status=open')).filter(item => ids.includes(item.id)).map(item => item.id)).toEqual([open.id])
})

test('route 82: the Inhouse team sets done or declined from open; an Admin and a Member can\'t, and nothing changes', async ({ request }) => {
  const a = await made(request, dana, { text: words('to finish') })
  const b = await made(request, dana, { text: words('to decline') })
  for (const who of [admin, dana, leo]) {
    for (const status of ['done', 'declined']) expectForbidden(await setStatus(request, who, a.id, status, 1))
  }
  expect((await list(request, inhouse)).find(x => x.id === a.id)).toMatchObject({ status: 'open', rev: 1 })
  const done = await setStatus(request, inhouse, a.id, 'done', 1)
  expect(done.status, done.text).toBe(200)
  expect(done.json).toMatchObject({ id: a.id, status: 'done', rev: 2, text: a.text })
  const declined = await setStatus(request, inhouse, b.id, 'declined', 1)
  expect(declined.status, declined.text).toBe(200)
  expect(declined.json).toMatchObject({ id: b.id, status: 'declined', rev: 2 })
  // The requester reads the answer.
  expect((await list(request, dana)).find(x => x.id === a.id)).toMatchObject({ status: 'done', mine: true })
})

test('route 82 never withdraws, and takes exactly { status, ifRev }', async ({ request }) => {
  const r = await made(request, dana, { text: words('no withdraw') })
  for (const json of [{ status: 'withdrawn', ifRev: 1 }, { status: 'open', ifRev: 1 }, { status: 'done' }, { ifRev: 1 }, { status: 'done', ifRev: 0 }, { status: 'done', ifRev: 1, extra: 1 }, {}]) {
    const bad = await call(request, inhouse, 'PUT', `/api/team-requests/${r.id}/status`, { json })
    expect([bad.status, bad.json?.error?.code], JSON.stringify(json)).toEqual([400, 'invalid'])
  }
  expect((await list(request, inhouse)).find(x => x.id === r.id)).toMatchObject({ status: 'open', rev: 1 })
})

test('a stale ifRev, or a request that isn\'t open any more, is a 409 with the request as it is now', async ({ request }) => {
  const r = await made(request, dana, { text: words('conflicts') })
  expect(expectConflict(await setStatus(request, inhouse, r.id, 'done', 2))).toMatchObject({ id: r.id, status: 'open', rev: 1 })
  expect((await setStatus(request, inhouse, r.id, 'done', 1)).status).toBe(200)
  // Done is final: not declined, not withdrawn.
  expect(expectConflict(await setStatus(request, inhouse, r.id, 'declined', 2))).toMatchObject({ id: r.id, status: 'done', rev: 2 })
  expect(expectConflict(await setStatus(request, inhouse, r.id, 'done', 1))).toMatchObject({ status: 'done', rev: 2 })
  expect(expectConflict(await withdraw(request, dana, r.id, 2))).toMatchObject({ id: r.id, status: 'done', rev: 2 })
  const w = await made(request, dana, { text: words('withdrawn conflicts') })
  expect((await withdraw(request, dana, w.id, 1)).status).toBe(200)
  expect(expectConflict(await setStatus(request, inhouse, w.id, 'done', 2))).toMatchObject({ status: 'withdrawn', rev: 2 })
  expect(expectConflict(await withdraw(request, dana, w.id, 2))).toMatchObject({ status: 'withdrawn', rev: 2 })
  expect(expectConflict(await withdraw(request, dana, w.id, 1))).toMatchObject({ status: 'withdrawn', rev: 2 })
})

test('route 83: only the requester withdraws, from open; another Member, the Admin and the Inhouse team can\'t', async ({ request }) => {
  const r = await made(request, dana, { text: words('to withdraw') })
  expectForbidden(await withdraw(request, leo, r.id, 1))
  expectForbidden(await withdraw(request, admin, r.id, 1))
  expectForbidden(await withdraw(request, inhouse, r.id, 1))
  expect((await list(request, inhouse)).find(x => x.id === r.id)).toMatchObject({ status: 'open', rev: 1 })
  expect(expectConflict(await withdraw(request, dana, r.id, 2))).toMatchObject({ id: r.id, status: 'open', rev: 1 })
  const mine = await withdraw(request, dana, r.id, 1)
  expect(mine.status, mine.text).toBe(200)
  expect(mine.json).toMatchObject({ id: r.id, status: 'withdrawn', rev: 2, mine: true })
  // An Admin withdraws their own like anyone.
  const own = await made(request, admin, { text: words('admin own') })
  expect((await withdraw(request, admin, own.id, 1)).json).toMatchObject({ status: 'withdrawn', mine: true })
  // A body that isn't exactly { ifRev } is invalid.
  const again = await made(request, dana, { text: words('body') })
  for (const json of [{}, { ifRev: 0 }, { ifRev: 1, withdrawn: true }, { withdrawn: true }]) {
    const bad = await call(request, dana, 'PUT', `/api/team-requests/${again.id}/withdrawn`, { json })
    expect([bad.status, bad.json?.error?.code], JSON.stringify(json)).toEqual([400, 'invalid'])
  }
})

test('an unknown id is 404 wherever the matrix lets the caller in; the matrix answers first for the rest', async ({ request }) => {
  const missing = 'tr_E2eNobodyAAAAAAAAAAAAA'
  expect(missing).toMatch(ID)
  expectError(await withdraw(request, dana, missing, 1), 404, 'not_found')
  expectError(await withdraw(request, admin, missing, 1), 404, 'not_found')
  expectError(await setStatus(request, inhouse, missing, 'done', 1), 404, 'not_found')
  expectError(await withdraw(request, dana, 'not-an-id', 1), 404, 'not_found')
  expectError(await setStatus(request, inhouse, 'not-an-id', 'done', 1), 404, 'not_found')
  expectForbidden(await setStatus(request, dana, missing, 'done', 1))
  expectForbidden(await withdraw(request, inhouse, missing, 1))
})

test('each write leaves one audit line with the id and the kind or status, never the text; a refused write leaves none', async ({ request }) => {
  needsLocalD1()
  const danaId = (await me(request, dana)).memberId as string
  const adminId = (await me(request, admin)).memberId as string
  const text = words('audited secret wording')
  const subject = `audited-${stamp}`
  let mark = auditMax()
  const r = await create(request, dana, { kind: 'change', subject, text })
  expect(r.status, r.text).toBe(201)
  const line = expectOneLine(mark, 'team_request.created', danaId, [text, subject])
  expect(JSON.parse(line.args_json)).toEqual({ requestId: r.json.id, kind: 'change' })
  expect([line.target_kind, line.target_id]).toEqual(['team_request', r.json.id])

  // Refused writes: no line.
  mark = auditMax()
  expectForbidden(await setStatus(request, admin, r.json.id, 'declined', 1))
  expectForbidden(await withdraw(request, leo, r.json.id, 1))
  expectError(await withdraw(request, dana, 'tr_E2eNobodyAAAAAAAAAAAAA', 1), 404, 'not_found')
  expect((await setStatus(request, inhouse, r.json.id, 'done', 9)).status).toBe(409)
  expect((await create(request, dana, { kind: 'job', text: '' })).status).toBe(400)
  expect(auditAfter(mark), 'no refused write leaves a line').toEqual([])

  mark = auditMax()
  expect((await setStatus(request, inhouse, r.json.id, 'done', 1)).status).toBe(200)
  const inhouseId = (await me(request, inhouse)).memberId as string
  const done = expectOneLine(mark, 'team_request.status', inhouseId, [text])
  expect(JSON.parse(done.args_json)).toEqual({ requestId: r.json.id, status: 'done' })

  const w = await made(request, admin, { text: words('admin withdraws') })
  mark = auditMax()
  expect((await withdraw(request, admin, w.id, 1)).status).toBe(200)
  const line2 = expectOneLine(mark, 'team_request.status', adminId, [w.text])
  expect(JSON.parse(line2.args_json)).toEqual({ requestId: w.id, status: 'withdrawn' })
})

test('the 51st open request is refused, and the team window keeps all open and the latest 50 closed', async ({ request }) => {
  test.setTimeout(180_000)
  await closeAllOpen(request)
  const ids: string[] = []
  for (let i = 0; i < 50; i++) {
    const r = await create(request, i % 2 === 0 ? dana : leo, { kind: 'feedback', text: words(`cap ${i}`) })
    expect(r.status, `request ${i + 1}: ${r.text}`).toBe(201)
    ids.push(r.json.id)
  }
  const over = await create(request, dana, { kind: 'feedback', text: words('the 51st') })
  expectError(over, 403, 'forbidden', 'request_limit')
  expect((await list(request, inhouse, '?status=open')).length).toBe(50)
  const fullWindow = await list(request, inhouse, '?view=window')
  expect(fullWindow.filter(r => r.status === 'open').map(r => r.id).sort()).toEqual(ids.slice().sort())
  // Closed ones don't count: the Inhouse team answers one, a requester takes one back.
  const done = await setStatus(request, inhouse, ids[0]!, 'done', 1)
  expect(done.status, done.text).toBe(200)
  expect((await create(request, dana, { kind: 'feedback', text: words('after one is done') })).status).toBe(201)
  expectError(await create(request, leo, { kind: 'feedback', text: words('full again') }), 403, 'forbidden', 'request_limit')
  const withdrawn = await withdraw(request, leo, ids[1]!, 1)
  expect(withdrawn.status, withdrawn.text).toBe(200)
  expect((await create(request, leo, { kind: 'feedback', text: words('after a withdraw') })).status).toBe(201)

  const closed: Rec[] = [done.json, withdrawn.json]
  const [stillOpen, ...toClose] = await list(request, inhouse, '?status=open')
  // Close older requests last, so ordering by creation time would give the wrong window.
  for (const r of toClose) {
    const declined = await setStatus(request, inhouse, r.id, 'declined', r.rev)
    expect(declined.status, declined.text).toBe(200)
    closed.push(declined.json)
  }
  expect(closed).toHaveLength(51)
  closed.sort((a, b) => b.updatedAt.ms - a.updatedAt.ms || (a.id < b.id ? 1 : -1))
  const window = await list(request, inhouse, '?view=window')
  expect(window.map(r => r.id)).toEqual([stillOpen!.id, ...closed.slice(0, 50).map(r => r.id)])
  await closeAllOpen(request)
})
