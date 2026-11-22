// P6a W2: the store's `setBrandApproved` and `waiting` on a migrated local D1. Ways it can fail, written down first:
//  1. approve or reject applies to a fact that isn't waiting (active, forgotten), at a stale rev, or to a person fact;
//  2. a decision writes no audit line, two, or one whose detail holds the fact's text; a refused one writes a line;
//  3. a batch that committed but whose reply was lost, sent again, applies twice or logs twice;
//  4. two approvals racing both apply, or both log;
//  5. a rejected fact can't be restored and approved again, or a restore reaches `active` without an approve;
//  6. the waiting list holds an active, forgotten or person fact, is in the wrong order or passes its limit;
//  7. over any history of saves, rewords, forgets, restores, approves, rejects and `m:ask` switches, a team fact is
//     `active` without an approve of its then-current revision (or, once W1's switches land, a person's agent's save or
//     reword while `m:ask` is off).
// Expected values are literals or the reference model below (written here, never the store's code).
import { env } from 'cloudflare:workers'
import { fc, test } from '@fast-check/vitest'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { auditText } from '../../../../shared/audit-text.ts'
import { AuditArgsSchema } from '../../../../shared/contract/audit.ts'
import { SYSTEM_MEMBER_ID } from '../../../db/ids.ts'
import { lastLineId, linesSince } from '../../../db/test-support.ts'
import { memoryStore } from './store.ts'

const db = env.DB
const store = memoryStore({ db })
const A = 'm_appr_a'
const ADMIN = 'm_appr_admin'
let k = 0
const newId = () => `mem_appr${String(++k).padStart(18, '0')}`
const at = (actorId = ADMIN) => ({ actorId, requestId: `r-${Math.random()}`, nowMs: 1_800_000_000_000 })
async function seed(scope: 'brand' | 'person', status: 'active' | 'waiting' | 'forgotten', text = `Fact ${k + 1}`) {
  const id = newId()
  await db.prepare('INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, 1, 1)')
    .bind(id, scope, scope === 'person' ? A : null, text, status, A).run()
  return id
}
const row = (id: string) => db.prepare('SELECT status, rev, text FROM memories WHERE id = ?').bind(id).first<{ status: string; rev: number; text: string }>()
const lines = async (before: number) => (await linesSince(db, before)).map(l => [l.action, l.actor_id, l.target_kind, l.target_id, JSON.parse(l.args_json)])

/** `db` whose batches matching `when` run, then throw as if the reply was lost on the way back. */
function replyLost(when: RegExp): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch') return async (stmts: D1PreparedStatement[]) => {
        const r = await target.batch(stmts)
        if (stmts.some(s => when.test(sqlOf.get(s) ?? ''))) throw new Error('network: reply lost')
        return r
      }
      if (prop === 'prepare') return (sql: string) => tagged(target.prepare(sql), sql)
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}
const sqlOf = new WeakMap<object, string>()
function tagged(s: D1PreparedStatement, sql: string): D1PreparedStatement {
  return new Proxy(s, { get(t, p) { const v = Reflect.get(t, p, t); return p === 'bind' ? (...a: unknown[]) => { const b = (v as (...x: unknown[]) => D1PreparedStatement).apply(t, a); sqlOf.set(b, sql); return b } : typeof v === 'function' ? v.bind(t) : v } })
}
/** Two `db`s whose first batch matching `when` each waits until both have reached it (a barrier), then both run. */
function racing(when: RegExp): [D1Database, D1Database] {
  let arrived = 0
  let open!: () => void
  const gate = new Promise<void>(r => { open = r })
  const one = (): D1Database => {
    let fired = false
    return new Proxy(db, {
      get(target, prop) {
        if (prop === 'batch') return async (stmts: D1PreparedStatement[]) => {
          if (!fired && stmts.some(s => when.test(sqlOf.get(s) ?? ''))) {
            fired = true
            if (++arrived === 2) open()
            await gate
          }
          return target.batch(stmts)
        }
        if (prop === 'prepare') return (sql: string) => tagged(target.prepare(sql), sql)
        const v = Reflect.get(target, prop, target)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
  }
  return [one(), one()]
}
const DECIDE = /^\s*UPDATE memories SET status = \?, rev = rev \+ 1, updated_at_ms = \?, req_id = \?\s+WHERE id = \? AND scope = 'brand' AND status = 'waiting'/

beforeAll(async () => {
  await db.batch([
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Ari', 1)").bind(A),
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'admin', 'active', 'Ada', 1)").bind(ADMIN),
  ])
})
beforeEach(async () => {
  await db.batch([db.prepare('DELETE FROM memories'), db.prepare("DELETE FROM settings WHERE key = 'm:ask'")])
})

describe('setBrandApproved: a waiting fact at its rev (failures 1 and 2)', () => {
  it('approve: active, rev + 1, one memory.approved line with the id and the revision decided', async () => {
    const f = await seed('brand', 'waiting')
    const before = await lastLineId(db)
    expect(await store.setBrandApproved({ id: f, approved: true, ifRev: 1 }, at())).toMatchObject({ ok: { id: f, status: 'active', rev: 2 } })
    expect(await row(f)).toMatchObject({ status: 'active', rev: 2 })
    expect(await lines(before)).toEqual([['memory.approved', ADMIN, 'memory', f, { memoryId: f, rev: 1 }]])
  })
  it('reject: forgotten, rev + 1, one memory.rejected line', async () => {
    const f = await seed('brand', 'waiting')
    const before = await lastLineId(db)
    expect(await store.setBrandApproved({ id: f, approved: false, ifRev: 1 }, at())).toMatchObject({ ok: { id: f, status: 'forgotten', rev: 2 } })
    expect(await row(f)).toMatchObject({ status: 'forgotten', rev: 2 })
    expect(await lines(before)).toEqual([['memory.rejected', ADMIN, 'memory', f, { memoryId: f, rev: 1 }]])
  })
  it('a stale rev, an active or a forgotten fact: conflict with the fact as it is, nothing changes, no line', async () => {
    const waiting = await seed('brand', 'waiting')
    await db.prepare('UPDATE memories SET rev = 4 WHERE id = ?').bind(waiting).run()
    const active = await seed('brand', 'active')
    const gone = await seed('brand', 'forgotten')
    const before = await lastLineId(db)
    for (const approved of [true, false]) {
      expect(await store.setBrandApproved({ id: waiting, approved, ifRev: 3 }, at())).toMatchObject({ conflict: { id: waiting, status: 'waiting', rev: 4 } })
      expect(await store.setBrandApproved({ id: active, approved, ifRev: 1 }, at())).toMatchObject({ conflict: { id: active, status: 'active', rev: 1 } })
      expect(await store.setBrandApproved({ id: gone, approved, ifRev: 1 }, at())).toMatchObject({ conflict: { id: gone, status: 'forgotten', rev: 1 } })
    }
    expect(await row(waiting)).toMatchObject({ status: 'waiting', rev: 4 })
    expect(await row(active)).toMatchObject({ status: 'active', rev: 1 })
    expect(await row(gone)).toMatchObject({ status: 'forgotten', rev: 1 })
    expect(await linesSince(db, before)).toEqual([])
  })
  it('a person fact (even one with status waiting) or an unknown id: notFound, nothing changes, no line', async () => {
    const p = await seed('person', 'active')
    const odd = await seed('person', 'waiting')
    const before = await lastLineId(db)
    for (const id of [p, odd, 'mem_apprNOPEaaaaaaaaaaaaaa']) {
      expect(await store.setBrandApproved({ id, approved: true, ifRev: 1 }, at()), id).toEqual({ notFound: true })
    }
    expect(await row(p)).toMatchObject({ status: 'active', rev: 1 })
    expect(await linesSince(db, before)).toEqual([])
  })
  it("the line's rendered detail never holds the fact's text (literal)", async () => {
    const secret = 'Kestrel pays net 30 on invoices'
    const yes = await seed('brand', 'waiting', secret)
    const no = await seed('brand', 'waiting', `${secret} again`)
    const before = await lastLineId(db)
    await store.setBrandApproved({ id: yes, approved: true, ifRev: 1 }, at())
    await store.setBrandApproved({ id: no, approved: false, ifRev: 1 }, at())
    const written = await linesSince(db, before)
    expect(written.map(l => l.action)).toEqual(['memory.approved', 'memory.rejected'])
    for (const l of written) {
      expect(l.args_json).not.toContain('Kestrel')
      const args = AuditArgsSchema.parse({ action: l.action, ...JSON.parse(l.args_json) })
      const t = auditText(args, () => 'Ada')
      expect(`${t.what} ${t.detail}`).not.toMatch(/Kestrel|net 30|invoice/)
      expect(t).toEqual(l.action === 'memory.approved' ? { what: 'approved a team memory', detail: '' } : { what: 'rejected a team memory', detail: '' })
    }
  })
})

describe('setBrandApproved: lost replies and races (failures 3 and 4)', () => {
  it('the batch committed but its reply was lost: the retry answers conflict with the fact approved, one line', async () => {
    const f = await seed('brand', 'waiting')
    const before = await lastLineId(db)
    await expect(memoryStore({ db: replyLost(DECIDE) }).setBrandApproved({ id: f, approved: true, ifRev: 1 }, at())).rejects.toThrow()
    expect(await row(f)).toMatchObject({ status: 'active', rev: 2 })
    expect(await store.setBrandApproved({ id: f, approved: true, ifRev: 1 }, at())).toMatchObject({ conflict: { id: f, status: 'active', rev: 2 } })
    expect(await lines(before)).toEqual([['memory.approved', ADMIN, 'memory', f, { memoryId: f, rev: 1 }]])
  })
  it('the same for a reject: the retry is a conflict with the fact forgotten, one line', async () => {
    const f = await seed('brand', 'waiting')
    const before = await lastLineId(db)
    await expect(memoryStore({ db: replyLost(DECIDE) }).setBrandApproved({ id: f, approved: false, ifRev: 1 }, at())).rejects.toThrow()
    expect(await store.setBrandApproved({ id: f, approved: false, ifRev: 1 }, at())).toMatchObject({ conflict: { status: 'forgotten', rev: 2 } })
    expect((await lines(before)).map(l => l[0])).toEqual(['memory.rejected'])
  })
  it('two approvals racing at the same rev: exactly one wins, one line', async () => {
    const f = await seed('brand', 'waiting')
    const before = await lastLineId(db)
    const [d1, d2] = racing(DECIDE)
    const results = await Promise.all([
      memoryStore({ db: d1 }).setBrandApproved({ id: f, approved: true, ifRev: 1 }, at()),
      memoryStore({ db: d2 }).setBrandApproved({ id: f, approved: true, ifRev: 1 }, at()),
    ])
    expect(results.filter(r => 'ok' in r)).toHaveLength(1)
    expect(results.filter(r => 'conflict' in r)).toHaveLength(1)
    expect(await row(f)).toMatchObject({ status: 'active', rev: 2 })
    expect((await lines(before)).map(l => l[0])).toEqual(['memory.approved'])
  })
  it('an approve racing a reject: one wins, the other is a conflict, one line', async () => {
    const f = await seed('brand', 'waiting')
    const before = await lastLineId(db)
    const [d1, d2] = racing(DECIDE)
    const [yes, no] = await Promise.all([
      memoryStore({ db: d1 }).setBrandApproved({ id: f, approved: true, ifRev: 1 }, at()),
      memoryStore({ db: d2 }).setBrandApproved({ id: f, approved: false, ifRev: 1 }, at()),
    ])
    expect(['ok' in yes, 'ok' in no].filter(Boolean)).toHaveLength(1)
    const now = await row(f)
    expect(now?.rev).toBe(2)
    expect((await lines(before)).map(l => l[0])).toEqual([now?.status === 'active' ? 'memory.approved' : 'memory.rejected'])
  })
})

describe('restore after a reject (failure 5)', () => {
  it('rejected, restored: it waits (not active); approved at the new rev, it counts', async () => {
    const f = await seed('brand', 'waiting')
    await store.setBrandApproved({ id: f, approved: false, ifRev: 1 }, at())
    expect(await store.setBrandForgotten({ id: f, forgotten: false, ifRev: 2 }, at())).toMatchObject({ ok: { status: 'waiting', rev: 3 } })
    expect(await store.visible(A, f)).toBeNull()
    expect(await store.setBrandApproved({ id: f, approved: true, ifRev: 2 }, at())).toMatchObject({ conflict: { status: 'waiting', rev: 3 } })
    expect(await store.setBrandApproved({ id: f, approved: true, ifRev: 3 }, at())).toMatchObject({ ok: { status: 'active', rev: 4 } })
    expect(await store.visible(A, f)).toMatchObject({ id: f, status: 'active' })
  })
})

describe('waiting: the only read of waiting facts (failure 6)', () => {
  it('brand waiting facts only, newest first, at most `limit`', async () => {
    await seed('brand', 'active', 'Active one')
    await seed('brand', 'forgotten', 'Forgotten one')
    await seed('person', 'active', 'Person one')
    const w1 = await seed('brand', 'waiting', 'Waiting first')
    const w2 = await seed('brand', 'waiting', 'Waiting second')
    const w3 = await seed('brand', 'waiting', 'Waiting third')
    expect((await store.waiting(200)).map(f => f.id)).toEqual([w3, w2, w1])
    expect((await store.waiting(2)).map(f => f.id)).toEqual([w3, w2])
    expect((await store.waiting(200)).every(f => f.scope === 'brand' && f.status === 'waiting')).toBe(true)
  })
  it('stops at the limit with more waiting than that', async () => {
    for (let i = 0; i < 205; i++) await seed('brand', 'waiting', `Waiting ${i}`)
    const list = await store.waiting(200)
    expect(list).toHaveLength(200)
    expect(list[0].text).toBe('Waiting 204')
    expect(list[199].text).toBe('Waiting 5')
  })
})

// ---------- failure 7: the history property. ----------

/**
 * W1's switches (`m:ask` honoured in `save` and `update`) aren't on this branch yet. Until W1's PR merges, switching
 * `m:ask` changes nothing in the model (and must change nothing in the store); once it merges, this is `true` and the
 * model follows the plan's rule: a person's agent's brand save or reword is `active` while `m:ask` is off.
 */
const SWITCHES_LANDED = false

type Who = 'person' | 'routine'
type Op =
  | { op: 'save'; who: Who; t: number }
  | { op: 'reword'; who: Who; i: number; t: number }
  | { op: 'forget'; i: number; stale: boolean }
  | { op: 'restore'; i: number; stale: boolean }
  | { op: 'decide'; i: number; approved: boolean; stale: boolean }
  | { op: 'ask'; to: 'on' | 'off' | 'unset' }
const TEXTS = ['We restock on Fridays', 'Ship orders before noon', 'Use the blue box for gifts', 'Returns take five days']
const who = fc.constantFrom<Who>('person', 'routine')
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ op: fc.constant('save' as const), who, t: fc.nat(TEXTS.length - 1) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('reword' as const), who, i: fc.nat(9), t: fc.nat(TEXTS.length - 1) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('forget' as const), i: fc.nat(9), stale: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('restore' as const), i: fc.nat(9), stale: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('decide' as const), i: fc.nat(9), approved: fc.boolean(), stale: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('ask' as const), to: fc.constantFrom('on' as const, 'off' as const, 'unset' as const) }) },
)

interface ModelFact { id: string; text: string; status: 'active' | 'waiting' | 'forgotten'; rev: number; why: string | null }

describe('the history property (failure 7)', () => {
  test.prop([fc.array(opArb, { minLength: 1, maxLength: 30 })], { numRuns: 40 })(
    'a team fact is active only through an approve of its revision (or, with the switches, an agent save while m:ask is off)',
    async ops => {
      await db.batch([db.prepare('DELETE FROM memories'), db.prepare("DELETE FROM settings WHERE key = 'm:ask'")])
      const facts: ModelFact[] = []
      let ask: 'on' | 'off' | 'unset' = 'unset'
      const askOff = () => SWITCHES_LANDED && ask === 'off'
      const member = (w: Who) => (w === 'person' ? A : SYSTEM_MEMBER_ID)
      let clock = 0
      const req = () => `rq-${++clock}`
      for (const o of ops) {
        if (o.op === 'save') {
          const text = TEXTS[o.t]
          const same = facts.find(f => f.text === text && f.status !== 'forgotten')
          const r = await store.save({ memberId: member(o.who), scope: 'brand', text, chatId: null, nowMs: ++clock, requestId: req() })
          if (same) {
            expect(r).toMatchObject({ duplicate: { id: same.id } })
          } else {
            expect('saved' in r).toBe(true)
            const id = (r as { saved: { id: string } }).saved.id
            const active = o.who === 'person' && askOff()
            facts.push({ id, text, status: active ? 'active' : 'waiting', rev: 1, why: active ? 'saved while m:ask off' : null })
          }
        } else if (o.op === 'reword') {
          const f = facts[o.i % Math.max(facts.length, 1)]
          if (!f) continue
          const text = TEXTS[o.t]
          const r = await store.update({ memberId: member(o.who), id: f.id, text, nowMs: ++clock, requestId: req() })
          if (f.status !== 'active') expect(r).toEqual({ notFound: true })
          else if (f.text === text) expect(r).toMatchObject({ unchanged: { id: f.id } })
          else {
            expect(r).toMatchObject({ updated: { id: f.id } })
            const active = o.who === 'person' && askOff()
            Object.assign(f, { text, rev: f.rev + 1, status: active ? 'active' : 'waiting', why: active ? 'reworded while m:ask off' : null })
          }
        } else if (o.op === 'forget' || o.op === 'restore') {
          const f = facts[o.i % Math.max(facts.length, 1)]
          if (!f) continue
          const forgotten = o.op === 'forget'
          const ifRev = o.stale ? Math.max(1, f.rev - 1) : f.rev
          const r = await store.setBrandForgotten({ id: f.id, forgotten, ifRev }, at())
          const takes = forgotten ? f.status !== 'forgotten' : f.status === 'forgotten'
          if (takes && ifRev === f.rev) {
            expect(r).toMatchObject({ ok: { id: f.id } })
            Object.assign(f, { rev: f.rev + 1, status: forgotten ? 'forgotten' : 'waiting', why: null })
          } else expect(r).toMatchObject({ conflict: { id: f.id } })
        } else if (o.op === 'decide') {
          const f = facts[o.i % Math.max(facts.length, 1)]
          if (!f) continue
          const ifRev = o.stale ? Math.max(1, f.rev - 1) : f.rev
          const r = await store.setBrandApproved({ id: f.id, approved: o.approved, ifRev }, at())
          if (f.status === 'waiting' && ifRev === f.rev) {
            expect(r).toMatchObject({ ok: { id: f.id } })
            Object.assign(f, { rev: f.rev + 1, status: o.approved ? 'active' : 'forgotten', why: o.approved ? `approved at rev ${ifRev}` : null })
          } else expect(r).toMatchObject({ conflict: { id: f.id } })
        } else {
          ask = o.to
          if (o.to === 'unset') await db.prepare("DELETE FROM settings WHERE owner = 'brand' AND key = 'm:ask'").run()
          else {
            await db.prepare(`INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 'm:ask', ?, 1, 1, ?, 'r')
              ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json, rev = rev + 1`).bind(o.to === 'on' ? 'true' : 'false', ADMIN).run()
          }
        }
        // The store matches the model, row for row.
        const rows = await db.prepare("SELECT id, text, status, rev FROM memories WHERE scope = 'brand' ORDER BY n").all<{ id: string; text: string; status: string; rev: number }>()
        expect(rows.results).toEqual(facts.map(f => ({ id: f.id, text: f.text, status: f.status, rev: f.rev })))
        // The invariant: every active fact got there through an approve of the revision it then had (one below its
        // rev now), or through an agent's save or reword while m:ask was off.
        for (const f of facts.filter(x => x.status === 'active')) {
          expect(f.why === `approved at rev ${f.rev - 1}` || (SWITCHES_LANDED && /while m:ask off$/.test(f.why ?? '')), `${f.id} ${f.why}`).toBe(true)
        }
        // And the one read of waiting facts lists exactly the waiting ones, newest first.
        expect((await store.waiting(200)).map(f => f.id)).toEqual(facts.filter(f => f.status === 'waiting').map(f => f.id).reverse())
      }
    },
  )
})
