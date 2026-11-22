// The memory store's write guards on their own (review L2, L3, L5): each case gets past every check made before the
// write (the read, the route's prefilter) and leaves the statement's own owner, status or rev guard to decide. Ways it
// can fail, written down first:
//  1. an update or a forget applies after the fact's owner or status changed between its read and its write;
//  2. a route-level forget applies with another member as owner, or to a fact of the other scope;
//  3. a forget or an undo applies to a fact already in the target status (only the rev matched);
//  4. a save goes in for a member who isn't active (removed, or no such member).
// Expected values are literals; a barrier runs the meddling change at the await between the read and the write.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { lastLineId, linesSince } from '../../../db/test-support.ts'
import { memoryStore } from './store.ts'

const db = env.DB
const store = memoryStore({ db })
const A = 'm_guard_a'
const B = 'm_guard_b'
const at = (actorId: string) => ({ actorId, requestId: `r-${Math.random()}`, nowMs: 10 })
let k = 0
const id = () => `mem_guard${String(++k).padStart(17, '0')}`
async function seed(scope: 'brand' | 'person', status: 'active' | 'waiting' | 'forgotten', owner: string | null = scope === 'person' ? A : null) {
  const memoryId = id()
  await db.prepare('INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, 1, 1)')
    .bind(memoryId, scope, owner, `Fact ${memoryId}`, status, owner ?? A).run()
  return memoryId
}
const row = (memoryId: string) => db.prepare('SELECT owner_id, status, rev, text FROM memories WHERE id = ?').bind(memoryId).first<{ owner_id: string | null; status: string; rev: number; text: string }>()

/** `db` with `step` run once, just before the first batch whose SQL matches `when`. */
function withBarrier(when: RegExp, step: () => Promise<unknown>): D1Database {
  const sqlOf = new WeakMap<object, string>()
  let fired = false
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => {
        const s = target.prepare(sql)
        return new Proxy(s, { get(t, p) { const v = Reflect.get(t, p, t); return p === 'bind' ? (...a: unknown[]) => { const b = (v as (...x: unknown[]) => D1PreparedStatement).apply(t, a); sqlOf.set(b, sql); return b } : typeof v === 'function' ? v.bind(t) : v } })
      }
      if (prop === 'batch') return async (stmts: D1PreparedStatement[]) => {
        if (!fired && stmts.some(s => when.test(sqlOf.get(s) ?? ''))) { fired = true; await step() }
        return target.batch(stmts)
      }
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}
const set = (memoryId: string, sql: string) => () => db.prepare(`UPDATE memories SET ${sql} WHERE id = ?`).bind(memoryId).run()

beforeAll(async () => {
  await db.batch([
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Ari', 1)").bind(A),
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Bea', 1)").bind(B),
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES ('m_guard_gone', 'person', 'member', 'removed', 'Cal', 1)"),
  ])
})

describe('update and forgetOwn: the statement re-checks owner and status (failure 1, L3)', () => {
  it('update: the fact forgotten, or given to another owner, between the read and the write', async () => {
    for (const meddle of ["status = 'forgotten'", `owner_id = '${B}'`]) {
      const f = await seed('person', 'active')
      const r = await memoryStore({ db: withBarrier(/^\s*UPDATE memories SET text/, set(f, meddle)) }).update({ memberId: A, id: f, text: 'Changed', nowMs: 2, requestId: 'r' })
      expect(r, meddle).toEqual({ conflict: true })
      expect((await row(f))?.text, meddle).toBe(`Fact ${f}`)
    }
    // A team fact sent to waiting between the read and the write (an admin, or another agent's update): not changed again.
    const t = await seed('brand', 'active')
    expect(await memoryStore({ db: withBarrier(/^\s*UPDATE memories SET text/, set(t, "status = 'waiting'")) }).update({ memberId: A, id: t, text: 'Changed', nowMs: 2, requestId: 'r' })).toEqual({ conflict: true })
    expect((await row(t))?.text).toBe(`Fact ${t}`)
  })
  it('forgetOwn: the fact forgotten, or given to another owner, between the read and the write', async () => {
    for (const meddle of ["status = 'waiting'", `owner_id = '${B}'`]) {
      const f = await seed('person', 'active')
      const r = await memoryStore({ db: withBarrier(/^\s*UPDATE memories SET status = 'forgotten'/, set(f, meddle)) }).forgetOwn({ memberId: A, id: f, nowMs: 2, requestId: 'r' })
      expect(r, meddle).toEqual({ conflict: true })
      expect((await row(f))?.rev, meddle).toBe(1)
    }
  })
})

describe('route forgets: owner and scope (failure 2, L2)', () => {
  it("setPersonForgotten with another member as owner is notFound, and changes nothing", async () => {
    const f = await seed('person', 'active', A)
    expect(await store.setPersonForgotten({ id: f, ownerId: B, forgotten: true, ifRev: 1 }, at(B))).toEqual({ notFound: true })
    expect(await row(f)).toMatchObject({ status: 'active', rev: 1 })
  })
  it('setBrandForgotten on a person fact, and setPersonForgotten on a team fact, are notFound; no line is written', async () => {
    const f = await seed('person', 'active', A)
    const t = await seed('brand', 'active')
    const before = await lastLineId(db)
    expect(await store.setBrandForgotten({ id: f, forgotten: true, ifRev: 1 }, at(A))).toEqual({ notFound: true })
    expect(await store.setPersonForgotten({ id: t, ownerId: A, forgotten: true, ifRev: 1 }, at(A))).toEqual({ notFound: true })
    expect(await row(f)).toMatchObject({ status: 'active', rev: 1 })
    expect(await row(t)).toMatchObject({ status: 'active', rev: 1 })
    expect(await linesSince(db, before)).toEqual([])
  })
})

describe('route forgets: the status guard, with the rev right (failure 3, L3)', () => {
  it('a person fact: forget of a forgotten one, undo of an active one, are conflicts', async () => {
    const gone = await seed('person', 'forgotten', A)
    expect(await store.setPersonForgotten({ id: gone, ownerId: A, forgotten: true, ifRev: 1 }, at(A))).toMatchObject({ conflict: { id: gone, status: 'forgotten', rev: 1 } })
    const live = await seed('person', 'active', A)
    expect(await store.setPersonForgotten({ id: live, ownerId: A, forgotten: false, ifRev: 1 }, at(A))).toMatchObject({ conflict: { id: live, status: 'active', rev: 1 } })
  })
  it('a team fact: forget of a forgotten one, undo of an active or a waiting one, are conflicts with no line', async () => {
    const before = await lastLineId(db)
    const gone = await seed('brand', 'forgotten')
    expect(await store.setBrandForgotten({ id: gone, forgotten: true, ifRev: 1 }, at(A))).toMatchObject({ conflict: { status: 'forgotten', rev: 1 } })
    for (const status of ['active', 'waiting'] as const) {
      const f = await seed('brand', status)
      expect(await store.setBrandForgotten({ id: f, forgotten: false, ifRev: 1 }, at(A)), status).toMatchObject({ conflict: { status, rev: 1 } })
    }
    expect(await linesSince(db, before)).toEqual([])
  })
})

describe("save: the member must be active (failure 4, L5)", () => {
  it('a removed member, or no such member, saves nothing', async () => {
    const count = async () => (await db.prepare('SELECT COUNT(*) AS n FROM memories').first<number>('n'))!
    const before = await count()
    for (const memberId of ['m_guard_gone', 'm_guard_nobody']) {
      for (const scope of ['person', 'brand'] as const) {
        expect(await store.save({ memberId, scope, text: `Saved by ${memberId}`, chatId: null, nowMs: 1, requestId: 'r' }), `${memberId} ${scope}`).toEqual({ refused: 'no_member' })
      }
    }
    expect(await count()).toBe(before)
  })
})
