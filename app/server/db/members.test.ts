// The member rules of p2-design section 7 against the real migrations. Ways they can fail, written down first:
//  1. an invite binds twice, or to a second identity (the same email with another subject takes the member over);
//  2. a removed member gets in on the next call; a re-invite hands the old id to a new identity, or a new id to the
//     same identity;
//  3. two first sign-ins at once both bind;
//  4. some sequence of role changes and removals leaves no active Admin;
//  5. a change applies while its audit line fails (not one transaction);
//  6. a brand-app sign-in yields an Inhouse or service principal;
//  7. pseudonymising loses the id or edits the audit log, or keeps the Access subject (the same identity, invited again,
//     would then be refused as removed instead of binding the new invite).
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from './ids.ts'
import { memberStore } from './members.ts'
import { stmt, type Stmt } from './sql.ts'
import { openStores } from './stores.ts'
import { at, brokenAudit, lastLineId, linesSince, person, reqId, reset, snapshot } from './test-support.ts'

const db = env.DB
const stores = openStores(env)
const broken = openStores(env, brokenAudit)
const T = 1_800_000_000_000
const signIn = (subject: string, email: string) => stores.members.resolvePerson({ subject, email, requestId: reqId(), nowMs: T })
const row = (id: string) => db.prepare('SELECT * FROM members WHERE id = ?').bind(id).first<{ status: string; subject: string | null; role: string; rev: number }>()
const activeAdmins = async () => (await db.prepare("SELECT COUNT(*) AS n FROM members WHERE kind = 'person' AND role = 'admin' AND status = 'active'").first<number>('n'))!

let u = 0
const uniq = () => `${++u}-${Math.random().toString(36).slice(2, 7)}`

beforeEach(() => reset(db))

describe('sign-in binding (failures 1, 2, 6)', () => {
  it('binds an invite to the first subject once; the same email with another subject is not_invited', async () => {
    const email = `a${uniq()}@example.test`
    await stores.members.invite({ name: 'Ada Example', email, role: 'member' }, at(SYSTEM_MEMBER_ID))
    const first = await signIn(`s1-${email}`, email)
    expect('ok' in first).toBe(true)
    const again = await signIn(`s1-${email}`, email)
    expect(again).toEqual({ ok: { ...('ok' in first ? first.ok : {}), requestId: expect.any(String) } })
    expect(await signIn(`s2-${email}`, email)).toEqual({ refused: 'not_invited' })
  })

  it('refuses a removed member on the next call', async () => {
    const email = `b${uniq()}@example.test`
    await person(stores, { email, subject: `s-${email}`, role: 'admin' })
    const id = await person(stores, { email: `x${email}`, subject: `sx-${email}`, role: 'member' })
    const r = await row(id)
    expect(await stores.members.remove({ id, ifRev: r!.rev }, at(SYSTEM_MEMBER_ID))).toMatchObject({ ok: { status: 'removed' } })
    expect(await signIn(`sx-${email}`, `x${email}`)).toEqual({ refused: 'removed' })
  })

  it('re-invite: the same subject gets its id back; a different subject gets a new id and the old stays removed', async () => {
    const email = `c${uniq()}@example.test`
    await person(stores, { email: `admin-${email}`, subject: `sa-${email}`, role: 'admin' })
    const id = await person(stores, { email, subject: `s1-${email}`, role: 'member' })
    const remove = async (mid: string) => stores.members.remove({ id: mid, ifRev: (await row(mid))!.rev }, at(SYSTEM_MEMBER_ID))

    await remove(id)
    expect(await stores.members.invite({ name: 'Cy Example', email, role: 'admin' }, at(SYSTEM_MEMBER_ID))).toMatchObject({ ok: { id, status: 'invited', role: 'admin' }, reinvited: true })
    expect(await signIn(`s1-${email}`, email)).toMatchObject({ ok: { memberId: id, role: 'admin' } })

    await remove(id)
    await stores.members.invite({ name: 'Cy Example', email, role: 'member' }, at(SYSTEM_MEMBER_ID))
    const other = await signIn(`s2-${email}`, email)
    if (!('ok' in other)) throw new Error('expected ok')
    expect(other.ok.memberId).not.toBe(id)
    expect(await row(id)).toMatchObject({ status: 'removed', subject: `s1-${email}` })
    // The old identity is refused (its row is removed); it never reaches the new id.
    expect(await signIn(`s1-${email}`, email)).toEqual({ refused: 'removed' })
    const bound = (await linesSince(db, 0)).filter(l => l.action === 'member.bound' && l.target_id === other.ok.memberId)
    expect(bound.map(l => JSON.parse(l.args_json))).toEqual([{ memberId: other.ok.memberId, replaces: id }])
  })

  it('a subject bound to an Inhouse row is wrong_kind on the brand app, even with an open invite for its email', async () => {
    const email = `d${uniq()}@example.test`
    await stores.members.resolveInhouse({ subject: `si-${email}`, email, requestId: reqId(), nowMs: T })
    await stores.members.invite({ name: 'Di Example', email, role: 'admin' }, at(SYSTEM_MEMBER_ID))
    expect(await signIn(`si-${email}`, email)).toEqual({ refused: 'wrong_kind' })
  })

  it('an Inhouse first sign-in writes one row and one line, then reuses it', async () => {
    const email = `e${uniq()}@example.test`
    const before = await lastLineId(db)
    const [a, b] = await Promise.all([1, 2].map(() => stores.members.resolveInhouse({ subject: `se-${email}`, email, requestId: reqId(), nowMs: T })))
    expect(a.memberId).toBe(b.memberId)
    expect((await linesSince(db, before)).map(l => l.action)).toEqual(['inhouse.first_sign_in'])
  })
})

describe('concurrent first sign-ins (failure 3)', () => {
  test.prop([fc.integer({ min: 2, max: 6 }), fc.boolean()], { numRuns: 20 })('bind once', async (n, sameSubject) => {
    await reset(db)
    const email = `f${uniq()}@example.test`
    await stores.members.invite({ name: 'Fi Example', email, role: 'member' }, at(SYSTEM_MEMBER_ID))
    const before = await lastLineId(db)
    const results = await Promise.all(Array.from({ length: n }, (_, i) => signIn(sameSubject ? `sf-${email}` : `sf${i}-${email}`, email)))
    const ok = results.filter(r => 'ok' in r)
    if (sameSubject) expect(ok).toHaveLength(n)
    else expect(ok).toHaveLength(1)
    expect(new Set(ok.map(r => ('ok' in r ? r.ok.memberId : '')))).toHaveProperty('size', 1)
    expect((await linesSince(db, before)).map(l => l.action)).toEqual(['member.bound'])
  })
})

describe('binding under any sequence (failures 1 and 2)', () => {
  type Op = { op: 'signIn'; who: number } | { op: 'remove' } | { op: 'reinvite' }
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constant('signIn' as const), who: fc.integer({ min: 0, max: 2 }) }),
    fc.constant({ op: 'remove' as const }),
    fc.constant({ op: 'reinvite' as const }),
  )
  test.prop([fc.array(opArb, { minLength: 1, maxLength: 12 })], { numRuns: 30 })('an id never changes identity; one open row; removed is refused', async ops => {
    await reset(db)
    const email = `g${uniq()}@example.test`
    await person(stores, { email: `admin-${email}`, subject: `sa-${email}`, role: 'admin' })
    await stores.members.invite({ name: 'Gil Example', email, role: 'member' }, at(SYSTEM_MEMBER_ID))
    const subjectOf = new Map<string, string>()
    for (const o of ops) {
      if (o.op === 'signIn') {
        const subject = `s${o.who}-${email}`
        const r = await signIn(subject, email)
        if ('ok' in r) {
          const seen = subjectOf.get(r.ok.memberId)
          expect(seen === undefined || seen === subject).toBe(true)
          subjectOf.set(r.ok.memberId, subject)
          expect((await row(r.ok.memberId))?.subject).toBe(subject)
        }
        const mine = await db.prepare("SELECT status FROM members WHERE kind = 'person' AND subject = ?").bind(subject).first<string>('status')
        if (mine === 'removed') expect(r).toEqual({ refused: 'removed' })
      } else if (o.op === 'remove') {
        const open = await db.prepare("SELECT id, rev FROM members WHERE email_norm = ? AND status IN ('invited', 'active')").bind(email).first<{ id: string; rev: number }>()
        if (open) expect(await stores.members.remove({ id: open.id, ifRev: open.rev }, at(SYSTEM_MEMBER_ID))).toHaveProperty('ok')
      } else {
        await stores.members.invite({ name: 'Gil Example', email, role: 'member' }, at(SYSTEM_MEMBER_ID))
      }
      const open = await db.prepare("SELECT COUNT(*) AS n FROM members WHERE email_norm = ? AND status IN ('invited', 'active')").bind(email).first<number>('n')
      expect(open).toBeLessThanOrEqual(1)
    }
  })
})

describe('the last Admin (failure 4)', () => {
  type Op = { op: 'demote' | 'promote' | 'remove'; who: number; stale: boolean }
  const opArb = fc.record({ op: fc.constantFrom('demote' as const, 'promote' as const, 'remove' as const), who: fc.integer({ min: 0, max: 2 }), stale: fc.boolean() })
  test.prop([fc.array(fc.constantFrom('member' as const, 'admin' as const), { minLength: 3, maxLength: 3 }), fc.array(opArb, { minLength: 1, maxLength: 15 }), fc.boolean()], { numRuns: 40 })(
    'no sequence of role changes and removals (in turn or at once) leaves zero active Admins',
    async (roles, ops, together) => {
      await reset(db)
      const k = uniq()
      const team = roles.map(r => r)
      team[0] = 'admin'
      const ids: string[] = []
      for (const [i, role] of team.entries()) ids.push(await person(stores, { email: `h${i}-${k}@example.test`, subject: `sh${i}-${k}`, role }))
      const run = async (o: Op) => {
        const r = (await row(ids[o.who]))!
        const ifRev = o.stale ? r.rev - 1 : r.rev
        if (o.op === 'remove') return stores.members.remove({ id: ids[o.who], ifRev }, at(ids[0]))
        return stores.members.changeRole({ id: ids[o.who], role: o.op === 'promote' ? 'admin' : 'member', ifRev }, at(ids[0]))
      }
      if (together) await Promise.all(ops.map(run))
      else for (const o of ops) {
        await run(o)
        expect(await activeAdmins()).toBeGreaterThanOrEqual(1)
      }
      expect(await activeAdmins()).toBeGreaterThanOrEqual(1)
    },
  )

  it('two Admins demoting each other at once leave one', async () => {
    const k = uniq()
    const a = await person(stores, { email: `i1-${k}@example.test`, subject: `si1-${k}`, role: 'admin' })
    const b = await person(stores, { email: `i2-${k}@example.test`, subject: `si2-${k}`, role: 'admin' })
    const [ra, rb] = await Promise.all([
      stores.members.changeRole({ id: a, role: 'member', ifRev: (await row(a))!.rev }, at(b)),
      stores.members.changeRole({ id: b, role: 'member', ifRev: (await row(b))!.rev }, at(a)),
    ])
    expect([ra, rb].filter(r => 'ok' in r)).toHaveLength(1)
    expect([ra, rb].filter(r => 'refused' in r && r.refused === 'last_admin')).toHaveLength(1)
    expect(await activeAdmins()).toBe(1)
  })
})

describe('one transaction: a failed audit line takes the change with it (failure 5)', () => {
  it('for every member write', async () => {
    const k = uniq()
    const admin = await person(stores, { email: `j0-${k}@example.test`, subject: `sj0-${k}`, role: 'admin' })
    const other = await person(stores, { email: `j1-${k}@example.test`, subject: `sj1-${k}`, role: 'admin' })
    await stores.members.invite({ name: 'Jo Example', email: `j2-${k}@example.test`, role: 'member' }, at(admin))
    const removed = await person(stores, { email: `j3-${k}@example.test`, subject: `sj3-${k}`, role: 'member' })
    await stores.members.remove({ id: removed, ifRev: (await row(removed))!.rev }, at(admin))
    const reinvitedSame = await person(stores, { email: `j4-${k}@example.test`, subject: `sj4-${k}`, role: 'member' })
    await stores.members.remove({ id: reinvitedSame, ifRev: (await row(reinvitedSame))!.rev }, at(admin))
    await stores.members.invite({ name: 'Jo Example', email: `j4-${k}@example.test`, role: 'member' }, at(admin))
    const rev = async (id: string) => (await row(id))!.rev

    const writes: [string, () => Promise<unknown>][] = [
      ['invite', () => broken.members.invite({ name: 'New Example', email: `j9-${k}@example.test`, role: 'member' }, at(admin))],
      ['reinvite', () => broken.members.invite({ name: 'Re Example', email: `j3-${k}@example.test`, role: 'member' }, at(admin))],
      ['bind', () => broken.members.resolvePerson({ subject: `sj2-${k}`, email: `j2-${k}@example.test`, requestId: reqId(), nowMs: T })],
      ['restore', () => broken.members.resolvePerson({ subject: `sj4-${k}`, email: `j4-${k}@example.test`, requestId: reqId(), nowMs: T })],
      ['bind a new identity', () => broken.members.resolvePerson({ subject: `sj4b-${k}`, email: `j4-${k}@example.test`, requestId: reqId(), nowMs: T })],
      ['inhouse first sign-in', () => broken.members.resolveInhouse({ subject: `sj5-${k}`, email: `j5-${k}@example.test`, requestId: reqId(), nowMs: T })],
      ['role change', async () => broken.members.changeRole({ id: other, role: 'member', ifRev: await rev(other) }, at(admin))],
      ['removal', async () => broken.members.remove({ id: other, ifRev: await rev(other) }, at(admin))],
      ['rename', async () => broken.settings.write({ owner: other, scope: 'personal', key: 'g:name', value: 'Renamed Example', ifRev: await rev(other) }, at(other))],
    ]
    for (const [name, w] of writes) {
      const before = await snapshot(db)
      await expect(w(), name).rejects.toThrow()
      expect(await snapshot(db), name).toEqual(before)
    }
  })
})

describe('pseudonymise (failure 7)', () => {
  it('keeps the id, drops the name, title, email and photo, and leaves the audit log as it was', async () => {
    const k = uniq()
    const admin = await person(stores, { email: `k0-${k}@example.test`, subject: `sk0-${k}`, role: 'admin' })
    const id = await person(stores, { email: `k1-${k}@example.test`, subject: `sk1-${k}`, role: 'member', name: 'Kay Example' })
    const lines = await linesSince(db, 0)
    expect(await stores.members.pseudonymise(id, at(admin))).toMatchObject({ ok: { id, name: 'Former member', email: null, title: null, photo: null, status: 'removed' } })
    expect(await linesSince(db, 0)).toEqual(lines)
    expect(await stores.members.pseudonymise(admin, at(admin))).toEqual({ refused: 'last_admin' })
    expect(await stores.members.profile(id)).toEqual({ name: 'Former member', email: null, photoKey: null })
    const listed = []
    for (let after: string | null = null, page = await stores.members.list({ limit: 100, afterId: null }); ; page = await stores.members.list({ limit: 100, afterId: after })) {
      listed.push(...page.items)
      if (page.lastId === null) break
      after = page.lastId
    }
    expect(listed.find(m => m.id === id)).toMatchObject({ name: 'Former member', status: 'removed', email: null })
  })

  it('clears the subject: the same identity, invited again, binds to the new invite', async () => {
    const k = uniq()
    const admin = await person(stores, { email: `l0-${k}@example.test`, subject: `sl0-${k}`, role: 'admin' })
    const email = `l1-${k}@example.test`
    const old = await person(stores, { email, subject: `sl1-${k}`, role: 'member' })
    expect(await stores.members.pseudonymise(old, at(admin))).toHaveProperty('ok')
    expect((await row(old))!.subject).toBeNull()
    const again = await stores.members.invite({ name: 'Lou Example', email, role: 'member' }, at(admin))
    if (!('ok' in again)) throw new Error('expected an invite')
    expect(again.ok.id).not.toBe(old)
    expect(await signIn(`sl1-${k}`, email)).toMatchObject({ ok: { memberId: again.ok.id } })
    expect(await row(old)).toMatchObject({ status: 'removed', subject: null })
  })
})

describe('an invite that loses the unique index (P8a P-auth)', () => {
  // The refusal reads the D1 error under StoreUnavailableError (its cause): the wrapper's own message no longer quotes
  // what D1 said, so a check on that message would turn this into a 503. The audit hook swaps the audit line for a
  // second open row with the same email, so the batch fails on the partial unique index the way a concurrent invite would.
  it('is refused as already_member, not a storage failure', async () => {
    const email = `race${uniq()}@example.test`
    const rival = (): Stmt => stmt(
      `INSERT INTO members (id, kind, role, status, name, title, email_norm, created_at_ms, invited_by, req_id)
       VALUES (?, 'person', 'member', 'invited', 'Other Example', NULL, ?, ?, ?, ?)`,
      `m_rival${uniq().replace(/[^a-z0-9]/g, '')}`, email, T, SYSTEM_MEMBER_ID, reqId(),
    )
    const store = memberStore({ db, hook: rival })
    expect(await store.invite({ name: 'Gi Example', email, role: 'member' }, at(SYSTEM_MEMBER_ID))).toEqual({ refused: 'already_member' })
  })
})
