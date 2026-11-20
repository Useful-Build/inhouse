// Routes 22 to 28 (p3-design sections 2, 3 and 4.8) through their handlers, on the real migrations and the real
// BrandAgent. Expected values are literals written from the design. Ways they can fail, written down first:
//  1. another person's chat is listed, read or changed, or answers anything but 404, or reaches `requireObject` first;
//     an Admin sees another's chat; Inhouse can't read without naming an owner;
//  2. paging skips or repeats a chat or a message (keyset `(last_at_ms DESC, id DESC)` and `pos DESC`);
//  3. a stale `ifRev` changes anything, or answers without `current`;
//  4. a delete or restore with one id not the caller's changes any chat (all-or-nothing), or 51 ids pass;
//  5. a create isn't idempotent for its owner, or a failed save leaves a row, or a lost reply makes a second one;
//  6. a delete leaves a queued turn waiting or a live one running, or ends them outside the BrandAgent's paths;
//  7. `running` and `runs` don't follow the BrandAgent's live run;
//  8. a send whose D1 read happened before a delete committed is admitted into the deleted chat, or a restored chat
//     still refuses sends.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { ChatPageSchema } from '../../shared/contract/chats.ts'
import { CATALOG } from '../model/catalog.ts'
import type { CatalogModel } from '../model/catalog.ts'
import { openStores } from '../db/stores.ts'
import type { Stores } from '../db/stores.ts'
import { chatStore } from '../db/chats.ts'
import { StoreUnavailableError } from '../db/sql.ts'
import { ctx, person, personPrincipal, reset } from '../db/test-support.ts'
import type { HandlerContext } from '../routes.ts'
import type { Principal } from '../auth/index.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import { sendTurnWith } from './runs.ts'
import { createChat, deleteChats, getChat, listChats, pinChat, renameChat, restoreChats } from './chats.ts'

const db = env.DB
const stores = openStores(env)
const NOW = 1_800_000_000_000
let u = 0
const uniq = () => `${++u}${Math.random().toString(36).slice(2, 7)}`
const sendPriced = sendTurnWith(CATALOG.map((m): CatalogModel => ({
  ...m, price: { tiers: [{ uptoInputTokens: null, input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1 }], fastModeMultiplier: null, geoMultipliers: {}, webSearchPerUse: 1 },
})))

let alice: string
let bob: string
let admin: string
beforeEach(async () => {
  await reset(db)
  alice = await person(stores, { email: `a-${uniq()}@example.test`, subject: `sa-${uniq()}`, role: 'member' })
  bob = await person(stores, { email: `b-${uniq()}@example.test`, subject: `sb-${uniq()}`, role: 'member' })
  admin = await person(stores, { email: `d-${uniq()}@example.test`, subject: `sd-${uniq()}`, role: 'admin' })
})

const chat = async (id: string, owner: string, o: { lastAt?: number; deleted?: boolean; title?: string } = {}) =>
  db.prepare('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms, deleted_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, owner, o.title ?? 'A chat', 1_000, o.lastAt ?? 2_000, o.deleted ? 1_500 : null).run()
const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const summary = (id: string, o: Partial<{ title: string; customTitle: string | null; pinned: boolean; deleted: boolean; at: number; rev: number; running: boolean }> = {}) => ({
  id, title: o.title ?? o.customTitle ?? 'A chat', customTitle: o.customTitle ?? null, pinned: o.pinned ?? false, deleted: o.deleted ?? false,
  at: instant(o.at ?? 2_000), rev: o.rev ?? 1, running: o.running ?? false,
})
const inhouse = (grant = true): Principal => ({ kind: 'inhouse', memberId: admin, subject: 'sub-ih', grant: grant ? { id: 'g_live', endsAtMs: NOW + 60_000 } : null, requestId: `r-${uniq()}`, expMs: 4_102_444_800_000 })
const smoke: Principal = { kind: 'service', name: 'smoke', memberId: 'm_smoke', requestId: 'r-smoke' }
const me = (who: string, role: 'member' | 'admin' = 'member') => personPrincipal(who, role)

const call = async (h: (c: HandlerContext) => Promise<Response>, principal: Principal, init: { method?: string; path: string; body?: unknown; params?: Record<string, string> }, s: Stores = stores, e: Env = env) => {
  const { c, objects } = ctx(s, principal, init)
  const res = await h({ ...c, env: e, ctx: {} as ExecutionContext } as HandlerContext)
  return { status: res.status, body: await res.json() as Record<string, unknown>, objects }
}
type ChatMark = { id: string; rev: number }[]
/** The env with some of the BrandAgent's calls replaced (a barrier, a failure); the rest go to the real object. */
function agentEnv(o: { chatRuns?: (ids: string[]) => Promise<unknown>; endChats?: (c: ChatMark) => Promise<void>; restoreChats?: (c: ChatMark) => Promise<void> }): Env {
  const real = brandAgent(env)
  const stub = { chatRuns: (ids: string[]) => real.chatRuns(ids), endChats: (c: ChatMark) => real.endChats(c), restoreChats: (c: ChatMark) => real.restoreChats(c), ...o }
  return { ...env, BRAND_AGENT: { getByName: () => stub } } as unknown as Env
}
const list = (p: Principal, query = '') => call(listChats, p, { path: `/api/chats${query}` })
const get = (p: Principal, id: string, query = '') => call(getChat, p, { path: `/api/chats/${id}${query}`, params: { id } })
const ids = (r: { body: Record<string, unknown> }) => (r.body.items as { id: string }[]).map(c => c.id)

describe('route 22: list (failures 1, 2, 7)', () => {
  it('a member pages their own chats, newest first with ties by id, deleted ones apart; nobody else\'s', async () => {
    const p = `c-${uniq()}`
    await chat(`${p}-a`, alice, { lastAt: 3_000 })
    await chat(`${p}-b`, alice)
    await chat(`${p}-c`, alice)
    await chat(`${p}-d`, alice, { deleted: true })
    await chat(`${p}-e`, bob, { lastAt: 9_000 })
    const one = await list(me(alice), '?limit=2')
    expect(one).toMatchObject({ status: 200, objects: [{ ownerId: alice }] })
    expect(one.body.items).toEqual([summary(`${p}-a`, { at: 3_000 }), summary(`${p}-c`)])
    const two = await list(me(alice), `?limit=2&cursor=${one.body.nextCursor as string}`)
    expect(two.body).toEqual({ items: [summary(`${p}-b`)], nextCursor: null })
    expect(ids(await list(me(alice), '?deleted=true'))).toEqual([`${p}-d`])
    expect(ids(await list(me(alice), '?deleted=false'))).toEqual([`${p}-a`, `${p}-c`, `${p}-b`])
    expect(ids(await list(me(bob)))).toEqual([`${p}-e`])
  })

  it('Inhouse under a grant lists every member\'s chats without naming an owner', async () => {
    const p = `c-${uniq()}`
    // Far ahead of every other test's chats, so the first page is these.
    await chat(`${p}-a`, alice, { lastAt: 8_000_000_000_000_001 })
    await chat(`${p}-b`, bob, { lastAt: 8_000_000_000_000_000 })
    const r = await list(inhouse(), '?limit=2')
    expect(r).toMatchObject({ status: 200, objects: [] })
    expect(ids(r)).toEqual([`${p}-a`, `${p}-b`])
  })

  it('smoke lists only its own chats', async () => {
    const p = `c-${uniq()}`
    await chat(`${p}-s`, 'm_smoke', { lastAt: 8_100_000_000_000_000 })
    await chat(`${p}-a`, alice, { lastAt: 8_200_000_000_000_000 })
    const r = await list(smoke, '?limit=1')
    expect(r).toMatchObject({ status: 200, objects: [{ ownerId: 'm_smoke' }] })
    expect(ids(r)).toEqual([`${p}-s`])
  })

  it('a bad cursor, a limit out of range, an unknown parameter or deleted=maybe is 400', async () => {
    for (const q of ['?cursor=AAAA', '?limit=0', '?limit=101', '?sort=id', '?deleted=maybe']) {
      expect((await list(me(alice), q)).body, q).toEqual({ error: { code: 'invalid' } })
    }
  })
})

describe('route 24: one chat and its history (failures 1, 2, 7)', () => {
  /** A turn id of the contract's shape (`t_` and 22), one per chat and number. */
  const tid = (chatId: string, k: number) => `t_${`${chatId.replace(/[^A-Za-z0-9]/g, '')}x${k}`.padEnd(22, 'x').slice(-22)}`
  const RUN = `r_${'a'.repeat(22)}`
  const insertMessages = async (chatId: string, count: number) => {
    const rows = []
    for (let pos = 0; pos < count; pos++) {
      const turn = tid(chatId, Math.floor(pos / 2))
      rows.push(pos % 2 === 0
        ? db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, author_id, text, extra_json, at_ms) VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, ?)")
          .bind(`${turn}.u`, chatId, RUN, turn, pos, alice, `q${pos}`, pos === 0 ? JSON.stringify({ quote: 'earlier', attachments: [{ fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA', name: 'a.pdf' }] }) : null, 10_000 + pos)
        : db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, text, part_json, extra_json, model, at_ms) VALUES (?, ?, ?, ?, ?, 'agent', ?, ?, ?, 'sonnet', ?)")
          .bind(`${turn}.0`, chatId, RUN, turn, pos, `a${pos}`, JSON.stringify({ type: 'text', text: `a${pos}` }), JSON.stringify({ trace: turn }), 10_000 + pos))
    }
    await db.batch(rows)
  }

  it('the owner reads pages of 50, newest first, then the rest; stored messages as the contract has them', async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    await insertMessages(id, 52)
    const one = await get(me(alice), id)
    expect(one.status).toBe(200)
    expect(one.objects).toEqual([{ ownerId: alice }])
    const page = ChatPageSchema.parse(one.body)
    expect(page.chat).toEqual(summary(id))
    expect(page.runs).toEqual([])
    expect(page.messages.map(m => m.pos)).toEqual(Array.from({ length: 50 }, (_, i) => 51 - i))
    const t25 = tid(id, 25)
    expect(one.body.messages).toContainEqual({ id: `${t25}.0`, role: 'agent', part: { type: 'text', text: 'a51' }, trace: t25, model: 'sonnet', turnId: t25, runId: RUN, pos: 51, at: instant(10_051) })
    const two = await get(me(alice), id, `?cursor=${page.nextCursor!}`)
    const t0 = tid(id, 0)
    expect(two.body.nextCursor).toBeNull()
    expect(two.body.messages).toEqual([
      { id: `${t0}.0`, role: 'agent', part: { type: 'text', text: 'a1' }, trace: t0, model: 'sonnet', turnId: t0, runId: RUN, pos: 1, at: instant(10_001) },
      { id: `${t0}.u`, role: 'user', text: 'q0', quote: 'earlier', atts: [{ name: 'a.pdf', meta: '', icon: 'description' }], turnId: t0, runId: RUN, pos: 0, at: instant(10_000) },
    ])
  })

  it('another member and an Admin get 404 before the object check; Inhouse under a grant reads it; a deleted chat still reads', async () => {
    const id = `c-${uniq()}`
    await chat(id, alice, { deleted: true })
    for (const p of [me(bob), me(admin, 'admin')]) expect(await get(p, id)).toMatchObject({ status: 404, objects: [] })
    expect(await get(me(alice), 'c-none')).toMatchObject({ status: 404, objects: [] })
    expect(await get(me(alice), 'bad id!')).toMatchObject({ status: 404, objects: [] })
    const ih = await get(inhouse(), id)
    expect(ih).toMatchObject({ status: 200, objects: [] })
    expect(ih.body.chat).toEqual(summary(id, { deleted: true }))
    expect((await get(me(alice), id, '?cursor=AAAA')).status).toBe(400)
  })

  it('smoke reads its own chat; another member\'s is 404 before the object check', async () => {
    const id = `c-${uniq()}`
    await chat(id, 'm_smoke')
    await chat(`${id}-a`, alice)
    expect(await get(smoke, id)).toMatchObject({ status: 200, objects: [{ ownerId: 'm_smoke' }] })
    expect(await get(smoke, `${id}-a`)).toMatchObject({ status: 404, objects: [] })
  })

  it("a turn whose flush lands between getChat's two reads is still in the page (runs, then history)", async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    const tag = uniq().replace(/[^A-Za-z0-9]/g, '').padEnd(22, 'q').slice(0, 22)
    const runId = `r_${tag}`
    const turnId = `t_${tag}`
    // An ended run whose one turn's rows aren't in D1 yet (the BrandAgent's state after a failed flush).
    await runInDurableObject(brandAgent(env), (_i, s) => {
      s.storage.sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, last_seq, started_at_ms, ended_at_ms) VALUES (?, ?, ?, 'ended', 2, 1000, 2000)", runId, id, alice)
      s.storage.sql.exec(`INSERT INTO turns (turn_id, run_id, chat_id, owner_id, ord, client_key, payload_hash, state, priority, text,
        attachments_json, model, picker_id, side_model, effort, max_turns, answer_position, created_at_ms, d1_flushed)
        VALUES (?, ?, ?, ?, 0, ?, 'h', 'cancelled', 'next', 'q', '[]', 'm', 'sonnet', 'm', 'medium', 25, 'queued', 1000, 0)`, turnId, runId, id, alice, `k${tag}`)
    })
    // The flush lands once, when the second of the two reads starts.
    let asked = false
    const land = async () => {
      await db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, author_id, text, at_ms) VALUES (?, ?, ?, ?, 0, 'user', ?, 'q', 1000)")
        .bind(`${turnId}.u`, id, runId, turnId, alice).run()
      await runInDurableObject(brandAgent(env), (_i, s) => { s.storage.sql.exec('UPDATE turns SET d1_flushed = 1 WHERE turn_id = ?', turnId) })
    }
    const e = agentEnv({ chatRuns: async ids => { asked = true; return brandAgent(env).chatRuns(ids) } })
    const s: Stores = { ...stores, chats: { ...stores.chats, messages: async (chatId, before, limit) => {
      if (asked) { await land(); return stores.chats.messages(chatId, before, limit) }
      const rows = await stores.chats.messages(chatId, before, limit)
      await land()
      return rows
    } } }
    const page = await call(getChat, me(alice), { path: `/api/chats/${id}`, params: { id } }, s, e)
    expect(page.body.runs).toEqual([{ runId, chatId: id, lastSeq: 2, live: false }])
    expect((page.body.messages as { id: string }[]).map(m => m.id)).toEqual([`${turnId}.u`])
  })
})

describe('route 23: create (failure 5)', () => {
  const create = (p: Principal, body: unknown, s: Stores = stores) => call(createChat, p, { method: 'POST', path: '/api/chats', body }, s)

  it('saves the chat for its owner, answers the same chat again, and another person\'s id is 404', async () => {
    const id = `c-${uniq()}`
    const first = await create(me(alice), { id, title: 'Plan' })
    expect(first).toMatchObject({ status: 200, objects: [{ ownerId: alice }] })
    expect(first.body).toEqual(summary(id, { title: 'Plan', at: NOW }))
    expect((await create(me(alice), { id, title: 'Other' })).body).toEqual(summary(id, { title: 'Plan', at: NOW }))
    expect(await create(me(bob), { id, title: 'Mine' })).toMatchObject({ status: 404, objects: [] })
    expect(await db.prepare('SELECT owner_id, title, created_at_ms, last_at_ms, rev FROM chats WHERE id = ?').bind(id).all().then(r => r.results))
      .toEqual([{ owner_id: alice, title: 'Plan', created_at_ms: NOW, last_at_ms: NOW, rev: 1 }])
    expect((await create(me(alice), {})).status).toBe(400)
    expect((await create(me(alice), { id: 'bad id!', title: 'x' })).status).toBe(400)
    expect((await create(smoke, { id: `${id}-s`, title: 'Smoke' })).objects).toEqual([{ ownerId: 'm_smoke' }])
  })

  it('a failed save throws the storage error and leaves no row; a lost reply\'s retry answers the one saved chat', async () => {
    const id = `c-${uniq()}`
    const broken = { ...stores, chats: chatStore({ db: { prepare: (q: string) => db.prepare(q.replace('INSERT INTO chats', 'INSERT INTO chats_missing')), batch: (s: D1PreparedStatement[]) => db.batch(s) } as unknown as D1Database }) }
    await expect(create(me(alice), { id, title: 'Plan' }, broken)).rejects.toBeInstanceOf(StoreUnavailableError)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM chats WHERE id = ?').bind(id).first('n')).toBe(0)
    let lost = true
    const lossy = { ...stores, chats: chatStore({ db: { prepare: (q: string) => db.prepare(q), batch: async (s: D1PreparedStatement[]) => { const r = await db.batch(s); if (lost) { lost = false; throw new Error('Network connection lost.') } return r } } as unknown as D1Database }) }
    await expect(create(me(alice), { id, title: 'Plan' }, lossy)).rejects.toBeInstanceOf(StoreUnavailableError)
    expect((await create(me(alice), { id, title: 'Plan' }, lossy)).body).toEqual(summary(id, { title: 'Plan', at: NOW }))
    expect(await db.prepare('SELECT COUNT(*) AS n FROM chats WHERE id = ?').bind(id).first('n')).toBe(1)
  })
})

describe('routes 25 and 26: rename and pin with ifRev (failures 1 and 3)', () => {
  const rename = (p: Principal, id: string, body: unknown) => call(renameChat, p, { method: 'PUT', path: `/api/chats/${id}/title`, params: { id }, body })
  const pin = (p: Principal, id: string, body: unknown) => call(pinChat, p, { method: 'PUT', path: `/api/chats/${id}/pin`, params: { id }, body })

  it('rename and back, pin and unpin, each moving rev; a stale ifRev is 409 with the chat as it is', async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    expect(await rename(me(alice), id, { title: 'New', ifRev: 1 })).toMatchObject({ status: 200, body: summary(id, { customTitle: 'New', rev: 2 }), objects: [{ ownerId: alice }] })
    expect((await rename(me(alice), id, { title: null, ifRev: 2 })).body).toEqual(summary(id, { rev: 3 }))
    expect((await pin(me(alice), id, { pinned: true, ifRev: 3 })).body).toEqual(summary(id, { pinned: true, rev: 4 }))
    expect(await rename(me(alice), id, { title: 'Stale', ifRev: 3 })).toMatchObject({ status: 409, body: { error: { code: 'conflict', current: summary(id, { pinned: true, rev: 4 }) } } })
    expect(await pin(me(alice), id, { pinned: false, ifRev: 1 })).toMatchObject({ status: 409, body: { error: { code: 'conflict', current: summary(id, { pinned: true, rev: 4 }) } } })
    expect((await pin(me(alice), id, { pinned: false, ifRev: 4 })).body).toEqual(summary(id, { rev: 5 }))
  })

  it('another member, an Admin or no chat is 404 before the object check and changes nothing; a bad body is 400', async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    for (const p of [me(bob), me(admin, 'admin')]) {
      expect(await rename(p, id, { title: 'Mine', ifRev: 1 })).toMatchObject({ status: 404, objects: [] })
      expect(await pin(p, id, { pinned: true, ifRev: 1 })).toMatchObject({ status: 404, objects: [] })
    }
    expect((await rename(me(alice), 'c-none', { title: 'x', ifRev: 1 })).status).toBe(404)
    expect((await rename(me(alice), id, { title: '', ifRev: 1 })).status).toBe(400)
    expect((await pin(me(alice), id, { pinned: 'yes', ifRev: 1 })).status).toBe(400)
    expect(await db.prepare('SELECT custom_title, pinned, rev FROM chats WHERE id = ?').bind(id).first()).toEqual({ custom_title: null, pinned: 0, rev: 1 })
  })
})

describe('routes 27 and 28: delete and restore, all or nothing (failures 4 and 6)', () => {
  const del = (p: Principal, body: unknown) => call(deleteChats, p, { method: 'POST', path: '/api/chats/delete', body })
  const restore = (p: Principal, body: unknown) => call(restoreChats, p, { method: 'POST', path: '/api/chats/restore', body })
  const deletedCount = async (chatIds: string[]) =>
    db.prepare(`SELECT COUNT(*) AS n FROM chats WHERE deleted_at_ms IS NOT NULL AND id IN (${chatIds.map(() => '?').join(', ')})`).bind(...chatIds).first('n')

  it('50 of the caller\'s chats delete and restore together; one of someone else\'s among them changes nothing', async () => {
    const p = `c-${uniq()}`
    const mine = Array.from({ length: 50 }, (_, i) => `${p}-${i}`)
    for (const id of mine) await chat(id, alice)
    await chat(`${p}-bob`, bob)
    const mixed = [...mine.slice(0, 49), `${p}-bob`]
    expect(await del(me(alice), { ids: mixed })).toMatchObject({ status: 404, objects: [] })
    expect(await del(me(alice), { ids: [...mine.slice(0, 49), `${p}-none`] })).toMatchObject({ status: 404, objects: [] })
    expect(await deletedCount([...mine, `${p}-bob`])).toBe(0)
    expect((await del(me(alice), { ids: [...mine, `${p}-50`] })).status).toBe(400)
    const done = await del(me(alice), { ids: mine })
    expect(done).toMatchObject({ status: 200, objects: [{ ownerId: alice }] })
    expect(done.body.items).toEqual(mine.map(id => summary(id, { deleted: true, rev: 2 })))
    expect(await deletedCount(mine)).toBe(50)
    expect(await restore(me(alice), { ids: [mine[0], `${p}-bob`] })).toMatchObject({ status: 404, objects: [] })
    expect(await deletedCount(mine)).toBe(50)
    expect(await restore(me(admin, 'admin'), { ids: [mine[0]] })).toMatchObject({ status: 404, objects: [] })
    const back = await restore(me(alice), { ids: mine })
    expect(back.body.items).toEqual(mine.map(id => summary(id, { rev: 3 })))
    expect(await deletedCount(mine)).toBe(0)
    // A repeat changes nothing (no rev moves).
    expect(((await restore(me(alice), { ids: [mine[0]] })).body.items as unknown[])).toEqual([summary(mine[0], { rev: 3 })])
  })

  it('a delete stops the chat\'s running turn and cancels its queued one in the BrandAgent; getChat follows the live run', async () => {
    await db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 's:cap', ?, 1, ?, ?, 'r')").bind(JSON.stringify('$320'), NOW, admin).run()
    const id = `c-${uniq()}`
    await chat(id, alice)
    const send = (key: string) => call(sendPriced, me(alice), { method: 'POST', path: `/api/chats/${id}/turns`, params: { id }, body: { clientTurnKey: key, text: 'hi', model: 'sonnet' } })
    const first = await send(`key${uniq()}`)
    const second = await send(`key${uniq()}`)
    expect(second.body.position).toBe('queued')
    const page = await get(me(alice), id)
    expect(page.body.runs).toEqual([expect.objectContaining({ runId: first.body.runId, chatId: id, live: true })])
    expect((page.body.chat as { running: boolean }).running).toBe(true)
    expect((await del(me(alice), { ids: [id] })).status).toBe(200)
    const rows = await runInDurableObject(brandAgent(env), (_i, s) => s.storage.sql.exec(
      'SELECT turn_id, state, outcome, cancel_why, fenced FROM turns WHERE chat_id = ? ORDER BY ord', id).toArray().map(r => ({ ...r })))
    expect(rows).toEqual([
      expect.objectContaining({ turn_id: first.body.turnId, cancel_why: 'deleted' }),
      { turn_id: second.body.turnId, state: 'cancelled', outcome: null, cancel_why: 'deleted', fenced: 0 },
    ])
    expect(['ending', 'cancelled']).toContain(rows[0].state)
  })

  it('a send that read the chat before the delete committed is refused 404 by the BrandAgent; after a restore it is admitted (failure 8)', async () => {
    await db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 's:cap', ?, 1, ?, ?, 'r')").bind(JSON.stringify('$320'), NOW, admin).run()
    const id = `c-${uniq()}`
    await chat(id, alice)
    // The barrier: route 29's owner read returns (the chat not deleted), then waits until the delete is done.
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    let read!: () => void
    const readDone = new Promise<void>(r => { read = r })
    const slow: Stores = { ...stores, chats: { ...stores.chats, ownerOf: async chatId => { const o = await stores.chats.ownerOf(chatId); read(); await held; return o } } }
    const key = `key${uniq()}`
    const body = { clientTurnKey: key, text: 'hi', model: 'sonnet' }
    const late = call(sendPriced, me(alice), { method: 'POST', path: `/api/chats/${id}/turns`, params: { id }, body }, slow)
    await readDone
    expect((await del(me(alice), { ids: [id] })).status).toBe(200)
    release()
    expect(await late).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } })
    const turns = () => runInDurableObject(brandAgent(env), (_i, s) => s.storage.sql.exec('SELECT COUNT(*) AS n FROM turns WHERE chat_id = ?', id).one().n)
    expect(await turns()).toBe(0)
    expect((await restore(me(alice), { ids: [id] })).status).toBe(200)
    const again = await call(sendPriced, me(alice), { method: 'POST', path: `/api/chats/${id}/turns`, params: { id }, body })
    expect(again).toMatchObject({ status: 200, body: { position: 'starting' } })
    expect(await turns()).toBe(1)
  })

  it("a delete whose BrandAgent call stalls past a restore doesn't undo the restore: sends are admitted", async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    let stalled!: () => void
    const reached = new Promise<void>(r => { stalled = r })
    let go!: () => void
    const gate = new Promise<void>(r => { go = r })
    const slow = agentEnv({ endChats: async c => { stalled(); await gate; await brandAgent(env).endChats(c) } })
    const deleting = call(deleteChats, me(alice), { method: 'POST', path: '/api/chats/delete', body: { ids: [id] } }, stores, slow)
    await reached
    expect((await restore(me(alice), { ids: [id] })).status).toBe(200)
    go()
    expect((await deleting).status).toBe(200)
    const sent = await call(sendPriced, me(alice), { method: 'POST', path: `/api/chats/${id}/turns`, params: { id }, body: { clientTurnKey: `key${uniq()}`, text: 'hi', model: 'sonnet' } })
    expect(sent.status).toBe(200)
  })

  it('a restore whose BrandAgent call fails leaves the chat deleted in D1 (the restore can be retried)', async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    expect((await del(me(alice), { ids: [id] })).status).toBe(200)
    const failing = agentEnv({ restoreChats: async () => { throw new Error('BrandAgent unreachable') } })
    await expect(call(restoreChats, me(alice), { method: 'POST', path: '/api/chats/restore', body: { ids: [id] } }, stores, failing)).rejects.toThrow('BrandAgent unreachable')
    expect(await deletedCount([id])).toBe(1)
    expect((await restore(me(alice), { ids: [id] })).body.items).toEqual([summary(id, { rev: 3 })])
  })

  it('a delete whose BrandAgent call fails answers an error; its retry ends with sends refused', async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    const failing = agentEnv({ endChats: async () => { throw new Error('BrandAgent unreachable') } })
    await expect(call(deleteChats, me(alice), { method: 'POST', path: '/api/chats/delete', body: { ids: [id] } }, stores, failing)).rejects.toThrow('BrandAgent unreachable')
    expect(await deletedCount([id])).toBe(1)
    expect((await del(me(alice), { ids: [id] })).status).toBe(200)
    // Straight to the BrandAgent (route 29 would refuse from D1 first): the chat is refused there too.
    const answer = await brandAgent(env).submitTurn({
      chatId: id, by: { kind: 'person', memberId: alice }, model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium', sideModel: 'claude-haiku-5-5',
      maxTurns: 25, webFetchDomains: null, input: { clientTurnKey: `key${uniq()}`, text: 'hi', priority: 'next', model: 'sonnet', attachments: [] },
    })
    expect(answer).toEqual({ refused: { code: 'not_found' } })
  })

  /** A send straight to the BrandAgent (route 29 would refuse from D1 first): what the object itself says. */
  const agentSend = (id: string) => brandAgent(env).submitTurn({
    chatId: id, by: { kind: 'person', memberId: alice }, model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium', sideModel: 'claude-haiku-5-5',
    maxTurns: 25, webFetchDomains: null, input: { clientTurnKey: `key${uniq()}`, text: 'hi', priority: 'next', model: 'sonnet', attachments: [] },
  })
  /** Stores whose `statesOf` runs `between` after its read, before the handler goes on (a request landing in the gap). */
  const readThen = (between: () => Promise<void>): Stores => ({ ...stores, chats: { ...stores.chats, statesOf: async ids => { const r = await stores.chats.statesOf(ids); await between(); return r } } })

  it("a restore landing between a delete's D1 write and its BrandAgent call wins: D1 and the BrandAgent agree, sends are admitted (round 2, 1)", async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    let fired = false
    const gap: Stores = { ...stores, chats: chatStore({ db: { prepare: (q: string) => db.prepare(q), batch: async (b: D1PreparedStatement[]) => {
      const r = await db.batch(b)
      if (!fired) { fired = true; expect((await restore(me(alice), { ids: [id] })).status).toBe(200) }
      return r
    } } as unknown as D1Database }) }
    const done = await call(deleteChats, me(alice), { method: 'POST', path: '/api/chats/delete', body: { ids: [id] } }, gap)
    // The delete answers the chat as its own write left it.
    expect(done.body.items).toEqual([summary(id, { deleted: true, rev: 2 })])
    expect(await deletedCount([id])).toBe(0)
    expect(await agentSend(id)).toMatchObject({ position: expect.any(String) })
  })

  it('a restore that read the chat live does nothing, so a delete landing after its read stays (round 2, 2)', async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    const late = readThen(async () => { expect((await del(me(alice), { ids: [id] })).status).toBe(200) })
    expect((await call(restoreChats, me(alice), { method: 'POST', path: '/api/chats/restore', body: { ids: [id] } }, late)).status).toBe(200)
    expect(await deletedCount([id])).toBe(1)
    expect(await agentSend(id)).toEqual({ refused: { code: 'not_found' } })
  })

  it('a restore whose read went stale (another restore, then a delete) answers 409 and flips nothing (round 2, 2)', async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    expect((await del(me(alice), { ids: [id] })).status).toBe(200)
    const late = readThen(async () => {
      expect((await restore(me(alice), { ids: [id] })).status).toBe(200)
      expect((await del(me(alice), { ids: [id] })).status).toBe(200)
    })
    const r = await call(restoreChats, me(alice), { method: 'POST', path: '/api/chats/restore', body: { ids: [id] } }, late)
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } })
    expect(await deletedCount([id])).toBe(1)
    expect(await db.prepare('SELECT rev FROM chats WHERE id = ?').bind(id).first('rev')).toBe(4)
    expect(await agentSend(id)).toEqual({ refused: { code: 'not_found' } })
  })

  it("a restore whose BrandAgent call landed but whose D1 write failed heals on retry (the BrandAgent skips the equal rev)", async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    expect((await del(me(alice), { ids: [id] })).status).toBe(200)
    let failOnce = true
    const flaky: Stores = { ...stores, chats: chatStore({ db: { prepare: (q: string) => db.prepare(q), batch: async (b: D1PreparedStatement[]) => {
      if (failOnce) { failOnce = false; throw new Error('D1_ERROR: scripted failure') }
      return db.batch(b)
    } } as unknown as D1Database }) }
    await expect(call(restoreChats, me(alice), { method: 'POST', path: '/api/chats/restore', body: { ids: [id] } }, flaky)).rejects.toBeInstanceOf(StoreUnavailableError)
    expect(await deletedCount([id])).toBe(1)
    expect((await restore(me(alice), { ids: [id] })).body.items).toEqual([summary(id, { rev: 3 })])
    expect(await agentSend(id)).toMatchObject({ position: expect.any(String) })
  })
})
