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
//  - the stub parts (a run, the library) that stop refusing;
//  - a failed first read (`meta`) that the shell shows as "Not connected yet": a 401 must be the signed-out screen, any
//    other failure the load error, and Retry must bring the app back without a reload.
import { fc, test as fcTest } from '@fast-check/vitest'
import { describe, expect, test, vi } from 'vitest'
import { AgentDataSchema, AgentStateSchema, MeSchema } from '../../../shared/contract'
import { CAN_KEYS } from '../../../shared/contract/keys'
import type { AgentClient, AgentNotice } from '../types'
import { AgentError } from '../types'
import { HttpAgent } from './client'
import { startScreen } from '../../shell/start-screen'

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
    expect(member1.calls.map(c => c.path), 'route 16 is not asked for a viewer who can\'t grant and isn\'t the Inhouse team').not.toContain('/api/grants')
    expect(member1.agent.read().resources.grants.status).toBe('ready')
    const staff = await loaded(reads({ me: me({ role: 'inhouse', can: can(false) }) }))
    // The Inhouse team reads the grants (route 16) though it can't grant; members and audit are skipped by its `can`.
    expect(staff.calls.map(c => c.path).sort()).toEqual(['/api/grants', '/api/me', '/api/settings/brand', '/api/settings/technical'])
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
  test('a lost connection is offline: the write rejects with it, tells once, and is taken back', async () => {
    // Reads work; every write's request is lost on the way.
    const s = server(reads({ settings: { personal: [record('g:theme', 'Dark', 3)] } }))
    const agent = new HttpAgent({ fetch: (i, init) => ((init?.method ?? 'GET') === 'GET' ? s.fetch(i, init) : Promise.reject(new TypeError('failed to fetch'))) })
    const heard: AgentNotice[] = []
    agent.onNotice(n => heard.push(n))
    await agent.whenLoaded()
    const before = agent.getSnapshot()
    const e = await errorOf(agent.setSetting('g:theme', 'Light')) as AgentError
    expect(e.code).toBe('offline')
    expect(heard).toEqual([{ type: 'error', code: 'offline', text: e.message }])
    expect(agent.getSnapshot()).toBe(before)
  })
  test('a body of ours with a code the server may send passes through as that code (cap reached)', async () => {
    const { agent } = await loaded({ ...reads(), 'PUT /api/settings/personal/g:theme': refusal(429, 'cap_reached') })
    expect(((await errorOf(agent.setSetting('g:theme', 'Dark'))) as AgentError).code).toBe('cap_reached')
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

  test('a setting or a switch leaves read() as it was (nothing it carries changed), and a member change does not', async () => {
    const { agent } = await loaded({ ...reads(), [put('n:slack')]: { body: record('n:slack', true, 1) }, 'PUT /api/members/m_dana/role': { body: member('m_dana', { role: 'admin', rev: 2 }) } })
    const data = agent.read()
    await agent.setToggle('n:slack', true)
    expect(agent.read()).toBe(data)
    await agent.setMemberRole('m_dana', 'admin')
    expect(agent.read()).not.toBe(data)
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
      'PUT /api/photo': q => { seen.push(q); return { body: { photoUrl: `/api/members/${ME_ID}/photo`, rev: 2 } } },
      'DELETE /api/photo': q => { seen.push(q); return { body: { photoUrl: null, rev: 3 } } },
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

  test('a grant that ended behind the client is not there to end, and the snapshot shows it ended', async () => {
    const { agent } = await loaded({
      ...reads(), 'GET /api/grants': { body: { items: [grant()] } },
      'POST /api/grants/g_1/end': refusal(409, 'conflict', { current: grant({ rev: 2, endedAt: iso(2000), endedBy: ME_ID, live: false }) }),
    })
    expect(((await errorOf(agent.endSupportGrant('g_1'))) as AgentError).code).toBe('not_found')
    expect(agent.read().people.supportGrant).toMatchObject({ rev: 2, live: false })
    expect(((await errorOf(agent.endSupportGrant('g_1'))) as AgentError).code, 'and once it shows ended, nothing is sent').toBe('not_found')
  })

  test('the name is written at the member rev, which a photo or a role change moved', async () => {
    let seen: unknown
    const { agent } = await loaded({ ...reads({ members: [member(ME_ID, { role: 'admin', rev: 4 })], settings: { personal: [record('g:name', 'Sam Mercer', 1)] } }), 'GET /api/me': { body: me() }, [put('g:name')]: r => { seen = JSON.parse(r.body!); return { body: record('g:name', 'Sam', 5) } } })
    await agent.setSetting('g:name', 'Sam')
    expect(seen).toEqual({ value: 'Sam', ifRev: 4 })
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

/** A record the fake server revs the way the real one does: a write at any rev but the current one is a 409 with the record. */
function revved(key: string, first: { value: unknown; rev: number }, refuse?: (n: number) => Answer | undefined) {
  const rec = { ...first }
  let n = 0
  const sent: number[] = []
  const answer = (r: Req): Answer => {
    const { value, ifRev } = JSON.parse(r.body!) as { value: unknown; ifRev: number }
    sent.push(ifRev)
    const no = refuse?.(++n)
    if (no) return no
    if (ifRev !== rec.rev) return refusal(409, 'conflict', { current: record(key, rec.value, rec.rev) })
    rec.value = value; rec.rev++
    return { body: record(key, rec.value, rec.rev) }
  }
  return { answer, sent, rec }
}

describe('writes to one record go one at a time', () => {
  test('two overlapping toggles on one key: the second sends the rev the first answered with, both save, no notice, the last value stays', async () => {
    const k = revved('n:weekly', { value: true, rev: 2 })
    const { agent, heard } = await loaded({ ...reads({ settings: { personal: [record('n:weekly', true, 2)] } }), 'PUT /api/settings/personal/n:weekly': k.answer })
    const first = agent.setToggle('n:weekly', false)
    const second = agent.setToggle('n:weekly', true)
    expect(agent.getSnapshot().toggles['n:weekly'], 'the change shows at once').toBe(true)
    await Promise.all([first, second])
    expect(k.sent).toEqual([2, 3])
    expect(heard).toEqual([])
    expect(agent.getSnapshot().toggles['n:weekly']).toBe(true)
    expect(k.rec).toEqual({ value: true, rev: 4 })
  })

  test('the screen shows the second change throughout, not the first answer', async () => {
    const k = revved('n:weekly', { value: true, rev: 2 })
    const { agent } = await loaded({ ...reads({ settings: { personal: [record('n:weekly', true, 2)] } }), 'PUT /api/settings/personal/n:weekly': k.answer })
    const seen: unknown[] = []
    agent.subscribe(() => seen.push(agent.getSnapshot().toggles['n:weekly']))
    await Promise.all([agent.setToggle('n:weekly', false), agent.setToggle('n:weekly', true)])
    expect(seen.at(-1)).toBe(true)
    // After the second change was applied, the value never goes back to the first write's.
    const second = seen.indexOf(true, 1)
    expect(seen.slice(second)).not.toContain(false)
  })

  test('two overlapping role changes on one member both save', async () => {
    let rev = 1
    const sent: number[] = []
    const { agent, heard } = await loaded({
      ...reads(),
      'PUT /api/members/m_dana/role': r => {
        const b = JSON.parse(r.body!) as { role: string; ifRev: number }
        sent.push(b.ifRev)
        if (b.ifRev !== rev) return refusal(409, 'conflict', { current: member('m_dana', { rev }) })
        rev++
        return { body: member('m_dana', { role: b.role, rev }) }
      },
    })
    await Promise.all([agent.setMemberRole('m_dana', 'admin'), agent.setMemberRole('m_dana', 'member')])
    expect(sent).toEqual([1, 2])
    expect(heard).toEqual([])
    expect(agent.read().people.members.find(m => m.id === 'm_dana')).toMatchObject({ role: 'member', rev: 3 })
  })

  test('the name saved twice in a row: each carries the member rev the earlier save left', async () => {
    let rev = 1
    const sent: number[] = []
    const { agent, heard } = await loaded({
      ...reads({ members: [member(ME_ID, { role: 'admin', rev: 1 })], settings: { personal: [record('g:name', 'Sam Mercer', 1)] } }),
      'GET /api/members': () => ({ body: { items: [member(ME_ID, { role: 'admin', rev })], nextCursor: null } }),
      'PUT /api/settings/personal/g:name': r => {
        const b = JSON.parse(r.body!) as { value: string; ifRev: number }
        sent.push(b.ifRev)
        if (b.ifRev !== rev) return refusal(409, 'conflict', { current: record('g:name', 'x', rev) })
        rev++
        return { body: record('g:name', b.value, rev) }
      },
    })
    await Promise.all([agent.setSetting('g:name', 'Sam A'), agent.setSetting('g:name', 'Sam B')])
    expect(sent).toEqual([1, 2])
    expect(heard).toEqual([])
  })

  test('the first of two overlapping writes refused: only it is taken back, and the second still saves at the rev the refusal gave', async () => {
    const k = revved('n:weekly', { value: true, rev: 2 }, n => (n === 1 ? refusal(409, 'conflict', { current: record('n:weekly', true, 5) }) : undefined))
    // The refusal's `current` rev is the one the second must send, so the fake holds the record at 5.
    k.rec.rev = 5
    const { agent, heard } = await loaded({ ...reads({ settings: { personal: [record('n:weekly', true, 2)] } }), 'PUT /api/settings/personal/n:weekly': k.answer })
    const first = errorOf(agent.setToggle('n:weekly', false))
    const second = agent.setToggle('n:weekly', true)
    expect(((await first) as AgentError).code).toBe('conflict')
    await second
    expect(k.sent).toEqual([2, 5])
    expect(heard).toHaveLength(1)
    expect(agent.getSnapshot().toggles['n:weekly']).toBe(true)
  })

  test('a refusal on one of two writes to different keys takes back only its own change', async () => {
    const { agent, heard } = await loaded({
      ...reads(),
      'PUT /api/settings/personal/n:weekly': refusal(503, 'unavailable'),
      'PUT /api/settings/personal/n:slack': { body: record('n:slack', true, 1) },
    })
    const refused = errorOf(agent.setToggle('n:weekly', true))
    const kept = agent.setToggle('n:slack', true)
    expect(agent.getSnapshot().toggles).toMatchObject({ 'n:weekly': true, 'n:slack': true })
    expect(((await refused) as AgentError).code).toBe('unavailable')
    await kept
    expect(agent.getSnapshot().toggles['n:weekly']).toBeUndefined()
    expect(agent.getSnapshot().toggles['n:slack']).toBe(true)
    expect(heard).toHaveLength(1)
  })
})

describe('queued writes that are refused go back to what the server last confirmed', () => {
  const lost = refusal(503, 'unavailable')
  const key = 'PUT /api/settings/personal/g:theme'

  test('two switches or settings queued, both refused with nothing to show: the loaded value', async () => {
    const { agent, heard } = await loaded({ ...reads({ settings: { personal: [record('g:theme', 'Dark', 3)] } }), [key]: lost })
    const a = errorOf(agent.setSetting('g:theme', 'Light'))
    const b = errorOf(agent.setSetting('g:theme', 'System'))
    expect(agent.getSnapshot().settings['g:theme']).toBe('System')
    await Promise.all([a, b])
    expect(agent.getSnapshot().settings['g:theme']).toBe('Dark')
    expect(heard).toHaveLength(2)
  })

  test('two role changes queued, both refused: the loaded role', async () => {
    const { agent } = await loaded({ ...reads(), 'PUT /api/members/m_dana/role': lost })
    await Promise.all([errorOf(agent.setMemberRole('m_dana', 'admin')), errorOf(agent.setMemberRole('m_dana', 'member'))])
    expect(agent.read().people.members.find(m => m.id === 'm_dana')).toMatchObject({ role: 'member', rev: 1 })
    const both = await loaded({ ...reads(), 'PUT /api/members/m_dana/role': lost })
    await Promise.all([errorOf(both.agent.setMemberRole('m_dana', 'admin')), errorOf(both.agent.setMemberRole('m_dana', 'admin'))])
    expect(both.agent.read().people.members.find(m => m.id === 'm_dana')?.role).toBe('member')
  })

  test('two removals queued, both refused: the person is still there', async () => {
    const { agent } = await loaded({ ...reads(), 'DELETE /api/members/m_dana?ifRev=1': lost })
    await Promise.all([errorOf(agent.removeMember('m_dana')), errorOf(agent.removeMember('m_dana'))])
    expect(agent.read().people.members.find(m => m.id === 'm_dana')?.status).toBe('active')
  })

  test('two photos queued, both refused: the loaded photo', async () => {
    const own = `/api/members/${ME_ID}/photo`
    const { agent } = await loaded({ ...reads({ me: me({ photoUrl: own }), members: [member(ME_ID, { role: 'admin', photo: own })] }), 'PUT /api/photo': lost })
    await Promise.all([errorOf(agent.setPhoto(ME_ID, 'data:image/png;base64,iVBORw0KGgo=')), errorOf(agent.setPhoto(ME_ID, 'data:image/png;base64,iVBORw0KGgoAAAA='))])
    expect(agent.me()?.photoUrl).toBe(own)
    expect(agent.read().people.members.find(m => m.id === ME_ID)?.photo).toBe(own)
  })

  test('two grants queued, both refused: no grant', async () => {
    const { agent } = await loaded({ ...reads(), 'POST /api/grants': lost })
    await Promise.all([errorOf(agent.grantSupport(1)), errorOf(agent.grantSupport(4))])
    expect(agent.read().people.supportGrant).toBeNull()
  })

  test('the first refused and the second saved: the second\'s value', async () => {
    const answers: Answer[] = [lost, { body: record('g:theme', 'System', 4) }]
    const { agent } = await loaded({ ...reads({ settings: { personal: [record('g:theme', 'Dark', 3)] } }), [key]: () => answers.shift()! })
    await Promise.all([errorOf(agent.setSetting('g:theme', 'Light')), agent.setSetting('g:theme', 'System')])
    expect(agent.getSnapshot().settings['g:theme']).toBe('System')
  })

  test('the first saved and the second refused: the first\'s value', async () => {
    const answers: Answer[] = [{ body: record('g:theme', 'Light', 4) }, lost]
    const { agent } = await loaded({ ...reads({ settings: { personal: [record('g:theme', 'Dark', 3)] } }), [key]: () => answers.shift()! })
    await Promise.all([agent.setSetting('g:theme', 'Light'), errorOf(agent.setSetting('g:theme', 'System'))])
    expect(agent.getSnapshot().settings['g:theme']).toBe('Light')
  })

  test('a role change refused while a photo is queued on the same member: each goes back on its own field', async () => {
    const own = `/api/members/${ME_ID}/photo`
    const { agent } = await loaded({
      ...reads({ me: me({ photoUrl: null }), members: [member(ME_ID, { role: 'admin' }), member('m_dana')] }),
      [`PUT /api/members/${ME_ID}/role`]: lost, 'PUT /api/photo': { body: { photoUrl: own, rev: 2 } },
      'GET /api/members': { body: { items: [member(ME_ID, { role: 'admin', photo: own, rev: 2 }), member('m_dana')], nextCursor: null } },
    })
    await Promise.all([errorOf(agent.setMemberRole(ME_ID, 'member')), agent.setPhoto(ME_ID, 'data:image/png;base64,iVBORw0KGgo=')])
    const mine = agent.read().people.members.find(m => m.id === ME_ID)!
    expect(mine.role, 'the refused role change is taken back').toBe('admin')
    expect(mine.photo, 'the photo that saved stays').toBe(own)
  })
})

describe('a refused write leaves a later queued write on the same field showing', () => {
  /** The second request of a path waits on `release`; the first is answered at once with `first`. */
  function held(routes: Record<string, Answer | ((r: Req) => Answer)>, path: string, first: Answer, second: Answer) {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const s = server(routes)
    let n = 0
    const fetchIt: typeof fetch = async (i, init) => {
      if (String(i).endsWith(path) && (init?.method ?? 'GET') !== 'GET') {
        if (n++ === 0) return new Response(JSON.stringify(first.body ?? {}), { status: first.status ?? 200 })
        await gate
        return new Response(JSON.stringify(second.body ?? {}), { status: second.status ?? 200 })
      }
      return s.fetch(i, init)
    }
    return { fetch: fetchIt, release }
  }

  test('photos: the first refused, the second still in flight: the second\'s picture is on screen', async () => {
    const own = `/api/members/${ME_ID}/photo`
    const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAA='
    const h = held(reads({ me: me({ photoUrl: null }), members: [member(ME_ID, { role: 'admin' })] }), '/api/photo', refusal(503, 'unavailable'), { body: { photoUrl: own, rev: 2 } })
    const agent = new HttpAgent({ fetch: h.fetch })
    await agent.whenLoaded()
    const first = errorOf(agent.setPhoto(ME_ID, 'data:image/png;base64,iVBORw0KGgo='))
    const second = agent.setPhoto(ME_ID, PNG2)
    expect(((await first) as AgentError).code).toBe('unavailable')
    expect(agent.me()?.photoUrl, 'the second change stays on screen while it saves').toBe(PNG2)
    h.release()
    await second
    expect(agent.me()?.photoUrl).toBe(own)
  })

  test('grants: the first refused, the second still in flight: the second\'s grant is on screen', async () => {
    const h = held(reads(), '/api/grants', refusal(503, 'unavailable'), { status: 201, body: grant({ id: 'g_2', endsAt: iso(5000 + 4 * 3_600_000), createdAt: iso(5000) }) })
    const agent = new HttpAgent({ fetch: h.fetch, now: () => 5000 })
    await agent.whenLoaded()
    const first = errorOf(agent.grantSupport(1))
    const second = agent.grantSupport(4)
    await first
    expect(agent.read().people.supportGrant, 'the second grant stays on screen while it saves').not.toBeNull()
    expect(agent.read().people.supportGrant!.endsAt.ms).toBe(5000 + 4 * 3_600_000)
    h.release()
    await second
    expect(agent.read().people.supportGrant?.id).toBe('g_2')
  })
})

// The photo is on screen twice (the account menu from `me`, the team list from the person's row), and the client may hold
// no row for the person at all. Ways it could break, written down before the tests:
//  - a refusal goes back to what the screen showed when the write was made, which may be an earlier unsaved photo;
//  - "no photo", confirmed by the server, is treated as "nothing confirmed" and the screen's value is used instead;
//  - the confirmed photo is only known when the team list holds the person's row (not for a person who may not read the
//    team, or whose row is on a later page);
//  - a read of who is signed in, made after a name save or a role change, puts the old photo back in the account menu
//    while a new one is still being saved, or its answer isn't what a later refusal goes back to.
describe('a refused photo goes back to what the server has, whatever the client loaded', () => {
  const lost = refusal(503, 'unavailable')
  const own = `/api/members/${ME_ID}/photo`
  const PNG = 'data:image/png;base64,iVBORw0KGgo='
  const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAA='
  const NAME = 'PUT /api/settings/personal/g:name'
  /** A Member who may not read the team: the list is never read, so the client holds no row for them. */
  const alone = (photoUrl: string | null) => ({ ...reads({ me: me({ role: 'member', can: can(false), photoUrl }) }), 'GET /api/members': refusal(403, 'forbidden') })
  /** A person whose row is on a later page of the team than the one read. */
  const offPage = (photoUrl: string | null) => ({ ...reads({ me: me({ photoUrl }) }), 'GET /api/members': { body: { items: [member('m_dana')], nextCursor: 'm_dana' } } })
  /** The team read after a save is refused for a person who may not read it, and the client says so on the console. */
  async function quiet<T>(run: () => Promise<T>): Promise<T> {
    const warn = console.warn
    console.warn = () => undefined
    try { return await run() } finally { console.warn = warn }
  }

  test('no photo loaded, two photos queued, both refused: no photo, in the account menu and in the team list', async () => {
    const { agent } = await loaded({ ...reads(), 'PUT /api/photo': lost })
    await Promise.all([errorOf(agent.setPhoto(ME_ID, PNG)), errorOf(agent.setPhoto(ME_ID, PNG2))])
    expect(agent.me()?.photoUrl).toBeNull()
    expect(agent.read().people.members.find(m => m.id === ME_ID)?.photo).toBeNull()
  })

  test.each([['a Member who may not read the team', alone], ['a person whose row is not on the page read', offPage]])(
    '%s, a photo loaded, two photos queued, both refused: the loaded photo', async (_who, routes) => {
      const { agent, calls } = await loaded({ ...routes(own), 'PUT /api/photo': lost })
      await Promise.all([errorOf(agent.setPhoto(ME_ID, PNG)), errorOf(agent.setPhoto(ME_ID, PNG2))])
      expect(agent.me()?.photoUrl).toBe(own)
      expect(agent.read().people.members.some(m => m.id === ME_ID), 'the client holds no row for them').toBe(false)
      expect(calls.filter(c => c.path === '/api/photo')).toHaveLength(2)
    })

  test.each([['a Member who may not read the team', alone], ['a person whose row is not on the page read', offPage]])(
    '%s: the first photo saved and the second refused: the served picture, not the first one\'s data', async (_who, routes) => {
      const answers: Answer[] = [{ body: { photoUrl: own, rev: 2 } }, lost]
      const { agent } = await loaded({ ...routes(null), 'PUT /api/photo': () => answers.shift()! })
      await quiet(() => Promise.all([agent.setPhoto(ME_ID, PNG), errorOf(agent.setPhoto(ME_ID, PNG2))]))
      expect(agent.me()?.photoUrl).toBe(own)
    })

  test('the first photo refused with the photo as it is now, the second refused with nothing to show: the photo the first refusal told of', async () => {
    const answers: Answer[] = [refusal(409, 'conflict', { current: { photoUrl: own, rev: 2 } }), lost]
    const { agent } = await loaded({ ...offPage(null), 'PUT /api/photo': () => answers.shift()! })
    await Promise.all([errorOf(agent.setPhoto(ME_ID, PNG)), errorOf(agent.setPhoto(ME_ID, PNG2))])
    expect(agent.me()?.photoUrl).toBe(own)
  })

  test('the team read after a photo is saved says it has since gone (removed on another device), and the next photo is refused: no photo', async () => {
    const answers: Answer[] = [{ body: { photoUrl: own, rev: 2 } }, lost]
    // The team's rows are served with no photo: by the read after the save the saved photo is gone again (removed elsewhere, so the row's rev moved on).
    let reads2 = 0
    const { agent } = await loaded({ ...reads(), 'GET /api/members': () => ({ body: { items: [member(ME_ID, { role: 'admin', rev: reads2++ === 0 ? 1 : 3 }), member('m_dana')], nextCursor: null } }), 'PUT /api/photo': () => answers.shift()! })
    await Promise.all([agent.setPhoto(ME_ID, PNG), errorOf(agent.setPhoto(ME_ID, PNG2))])
    expect(agent.me()?.photoUrl).toBeNull()
    expect(agent.read().people.members.find(m => m.id === ME_ID)?.photo).toBeNull()
  })

  test.each<[string, (a: HttpAgent) => Promise<void>]>([
    ['a name save', a => a.setSetting('g:name', 'Sam B')],
    ['their own role change', a => a.setMemberRole(ME_ID, 'member')],
  ])('%s with a photo waiting behind it: the account menu keeps the new photo, it never goes back to the old one', async (_what, first) => {
    let photo: string | null = null
    const { agent, heard } = await loaded({
      ...reads({ settings: { personal: [record('g:name', 'Sam Mercer', 1)] } }),
      'GET /api/me': () => ({ body: me({ photoUrl: photo }) }),
      'GET /api/members': () => ({ body: { items: [member(ME_ID, { role: 'admin', photo }), member('m_dana')], nextCursor: null } }),
      [NAME]: { body: record('g:name', 'Sam B', 2) },
      [`PUT /api/members/${ME_ID}/role`]: { body: member(ME_ID, { rev: 2 }) },
      'PUT /api/photo': () => { photo = own; return { body: { photoUrl: own, rev: 2 } } },
    })
    const seen: unknown[] = []
    const saved = [first(agent), agent.setPhoto(ME_ID, PNG)]
    agent.subscribe(() => seen.push(agent.me()?.photoUrl))
    await Promise.all(saved)
    expect(heard).toEqual([])
    expect(seen.filter(p => p !== PNG && p !== own), 'only the new photo, then the served one').toEqual([])
    expect(seen.at(-1)).toBe(own)
  })

  test('who is signed in is read again while a photo waits, and the photo is then refused: what that read said, not what was loaded', async () => {
    // Another device gave this person a photo after the first load; the read after the name save learns of it.
    let asked = 0
    const { agent } = await loaded({
      ...alone(null),
      'GET /api/me': () => ({ body: me({ role: 'member', can: can(false), photoUrl: asked++ === 0 ? null : own }) }),
      [NAME]: { body: record('g:name', 'Sam B', 2) },
      'PUT /api/photo': lost,
    })
    await quiet(() => Promise.all([agent.setSetting('g:name', 'Sam B'), errorOf(agent.setPhoto(ME_ID, PNG))]))
    expect(agent.me()?.photoUrl).toBe(own)
  })

  type Step = { kind: 'photo'; to: string | null; answer: 'saved' | 'lost' | 'changed elsewhere' } | { kind: 'name'; answer: 'saved' | 'lost' }
  const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 3, arbitrary: fc.record({ kind: fc.constant('photo' as const), to: fc.constantFrom(PNG, PNG2, null), answer: fc.constantFrom('saved' as const, 'lost' as const, 'changed elsewhere' as const) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('name' as const), answer: fc.constantFrom('saved' as const, 'lost' as const) }) },
  )

  // Photo and name writes made together, each answered as drawn (saved, refused with nothing to show, or refused because
  // another device changed the photo first), by a server that keeps the photo and tells of it as the real one does.
  fcTest.prop([fc.constantFrom('mine' as const, 'not on the page' as const, 'not readable' as const), fc.boolean(), fc.array(step, { minLength: 1, maxLength: 6 })], { numRuns: 300 })(
    'any photo and name writes made together: the account menu shows the last photo chosen until its write answers, then what the server has', async (team, had, steps) => {
      let has = had
      let rev = 1
      const url = () => (has ? own : null)
      const photos = steps.flatMap(s => (s.kind === 'photo' ? [s.answer] : []))
      const names = steps.flatMap(s => (s.kind === 'name' ? [s.answer] : []))
      const photo = (r: Req): Answer => {
        const answer = photos.shift()!
        if (answer === 'lost') return lost
        rev++
        if (answer === 'changed elsewhere') { has = !has; return refusal(409, 'conflict', { current: { photoUrl: url(), rev } }) }
        has = r.method === 'PUT'
        return { body: { photoUrl: url(), rev } }
      }
      const { agent } = await loaded({
        // The name's record carries the member row's rev (the real settings read says so), whether or not the team list has the row.
        ...reads({ settings: { personal: [record('g:name', 'Sam Mercer', 1)] } }),
        'GET /api/me': () => ({ body: me({ ...(team === 'not readable' ? { role: 'member', can: can(false) } : {}), photoUrl: url() }) }),
        'GET /api/members': () => (team === 'not readable' ? refusal(403, 'forbidden') : {
          body: team === 'mine' ? { items: [member(ME_ID, { role: 'admin', photo: url(), rev }), member('m_dana')], nextCursor: null } : { items: [member('m_dana')], nextCursor: 'm_dana' },
        }),
        'PUT /api/photo': photo,
        'DELETE /api/photo': photo,
        // Like the real route: written at the member row's rev, or a 409 with the record as it is (so a stale rev is caught).
        [NAME]: r => {
          if (names.shift() === 'lost') return lost
          const b = JSON.parse(r.body!) as { value: string; ifRev: number }
          return b.ifRev === rev ? { body: record('g:name', b.value, ++rev) } : refusal(409, 'conflict', { current: record('g:name', 'elsewhere', rev) })
        },
      })
      await quiet(async () => {
        const settled = steps.map((s, i) => errorOf(s.kind === 'photo' ? agent.setPhoto(ME_ID, s.to) : agent.setSetting('g:name', `Sam ${i}`)))
        // Read as a renderer does, once the client has finished the change it is making: a refusal that carries the
        // record as it is now is two changes back to back (taken back, then the record put in).
        const seen: unknown[] = []
        agent.subscribe(() => queueMicrotask(() => seen.push(agent.me()?.photoUrl)))
        const results = await Promise.all(settled)
        // The server checks the rev a name is written at: a name it answered 'saved' to was written at the row's latest rev (the photo's answer, or a refusal's current).
        steps.forEach((st, i) => { if (st.kind === 'name' && st.answer === 'saved') expect(results[i], `name write ${i} saved`).toBe('resolved') })
        expect(agent.me()?.photoUrl, 'the account menu, once every write has answered').toBe(url())
        if (team === 'mine') expect(agent.read().people.members.find(m => m.id === ME_ID)?.photo, 'the team list').toBe(url())
        const last = steps.findLast(s => s.kind === 'photo')
        if (!last) return
        const moved = seen.findIndex(p => p !== last.to)
        expect(moved === -1 ? [] : seen.slice(moved).filter(p => p !== url()), 'after the last photo chosen, only what the server has').toEqual([])
      })
    })
})

describe('the rev a photo leaves on the member row', () => {
  const own = `/api/members/${ME_ID}/photo`
  const PNG = 'data:image/png;base64,iVBORw0KGgo='
  /** A person whose own row is not on the first page of the team list, on a server whose row is at `rev` and revs as the real one does. */
  function offPage(opts: { photoRev?: number; rev?: number } = {}) {
    let rev = opts.rev ?? 4
    const sent: { name: number[]; role: number[] } = { name: [], role: [] }
    const routes = {
      ...reads({ me: me({ photoUrl: null }), members: [member('m_dana')], settings: { personal: [record('g:name', 'Sam Mercer', 4)] } }),
      'GET /api/members': { body: { items: [member('m_dana')], nextCursor: 'm_dana' } },
      'PUT /api/photo': () => { rev = opts.photoRev ?? rev + 1; return { body: { photoUrl: own, rev } } },
      'DELETE /api/photo': () => { rev++; return { body: { photoUrl: null, rev } } },
      'PUT /api/settings/personal/g:name': (r: Req): Answer => {
        const b = JSON.parse(r.body!) as { value: string; ifRev: number }
        sent.name.push(b.ifRev)
        return b.ifRev === rev ? { body: record('g:name', b.value, ++rev) } : refusal(409, 'conflict', { current: record('g:name', 'elsewhere', rev) })
      },
      [`PUT /api/members/${ME_ID}/role`]: (r: Req): Answer => {
        const b = JSON.parse(r.body!) as { role: string; ifRev: number }
        sent.role.push(b.ifRev)
        return b.ifRev === rev ? { body: member(ME_ID, { role: b.role, rev: ++rev }) } : refusal(409, 'conflict', { current: member(ME_ID, { rev }) })
      },
    }
    return { routes, sent, rev: () => rev }
  }

  test('a person off the first page saves a photo, then their name: the name is written at the photo\'s rev, and saves with no notice', async () => {
    const o = offPage()
    const { agent, heard } = await loaded(o.routes)
    await agent.setPhoto(ME_ID, PNG)
    await agent.setSetting('g:name', 'Sam B')
    expect(o.sent.name).toEqual([5])
    expect(heard).toEqual([])
    expect(agent.getSnapshot().settings['g:name']).toBe('Sam B')
  })

  test('the same, queued together', async () => {
    const o = offPage()
    const { agent, heard } = await loaded(o.routes)
    await Promise.all([agent.setPhoto(ME_ID, PNG), agent.setSetting('g:name', 'Sam B')])
    expect(o.sent.name).toEqual([5])
    expect(heard).toEqual([])
  })

  test('a photo, then their own role: written at the photo\'s rev', async () => {
    const o = offPage()
    const { agent, heard } = await loaded({ ...o.routes, 'GET /api/members': { body: { items: [member('m_dana'), member(ME_ID, { role: 'admin', rev: 4 })], nextCursor: null } } })
    // The row is on the page here, but the photo answer's rev is what the role must carry (the team read is served from before the photo).
    await agent.setPhoto(ME_ID, PNG)
    await agent.setMemberRole(ME_ID, 'member')
    expect(o.sent.role).toEqual([5])
    expect(heard).toEqual([])
  })

  test('a photo removed likewise leaves its rev', async () => {
    const o = offPage()
    const { agent, heard } = await loaded(o.routes)
    await agent.setPhoto(ME_ID, null)
    await agent.setSetting('g:name', 'Sam B')
    expect(o.sent.name).toEqual([5])
    expect(heard).toEqual([])
  })

  test('a photo refused with the row as it is (a rev in current): the next name is written at that rev', async () => {
    // The row moved on elsewhere (rev 6); the name setting this client loaded says 4.
    const o = offPage({ rev: 6 })
    const { agent } = await loaded({ ...o.routes, 'PUT /api/photo': refusal(409, 'conflict', { current: { photoUrl: null, rev: 6 } }) })
    await errorOf(agent.setPhoto(ME_ID, PNG))
    expect(await errorOf(agent.setSetting('g:name', 'Sam B'))).toBe('resolved')
    expect(o.sent.name).toEqual([6])
  })

  test('a team page served before a write does not lower the row\'s rev or put its photo back', async () => {
    let page = 0
    const { agent } = await loaded({
      ...reads({ me: me({ photoUrl: null }), members: [member(ME_ID, { role: 'admin', rev: 1 })] }),
      'GET /api/members': { body: { items: [member(ME_ID, { role: 'admin', rev: 1 })], nextCursor: 'c' } },
      'GET /api/members?cursor=c': () => { page++; return { body: { items: [member('m_dana'), member(ME_ID, { role: 'admin', rev: 1, photo: null })], nextCursor: null } } },
      'PUT /api/photo': { body: { photoUrl: own, rev: 2 } },
    })
    await agent.setPhoto(ME_ID, PNG)
    await agent.loadMore('members')
    expect(page).toBe(1)
    const mine = agent.read().people.members.find(m => m.id === ME_ID)!
    expect(mine).toMatchObject({ rev: 2, photo: own })
    expect(agent.me()?.photoUrl).toBe(own)
    // And a re-read of the whole list that was served before the write.
    await agent.retry('members')
    expect(agent.read().people.members.find(m => m.id === ME_ID)).toMatchObject({ rev: 2, photo: own })
  })
})

describe('one member row is one lane', () => {
  test('a name saved while a photo uploads: both save, no notice, the name carries the rev the photo left', async () => {
    let rev = 1
    const sent: number[] = []
    const { agent, heard } = await loaded({
      ...reads({ members: [member(ME_ID, { role: 'admin', rev: 1 })], settings: { personal: [record('g:name', 'Sam Mercer', 1)] } }),
      'GET /api/members': () => ({ body: { items: [member(ME_ID, { role: 'admin', rev })], nextCursor: null } }),
      'PUT /api/photo': () => { rev++; return { body: { photoUrl: `/api/members/${ME_ID}/photo`, rev } } },
      'PUT /api/settings/personal/g:name': r => {
        const b = JSON.parse(r.body!) as { value: string; ifRev: number }
        sent.push(b.ifRev)
        if (b.ifRev !== rev) return refusal(409, 'conflict', { current: record('g:name', 'x', rev) })
        rev++
        return { body: record('g:name', b.value, rev) }
      },
    })
    await Promise.all([agent.setPhoto(ME_ID, 'data:image/png;base64,iVBORw0KGgo='), agent.setSetting('g:name', 'Sam B')])
    expect(sent).toEqual([2])
    expect(heard).toEqual([])
  })

  test('a name save refused with the record as it is: the next queued name save sends that rev, though the team read did not move', async () => {
    const sent: number[] = []
    const answers: Answer[] = [refusal(409, 'conflict', { current: record('g:name', 'Elsewhere', 9) }), { body: record('g:name', 'Sam C', 10) }]
    const { agent, heard } = await loaded({
      ...reads({ members: [member(ME_ID, { role: 'admin', rev: 1 })], settings: { personal: [record('g:name', 'Sam Mercer', 1)] } }),
      'PUT /api/settings/personal/g:name': r => { sent.push((JSON.parse(r.body!) as { ifRev: number }).ifRev); return answers.shift()! },
    })
    await Promise.all([errorOf(agent.setSetting('g:name', 'Sam B')), agent.setSetting('g:name', 'Sam C')])
    expect(sent).toEqual([1, 9])
    expect(heard).toHaveLength(1)
  })

  test('a role change and a photo on one member are one queue: the role sends the rev the photo left', async () => {
    let rev = 1
    const sent: number[] = []
    const { agent, heard } = await loaded({
      ...reads({ me: me(), members: [member(ME_ID, { role: 'admin', rev: 1 }), member('m_dana')] }),
      'GET /api/members': () => ({ body: { items: [member(ME_ID, { role: 'admin', rev }), member('m_dana')], nextCursor: null } }),
      'PUT /api/photo': () => { rev++; return { body: { photoUrl: `/api/members/${ME_ID}/photo`, rev } } },
      [`PUT /api/members/${ME_ID}/role`]: r => {
        const b = JSON.parse(r.body!) as { role: string; ifRev: number }
        sent.push(b.ifRev)
        if (b.ifRev !== rev) return refusal(409, 'conflict', { current: member(ME_ID, { rev }) })
        rev++
        return { body: member(ME_ID, { role: b.role, rev }) }
      },
    })
    await Promise.all([agent.setPhoto(ME_ID, 'data:image/png;base64,iVBORw0KGgo='), agent.setMemberRole(ME_ID, 'member')])
    expect(sent).toEqual([2])
    expect(heard).toEqual([])
  })
})

describe('a request that never answers', () => {
  test('is given up after the time limit: the lane is released, the change goes back, one notice, and the next write goes through', async () => {
    vi.useFakeTimers()
    try {
      const r = reads({ settings: { personal: [record('g:theme', 'Dark', 3)] } })
      const s = server(r)
      let puts = 0
      const fetchIt: typeof fetch = (i, init) => {
        if ((init?.method ?? 'GET') === 'GET') return s.fetch(i, init)
        if (puts++ > 0) return Promise.resolve(new Response(JSON.stringify(record('g:theme', 'System', 4)), { status: 200 }))
        return new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)) })
      }
      const agent = new HttpAgent({ fetch: fetchIt, timeoutMs: 30_000 })
      const heard: AgentNotice[] = []
      agent.onNotice(n => heard.push(n))
      await agent.whenLoaded()
      const first = errorOf(agent.setSetting('g:theme', 'Light'))
      const second = agent.setSetting('g:theme', 'System')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(((await first) as AgentError).code).toBe('unavailable')
      await second
      expect(agent.getSnapshot().settings['g:theme']).toBe('System')
      expect(heard).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })
})

describe('the schemas chunk', () => {
  test('a chunk that fails to load: a write rejects with unavailable and one notice, sends nothing, and nothing is left unhandled', async () => {
    const s = server(reads())
    const unhandled: unknown[] = []
    const on = (e: unknown) => { unhandled.push(e) }
    const proc = (globalThis as unknown as { process: { on(e: string, f: (x: unknown) => void): void; off(e: string, f: (x: unknown) => void): void } }).process
    proc.on('unhandledRejection', on)
    const err = console.error
    console.error = () => undefined
    try {
      const agent = new HttpAgent({ fetch: s.fetch, loadContract: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')) })
      const heard: AgentNotice[] = []
      agent.onNotice(n => heard.push(n))
      const e = await errorOf(agent.setSetting('g:theme', 'Dark')) as AgentError
      expect(e).toBeInstanceOf(AgentError)
      expect(e.code).toBe('unavailable')
      expect(heard).toEqual([{ type: 'error', code: 'unavailable', text: e.message }])
      expect(((await errorOf(agent.setPhoto(ME_ID, null))) as AgentError).code).toBe('unavailable')
      expect(s.calls.filter(c => c.method !== 'GET')).toEqual([])
      await new Promise(r => setTimeout(r, 0))
      expect(unhandled).toEqual([])
    } finally { console.error = err; proc.off('unhandledRejection', on) }
  })
})

describe('leaving the team is the signed-out state, whichever request meets it', () => {
  test.each([['removed'], ['not_invited']])('a 403 %s on a write puts meta in the signed-out state', async reason => {
    const { agent } = await loaded({ ...reads(), 'PUT /api/settings/personal/g:theme': refusal(403, 'forbidden', { reason }) })
    await errorOf(agent.setSetting('g:theme', 'Light'))
    expect(agent.read().resources.meta).toEqual({ status: 'error', error: 'forbidden', reason })
  })
  test('a 403 removed on a later read does too, and a plain 403 does not', async () => {
    let gone = false
    const r = reads()
    const { agent } = await loaded({ ...r, 'GET /api/members': () => (gone ? refusal(403, 'forbidden', { reason: 'removed' }) : r['GET /api/members']) })
    expect(agent.read().resources.meta.status).toBe('ready')
    gone = true
    await agent.retry('members')
    expect(agent.read().resources.meta).toEqual({ status: 'error', error: 'forbidden', reason: 'removed' })
    expect(agent.read().resources.members).toMatchObject({ status: 'error', error: 'forbidden' })
  })
  test('the grants read: a Member-style 403 is "not for you", a 403 removed is signed out', async () => {
    const plain = await loaded({ ...reads(), 'GET /api/grants': refusal(403, 'forbidden') })
    expect(plain.agent.read().resources.grants).toEqual({ status: 'ready' })
    expect(plain.agent.read().resources.meta.status).toBe('ready')
    const left = await loaded({ ...reads(), 'GET /api/grants': refusal(403, 'forbidden', { reason: 'removed' }) })
    expect(left.agent.read().resources.meta).toEqual({ status: 'error', error: 'forbidden', reason: 'removed' })
    expect(left.agent.read().resources.grants.status).toBe('error')
  })
})

describe('a photo that is not valid base64', () => {
  const PHOTO = 'data:image/png;base64,'
  test('base64 of a length that is one over a multiple of four is invalid: a rejection and a notice, never a throw', async () => {
    const { agent, heard } = await loaded(reads())
    let p: Promise<void> | undefined
    expect(() => { p = agent.setPhoto(ME_ID, `${PHOTO}AAAAA`) }).not.toThrow()
    const e = await errorOf(p!) as AgentError
    expect(e.code).toBe('invalid')
    expect(heard).toHaveLength(1)
  })
  fcTest.prop([fc.string({ maxLength: 40 }), fc.constantFrom('', PHOTO, 'data:image/jpeg;base64,', 'data:image/webp;base64,')], { numRuns: 200 })(
    'setPhoto never throws on any text: it resolves or rejects with an AgentError', async (tail, head) => {
      const s = server({ ...reads(), 'PUT /api/photo': { body: { photoUrl: `/api/members/${ME_ID}/photo`, rev: 2 } } })
      const agent = new HttpAgent({ fetch: s.fetch })
      await agent.whenLoaded()
      let p: Promise<void> | undefined
      expect(() => { p = agent.setPhoto(ME_ID, head + tail) }).not.toThrow()
      const e = await errorOf(p!)
      expect(e === 'resolved' || e instanceof AgentError).toBe(true)
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
    ['createChat', c => c.createChat({ id: 'c', title: 't' })], ['send', c => c.send('c', { clientTurnKey: 'key-12345', text: 'x', model: 'sonnet' })], ['listChats', c => c.listChats()], ['getChat', c => c.getChat('c')], ['interrupt', c => c.interrupt('t')], ['stop', c => c.stop('t')], ['resetSession', c => c.resetSession('c')], ['pause', c => c.pause()],
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

  test('no run is ever attached to, a listener that unsubscribed hears nothing, and the lists are empty and stable', async () => {
    const { agent, heard } = await loaded(reads())
    expect(await agent.activeRuns()).toEqual([])
    expect(agent.link()).toBe('live')
    agent.attach('r', () => { throw new Error('a frame') })()
    expect(heard).toEqual([])
    const quiet: AgentNotice[] = []
    agent.onNotice(n => quiet.push(n))()
    await errorOf(agent.requestSkill('s'))
    expect(quiet).toEqual([])
    expect(agent.listFiles()).toBe(agent.listFiles())
    expect(agent.listNotifications()).toBe(agent.listNotifications())
    expect(await agent.getTrace('any')).toBeNull()
  })
})

describe('the first read failing: the screen the shell shows (start-screen.ts)', () => {
  /** A failure of `GET /api/me` that is not about who the person is: a refusal by status, or no answer at all. */
  const failure = fc.oneof(
    fc.constantFrom(500, 502, 503, 429, 400, 404).map(status => ({ kind: 'status' as const, status })),
    fc.constant({ kind: 'network' as const, status: 0 }),
  )

  fcTest.prop([failure])('a 5xx, a refusal or a lost connection is the load error with its kind, and Retry brings the app', async f => {
    let failing = true
    const s = server(reads())
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (failing && String(input).endsWith('/api/me')) return f.kind === 'network' ? Promise.reject(new TypeError('failed to fetch')) : Promise.resolve(new Response('{}', { status: f.status }))
      return s.fetch(input, init)
    }
    const agent = new HttpAgent({ fetch, now: () => 5000 })
    await agent.whenLoaded()
    expect(startScreen(agent.read())).toBe('load-error')
    expect(agent.read().resources.meta).toMatchObject({ status: 'error', error: expect.any(String) })
    expect(agent.read().resources.meta.error).not.toBe('unauthorized')
    failing = false
    await agent.retry('meta')
    expect(startScreen(agent.read())).toBe('app')
    expect(agent.read().status).toBe('ready')
    expect(agent.read().resources.members.status).toBe('ready')
  })

  test('two retries while meta reads again make one read, and the app stays up', async () => {
    let failing = true
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const s = server(reads())
    let meCalls = 0
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/api/me')) {
        meCalls++
        if (failing) return new Response('{}', { status: 503 })
        await held
      }
      return s.fetch(input, init)
    }
    const agent = new HttpAgent({ fetch, now: () => 5000 })
    await agent.whenLoaded()
    expect(startScreen(agent.read())).toBe('load-error')
    failing = false
    const first = agent.retry('meta')
    const second = agent.retry('meta')
    expect(second).toBe(first)
    release()
    await Promise.all([first, second])
    expect(meCalls).toBe(2)
    expect(startScreen(agent.read())).toBe('app')
  })

  test('a 401 on me() is the signed-out screen, not "Not connected yet"', async () => {
    const { agent } = await loaded({ 'GET /api/me': refusal(401, 'unauthorized') })
    expect(startScreen(agent.read())).toBe('signed-out')
  })

  test('a 403 not invited or removed stays "You\'re not on this team"', async () => {
    for (const reason of ['not_invited', 'removed']) {
      const { agent } = await loaded({ 'GET /api/me': refusal(403, 'forbidden', { reason }) })
      expect(startScreen(agent.read())).toBe('not-on-team')
    }
  })

  test('a 401 mid-session swaps the app for the signed-out screen', async () => {
    const { agent } = await loaded({ ...reads(), 'PUT /api/settings/personal/g:theme': refusal(401, 'unauthorized') })
    expect(startScreen(agent.read())).toBe('app')
    await errorOf(agent.setSetting('g:theme', 'Light'))
    expect(startScreen(agent.read())).toBe('signed-out')
  })

  test('before the first answer it is "Not connected yet"', () => {
    expect(startScreen(new HttpAgent({ fetch: server({}).fetch }).read())).toBe('not-connected')
  })
})
