// "Learn from my chats" (`m:learn`) and "Ask before saving a team rule" (`m:ask`) honoured by the memory tools (P6a W1).
// Ways it can fail, written down first:
//  1. a person's save or reword goes in while their `m:learn` is off (or the switch is read before the write, so a
//     switch flipped in between is missed);
//  2. a brand fact is `active` when it should wait (a routine's fact, `m:ask` on, missing or null) or `waiting` when a
//     person's agent saved it with `m:ask` off;
//  3. turning `m:ask` off approves what already waits, or an admin's restore skips the approval;
//  4. a waiting fact is found by search, list or page;
//  5. memory doesn't work at stage Watch (no stage check exists on the server; this proves it).
// Expected values are literals, or a separately written reference model; the property prints its seed on failure.
import { env } from 'cloudflare:workers'
import { fc, test } from '@fast-check/vitest'
import { beforeAll, describe, expect, it } from 'vitest'
import { handleMcp } from '../../server/index.ts'
import { SYSTEM_MEMBER_ID } from '../../../db/ids.ts'
import { memberStore } from '../../../db/members.ts'
import { settingStore } from '../../../db/settings.ts'
import { memoryStore } from './store.ts'

const db = env.DB
const store = memoryStore({ db })
const P1 = 'm_tog_a'
const P2 = 'm_tog_b'
let rid = 0
const at = (actorId: string) => ({ actorId, requestId: `r-tog-${++rid}`, nowMs: 10 })

async function call(who: string, name: string, args: Record<string, unknown>, database: D1Database = db) {
  const res = await handleMcp(new Request('http://egress.internal/mcp/', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }) }),
    { memberId: who, chatId: 'c_tog', runId: 'r_AAAAAAAAAAAAAAAAAAAAAA', turnId: 't_AAAAAAAAAAAAAAAAAAAAAA' }, { db: database, now: () => 1_800_000_000_000 })
  const body = (await res.json()) as { result: { structuredContent: Record<string, unknown>; content: { text: string }[]; isError?: true } }
  return body.result
}

type Switch = true | false | null | 'missing'
/** Writes a setting row as the settings store does: JSON text, a reset as `null`, `missing` as no row. */
async function setSwitch(owner: string, key: string, v: Switch) {
  if (v === 'missing') { await db.prepare('DELETE FROM settings WHERE owner = ? AND key = ?').bind(owner, key).run(); return }
  await db.prepare(`INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES (?, ?, ?, 1, 1, 'm_x', 'r')
    ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json, rev = rev + 1`).bind(owner, key, JSON.stringify(v)).run()
}
const learn = (who: string, v: Switch) => setSwitch(who, 'm:learn', v)
const ask = (v: Switch) => setSwitch('brand', 'm:ask', v)
const row = (id: string) => db.prepare('SELECT status, text, rev FROM memories WHERE id = ?').bind(id).first<{ status: string; text: string; rev: number }>()
const savedId = (r: { structuredContent: Record<string, unknown> }) => (r.structuredContent.fact as { memory_id: string }).memory_id
const reset = async () => { await learn(P1, 'missing'); await learn(P2, 'missing'); await ask('missing') }

/** `db` with a step run once, just before the first batch whose SQL matches `when` (a barrier at the store's await). */
function withBarrier(when: RegExp, step: () => Promise<unknown>, after?: () => Promise<unknown>): D1Database {
  const sqlOf = new WeakMap<object, string>()
  let fired = false
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => {
        const s = target.prepare(sql)
        return new Proxy(s, { get(t, p) { const v = Reflect.get(t, p, t); return p === 'bind' ? (...a: unknown[]) => { const b = (v as (...x: unknown[]) => D1PreparedStatement).apply(t, a); sqlOf.set(b, sql); return b } : typeof v === 'function' ? v.bind(t) : v } })
      }
      if (prop === 'batch') return async (stmts: D1PreparedStatement[]) => {
        const hit = !fired && stmts.some(s => when.test(sqlOf.get(s) ?? ''))
        if (hit) { fired = true; await step() }
        const out = await target.batch(stmts)
        if (hit && after) await after()
        return out
      }
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

beforeAll(async () => {
  await db.batch([
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Tia', 1)").bind(P1),
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Tom', 1)").bind(P2),
  ])
})

describe('the literal cases (failures 1 to 4)', () => {
  it('m:learn off refuses a person save and a person reword with learning_off; forget and brand saves are unaffected', async () => {
    await reset()
    const mine = savedId(await call(P1, 'memory_save', { scope: 'person', text: 'Tia likes tidy tables' }))
    await learn(P1, false)
    const refused = await call(P1, 'memory_save', { scope: 'person', text: 'Tia wants bold totals' })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toEqual({ error: 'learning_off' })
    expect(refused.content[0].text).toBe('Not saved: this person turned off "Learn from my chats" in Settings, so don\'t save their preferences. If they want it saved, they can turn it back on.')
    expect(await db.prepare("SELECT COUNT(*) AS n FROM memories WHERE text = 'Tia wants bold totals'").first<number>('n')).toBe(0)
    expect((await call(P1, 'memory_update', { memory_id: mine, text: 'Tia likes very tidy tables' })).structuredContent).toEqual({ error: 'learning_off' })
    expect(await row(mine)).toEqual({ status: 'active', text: 'Tia likes tidy tables', rev: 1 })
    expect((await call(P1, 'memory_save', { scope: 'brand', text: 'Learn-off brand fact one' })).isError).toBeUndefined()
    expect((await call(P1, 'memory_forget', { memory_id: mine })).structuredContent).toEqual({ memory_id: mine, forgotten: true })
    // Another person's switch is theirs alone.
    expect((await call(P2, 'memory_save', { scope: 'person', text: 'Tom likes quiet mode' })).isError).toBeUndefined()
  })

  it('m:learn null, missing or true saves', async () => {
    for (const [i, v] of ([null, 'missing', true] as const).entries()) {
      await reset()
      await learn(P1, v)
      expect((await call(P1, 'memory_save', { scope: 'person', text: `Tia switch case ${i}` })).isError).toBeUndefined()
    }
  })

  it('a duplicate is answered as already saved even with m:learn off (the duplicate is found first)', async () => {
    await reset()
    await call(P1, 'memory_save', { scope: 'person', text: 'Tia dup under switch' })
    await learn(P1, false)
    expect((await call(P1, 'memory_save', { scope: 'person', text: 'Tia dup under switch' })).structuredContent).toMatchObject({ already_saved: true })
  })

  it('m:ask on (missing, null, true): a brand fact waits; m:ask off: a person\'s brand save and reword are active, a routine\'s waits', async () => {
    for (const v of ['missing', null, true] as const) {
      await reset(); await ask(v)
      const r = await call(P1, 'memory_save', { scope: 'brand', text: `Ask-on fact ${String(v)}` })
      expect((await row(savedId(r)))!.status).toBe('waiting')
    }
    await reset(); await ask(false)
    const active = await call(P1, 'memory_save', { scope: 'brand', text: 'Ask-off fact by a person' })
    expect((await row(savedId(active)))!.status).toBe('active')
    expect(active.content[0].text).toBe(`Saved for the team (memory_id: ${savedId(active)}). It counts from now.`)
    const routine = await store.save({ memberId: SYSTEM_MEMBER_ID, scope: 'brand', text: 'Ask-off fact by a routine', chatId: null, nowMs: 5, requestId: 'r-sys' })
    expect('saved' in routine && routine.saved.status).toBe('waiting')
    const id = savedId(active)
    const reworded = await call(P2, 'memory_update', { memory_id: id, text: 'Ask-off fact by a person, reworded' })
    expect(await row(id)).toEqual({ status: 'active', text: 'Ask-off fact by a person, reworded', rev: 2 })
    expect(reworded.content[0].text).toBe(`Changed (memory_id: ${id}). It counts from now.`)
    await ask('missing')
    const back = await call(P2, 'memory_update', { memory_id: id, text: 'Ask-on again, reworded' })
    expect((await row(id))!.status).toBe('waiting')
    expect(back.content[0].text).toBe(`Changed (memory_id: ${id}). A team fact waits for an admin's OK again after a change, so don't rely on it until then.`)
  })

  it('the waiting answer for a save is the old text', async () => {
    await reset()
    const r = await call(P1, 'memory_save', { scope: 'brand', text: 'Waiting answer fact' })
    expect(r.content[0].text).toBe(`Saved for the team (memory_id: ${savedId(r)}). It waits for an admin's OK, so don't rely on it until then.`)
  })

  it('turning m:ask off leaves a waiting fact waiting; an admin\'s restore still sends a fact to waiting; waiting facts are never found', async () => {
    await reset()
    const waiting = savedId(await call(P1, 'memory_save', { scope: 'brand', text: 'Zebra rule waits' }))
    await ask(false)
    expect((await row(waiting))!.status).toBe('waiting')
    const find = async () => ({
      search: ((await call(P2, 'memory_search', { query: 'Zebra' })).structuredContent.facts as unknown[]).length,
      list: ((await call(P2, 'memory_list', { scope: 'brand' })).structuredContent.facts as { text: string }[]).filter(f => f.text.includes('Zebra')).length,
      page: (await store.page(P2)).team.filter(f => f.text.includes('Zebra')).length,
    })
    expect(await find()).toEqual({ search: 0, list: 0, page: 0 })
    const active = savedId(await call(P1, 'memory_save', { scope: 'brand', text: 'Yak rule counts' }))
    expect((await row(active))!.status).toBe('active')
    expect(await store.setBrandForgotten({ id: active, forgotten: true, ifRev: 1 }, at(P1))).toMatchObject({ ok: { status: 'forgotten' } })
    expect(await store.setBrandForgotten({ id: active, forgotten: false, ifRev: 2 }, at(P1))).toMatchObject({ ok: { status: 'waiting' } })
  })
})

describe('pins from the line-A review', () => {
  it('m:ask on: a person\'s reword of an active brand fact goes back to waiting', async () => {
    await reset()
    const id = savedId(await call(P1, 'memory_save', { scope: 'brand', text: 'Pin brand fact' }))
    await db.prepare("UPDATE memories SET status = 'active' WHERE id = ?").bind(id).run()   // an admin's OK
    await call(P2, 'memory_update', { memory_id: id, text: 'Pin brand fact, reworded' })
    expect(await row(id)).toEqual({ status: 'waiting', text: 'Pin brand fact, reworded', rev: 2 })
  })
  it('m:learn off: an admin cannot reword someone else\'s person fact (owner only)', async () => {
    await reset()
    await db.prepare("INSERT OR IGNORE INTO members (id, kind, role, status, name, created_at_ms) VALUES ('m_tog_admin', 'person', 'admin', 'active', 'Ada', 1)").run()
    const id = savedId(await call(P1, 'memory_save', { scope: 'person', text: 'Tia private pin' }))
    expect((await call('m_tog_admin', 'memory_update', { memory_id: id, text: 'Admin edit' })).structuredContent).toEqual({ error: 'not_found' })
    await learn(P1, false)
    expect((await call('m_tog_admin', 'memory_update', { memory_id: id, text: 'Admin edit' })).structuredContent).toEqual({ error: 'not_found' })
    expect(await row(id)).toEqual({ status: 'active', text: 'Tia private pin', rev: 1 })
  })
  it('the real settings store writes the switch off as the text false, and the save then refuses', async () => {
    await reset()
    const settings = settingStore({ db, hashKey: 'test-hash-key', members: memberStore({ db }) })
    const done = await settings.write({ owner: P1, scope: 'personal', key: 'm:learn', value: false, ifRev: 0 }, at(P1))
    expect('ok' in done).toBe(true)
    expect(await db.prepare("SELECT value_json FROM settings WHERE owner = ? AND key = 'm:learn'").bind(P1).first<string>('value_json')).toBe('false')
    expect((await call(P1, 'memory_save', { scope: 'person', text: 'Tia after the real switch' })).structuredContent).toEqual({ error: 'learning_off' })
    const reset1 = await settings.write({ owner: P1, scope: 'personal', key: 'm:learn', value: null, ifRev: 1 }, at(P1))
    expect('ok' in reset1).toBe(true)
    expect((await call(P1, 'memory_save', { scope: 'person', text: 'Tia after the reset' })).isError).toBeUndefined()
  })
})

describe('memory at stage Watch (failure 5)', () => {
  it('saves and searches with the brand\'s stage set to Watch', async () => {
    await reset()
    await setSwitch('brand', 'stage', 'Watch' as unknown as Switch)
    const row0 = await db.prepare("SELECT value_json FROM settings WHERE owner = 'brand' AND key = 'stage'").first<string>('value_json')
    expect(row0).toBe('"Watch"')
    await call(P1, 'memory_save', { scope: 'person', text: 'Watch stage person fact' })
    expect(((await call(P1, 'memory_search', { query: 'Watch stage' })).structuredContent.facts as unknown[]).length).toBe(1)
    await setSwitch('brand', 'stage', 'missing')
  })
})

describe('races (failure 1)', () => {
  it('the switch is written between the read and the save: the save is refused, nothing is written', async () => {
    await reset()
    const r = await call(P1, 'memory_save', { scope: 'person', text: 'Tia raced save' }, withBarrier(/^\s*INSERT INTO memories/, () => learn(P1, false)))
    expect(r.structuredContent).toEqual({ error: 'learning_off' })
    expect(await db.prepare("SELECT COUNT(*) AS n FROM memories WHERE text = 'Tia raced save'").first<number>('n')).toBe(0)
  })
  it('the switch is written between the read and the reword: refused, the fact is unchanged', async () => {
    await reset()
    const id = savedId(await call(P1, 'memory_save', { scope: 'person', text: 'Tia race reword' }))
    const r = await call(P1, 'memory_update', { memory_id: id, text: 'Tia race reword two' }, withBarrier(/^\s*UPDATE memories SET text/, () => learn(P1, false)))
    expect(r.structuredContent).toEqual({ error: 'learning_off' })
    expect(await row(id)).toEqual({ status: 'active', text: 'Tia race reword', rev: 1 })
  })
  it('m:ask turned on between the read and a brand save: the fact waits', async () => {
    await reset(); await ask(false)
    const r = await call(P1, 'memory_save', { scope: 'brand', text: 'Race ask save' }, withBarrier(/^\s*INSERT INTO memories/, () => ask(true)))
    expect((await row(savedId(r)))!.status).toBe('waiting')
  })
  it('the batch committed but the reply was lost: the same save sent again finds the first', async () => {
    await reset(); await ask(false)
    const lost = withBarrier(/^\s*INSERT INTO memories/, async () => {}, async () => { throw new Error('reply lost') })
    await expect(memoryStore({ db: lost }).save({ memberId: P1, scope: 'brand', text: 'Lost reply fact', chatId: null, nowMs: 1, requestId: 'r-lost' })).rejects.toThrow('reply lost')
    const again = await call(P1, 'memory_save', { scope: 'brand', text: 'Lost reply fact' })
    expect(again.structuredContent).toMatchObject({ already_saved: true })
    expect(await db.prepare("SELECT COUNT(*) AS n FROM memories WHERE text = 'Lost reply fact'").first<number>('n')).toBe(1)
  })
})

// ----- the property: histories against a reference model written here, not the store's SQL -----
type Op =
  | { op: 'save'; who: 'p1' | 'p2' | 'sys'; scope: 'person' | 'brand'; t: number }
  | { op: 'update'; who: 'p1' | 'p2'; pick: number; t: number }
  | { op: 'learn'; who: 'p1' | 'p2'; v: Switch }
  | { op: 'ask'; v: Switch }
const sw = fc.constantFrom<Switch>(true, false, null, 'missing')
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant('save' as const), who: fc.constantFrom('p1' as const, 'p2' as const, 'sys' as const), scope: fc.constantFrom('person' as const, 'brand' as const), t: fc.integer({ min: 0, max: 3 }) }),
  fc.record({ op: fc.constant('update' as const), who: fc.constantFrom('p1' as const, 'p2' as const), pick: fc.nat(20), t: fc.integer({ min: 0, max: 3 }) }),
  fc.record({ op: fc.constant('learn' as const), who: fc.constantFrom('p1' as const, 'p2' as const), v: sw }),
  fc.record({ op: fc.constant('ask' as const), v: sw }),
)
interface ModelFact { id: string; scope: 'person' | 'brand'; owner: string | null; text: string; status: 'active' | 'waiting' }
const idOf = { p1: P1, p2: P2, sys: SYSTEM_MEMBER_ID }
let runNo = 0

describe('histories against a reference model (failures 1 and 2)', () => {
  test.prop({ ops: fc.array(opArb, { minLength: 1, maxLength: 25 }) }, { numRuns: 60 })('every save and reword is refused or lands as the model says', async ({ ops }) => {
    await reset()
    await db.prepare("DELETE FROM memories WHERE text LIKE 'prop%'").run()
    const run = ++runNo
    const text = (scope: string, t: number) => `prop run ${run} ${scope} text ${t}`
    const learnOff = { p1: false, p2: false }
    let askOff = false
    const facts: ModelFact[] = []
    for (const o of ops) {
      if (o.op === 'learn') { await learn(idOf[o.who], o.v); learnOff[o.who] = o.v === false; continue }
      if (o.op === 'ask') { await ask(o.v); askOff = o.v === false; continue }
      if (o.op === 'save') {
        const who = idOf[o.who]
        const owner = o.scope === 'person' ? who : null
        const t = text(o.scope, o.t)
        const r = await store.save({ memberId: who, scope: o.scope, text: t, chatId: null, nowMs: 1, requestId: `r-p-${++rid}` })
        if (o.scope === 'person' && o.who === 'sys') { expect(r).toEqual({ refused: 'service_person_fact' }); continue }
        if (facts.some(f => f.scope === o.scope && f.owner === owner && f.text === t)) { expect('duplicate' in r, 'duplicate').toBe(true); continue }
        if (o.scope === 'person' && learnOff[o.who as 'p1' | 'p2']) { expect(r).toEqual({ refused: 'learning_off' }); continue }
        const status = o.scope === 'person' ? 'active' : o.who !== 'sys' && askOff ? 'active' : 'waiting'
        expect('saved' in r && r.saved.status, JSON.stringify(o)).toBe(status)
        if ('saved' in r) facts.push({ id: r.saved.id, scope: o.scope, owner, text: t, status })
        continue
      }
      // update: the model's visible facts for `who` are active ones of the brand and their own
      const who = idOf[o.who]
      const visible = facts.filter(f => f.status === 'active' && (f.scope === 'brand' || f.owner === who))
      if (visible.length === 0) continue
      const target = visible[o.pick % visible.length]
      const t = text(`${target.scope}-re`, o.t)
      const r = await store.update({ memberId: who, id: target.id, text: t, nowMs: 2, requestId: `r-p-${++rid}` })
      if (target.text === t) { expect('unchanged' in r).toBe(true); continue }
      if (target.scope === 'person' && learnOff[o.who]) { expect(r, JSON.stringify(o)).toEqual({ refused: 'learning_off' }); continue }
      expect('updated' in r, JSON.stringify(o)).toBe(true)
      target.text = t
      target.status = target.scope === 'person' || askOff ? 'active' : 'waiting'
      if ('updated' in r) expect(r.updated.status).toBe(target.status)
    }
    for (const f of facts) expect((await row(f.id))!.status, f.text).toBe(f.status)
  })
})
