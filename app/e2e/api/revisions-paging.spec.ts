// Revisions and paging (p2-design section 5): a stale `ifRev` is 409 with the record as it is now, a missing one is 400
// (never last-write-wins), and the audit log and the member list page by keyset cursor to the end with no item twice.
import { expect, test } from '@playwright/test'
import { actor, allPages, call, expectConflict, expectError, newIdentity, personActor, sampleValue, settingRev, someKey } from './kit.ts'
import { auditMax, readSql } from './db.ts'

const admin = actor('admin')
const dana = actor('memberA')
const alex = actor('inhouse')
test.describe.configure({ mode: 'serial' })

test.describe('ifRev on a setting', () => {
  type Scope = 'personal' | 'brand' | 'technical'
  // Any key of the kind will do: the registry names one and the values it takes.
  const make = (name: string, who: typeof admin, scope: Scope, kind: 'bool' | 'enum') => {
    const key = someKey(scope, kind, scope === 'technical' ? ['stage', 'd:chats'] : [])
    return { name, who, scope, key, first: sampleValue(key, 0), second: sampleValue(key, 1) }
  }
  const cases = [
    make('a personal switch', dana, 'personal', 'bool'),
    make('a brand choice', admin, 'brand', 'enum'),
    make('a technical choice', alex, 'technical', 'enum'),
  ]
  for (const c of cases) {
    test(`${c.name}: a stale ifRev is 409 with the current record, and the first write stands`, async ({ request }) => {
      const rev = await settingRev(request, c.who, c.scope, c.key)
      const path = `/api/settings/${c.scope}/${encodeURIComponent(c.key)}`
      const first = await call(request, c.who, 'PUT', path, { json: { value: c.first, ifRev: rev } })
      expect(first.status, first.text).toBe(200)
      expect(first.json).toMatchObject({ key: c.key, value: c.first, rev: rev + 1 })
      const stale = await call(request, c.who, 'PUT', path, { json: { value: c.second, ifRev: rev } })
      expect(expectConflict(stale)).toMatchObject({ key: c.key, value: c.first, rev: rev + 1 })
      // A rev from the future is stale too.
      expectConflict(await call(request, c.who, 'PUT', path, { json: { value: c.second, ifRev: rev + 9 } }))
      expect(await settingRev(request, c.who, c.scope, c.key)).toBe(rev + 1)
      // At the current rev it goes through, and a null resets (and still counts as a revision).
      const next = await call(request, c.who, 'PUT', path, { json: { value: c.second, ifRev: rev + 1 } })
      expect(next.json).toMatchObject({ value: c.second, rev: rev + 2 })
      const reset = await call(request, c.who, 'PUT', path, { json: { value: null, ifRev: rev + 2 } })
      expect(reset.json).toMatchObject({ value: null, rev: rev + 3 })
    })

    test(`${c.name}: a missing ifRev is 400 invalid, and nothing changes`, async ({ request }) => {
      const rev = await settingRev(request, c.who, c.scope, c.key)
      expectError(await call(request, c.who, 'PUT', `/api/settings/${c.scope}/${encodeURIComponent(c.key)}`, { json: { value: c.first } }), 400, 'invalid')
      expect(await settingRev(request, c.who, c.scope, c.key)).toBe(rev)
    })
  }

  test('a key never set starts at rev 0, and ifRev 0 sets it once', async ({ request }) => {
    // `d:chats` is written by no other spec, and not by the seed: it must be absent from the list (never set, rev 0).
    const key = 'd:chats'
    const listed = (await call(request, alex, 'GET', '/api/settings/technical')).json.items.map((i: { key: string }) => i.key)
    expect(listed, 'a key never set is not listed').not.toContain(key)
    const path = `/api/settings/technical/${encodeURIComponent(key)}`
    expectConflict(await call(request, alex, 'PUT', path, { json: { value: '6 months', ifRev: 1 } }))
    const first = await call(request, alex, 'PUT', path, { json: { value: '6 months', ifRev: 0 } })
    expect(first.status, first.text).toBe(200)
    expect(first.json.rev).toBe(1)
    expectConflict(await call(request, alex, 'PUT', path, { json: { value: '12 months', ifRev: 0 } }))
  })
})

test.describe('ifRev on members and grants', () => {
  test('a missing ifRev is 400 on a role change, a removal and a grant end; a stale one is 409', async ({ request }) => {
    const who = newIdentity('rev')
    const invited = await call(request, admin, 'POST', '/api/members/invites', { json: { name: who.name, email: who.email, role: 'member' } })
    expect(invited.status, invited.text).toBe(201)
    const id = invited.json.id as string
    const grant = await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })
    expect(grant.status, grant.text).toBe(201)
    const mark = auditMax()
    expectError(await call(request, admin, 'PUT', `/api/members/${id}/role`, { json: { role: 'admin' } }), 400, 'invalid')
    expectError(await call(request, admin, 'DELETE', `/api/members/${id}`), 400, 'invalid')
    expectConflict(await call(request, admin, 'PUT', `/api/members/${id}/role`, { json: { role: 'admin', ifRev: 40 } }))
    expectConflict(await call(request, admin, 'DELETE', `/api/members/${id}?ifRev=40`))

    try {
      expectError(await call(request, admin, 'POST', `/api/grants/${grant.json.id}/end`, { json: {} }), 400, 'invalid')
      expect(expectConflict(await call(request, admin, 'POST', `/api/grants/${grant.json.id}/end`, { json: { ifRev: 40 } }))).toMatchObject({ id: grant.json.id, live: true })
      expect(auditMax(), 'no stale or missing ifRev added a line').toBe(mark)
    } finally {
      const ended = await call(request, admin, 'POST', `/api/grants/${grant.json.id}/end`, { json: { ifRev: grant.json.rev } })
      expect(ended.status, ended.text).toBe(200)
    }
    // Tidy: the invitee signs in and is removed, so the team list holds no half-made member from this test.
    expect((await call(request, personActor(who), 'GET', '/api/me')).status).toBe(200)
    const rev = (await allPages<{ id: string; rev: number }>(request, admin, '/api/members', 100)).items.find(m => m.id === id)?.rev
    expect((await call(request, admin, 'DELETE', `/api/members/${id}?ifRev=${rev}`)).status).toBe(200)
  })
})

test.describe('paging', () => {
  test.beforeAll(async ({ request }) => {
    // Past 100 lines, so a cursor that stops early at the page maximum fails the totals below.
    const count = () => readSql<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')[0].n
    const shortfall = Math.max(0, 101 - count())
    for (let i = 0; i < shortfall; i++) {
      const who = newIdentity('page')
      const r = await call(request, admin, 'POST', '/api/members/invites', { json: { name: who.name, email: who.email, role: 'member' } })
      expect(r.status, r.text).toBe(201)
    }
    expect(count(), 'invites write one line each').toBeGreaterThan(100)
  })

  test('the audit log pages newest first to a null cursor with no line twice, and the pages add up to the whole', async ({ request }) => {
    const whole = (await call(request, admin, 'GET', '/api/audit?limit=100')).json
    expect(whole.items.length).toBeGreaterThan(6)
    const total = readSql<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')[0].n
    for (const limit of [1, 2, 3, 7, 100]) {
      const { items, pages } = await allPages<{ id: number }>(request, admin, '/api/audit', limit)
      const ids = items.map(i => i.id)
      expect(new Set(ids).size, `limit ${limit}: no line twice`).toBe(ids.length)
      expect(ids, `limit ${limit}: newest first`).toEqual([...ids].sort((a, b) => b - a))
      expect(pages, `limit ${limit}: at least one page per ${limit} lines`).toBeGreaterThanOrEqual(Math.ceil(ids.length / limit))
      expect(ids.length, `limit ${limit}: every stored line is paged`).toBe(total)
      expect(ids.slice(0, whole.items.length), `limit ${limit}: the first lines are the same`).toEqual(whole.items.map((i: { id: number }) => i.id))
    }
    // Page size and cursor are checked.
    const first = await call(request, admin, 'GET', '/api/audit?limit=2')
    expect(first.json.items).toHaveLength(2)
    expect(typeof first.json.nextCursor).toBe('string')
    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'limit=1.5', 'cursor=!!!', 'cursor=bm90IGEgbnVtYmVy', 'limit=1&limit=2', 'extra=1']) {
      expectError(await call(request, admin, 'GET', `/api/audit?${q}`), 400, 'invalid')
    }
    // Default and maximum.
    expect((await call(request, admin, 'GET', '/api/audit')).json.items.length).toBeLessThanOrEqual(50)
    expect((await call(request, admin, 'GET', '/api/audit?limit=100')).status).toBe(200)
  })

  test('the member list pages by id to a null cursor with no member twice', async ({ request }) => {
    const whole = (await allPages<{ id: string }>(request, admin, '/api/members', 100)).items.map(m => m.id)
    expect(whole.length).toBeGreaterThan(6)
    const people = readSql<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE kind = 'person'")[0].n
    for (const limit of [1, 2, 5]) {
      const { items, pages } = await allPages<{ id: string }>(request, admin, '/api/members', limit)
      const ids = items.map(m => m.id)
      expect(new Set(ids).size, `limit ${limit}: no member twice`).toBe(ids.length)
      expect(ids, `limit ${limit}: the same members in the same order`).toEqual(whole)
      expect(ids, 'by id').toEqual([...ids].sort())
      expect(pages, `limit ${limit}: pages`).toBeGreaterThanOrEqual(Math.ceil(ids.length / limit))
      expect(ids.length, `limit ${limit}: every person row is paged`).toBe(people)
    }
    for (const q of ['limit=0', 'limit=101', 'cursor=!!!', 'extra=1']) expectError(await call(request, admin, 'GET', `/api/members?${q}`), 400, 'invalid')
  })

  test('a page read while lines are added still shows no line twice', async ({ request }) => {
    const first = await call(request, admin, 'GET', '/api/audit?limit=3')
    const who = newIdentity('page')
    expect((await call(request, admin, 'POST', '/api/members/invites', { json: { name: who.name, email: who.email, role: 'member' } })).status).toBe(201)
    const second = await call(request, admin, 'GET', `/api/audit?limit=3&cursor=${encodeURIComponent(first.json.nextCursor)}`)
    const seen = [...first.json.items, ...second.json.items].map((i: { id: number }) => i.id)
    expect(new Set(seen).size).toBe(seen.length)
    expect(Math.max(...second.json.items.map((i: { id: number }) => i.id))).toBeLessThan(Math.min(...first.json.items.map((i: { id: number }) => i.id)))
  })
})
