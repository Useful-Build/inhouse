// Routes 29-31, 35-37 and 49 (p3-design 3, 4.3, 4.7, 4.9, 4.11) through their handlers, on the real migrations and the
// real BrandAgent (its ports are compose.ts's fakes until W2, W3 and W4 fill them). Expected values are literals. Ways
// they can fail, written down first:
//  1. another person's chat or turn answers anything but 404, or reaches `requireObject` (a caught refusal is a 403);
//  2. a deleted chat, a bad body, an unknown model or a model switched off or unpriced is admitted;
//  3. the turn runs with settings other than the brand's: model, effort, side model, `maxTurns`, WebFetch's hosts;
//  4. a pause or resume writes no line, or a line by someone else; resume starts anything;
//  5. a run token on `/api/*` authorises anything (no handler or auth file reads it).
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CATALOG } from '../model/catalog.ts'
import type { CatalogModel } from '../model/catalog.ts'
import { openStores } from '../db/stores.ts'
import { ctx, lastLineId, person, personPrincipal, reset } from '../db/test-support.ts'
import type { HandlerContext } from '../routes.ts'
import type { Principal } from '../auth/index.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import { interruptTurn, sendTurnWith, stopTurn } from './runs.ts'
import { getPause, pauseAgent, resumeAgent } from './pause.ts'
import { resetSession } from './chats.ts'

const db = env.DB
const stores = openStores(env)
const T = 1_800_000_000_000
let u = 0
const uniq = () => `${++u}-${Math.random().toString(36).slice(2, 7)}`

/** The shipped catalogue with a price on every model (W3 fills the real ones). */
const PRICED: CatalogModel[] = CATALOG.map(m => ({
  ...m, price: { tiers: [{ uptoInputTokens: null, input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1 }], fastModeMultiplier: null, geoMultipliers: {}, webSearchPerUse: 1 },
}))
const sendPriced = sendTurnWith(PRICED)
const sendShipped = sendTurnWith(CATALOG)

let alice: string
let bob: string
let admin: string
beforeEach(async () => {
  await reset(db)
  alice = await person(stores, { email: `a-${uniq()}@example.test`, subject: `sa-${uniq()}`, role: 'member' })
  bob = await person(stores, { email: `b-${uniq()}@example.test`, subject: `sb-${uniq()}`, role: 'member' })
  admin = await person(stores, { email: `d-${uniq()}@example.test`, subject: `sd-${uniq()}`, role: 'admin' })
})
afterEach(async () => {
  await brandAgent(env).resume({ kind: 'person', memberId: admin })
})

const chat = async (id: string, owner: string, deleted = false) =>
  db.prepare('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms, deleted_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, owner, 'A chat', T, T, deleted ? T : null).run()
const setting = (key: string, value: string) =>
  db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', ?, ?, 1, ?, ?, 'r')")
    .bind(key, JSON.stringify(value), T, admin).run()

const call = async (h: (c: HandlerContext) => Promise<Response>, principal: Principal, init: { method?: string; path: string; body?: unknown; params?: Record<string, string> }) => {
  const { c, objects } = ctx(stores, principal, init)
  const res = await h({ ...c, env, ctx: {} as ExecutionContext } as HandlerContext)
  return { status: res.status, body: await res.json() as Record<string, unknown>, objects }
}
const send = (h: typeof sendPriced, who: string, chatId: string, body: unknown) =>
  call(h, personPrincipal(who, 'member'), { method: 'POST', path: `/api/chats/${chatId}/turns`, params: { id: chatId }, body })
const turnRow = (turnId: string) => runInDurableObject(brandAgent(env), (_i, s) =>
  ({ ...s.storage.sql.exec('SELECT model, picker_id, effort, side_model, max_turns, web_fetch_json, state FROM turns WHERE turn_id = ?', turnId).one() }))
const key = () => `key-${uniq().replace(/[^A-Za-z0-9]/g, '')}`

describe('route 29: send a turn', () => {
  it("another person's chat is 404 and never reaches the object check (failure 1)", async () => {
    await chat(`c-${u}-bob`, bob)
    const r = await send(sendPriced, alice, `c-${u}-bob`, { clientTurnKey: key(), text: 'hi', model: 'sonnet' })
    expect(r.status).toBe(404)
    expect(r.objects).toEqual([])
  })

  it('a deleted chat, a bad body and an unknown model are refused (failure 2)', async () => {
    const id = `c-${uniq()}`
    await chat(id, alice, true)
    expect((await send(sendPriced, alice, id, { clientTurnKey: key(), text: 'hi', model: 'sonnet' })).status).toBe(404)
    const live = `c-${uniq()}`
    await chat(live, alice)
    expect((await send(sendPriced, alice, live, { text: 'no key', model: 'sonnet' })).body).toEqual({ error: { code: 'invalid' } })
    expect((await send(sendPriced, alice, live, { clientTurnKey: key(), text: 'hi', model: 'gpt' })).body).toEqual({ error: { code: 'invalid' } })
  })

  it('the same attachment twice is 400 invalid at the send, before admission (failure 2)', async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    const att = { fileId: 'f_AAAAAAAAAAAAAAAAAAAAAA', name: 'a.pdf' }
    const r = await send(sendPriced, alice, id, { clientTurnKey: key(), text: 'hi', model: 'sonnet', attachments: [att, { ...att, name: 'b.pdf' }] })
    expect(r).toMatchObject({ status: 400, body: { error: { code: 'invalid' } }, objects: [] })
  })

  it('an unpriced model, or one switched off, is model_off (failure 2)', async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    expect(await send(sendShipped, alice, id, { clientTurnKey: key(), text: 'hi', model: 'sonnet' })).toMatchObject({ status: 403, body: { error: { code: 'forbidden', reason: 'model_off' } } })
    await setting('tm:opus:on', 'off')
    expect(await send(sendPriced, alice, id, { clientTurnKey: key(), text: 'hi', model: 'opus' })).toMatchObject({ status: 403, body: { error: { code: 'forbidden', reason: 'model_off' } } })
  })

  it("the turn runs on the brand's settings (failure 3)", async () => {
    await setting('tm:sonnet:effort', 'High')
    await setting('t:max_turns', '50')
    await setting('t:webfetch', 'docs.example.test\nshop.example.test')
    const id = `c-${uniq()}`
    await chat(id, alice)
    const r = await send(sendPriced, alice, id, { clientTurnKey: key(), text: 'hi', model: 'sonnet' })
    expect(r.status).toBe(200)
    expect(r.objects).toEqual([{ ownerId: alice }])
    expect(r.body).toMatchObject({ position: 'starting' })
    expect(await turnRow(r.body.turnId as string)).toMatchObject({
      model: 'claude-sonnet-5-5', picker_id: 'sonnet', effort: 'high', side_model: 'claude-haiku-5-5', max_turns: 50,
      web_fetch_json: '["docs.example.test","shop.example.test"]',
    })
  })

  it('an empty t:webfetch is any public host (null), and the default maxTurns is 25', async () => {
    await setting('t:webfetch', '')
    const id = `c-${uniq()}`
    await chat(id, alice)
    const r = await send(sendPriced, alice, id, { clientTurnKey: key(), text: 'hi', model: 'haiku' })
    expect(await turnRow(r.body.turnId as string)).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low', max_turns: 25, web_fetch_json: null })
  })
})

describe('routes 30 and 31: interrupt and stop', () => {
  it("another person's turn is 404 before the object check; one's own acts; a malformed id is 404", async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    const sent = await send(sendPriced, alice, id, { clientTurnKey: key(), text: 'hi', model: 'sonnet' })
    const turnId = sent.body.turnId as string
    const asBob = await call(stopTurn, personPrincipal(bob, 'member'), { method: 'POST', path: `/api/turns/${turnId}/stop`, params: { turnId } })
    expect(asBob.status).toBe(404)
    expect(asBob.objects).toEqual([])
    expect((await call(interruptTurn, personPrincipal(alice, 'member'), { method: 'POST', path: '/api/turns/t1/interrupt', params: { turnId: 't1' } })).status).toBe(404)
    const own = await call(stopTurn, personPrincipal(alice, 'member'), { method: 'POST', path: `/api/turns/${turnId}/stop`, params: { turnId } })
    expect(own).toMatchObject({ status: 200, body: { ok: true }, objects: [{ ownerId: alice }] })
    const again = await call(stopTurn, personPrincipal(alice, 'member'), { method: 'POST', path: `/api/turns/${turnId}/stop`, params: { turnId } })
    expect(again.body).toEqual({ error: { code: 'conflict', reason: 'turn_ended' } })
  })
})

describe('routes 35-37: pause and resume (failure 4)', () => {
  let mark = 0
  beforeEach(async () => { mark = await lastLineId(db) })
  const lines = async () => (await db.prepare("SELECT actor_id, action FROM audit_log WHERE id > ? AND action IN ('agent.paused', 'agent.resumed') ORDER BY id").bind(mark).all()).results

  it('an Admin pauses and resumes, each with its line; a send while paused is refused', async () => {
    const p = await call(pauseAgent, personPrincipal(admin, 'admin'), { method: 'POST', path: '/api/pause', body: {} })
    expect(p).toMatchObject({ status: 200, body: { paused: true, by: admin } })
    const id = `c-${uniq()}`
    await chat(id, alice)
    expect((await send(sendPriced, alice, id, { clientTurnKey: key(), text: 'hi', model: 'sonnet' })).body).toEqual({ error: { code: 'forbidden', reason: 'paused' } })
    expect((await call(getPause, personPrincipal(alice, 'member'), { path: '/api/pause' })).body).toMatchObject({ paused: true })
    const r = await call(resumeAgent, personPrincipal(admin, 'admin'), { method: 'POST', path: '/api/resume', body: {} })
    expect(r).toMatchObject({ status: 200, body: { paused: false, at: null, by: null } })
    expect(await lines()).toEqual([{ actor_id: admin, action: 'agent.paused' }, { actor_id: admin, action: 'agent.resumed' }])
  })

  it('an Inhouse emergency pause is audited with the Inhouse member as the actor (item 19)', async () => {
    const inhouse: Principal = { kind: 'inhouse', memberId: admin, subject: 'sub-ih', grant: null, requestId: 'req-ih', expMs: 4_102_444_800_000 }
    expect((await call(pauseAgent, inhouse, { method: 'POST', path: '/api/pause', body: {} })).body).toMatchObject({ paused: true, by: admin })
    expect(await lines()).toEqual([{ actor_id: admin, action: 'agent.paused' }])
  })

  it('a body is refused', async () => {
    expect((await call(pauseAgent, personPrincipal(admin, 'admin'), { method: 'POST', path: '/api/pause', body: { paused: true } })).status).toBe(400)
    expect(await lines()).toEqual([])
  })
})

describe('route 49: session reset', () => {
  it("another person's chat is 404 before the object check; one's own resets", async () => {
    const id = `c-${uniq()}`
    await chat(id, alice)
    const asBob = await call(resetSession, personPrincipal(bob, 'member'), { method: 'POST', path: `/api/chats/${id}/session/reset`, params: { id } })
    expect(asBob).toMatchObject({ status: 404, objects: [] })
    const own = await call(resetSession, personPrincipal(alice, 'member'), { method: 'POST', path: `/api/chats/${id}/session/reset`, params: { id } })
    expect(own).toMatchObject({ status: 200, body: { ok: true }, objects: [{ ownerId: alice }] })
  })
})

describe('a run token never authorises /api/* (failure 5)', () => {
  it('no API handler or auth file reads x-inhouse-run-token', () => {
    const sources = import.meta.glob(['../api/*.ts', '../auth/*.ts', '../api.ts', '../index.ts', '!../**/*.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    expect(Object.keys(sources).length).toBeGreaterThan(10)
    for (const [file, text] of Object.entries(sources)) expect(text.toLowerCase(), file).not.toContain('x-inhouse-run-token')
  })
})
