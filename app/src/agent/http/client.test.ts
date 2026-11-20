// The product client over a fake `fetch`. Ways it could break what the product shell and the settings UI rely on, written
// down before the tests:
//  - a refusal that maps to the wrong `AgentError` (code, reason, the record as it is now), or a body that isn't ours
//    treated as one of ours;
//  - an answer that doesn't parse reaching the snapshot, or `me()` set from one;
//  - a failed write that stays applied, tells nobody or tells twice, or keeps a snapshot object it should have given back;
//  - a stale `ifRev` that doesn't show the current record, or a write that sends no `ifRev` at all;
//  - a 401 or a 403 "not invited" that isn't the signed-out state, or that still reads the rest;
//  - a read a Member can't make (the grants) that is asked for anyway, or `me()` that arrives after the page is ready;
//  - `loadMore` that fetches the same page twice when called twice;
//  - a request that leaves the app's origin, carries a cookie it shouldn't, or sends a body in the wrong type;
//  - the stub parts (a run, the library) that stop refusing.
import { fc, test as fcTest } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import { AgentDataSchema, AgentStateSchema, ErrorBodySchema, MeSchema } from '../../../shared/contract'
import { CAN_KEYS } from '../../../shared/contract/keys'
import type { AgentClient, AgentNotice } from '../types'
import { AgentError } from '../types'
import { HttpAgent } from './client'

const ME_ID = 'm_sam'
const iso = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const can = (on: boolean) => Object.fromEntries(CAN_KEYS.map(k => [k, on]))
const me = (o: Record<string, unknown> = {}) => ({ memberId: ME_ID, name: 'Sam Mercer', email: 'sam@example.test', role: 'admin', can: can(true), photoUrl: null, grant: null, ...o })
const member = (id: string, o: Record<string, unknown> = {}) => ({ id, name: id, email: `${id}@example.test`, title: null, role: 'member', status: 'active', photo: null, rev: 1, ...o })
const grant = (o: Record<string, unknown> = {}) => ({ id: 'g_1', createdBy: ME_ID, createdAt: iso(1000), endsAt: iso(1000 + 3_600_000), endedAt: null, endedBy: null, rev: 1, live: true, ...o })
const line = (id: number) => ({ id, at: iso(id * 1000), actorId: ME_ID, who: 'Sam', what: 'Changed', detail: '' })

type Req = { method: string; path: string; headers: Record<string, string>; body: string | undefined; credentials: string | undefined }
type Answer = { status?: number; body?: unknown; text?: string }
/** Answers by "METHOD path" (query included); a request nobody answers is a test mistake and throws. */
function server(routes: Record<string, Answer | ((r: Req) => Answer)>) {
  const calls: Req[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://x.test')
    const req: Req = {
      method: init?.method ?? 'GET', path: decodeURIComponent(url.pathname) + url.search, headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined, credentials: init?.credentials,
    }
    calls.push(req)
    const route = routes[`${req.method} ${req.path}`]
    if (!route) throw new Error(`no answer for ${req.method} ${req.path}`)
    const a = typeof route === 'function' ? route(req) : route
    const status = a.status ?? 200
    return new Response(a.text ?? JSON.stringify(a.body ?? {}), { status })
  }
  return { fetch, calls }
}
const refusal = (status: number, code: string, extra: Record<string, unknown> = {}): Answer => ({ status, body: { error: { code, ...extra } } })

/** The reads a brand Admin's first load makes. */
const reads = (o: { me?: unknown; members?: unknown[]; settings?: Record<string, unknown[]> } = {}): Record<string, Answer> => ({
  'GET /api/me': { body: o.me ?? me() },
  'GET /api/settings/personal': { body: { items: o.settings?.personal ?? [] } },
  'GET /api/settings/brand': { body: { items: o.settings?.brand ?? [] } },
  'GET /api/settings/technical': { body: { items: o.settings?.technical ?? [] } },
  'GET /api/members': { body: { items: o.members ?? [member(ME_ID, { role: 'admin' }), member('m_dana')], nextCursor: null } },
  'GET /api/grants': { body: { items: [] } },
  'GET /api/audit': { body: { items: [line(2), line(1)], nextCursor: null } },
})
const record = (key: string, value: unknown, rev: number) => ({ key, value, rev, updatedAt: null, updatedBy: null })

async function loaded(routes: Record<string, Answer | ((r: Req) => Answer)>) {
  const s = server(routes)
  const agent = new HttpAgent({ fetch: s.fetch, now: () => 5000 })
  const heard: AgentNotice[] = []
  agent.onNotice(n => heard.push(n))
  await agent.whenLoaded()
  return { agent, heard, ...s }
}
const errorOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => 'resolved', (e: unknown) => e)

describe('reads', () => {
  test('before anything is read: the same loading objects every time, in the product shape, and nothing asked of the server', () => {
    const s = server({})
    const c = new HttpAgent({ fetch: s.fetch })
    expect(c.read()).toBe(c.read())
    expect(c.getSnapshot()).toBe(c.getSnapshot())
    expect(c.me()).toBeNull()
    expect(AgentDataSchema.parse(c.read()).status).toBe('loading')
    AgentStateSchema.parse(c.getSnapshot())
    expect(Object.keys(c.read())).not.toContain('scenarios')
    expect(s.calls).toEqual([])
  })

  test('the first reads: me first, one fetch per resource, same origin, no cookie leaving it, and read() stays stable', async () => {
    const { agent, calls } = await loaded(reads({ settings: { personal: [record('g:theme', 'Dark', 3), record('n:weekly', true, 2)], brand: [record('g:tz', 'Europe/London', 1)] } }))
    expect(calls[0].path).toBe('/api/me')
    expect(calls.map(c => `${c.method} ${c.path}`).sort()).toEqual(Object.keys(reads()).sort())
    for (const c of calls) { expect(c.credentials).toBe('same-origin'); expect(c.path.startsWith('/api/')).toBe(true) }
    expect(AgentDataSchema.parse(agent.read())).toMatchObject({ status: 'ready', people: { members: [{ id: ME_ID }, { id: 'm_dana' }] }, meta: { currentUser: { id: ME_ID, role: 'Admin', initials: 'SM' } } })
    expect(MeSchema.parse(agent.me()).memberId).toBe(ME_ID)
    expect(agent.getSnapshot()).toMatchObject({ settings: { 'g:theme': 'Dark', 'g:tz': 'Europe/London' }, toggles: { 'n:weekly': true } })
    expect(Object.values(agent.read().resources).every(r => r.status === 'ready')).toBe(true)
    expect(agent.read()).toBe(agent.read())
    expect(agent.auditExportUrl()).toBe('/api/audit/export.csv')
    expect(agent.signOutUrl()).toBe('/cdn-cgi/access/logout')
  })

  test('me() is there before read().status is ready', async () => {
    const seen: string[] = []
    const r = reads()
    const s = server({ ...r, 'GET /api/settings/brand': () => { seen.push('settings'); return r['GET /api/settings/brand'] } })
    const agent = new HttpAgent({ fetch: s.fetch })
    agent.subscribe(() => { seen.push(`${agent.read().status}:${agent.me() ? 'me' : 'no-me'}`) })
    await agent.whenLoaded()
    expect(seen.filter(x => x.startsWith('ready'))).not.toContain('ready:no-me')
  })

  test('a Member is not asked for the grants, or for what they may not view; the Inhouse team has no personal settings', async () => {
    const member1 = await loaded(reads({ me: me({ role: 'member', can: { ...can(false), viewMembers: true, viewAudit: true } }) }))
    expect(member1.calls.map(c => c.path)).not.toContain('/api/grants')
    expect(member1.agent.read().resources.grants.status).toBe('ready')
    const staff = await loaded(reads({ me: me({ role: 'inhouse', can: can(false) }) }))
    expect(staff.calls.map(c => c.path)).toEqual(['/api/me', '/api/settings/brand', '/api/settings/technical'])
  })

  test('a 403 on the grants reads as "not for you", not an error', async () => {
    const { agent } = await loaded({ ...reads(), 'GET /api/grants': refusal(403, 'forbidden') })
    expect(agent.read().resources.grants).toEqual({ status: 'ready' })
  })

  test.each([
    ['a 401', refusal(401, 'unauthorized'), { status: 'error', error: 'unauthorized' }],
    ['a 403 not invited', refusal(403, 'forbidden', { reason: 'not_invited' }), { status: 'error', error: 'forbidden', reason: 'not_invited' }],
    ['a 403 removed', refusal(403, 'forbidden', { reason: 'removed' }), { status: 'error', error: 'forbidden', reason: 'removed' }],
  ])('%s on me() is the signed-out state: meta says so and nothing else is read', async (_n, answer, meta) => {
    const { agent, calls } = await loaded({ 'GET /api/me': answer })
    expect(agent.read().resources.meta).toEqual(meta)
    expect(agent.read().status).toBe('loading')
    expect(agent.me()).toBeNull()
    expect(calls.map(c => c.path)).toEqual(['/api/me'])
  })

  test('an answer that does not parse never reaches the snapshot, and its schema message is logged', async () => {
    const logged: unknown[] = []
    const real = console.error
    console.error = (...a: unknown[]) => { logged.push(a) }
    try {
      const { agent } = await loaded({ ...reads(), 'GET /api/members': { body: { items: [{ id: 'm_x', name: 7 }], nextCursor: null } }, 'GET /api/audit': { text: 'not json' } })
      expect(agent.read().people.members).toEqual([])
      expect(agent.read().resources.members).toEqual({ status: 'error', error: 'unknown' })
      expect(agent.read().resources.audit).toEqual({ status: 'error', error: 'unknown' })
      expect(agent.read().resources.meta.status).toBe('ready')
      expect(logged.length).toBeGreaterThanOrEqual(2)
      const bad = await loaded({ ...reads({ me: { ...me(), role: 'owner' } }) })
      expect(bad.agent.me()).toBeNull()
      expect(bad.agent.read().resources.meta).toEqual({ status: 'error', error: 'unknown' })
    } finally { console.error = real }
  })

  test('retry reads a failed resource again and tells the listeners; the others stay as they were', async () => {
    let fail = true
    const r = reads()
    const { agent } = await loaded({ ...r, 'GET /api/members': () => (fail ? refusal(503, 'unavailable') : r['GET /api/members']) })
    expect(agent.read().resources.members).toEqual({ status: 'error', error: 'unavailable' })
    expect(agent.read().resources.audit.status).toBe('ready')
    fail = false
    let heard = 0
    agent.subscribe(() => { heard++ })
    await agent.retry('members')
    expect(agent.read().resources.members).toEqual({ status: 'ready' })
    expect(agent.read().people.members).toHaveLength(2)
    expect(heard).toBeGreaterThanOrEqual(1)
    await expect(agent.retry('library')).resolves.toBeUndefined()
  })
})

describe('refusals become AgentErrors', () => {
  const cases: [number, string, string][] = [
    [400, 'invalid', 'invalid'], [401, 'unauthorized', 'unauthorized'], [403, 'forbidden', 'forbidden'], [404, 'not_found', 'not_found'],
    [409, 'conflict', 'conflict'], [429, 'rate_limited', 'rate_limited'], [503, 'unavailable', 'unavailable'], [500, 'unknown', 'unknown'],
  ]
  test.each(cases)('status %i with a body naming %s is code %s, with its reason', async (status, code, want) => {
    const { agent } = await loaded({ ...reads(), 'PUT /api/settings/personal/g:theme': refusal(status, code, { reason: 'not_owner' }) })
    const e = await errorOf(agent.setSetting('g:theme', 'Dark')) as AgentError
    expect(e).toBeInstanceOf(AgentError)
    expect([e.code, e.reason]).toEqual([want, 'not_owner'])
  })
  test.each([[400, 'invalid'], [401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'], [409, 'conflict'], [429, 'rate_limited'], [503, 'unavailable'], [502, 'unknown'], [500, 'unknown']])(
    'status %i with no body of ours is %s', async (status, code) => {
      const { agent } = await loaded({ ...reads(), 'PUT /api/settings/personal/g:theme': { status, text: '<html>nope</html>' } })
      expect(((await errorOf(agent.setSetting('g:theme', 'Dark'))) as AgentError).code).toBe(code)
    })
  test('a lost connection is offline', async () => {
    const { agent } = await loaded(reads())
    const dead = new HttpAgent({ fetch: () => Promise.reject(new TypeError('failed to fetch')) })
    expect(((await errorOf(dead.setSetting('g:theme', 'Dark'))) as AgentError).code).toBe('offline')
    expect(agent).toBeDefined()
  })
  test('the error body is the shared schema: the codes it names are the codes the client rejects with', () => {
    for (const code of ErrorBodySchema.shape.error.shape.code.options) expect(cases.map(c => c[1]).concat(['offline', 'cap_reached'])).toContain(code)
  })
})

describe('writes', () => {
  const put = (key: string, scope = 'personal') => `PUT /api/settings/${scope}/${key}`

  test('a setting shows at once, is saved with the rev last read as ifRev, and takes the rev it answers with', async () => {
    let seen: Req | undefined
    const { agent, heard } = await loaded({
      ...reads({ settings: { personal: [record('g:theme', 'Dark', 3)] } }),
      [put('g:theme')]: r => { seen = r; return { body: record('g:theme', 'Light', 4) } },
      [put('n:weekly')]: r => { seen = r; return { body: record('n:weekly', true, 1) } },
    })
    const p = agent.setSetting('g:theme', 'Light')
    expect(agent.getSnapshot().settings['g:theme'], 'applied before the answer').toBe('Light')
    await p
    expect(JSON.parse(seen!.body!)).toEqual({ value: 'Light', ifRev: 3 })
    expect(seen!.headers['Content-Type']).toBe('application/json')
    await agent.setToggle('n:weekly', true)
    expect(JSON.parse(seen!.body!)).toEqual({ value: true, ifRev: 0 })
    expect(agent.getSnapshot().toggles['n:weekly']).toBe(true)
    expect(heard).toEqual([])
  })

  test('each scope has its own route, by the key', async () => {
    const paths: string[] = []
    const all = (k: string, v: unknown): Answer => ({ body: record(k, v, 1) })
    const { agent } = await loaded({
      ...reads(),
      [put('g:tz', 'brand')]: r => { paths.push(r.path); return all('g:tz', 'Europe/Paris') },
      [put('stage', 'technical')]: r => { paths.push(r.path); return all('stage', 'Act') },
      [put('n:channel')]: r => { paths.push(r.path); return all('n:channel', 'ops') },
    })
    await agent.setSetting('g:tz', 'Europe/Paris'); await agent.setSetting('stage', 'Act'); await agent.setSetting('n:channel', 'ops')
    expect(paths).toEqual(['/api/settings/brand/g:tz', '/api/settings/technical/stage', '/api/settings/personal/n:channel'])
  })

  test('a failed write is taken back with the very objects it had, and tells once', async () => {
    const { agent, heard } = await loaded({ ...reads({ settings: { personal: [record('g:theme', 'Dark', 3)] } }), [put('g:theme')]: refusal(503, 'unavailable') })
    const before = { snap: agent.getSnapshot(), data: agent.read() }
    const p = agent.setSetting('g:theme', 'Light')
    expect(agent.getSnapshot().settings['g:theme']).toBe('Light')
    const e = await errorOf(p) as AgentError
    expect(e.code).toBe('unavailable')
    expect(agent.getSnapshot()).toBe(before.snap)
    expect(agent.read()).toBe(before.data)
    expect(heard).toEqual([{ type: 'error', code: 'unavailable', text: e.message }])
  })

  test('a stale ifRev puts the current record in the snapshot and the error, and the next write sends its rev', async () => {
    const answers: Answer[] = [refusal(409, 'conflict', { current: record('g:theme', 'Light', 7) }), { body: record('g:theme', 'Dark', 8) }]
    const bodies: unknown[] = []
    const { agent, heard } = await loaded({ ...reads({ settings: { personal: [record('g:theme', 'Dark', 3)] } }), [put('g:theme')]: r => { bodies.push(JSON.parse(r.body!)); return answers.shift()! } })
    const e = await errorOf(agent.setSetting('g:theme', 'System')) as AgentError
    expect([e.code, (e.current as { value: string }).value]).toEqual(['conflict', 'Light'])
    expect(agent.getSnapshot().settings['g:theme']).toBe('Light')
    expect(heard).toHaveLength(1)
    await agent.setSetting('g:theme', 'Dark')
    expect(bodies).toEqual([{ value: 'System', ifRev: 3 }, { value: 'Dark', ifRev: 7 }])
  })

  test('a setting or value outside the registry never leaves the client: invalid, one notice, nothing changed', async () => {
    const { agent, heard, calls } = await loaded(reads())
    const snap = agent.getSnapshot()
    const n = calls.length
    for (const run of [
      () => agent.setSetting('no:such', 'x'), () => agent.setSetting('g:theme', 'Neon'), () => agent.setSetting('n:slack', 'yes'), () => agent.setToggle('g:theme', true),
      () => agent.setSetting(`p:${ME_ID}`, 'Admin'), () => agent.setSetting('d:support', 'on'), () => agent.setSetting(`photo:${ME_ID}`, 'data:image/png;base64,AAAA'),
    ]) expect(((await errorOf(run())) as AgentError).code).toBe('invalid')
    expect(agent.getSnapshot()).toBe(snap)
    expect(calls).toHaveLength(n)
    expect(heard.every(x => x.type === 'error' && x.code === 'invalid')).toBe(true)
    expect(heard).toHaveLength(7)
  })

  test('a reset stores null and removes the value from both maps', async () => {
    const { agent } = await loaded({ ...reads({ settings: { personal: [record('g:theme', 'Dark', 3)] } }), [put('g:theme')]: { body: record('g:theme', null, 4) } })
    await agent.setSetting('g:theme', null)
    expect(agent.getSnapshot().settings['g:theme']).toBeUndefined()
  })

  fcTest.prop([fc.constantFrom(400, 401, 403, 404, 409, 429, 500, 502, 503), fc.constantFrom('Light', 'Dark', 'System')], { numRuns: 60 })(
    'any refusal of a setting write leaves the snapshot as it was and tells exactly once, with the same code it rejects with', async (status, value) => {
      const { agent, heard } = await loaded({ ...reads({ settings: { personal: [record('g:theme', 'Dark', 3)] } }), [put('g:theme')]: { status, text: '{}' } })
      const before = agent.getSnapshot()
      const e = await errorOf(agent.setSetting('g:theme', value)) as AgentError
      expect(e).toBeInstanceOf(AgentError)
      expect(agent.getSnapshot()).toBe(before)
      expect(heard).toEqual([{ type: 'error', code: e.code, text: e.message }])
    })

  test('a 401 on a write puts the client in the signed-out state', async () => {
    const { agent } = await loaded({ ...reads(), [put('g:theme')]: refusal(401, 'unauthorized') })
    await errorOf(agent.setSetting('g:theme', 'Light'))
    expect(agent.read().resources.meta).toMatchObject({ status: 'error', error: 'unauthorized' })
  })

  test('the name is on the member record too: both are read again after it is saved', async () => {
    let people = [member(ME_ID, { role: 'admin', rev: 1 })]
    const { agent } = await loaded({
      ...reads(),
      'GET /api/members': () => ({ body: { items: people, nextCursor: null } }),
      'GET /api/me': () => ({ body: me({ name: 'Sam Example' }) }),
      [put('g:name')]: () => { people = [member(ME_ID, { role: 'admin', rev: 2, name: 'Sam Example' })]; return { body: record('g:name', 'Sam Example', 1) } },
    })
    await agent.setSetting('g:name', 'Sam Example')
    expect(agent.read().people.members[0]).toMatchObject({ name: 'Sam Example', rev: 2 })
    expect(agent.me()?.name).toBe('Sam Example')
  })

  test('a photo is sent as bytes with its type, and null removes it', async () => {
    const seen: Req[] = []
    let bytes: Uint8Array | undefined
    const r = reads()
    const s = server({
      ...r,
      'PUT /api/photo': q => { seen.push(q); return { body: { photoUrl: `/api/members/${ME_ID}/photo` } } },
      'DELETE /api/photo': q => { seen.push(q); return { body: { photoUrl: null } } },
    })
    const base = s.fetch
    const agent = new HttpAgent({ fetch: (i, init) => { if (init?.body instanceof Uint8Array) bytes = init.body; return base(i, init) } })
    await agent.whenLoaded()
    await agent.setPhoto(ME_ID, 'data:image/png;base64,iVBORw0KGgo=')
    expect(seen[0].headers['Content-Type']).toBe('image/png')
    expect([...bytes!]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(agent.me()?.photoUrl).toBe(`/api/members/${ME_ID}/photo`)
    await agent.setPhoto(ME_ID, null)
    expect(seen[1].method).toBe('DELETE')
    expect(agent.me()?.photoUrl).toBeNull()
    expect(((await errorOf(agent.setPhoto('m_nobody', 'data:image/png;base64,AAAA'))) as AgentError).code).toBe('not_found')
    expect(((await errorOf(agent.setPhoto('m_dana', 'data:image/png;base64,AAAA'))) as AgentError).code).toBe('forbidden')
    expect(((await errorOf(agent.setPhoto(ME_ID, 'data:text/html;base64,AAAA'))) as AgentError).reason).toBe('bad_type')
  })

  test('members: invite, role and removal send the rev read, and a conflict shows the current record', async () => {
    const seen: Req[] = []
    const answers: Record<string, Answer> = {
      'POST /api/members/invites': { status: 201, body: member('m_new', { status: 'invited', email: 'robin@example.test' }) },
      'PUT /api/members/m_dana/role': { body: member('m_dana', { role: 'admin', rev: 2 }) },
      'DELETE /api/members/m_dana?ifRev=2': { body: member('m_dana', { status: 'removed', rev: 3 }) },
    }
    const { agent } = await loaded({ ...reads(), ...Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, (r: Req) => { seen.push(r); return a }])) })
    await agent.inviteMember({ name: 'Robin Example', email: 'robin@example.test', role: 'member' })
    expect(agent.read().people.members.map(m => m.id)).toEqual([ME_ID, 'm_dana', 'm_new'])
    expect(JSON.parse(seen[0].body!)).toEqual({ name: 'Robin Example', email: 'robin@example.test', role: 'member' })
    await agent.setMemberRole('m_dana', 'admin')
    expect(JSON.parse(seen[1].body!)).toEqual({ role: 'admin', ifRev: 1 })
    expect(agent.read().people.members.find(m => m.id === 'm_dana')).toMatchObject({ role: 'admin', rev: 2 })
    await agent.removeMember('m_dana')
    expect(agent.read().people.members.find(m => m.id === 'm_dana')?.status).toBe('removed')
  })

  test('members: a stale rev and the last Admin are conflicts; an invalid invite or role never leaves the client', async () => {
    const { agent, calls } = await loaded({
      ...reads(),
      'PUT /api/members/m_dana/role': refusal(409, 'conflict', { current: member('m_dana', { role: 'admin', rev: 5 }) }),
      [`DELETE /api/members/${ME_ID}?ifRev=1`]: refusal(409, 'conflict', { reason: 'last_admin' }),
      'POST /api/members/invites': refusal(409, 'conflict', { reason: 'already_member' }),
    })
    const stale = await errorOf(agent.setMemberRole('m_dana', 'member')) as AgentError
    expect([stale.code, (stale.current as { rev: number }).rev]).toEqual(['conflict', 5])
    expect(agent.read().people.members.find(m => m.id === 'm_dana')).toMatchObject({ role: 'admin', rev: 5 })
    expect((await errorOf(agent.removeMember(ME_ID)) as AgentError).reason).toBe('last_admin')
    expect(agent.read().people.members.find(m => m.id === ME_ID)?.status).toBe('active')
    expect((await errorOf(agent.inviteMember({ name: 'A', email: 'a@example.test', role: 'member' })) as AgentError).reason).toBe('already_member')
    expect(agent.read().people.members).toHaveLength(2)
    const n = calls.length
    for (const run of [() => agent.inviteMember({ name: ' ', email: 'a@example.test', role: 'member' }), () => agent.inviteMember({ name: 'A', email: 'nope', role: 'member' }), () => agent.inviteMember({ name: 'A', email: 'a@example.test', role: 'inhouse' as never }), () => agent.setMemberRole('m_dana', 'inhouse' as never)]) {
      expect(((await errorOf(run())) as AgentError).code).toBe('invalid')
    }
    expect(calls).toHaveLength(n)
  })

  test('support access: grant, end, a conflict, and liveness follows the clock', async () => {
    let now = 5000
    const s = server({
      ...reads(),
      'POST /api/grants': q => ({ status: 201, body: grant({ createdAt: iso(5000), endsAt: iso(5000 + 4 * 3_600_000), id: 'g_2', _: q.body }) }),
      'POST /api/grants/g_2/end': q => ({ body: grant({ id: 'g_2', rev: 2, endedAt: iso(6000), endedBy: ME_ID, live: false, _: q.body }) }),
    })
    const agent = new HttpAgent({ fetch: s.fetch, now: () => now })
    await agent.whenLoaded()
    await agent.grantSupport(4)
    expect(JSON.parse(s.calls.at(-1)!.body!)).toEqual({ hours: 4 })
    expect(agent.read().people.supportGrant).toMatchObject({ id: 'g_2', live: true })
    now += 4 * 3_600_000 + 1
    expect(agent.read().people.supportGrant?.live, 'over by itself when its hours pass').toBe(false)
    now = 5000
    await agent.endSupportGrant('g_2')
    expect(JSON.parse(s.calls.at(-1)!.body!)).toEqual({ ifRev: 1 })
    expect(agent.read().people.supportGrant).toMatchObject({ live: false, endedBy: ME_ID })
    expect(((await errorOf(agent.grantSupport(2))) as AgentError).code).toBe('invalid')
  })

  test('a refused grant is taken back; one already live is a conflict with its reason', async () => {
    const { agent, heard } = await loaded({ ...reads(), 'POST /api/grants': refusal(409, 'conflict', { reason: 'grant_live' }) })
    const before = agent.read()
    const e = await errorOf(agent.grantSupport(1)) as AgentError
    expect([e.code, e.reason]).toEqual(['conflict', 'grant_live'])
    expect(agent.read()).toBe(before)
    expect(heard).toHaveLength(1)
  })
})

describe('paging', () => {
  test('loadMore appends the next page and ignores a second call while one is in flight', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(r => { release = r })
    const r = reads()
    const s = server({
      ...r,
      'GET /api/audit': { body: { items: [line(4), line(3)], nextCursor: 'abc' } },
      'GET /api/audit?cursor=abc': { body: { items: [line(2), line(1)], nextCursor: null } },
    })
    const slow: typeof fetch = async (i, init) => { if (String(i).includes('cursor=abc')) await gate; return s.fetch(i, init) }
    const agent = new HttpAgent({ fetch: slow })
    await agent.whenLoaded()
    expect(agent.read().more).toEqual({ audit: true, members: false })
    const first = agent.loadMore('audit')
    const second = agent.loadMore('audit')
    release!()
    await Promise.all([first, second])
    expect(s.calls.filter(c => c.path.includes('cursor=abc'))).toHaveLength(1)
    expect(agent.read().auditLog.map(l => l.id)).toEqual([4, 3, 2, 1])
    expect(agent.read().more.audit).toBe(false)
    await agent.loadMore('audit')
    await agent.loadMore('members')
    expect(s.calls.filter(c => c.path.includes('cursor'))).toHaveLength(1)
  })
})

describe('the parts that stay the stub until their phase', () => {
  const STUBS: [string, (c: AgentClient) => Promise<unknown>][] = [
    ['approve', c => c.approve('p')], ['undo', c => c.undo('p')], ['editDraft', c => c.editDraft('p', 'x')],
    ['createChat', c => c.createChat({ id: 'c', title: 't' })], ['send', c => c.send('r', 'x')], ['pause', c => c.pause()],
    ['requestTool', c => c.requestTool('k', true)], ['forgetMemory', c => c.forgetMemory('k', true)], ['setToggle (a routine)', c => c.setToggle('r:Morning', true)],
    ['markNoticesRead', c => c.markNoticesRead(['n'])], ['deleteFiles', c => c.deleteFiles(['f'])], ['runRoutine', c => c.runRoutine('r')],
    ['renameChat', c => c.renameChat('c', 't')], ['deleteChats', c => c.deleteChats(['c'])],
  ]
  test.each(STUBS)('%s rejects with AgentError("unavailable") and sends one error notice', async (_n, call) => {
    const { agent, heard } = await loaded(reads())
    const e = await errorOf(call(agent))
    expect(e).toBeInstanceOf(AgentError)
    expect((e as AgentError).code).toBe('unavailable')
    expect(heard).toEqual([{ type: 'error', code: 'unavailable', text: (e as AgentError).message }])
  })

  test('ask never starts a run, a listener that unsubscribed hears nothing, and the lists are empty and stable', async () => {
    const { agent, heard } = await loaded(reads())
    const e = await errorOf(agent.ask('Which orders are stuck?', { chatId: 'c' })[Symbol.asyncIterator]().next())
    expect((e as AgentError).code).toBe('unavailable')
    expect(heard).toEqual([])
    const quiet: AgentNotice[] = []
    agent.onNotice(n => quiet.push(n))()
    await errorOf(agent.requestSkill('s'))
    expect(quiet).toEqual([])
    expect(agent.listFiles()).toBe(agent.listFiles())
    expect(agent.listNotifications()).toBe(agent.listNotifications())
    expect(agent.getTrace('any')).toBeNull()
  })
})
