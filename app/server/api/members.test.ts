// Routes 3 to 6 against the real migrations. Ways they can fail, written down first:
//  1. a body or query that breaks its schema reaches the data layer (no ifRev, a bad role, an extra field, a bad cursor);
//  2. two writes with the same ifRev both apply; a conflict comes back without the current record;
//  3. the log gains a line for a refused or conflicting write, or none for one that applied; the actor isn't a member id;
//  4. paging skips or repeats a member, or lists a removed one;
//  5. a second invite for an open email goes through.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { MemberRecordSchema } from '../../shared/contract/members.ts'
import { pageOf } from '../../shared/contract/paging.ts'
import { openStores } from '../db/stores.ts'
import { ctx, lastLineId, linesSince, person, personPrincipal, reset } from '../db/test-support.ts'
import { changeMemberRole, inviteMember, listMembers, removeMember } from './members.ts'

const db = env.DB
const stores = openStores(env)
let u = 0
const uniq = () => `${++u}-${Math.random().toString(36).slice(2, 7)}`
let admin: string

beforeEach(async () => {
  await reset(db)
  admin = await person(stores, { email: `adm-${uniq()}@example.test`, subject: `sadm-${uniq()}`, role: 'admin' })
})

const as = () => personPrincipal(admin, 'admin')
const json = async (r: Promise<Response>) => {
  const res = await r
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const invite = (body: unknown) => json(inviteMember(ctx(stores, as(), { method: 'POST', path: '/api/members/invites', body }).c))
const role = (id: string, body: unknown) => json(changeMemberRole(ctx(stores, as(), { method: 'PUT', path: `/api/members/${id}/role`, params: { id }, body }).c))
const remove = (id: string, query: string) => json(removeMember(ctx(stores, as(), { method: 'DELETE', path: `/api/members/${id}${query}`, params: { id } }).c))
const rev = async (id: string) => (await stores.members.get(id))!.rev

describe('input (failure 1)', () => {
  it('refuses bodies and queries that break their schema with 400 invalid', async () => {
    const bad = { status: 400, body: { error: { code: 'invalid' } } }
    expect(await invite({ name: 'No Email', role: 'member' })).toEqual(bad)
    expect(await invite({ name: 'X', email: 'x@example.test', role: 'owner' })).toEqual(bad)
    expect(await invite({ name: 'X', email: 'x@example.test', role: 'member', extra: true })).toEqual(bad)
    expect(await role(admin, { role: 'member' })).toEqual(bad)
    expect(await remove(admin, '')).toEqual(bad)
    expect(await remove(admin, '?ifRev=abc')).toEqual(bad)
    expect(await remove(admin, '?ifRev=')).toEqual(bad)
    expect(await remove(admin, '?ifRev=1&ifRev=2')).toEqual(bad)
    expect(await json(listMembers(ctx(stores, as(), { path: '/api/members?cursor=***' }).c))).toEqual(bad)
    expect(await json(listMembers(ctx(stores, as(), { path: '/api/members?limit=101' }).c))).toEqual(bad)
    expect(await json(listMembers(ctx(stores, as(), { path: '/api/members?other=1' }).c))).toEqual(bad)
  })
  it('a missing title is null; an unknown member is 404', async () => {
    const r = await invite({ name: 'Tia Example', email: `T${uniq()}@Example.test`, role: 'member' })
    expect(r.status).toBe(201)
    expect(MemberRecordSchema.parse(r.body)).toMatchObject({ title: null, status: 'invited', rev: 1 })
    expect((r.body.email as string)).toBe((r.body.email as string).toLowerCase())
    expect((await role('m_nobody', { role: 'admin', ifRev: 1 })).status).toBe(404)
    expect((await remove('not-an-id', '?ifRev=1')).status).toBe(404)
  })
})

describe('invites (failure 5)', () => {
  it('an open email is 409 already_member, also for an invite racing it', async () => {
    const email = `dup-${uniq()}@example.test`
    const results = await Promise.all([1, 2, 3].map(() => invite({ name: 'Dup Example', email, role: 'member' })))
    expect(results.filter(r => r.status === 201)).toHaveLength(1)
    expect(results.filter(r => r.status === 409).map(r => r.body)).toEqual([
      { error: { code: 'conflict', reason: 'already_member' } }, { error: { code: 'conflict', reason: 'already_member' } },
    ])
  })
})

describe('ifRev (failure 2)', () => {
  it('two role changes with the same ifRev: one applies, the other gets the current record', async () => {
    const id = await person(stores, { email: `r-${uniq()}@example.test`, subject: `sr-${uniq()}`, role: 'member' })
    const ifRev = await rev(id)
    const first = await role(id, { role: 'admin', ifRev })
    expect(first).toMatchObject({ status: 200, body: { role: 'admin', rev: ifRev + 1 } })
    expect(await role(id, { role: 'member', ifRev })).toEqual({ status: 409, body: { error: { code: 'conflict', current: first.body } } })
    expect(await remove(id, `?ifRev=${ifRev}`)).toEqual({ status: 409, body: { error: { code: 'conflict', current: first.body } } })
  })
  it('the last Admin is 409 last_admin', async () => {
    expect(await role(admin, { role: 'member', ifRev: await rev(admin) })).toEqual({ status: 409, body: { error: { code: 'conflict', reason: 'last_admin' } } })
    expect(await remove(admin, `?ifRev=${await rev(admin)}`)).toEqual({ status: 409, body: { error: { code: 'conflict', reason: 'last_admin' } } })
  })
})

describe('one write, one line (failure 3)', () => {
  type Op = { op: 'invite'; email: number } | { op: 'role'; who: number; to: 'member' | 'admin'; stale: boolean } | { op: 'remove'; who: number; stale: boolean }
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constant('invite' as const), email: fc.integer({ min: 0, max: 3 }) }),
    fc.record({ op: fc.constant('role' as const), who: fc.integer({ min: 0, max: 3 }), to: fc.constantFrom('member' as const, 'admin' as const), stale: fc.boolean() }),
    fc.record({ op: fc.constant('remove' as const), who: fc.integer({ min: 0, max: 3 }), stale: fc.boolean() }),
  )
  test.prop([fc.array(opArb, { minLength: 1, maxLength: 12 })], { numRuns: 40 })('the log grows by one line per change that applied, none otherwise', async ops => {
    const k = uniq()
    const emails = [0, 1, 2, 3].map(i => `w${i}-${k}@example.test`)
    for (const o of ops) {
      const before = await lastLineId(db)
      let changed: boolean
      if (o.op === 'invite') {
        const r = await invite({ name: 'Wes Example', email: emails[o.email], role: 'member' })
        changed = r.status === 201
      } else {
        const target = await db.prepare("SELECT id, rev, role FROM members WHERE email_norm = ? AND status IN ('invited', 'active')").bind(emails[o.who]).first<{ id: string; rev: number; role: string }>()
        const id = target?.id ?? admin
        const was = (await stores.members.get(id))!
        const r = o.op === 'role' ? await role(id, { role: o.to, ifRev: was.rev + (o.stale ? 1 : 0) }) : await remove(id, `?ifRev=${was.rev + (o.stale ? 1 : 0)}`)
        // A role change to the role it already has answers 200 with no change and no line.
        changed = r.status === 200 && !(o.op === 'role' && was.role === o.to)
      }
      const lines = await linesSince(db, before)
      expect(lines).toHaveLength(changed ? 1 : 0)
      for (const l of lines) expect(l.actor_id).toBe(admin)
    }
  })
})

describe('paging (failure 4)', () => {
  test.prop([fc.integer({ min: 0, max: 12 }), fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 3 })], { numRuns: 15 })('every open member once, in id order, removed ones left out', async (n, limit, removedCount) => {
    await reset(db)
    admin = await person(stores, { email: `padm-${uniq()}@example.test`, subject: `spadm-${uniq()}`, role: 'admin' })
    const ids = [admin]
    for (let i = 0; i < n; i++) ids.push((await invite({ name: 'Pip Example', email: `p${i}-${uniq()}@example.test`, role: 'member' })).body.id as string)
    for (const id of ids.slice(1, 1 + removedCount)) await remove(id, `?ifRev=${await rev(id)}`)
    const want = ids.filter((_, i) => i === 0 || i > removedCount).sort()
    const seen: string[] = []
    let cursor: string | null = null
    for (let pages = 0; pages < 50; pages++) {
      const r = await json(listMembers(ctx(stores, as(), { path: `/api/members?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}` }).c))
      const page = pageOf(MemberRecordSchema).parse(r.body)
      expect(page.items.length).toBeLessThanOrEqual(limit)
      seen.push(...page.items.map(m => m.id))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual(want)
  })
})
