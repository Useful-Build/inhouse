// The real client's chat, model, usage and pause parts over a fake `fetch` (P3 W5 PR 2). Ways they could break what a
// person sees, written down before the tests:
//  - a chat write that sends no `ifRev`, sends a stale one, or leaves its change on screen after a refusal;
//  - a chat's title, pin or delete that the snapshot doesn't carry the way the UI reads it (`chatTitles`, `chatPinned`,
//    `chatDeleted`), or a deleted chat that is lost instead of kept for Undo;
//  - a send that leaves before the chat's own save, that mints a new key on retry, or whose refusal loses its reason;
//  - a model switched off that vanishes from the Models page (it must stay, off), or one that route 38 doesn't serve showing as on;
//  - the pause state that disagrees with the server after a refused pause, or a Member's pause that isn't refused;
//  - the cap that isn't re-read after its save, or a spending page that keeps an old total after a turn ends;
//  - route 32 (the run replay) not asked for once #163 is in, or asked for before the chats it names are known.
import { describe, expect, test } from 'vitest'
import type { AgentNotice } from '../types'
import { AgentError } from '../types'
import { HttpAgent } from './client'
import { ALL_MODELS, ME_ID, chatRow, iso, me, reads, record, refusal, server, usage } from './testing/fake-server'
import type { Routes } from './testing/fake-server'

const TURN = 't_AAAAAAAAAAAAAAAAAAAAAA'
const RUN = 'r_AAAAAAAAAAAAAAAAAAAAAA'
const errorOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => 'resolved', (e: unknown) => e)

async function loaded(routes: Routes, opts: ConstructorParameters<typeof HttpAgent>[0] = {}) {
  const s = server(routes)
  const agent = new HttpAgent({ fetch: s.fetch, now: () => 5000, ...opts })
  const heard: AgentNotice[] = []
  agent.onNotice(n => heard.push(n))
  await agent.whenLoaded()
  return { agent, heard, ...s }
}
const json = (r: { body: string | undefined }) => JSON.parse(r.body!)

describe('the chat list', () => {
  test('reads the first page on start (newest first) and puts titles, pins and deletes where the UI reads them', async () => {
    const { agent } = await loaded(reads({ chats: [
      chatRow('c_new', { at: iso(3000), customTitle: 'My title', title: 'My title', pinned: true }),
      chatRow('c_old', { at: iso(2000) }),
      chatRow('c_gone', { at: iso(1000), deleted: true }),
    ] }))
    expect(agent.read().chat.chats.map(c => [c.id, c.title])).toEqual([['c_new', 'My title'], ['c_old', 'Chat c_old'], ['c_gone', 'Chat c_gone']])
    expect(agent.allChatIds()).toEqual(['c_new', 'c_old', 'c_gone'])
    expect(agent.getSnapshot()).toMatchObject({ chatTitles: { c_new: 'My title' }, chatPinned: { c_new: true }, chatDeleted: { c_gone: true } })
    expect(agent.read().resources.chat).toEqual({ status: 'ready' })
  })

  test('the Inhouse team is not asked for chats on start (each read under a grant writes an audit line), only when its page asks', async () => {
    const staff = await loaded({ ...reads({ chats: [chatRow('c1')] }), 'GET /api/me': { body: me({ role: 'inhouse' }) } })
    expect(staff.calls.map(c => c.path)).not.toContain('/api/chats?limit=50')
    await staff.agent.retry('chat')
    expect(staff.agent.allChatIds()).toEqual(['c1'])
  })

  test('a 403 on the list (no live grant) is nothing to show, not an error', async () => {
    const { agent } = await loaded({ ...reads(), 'GET /api/chats?limit=50': refusal(403, 'forbidden', { reason: 'grant_required' }) })
    expect(agent.read().resources.chat).toEqual({ status: 'ready' })
  })

  test('getChat answers the page and keeps the chat\'s rev; a 404 rejects not_found', async () => {
    const page = { chat: chatRow('c1', { rev: 4 }), messages: [], nextCursor: null, runs: [] }
    const { agent } = await loaded({ ...reads(), 'GET /api/chats/c1': { body: page }, 'GET /api/chats/c1?cursor=abc': { body: { ...page, nextCursor: 'zzz' } }, 'GET /api/chats/nope': refusal(404, 'not_found') })
    expect(await agent.getChat('c1')).toEqual(page)
    expect((await agent.getChat('c1', 'abc')).nextCursor).toBe('zzz')
    expect(agent.allChatIds()).toEqual(['c1'])
    expect(await errorOf(agent.getChat('nope'))).toMatchObject({ code: 'not_found' })
  })

  test('a getChat waits for the chat\'s own save (a chat started a moment ago has no 404), and reads it once saved', async () => {
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const s = server({ ...reads(), 'POST /api/chats': { body: chatRow('c1') }, 'GET /api/chats/c1': { body: { chat: chatRow('c1'), messages: [], nextCursor: null, runs: [] } } })
    const slow: typeof fetch = async (i, init) => { if (String(i).endsWith('/api/chats') && init?.method === 'POST') await held; return s.fetch(i, init) }
    const agent = new HttpAgent({ fetch: slow, now: () => 5000 })
    await agent.whenLoaded()
    const made = agent.createChat({ id: 'c1', title: 'Hi' })
    const page = agent.getChat('c1')
    await new Promise(r => setTimeout(r, 0))
    expect(s.calls.filter(c => c.path === '/api/chats/c1')).toHaveLength(0)
    release()
    await made
    expect((await page).chat.id).toBe('c1')
  })

  test('a failed save then a getChat: the read gets the server\'s not_found (the store reads that as an empty chat)', async () => {
    const { agent } = await loaded({ ...reads(), 'POST /api/chats': refusal(503, 'unavailable'), 'GET /api/chats/c1': refusal(404, 'not_found') })
    await errorOf(agent.createChat({ id: 'c1', title: 'Hi' }))
    expect(await errorOf(agent.getChat('c1'))).toMatchObject({ code: 'not_found' })
  })

  test('the first page of the deleted chats is the server\'s page only: it doesn\'t put them in the list', async () => {
    const { agent } = await loaded({ ...reads({ chats: [chatRow('c1')] }), 'GET /api/chats?deleted=true': { body: { items: [chatRow('c_del', { deleted: true })], nextCursor: null } } })
    const page = await agent.listChats({ deleted: true })
    expect(page.items.map(c => c.id)).toEqual(['c_del'])
    expect(agent.allChatIds()).toEqual(['c1'])
  })

  test('listChats passes its options as the query and answers the server\'s page', async () => {
    const { agent, calls } = await loaded({
      ...reads(), 'GET /api/chats?cursor=k1&limit=10&deleted=true': { body: { items: [chatRow('c9', { deleted: true })], nextCursor: null } },
    })
    const page = await agent.listChats({ cursor: 'k1', limit: 10, deleted: true })
    expect(page.items.map(c => c.id)).toEqual(['c9'])
    expect(calls.at(-1)!.path).toBe('/api/chats?cursor=k1&limit=10&deleted=true')
  })
})

describe('createChat', () => {
  test('shows the chat at once, saves it (route 23) and keeps the server\'s record', async () => {
    const { agent, calls } = await loaded({ ...reads(), 'POST /api/chats': r => ({ body: chatRow(json(r).id, { title: json(r).title, rev: 1, at: iso(5000) }) }) })
    const p = agent.createChat({ id: 'c_a', title: 'Hello' })
    expect(agent.allChatIds()).toEqual(['c_a'])
    await p
    expect(json(calls.at(-1)!)).toEqual({ id: 'c_a', title: 'Hello' })
    expect(agent.read().chat.chats).toEqual([{ id: 'c_a', title: 'Hello', at: iso(5000), turns: [] }])
  })

  test('a failed save takes the chat back, rejects with the error and sends one notice', async () => {
    const { agent, heard } = await loaded({ ...reads(), 'POST /api/chats': refusal(503, 'unavailable') })
    expect(await errorOf(agent.createChat({ id: 'c_a', title: 'Hello' }))).toMatchObject({ code: 'unavailable' })
    expect(agent.allChatIds()).toEqual([])
    expect(heard.filter(n => n.type === 'error')).toHaveLength(1)
  })

  test('a title or id the schema refuses is refused here, and nothing leaves', async () => {
    const { agent, calls } = await loaded(reads())
    const before = calls.length
    expect(await errorOf(agent.createChat({ id: 'bad id!', title: 'x' }))).toMatchObject({ code: 'invalid' })
    expect(await errorOf(agent.createChat({ id: 'c_a', title: '' }))).toMatchObject({ code: 'invalid' })
    expect(calls).toHaveLength(before)
  })
})

describe('rename, pin, delete and restore', () => {
  const two = [chatRow('c1', { rev: 3 }), chatRow('c2', { rev: 1, at: iso(500) })]
  const answerTitle = (r: { body: string | undefined }) => ({ body: chatRow('c1', { rev: json(r).ifRev + 1, customTitle: json(r).title, title: json(r).title ?? 'Chat c1' }) })

  test('rename sends the chat\'s rev, shows the title at once and trimmed, and the next write goes at the rev the answer left', async () => {
    const { agent, calls } = await loaded({
      ...reads({ chats: two }), 'PUT /api/chats/c1/title': answerTitle,
      'PUT /api/chats/c1/pin': r => ({ body: chatRow('c1', { rev: json(r).ifRev + 1, pinned: json(r).pinned, customTitle: 'Weekly stock', title: 'Weekly stock' }) }),
    })
    const p = agent.renameChat('c1', '  Weekly stock  ')
    expect(agent.getSnapshot().chatTitles.c1).toBe('Weekly stock')
    await p
    await agent.pinChat('c1', true)
    expect(calls.filter(c => c.method === 'PUT').map(c => [c.path, json(c)])).toEqual([
      ['/api/chats/c1/title', { title: 'Weekly stock', ifRev: 3 }],
      ['/api/chats/c1/pin', { pinned: true, ifRev: 4 }],
    ])
    expect(agent.getSnapshot().chatPinned).toEqual({ c1: true })
  })

  test('a null title puts the chat\'s own title back', async () => {
    const { agent, calls } = await loaded({ ...reads({ chats: [chatRow('c1', { rev: 2, customTitle: 'Mine', title: 'Mine' })] }), 'PUT /api/chats/c1/title': r => ({ body: chatRow('c1', { rev: 3, customTitle: json(r).title }) }) })
    await agent.renameChat('c1', null)
    expect(json(calls.at(-1)!)).toEqual({ title: null, ifRev: 2 })
    expect(agent.getSnapshot().chatTitles).toEqual({})
  })

  test('a stale rev (409 with the chat as it is) puts the current chat in, rejects with conflict and sends one notice', async () => {
    const current = chatRow('c1', { rev: 7, customTitle: 'Someone else', title: 'Someone else' })
    const { agent, heard } = await loaded({ ...reads({ chats: two }), 'PUT /api/chats/c1/title': { status: 409, body: { error: { code: 'conflict', current } } } })
    const e = await errorOf(agent.renameChat('c1', 'Mine'))
    expect(e).toMatchObject({ code: 'conflict' })
    expect((e as AgentError).current).toMatchObject({ rev: 7 })
    expect(agent.getSnapshot().chatTitles.c1).toBe('Someone else')
    expect(heard.filter(n => n.type === 'error')).toHaveLength(1)
  })

  test('a refused rename or pin goes back to what the server last said', async () => {
    const { agent } = await loaded({ ...reads({ chats: two }), 'PUT /api/chats/c1/title': refusal(503, 'unavailable'), 'PUT /api/chats/c1/pin': refusal(500, 'unknown') })
    await errorOf(agent.renameChat('c1', 'Mine'))
    await errorOf(agent.pinChat('c1', true))
    expect(agent.getSnapshot()).toMatchObject({ chatTitles: {}, chatPinned: {} })
  })

  // The pins, titles and deletes derived from the chats must not be rebuilt when a rollback brings the chats back as they were.
  test('a refused rename or pin hands back the identical snapshot', async () => {
    const { agent } = await loaded({ ...reads({ chats: two }), 'PUT /api/chats/c1/title': refusal(503, 'unavailable'), 'PUT /api/chats/c1/pin': refusal(403, 'forbidden') })
    const before = agent.getSnapshot()
    await errorOf(agent.renameChat('c1', 'Mine'))
    expect(agent.getSnapshot()).toBe(before)
    await errorOf(agent.pinChat('c1', true))
    expect(agent.getSnapshot()).toBe(before)
  })

  test('a refused delete or restore hands back the identical snapshot (chatDeleted)', async () => {
    const { agent } = await loaded({ ...reads({ chats: two }), 'POST /api/chats/delete': refusal(503, 'unavailable'), 'POST /api/chats/restore': refusal(403, 'forbidden') })
    const before = agent.getSnapshot()
    await errorOf(agent.deleteChats(['c1']))
    expect(agent.getSnapshot()).toBe(before)
    await errorOf(agent.restoreChats(['c2']))
    expect(agent.getSnapshot()).toBe(before)
  })

  test('a chat that isn\'t there is refused locally', async () => {
    const { agent } = await loaded(reads())
    expect(await errorOf(agent.renameChat('nope', 'x'))).toMatchObject({ code: 'not_found' })
    expect(await errorOf(agent.pinChat('nope', true))).toMatchObject({ code: 'not_found' })
  })

  test('delete hides the chats at once and keeps them for Undo; restore brings them back; 0 or 51 ids are refused here', async () => {
    const { agent, calls } = await loaded({
      ...reads({ chats: two }),
      'POST /api/chats/delete': r => ({ body: { items: json(r).ids.map((id: string) => chatRow(id, { deleted: true, rev: 2 })) } }),
      'POST /api/chats/restore': r => ({ body: { items: json(r).ids.map((id: string) => chatRow(id, { deleted: false, rev: 3 })) } }),
    })
    const p = agent.deleteChats(['c1', 'c2'])
    expect(agent.getSnapshot().chatDeleted).toEqual({ c1: true, c2: true })
    expect(agent.allChatIds()).toEqual(['c1', 'c2'])
    await p
    await agent.restoreChats(['c1'])
    expect(agent.getSnapshot().chatDeleted).toEqual({ c2: true })
    expect(calls.filter(c => c.method === 'POST').map(c => [c.path, json(c)])).toEqual([
      ['/api/chats/delete', { ids: ['c1', 'c2'] }], ['/api/chats/restore', { ids: ['c1'] }],
    ])
    expect(await errorOf(agent.deleteChats([]))).toMatchObject({ code: 'invalid' })
    expect(await errorOf(agent.deleteChats(Array.from({ length: 51 }, (_, i) => `c${i}`)))).toMatchObject({ code: 'invalid' })
    expect(await errorOf(agent.deleteChats(['c1', 'nope']))).toMatchObject({ code: 'not_found' })
  })

  test('a refused delete shows the chats again', async () => {
    const { agent } = await loaded({ ...reads({ chats: two }), 'POST /api/chats/delete': refusal(404, 'not_found') })
    await errorOf(agent.deleteChats(['c1']))
    expect(agent.getSnapshot().chatDeleted).toEqual({})
  })

  test('resetSession posts to route 49 and a refusal keeps its reason', async () => {
    const ok = await loaded({ ...reads(), 'POST /api/chats/c1/session/reset': { body: { ok: true } } })
    await ok.agent.resetSession('c1')
    const no = await loaded({ ...reads(), 'POST /api/chats/c1/session/reset': refusal(404, 'not_found') })
    expect(await errorOf(no.agent.resetSession('c1'))).toMatchObject({ code: 'not_found' })
  })
})

describe('send, interrupt and stop', () => {
  const input = { clientTurnKey: 'key-12345', text: 'What is low on stock?', model: 'sonnet' }
  const sent = { runId: RUN, turnId: TURN, messageId: `${TURN}.u`, position: 'starting' }

  test('a send posts the shared schema\'s body (defaults filled) to route 29 and answers the turn', async () => {
    const { agent, calls } = await loaded({ ...reads(), 'POST /api/chats/c1/turns': { body: sent } })
    expect(await agent.send('c1', { ...input, quote: 'a part', priority: 'later' })).toEqual(sent)
    expect(json(calls.at(-1)!)).toEqual({ clientTurnKey: 'key-12345', text: 'What is low on stock?', quote: 'a part', priority: 'later', model: 'sonnet', attachments: [] })
    await agent.send('c1', input)
    expect(json(calls.at(-1)!)).toMatchObject({ priority: 'next', attachments: [] })
  })

  test('the chat\'s own save goes first when it is still on its way', async () => {
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const s = server({ ...reads(), 'POST /api/chats': { body: chatRow('c1') }, 'POST /api/chats/c1/turns': { body: sent } })
    const slow: typeof fetch = async (i, init) => { if (String(i).endsWith('/api/chats')) await held; return s.fetch(i, init) }
    const agent = new HttpAgent({ fetch: slow, now: () => 5000 })
    await agent.whenLoaded()
    const made = agent.createChat({ id: 'c1', title: 'Hi' })
    const result = agent.send('c1', input)
    await new Promise(r => setTimeout(r, 0))
    expect(s.calls.filter(c => c.path.startsWith('/api/chats/c1/turns'))).toHaveLength(0)
    release()
    await Promise.all([made, result])
    const order = s.calls.filter(c => c.method === 'POST').map(c => c.path)
    expect(order).toEqual(['/api/chats', '/api/chats/c1/turns'])
  })

  test.each([
    ['paused', 403, 'forbidden', 'paused'], ['model off', 403, 'forbidden', 'model_off'], ['draining', 503, 'unavailable', 'draining'],
    ['damaged session', 409, 'conflict', 'session_damaged'], ['waiting for an answer', 409, 'conflict', 'waiting_answer'],
    ['queue full', 429, 'rate_limited', 'queue_full'], ['the key reused with other text', 409, 'conflict', 'key_reused'], ['removed', 403, 'forbidden', 'removed'],
  ])('a refused send (%s) rejects with its code and reason, and sends no notice of its own (the chat shows the failed line)', async (_n, status, code, reason) => {
    const { agent, heard } = await loaded({ ...reads(), 'POST /api/chats/c1/turns': refusal(status, code, { reason }) })
    const e = await errorOf(agent.send('c1', input))
    expect(e).toBeInstanceOf(AgentError)
    expect(e).toMatchObject({ code, reason })
    expect(heard).toEqual([])
  })

  test('a send the schema refuses (an empty text, a bad key, a model id with spaces) is refused here as invalid, and nothing leaves', async () => {
    const { agent, calls } = await loaded(reads())
    const before = calls.length
    for (const bad of [{ ...input, text: '' }, { ...input, clientTurnKey: 'short' }, { ...input, model: 'not a model' }]) {
      expect(await errorOf(agent.send('c1', bad))).toMatchObject({ code: 'invalid' })
    }
    expect(calls).toHaveLength(before)
  })

  test('a 401 on a send is the signed-out state', async () => {
    const { agent } = await loaded({ ...reads(), 'POST /api/chats/c1/turns': refusal(401, 'unauthorized') })
    await errorOf(agent.send('c1', input))
    expect(agent.read().resources.meta).toMatchObject({ status: 'error', error: 'unauthorized' })
  })

  test('interrupt and stop go to routes 30 and 31 by turn id; a stale turn is a conflict with one notice', async () => {
    const { agent, calls, heard } = await loaded({
      ...reads(), [`POST /api/turns/${TURN}/interrupt`]: { body: { ok: true } }, [`POST /api/turns/${TURN}/stop`]: refusal(409, 'conflict', { reason: 'turn_ended' }),
    })
    await agent.interrupt(TURN)
    expect(await errorOf(agent.stop(TURN))).toMatchObject({ code: 'conflict', reason: 'turn_ended' })
    expect(calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual([`/api/turns/${TURN}/interrupt`, `/api/turns/${TURN}/stop`])
    expect(heard.filter(n => n.type === 'error')).toHaveLength(1)
  })

  test('the run replay (route 32) is read after the first reads, and answers the runs the server names', async () => {
    const run = { runId: RUN, chatId: 'c1', lastSeq: 4, live: true }
    const { agent, calls } = await loaded({ ...reads({ chats: [chatRow('c1')] }), 'GET /api/runs/active': { body: { runs: [run] } } })
    expect(await agent.activeRuns()).toEqual([run])
    // Asked before the chat list was read (the app asks at start): it waits for the first reads, so its chat is known.
    const early = server({ ...reads({ chats: [chatRow('c1')] }), 'GET /api/runs/active': { body: { runs: [run] } } })
    const a2 = new HttpAgent({ fetch: early.fetch })
    expect(await a2.activeRuns()).toEqual([run])
    expect(a2.allChatIds()).toEqual(['c1'])
    expect(early.calls.map(c => c.path).indexOf('/api/runs/active')).toBeGreaterThan(early.calls.map(c => c.path).indexOf('/api/chats?limit=50'))
    expect(calls.filter(c => c.path === '/api/runs/active')).toHaveLength(1)
  })

  test.each([
    ['a 401', refusal(401, 'unauthorized')],
    ['a 403 not invited', refusal(403, 'forbidden', { reason: 'not_invited' })],
    ['a 403 Inhouse team account', refusal(403, 'forbidden', { reason: 'wrong_kind' })],
  ])('the run replay is not read when the first read was refused (%s): nothing after the refusal', async (_n, answer) => {
    const s = server({ 'GET /api/me': answer, 'GET /api/runs/active': { body: { runs: [] } } })
    const agent = new HttpAgent({ fetch: s.fetch })
    // The app asks at start, before the first read answers (store.ts).
    expect(await agent.activeRuns()).toEqual([])
    expect(s.calls.map(c => c.path)).toEqual(['/api/me'])
  })

  test('the trace route answers a trace or null for a 404', async () => {
    const trace = { id: RUN, title: 'A run', durationMs: 1200, cost: { minor: 3, currency: 'USD' }, tokens: '1k', steps: [] }
    const { agent } = await loaded({ ...reads(), [`GET /api/traces/${RUN}`]: { body: trace }, 'GET /api/traces/gone': refusal(404, 'not_found') })
    expect(await agent.getTrace(RUN)).toEqual(trace)
    expect(await agent.getTrace('gone')).toBeNull()
  })
})

describe('models (route 38)', () => {
  test('a model Admins switched off stays on the Models page (off); one the server serves is on; the default is the server\'s', async () => {
    const served = { default: 'opus', modes: ALL_MODELS.filter(m => m.id !== 'haiku') }
    const { agent } = await loaded(reads({ models: served }))
    // `tm:haiku:on` is not saved yet, so haiku (unserved, not off) is unpriced: not listed.
    expect(agent.read().models.map(m => m.id)).toEqual(['fable', 'opus', 'sonnet'])
    expect(agent.read().defaultModel).toBe('opus')
    const off = await loaded({ ...reads({ models: served }), 'GET /api/settings/technical': { body: { items: [record('tm:haiku:on', 'off', 2)] } } })
    expect(off.agent.read().models.map(m => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })

  test('route 38 listing none: no model on the page that the picker can use, default empty', async () => {
    const { agent } = await loaded(reads({ models: { default: null, modes: [] } }))
    expect(agent.read().models).toEqual([])
    expect(agent.read().defaultModel).toBe('')
  })

  test('switching a model on or off, or its effort, reads the list again; a switch on shows its row at once', async () => {
    let served = ALL_MODELS.filter(m => m.id !== 'haiku')
    const { agent, calls } = await loaded({
      ...reads({ models: { default: 'opus', modes: served } }),
      'GET /api/models': () => ({ body: { default: 'opus', modes: served } }),
      'GET /api/settings/technical': { body: { items: [record('tm:haiku:on', 'off', 2)] } },
      'PUT /api/settings/technical/tm:haiku:on': () => { served = ALL_MODELS; return { body: record('tm:haiku:on', 'on', 3) } },
    })
    // The model's switch is the text value 'on' or 'off' (`tm:<id>:on`).
    await agent.setSetting('tm:haiku:on', 'on')
    expect(calls.filter(c => c.path === '/api/models')).toHaveLength(2)
    expect(agent.read().models.map(m => m.id)).toContain('haiku')
  })
})

describe('the pause state a send proves or reveals (QA round 2: a Member\'s page kept the paused banner after an Admin resumed)', () => {
  const input = { clientTurnKey: 'key-12345', text: 'What is low on stock?', model: 'sonnet' }
  const sentOk = { status: 202, body: { runId: RUN, turnId: TURN, messageId: `${TURN}.u`, position: 'starting' } }
  test('a send the agent accepts clears the paused state the page read on load', async () => {
    const { agent, calls } = await loaded({ ...reads({ pause: { paused: true, at: iso(4000), by: ME_ID } }), 'POST /api/chats/c1/turns': sentOk })
    expect(agent.getSnapshot().paused).toEqual(iso(4000))
    await agent.send('c1', input)
    expect(agent.getSnapshot().paused).toBeNull()
    expect(calls.filter(c => c.path === '/api/pause')).toHaveLength(1) // no extra read: the send is the proof
  })
  test('a send refused as paused reads the real state once, so a page that did not know shows the pause (with its real time)', async () => {
    let paused = false
    const { agent, calls } = await loaded({
      ...reads(),
      'GET /api/pause': () => ({ body: paused ? { paused: true, at: iso(7000), by: ME_ID } : { paused: false, at: null, by: null } }),
      'POST /api/chats/c1/turns': refusal(403, 'forbidden', { reason: 'paused' }),
    })
    expect(agent.getSnapshot().paused).toBeNull()
    paused = true // an Admin pauses after the page loaded
    expect(await errorOf(agent.send('c1', input))).toMatchObject({ code: 'forbidden', reason: 'paused' })
    await new Promise(r => setTimeout(r, 0))
    expect(agent.getSnapshot().paused).toEqual(iso(7000))
    expect(calls.filter(c => c.path === '/api/pause')).toHaveLength(2)
  })
  test('a send refused for another reason leaves the pause state alone and reads nothing', async () => {
    const { agent, calls } = await loaded({ ...reads({ pause: { paused: true, at: iso(4000), by: ME_ID } }), 'POST /api/chats/c1/turns': refusal(403, 'forbidden', { reason: 'model_off' }) })
    await errorOf(agent.send('c1', input))
    expect(agent.getSnapshot().paused).toEqual(iso(4000))
    expect(calls.filter(c => c.path === '/api/pause')).toHaveLength(1)
  })
})

describe('pause and resume (routes 35 to 37)', () => {
  test('the pause state is read on start and is the snapshot\'s `paused`', async () => {
    const { agent } = await loaded(reads({ pause: { paused: true, at: iso(4000), by: ME_ID } }))
    expect(agent.getSnapshot().paused).toEqual(iso(4000))
    const calm = await loaded(reads())
    expect(calm.agent.getSnapshot().paused).toBeNull()
  })

  test('pause shows at once, resolves to when the server paused it, and resume clears it', async () => {
    const { agent, calls } = await loaded({
      ...reads(), 'POST /api/pause': { body: { paused: true, at: iso(6000), by: ME_ID } }, 'POST /api/resume': { body: { paused: false, at: null, by: null } },
    })
    const p = agent.pause()
    expect(agent.getSnapshot().paused).not.toBeNull()
    expect(await p).toEqual(iso(6000))
    expect(agent.getSnapshot().paused).toEqual(iso(6000))
    await agent.resume()
    expect(agent.getSnapshot().paused).toBeNull()
    expect(calls.filter(c => c.method === 'POST').map(c => [c.path, c.body])).toEqual([['/api/pause', undefined], ['/api/resume', undefined]])
  })

  test('a refused pause hands back the identical snapshot', async () => {
    const { agent } = await loaded({ ...reads(), 'POST /api/pause': refusal(403, 'forbidden') })
    const before = agent.getSnapshot()
    await errorOf(agent.pause())
    expect(agent.getSnapshot()).toBe(before)
  })

  test('a refused pause (a Member\'s 403) takes it back and sends one notice', async () => {
    const { agent, heard } = await loaded({ ...reads(), 'POST /api/pause': refusal(403, 'forbidden') })
    expect(await errorOf(agent.pause())).toMatchObject({ code: 'forbidden' })
    expect(agent.getSnapshot().paused).toBeNull()
    expect(heard.filter(n => n.type === 'error')).toHaveLength(1)
  })
})

describe('spending (route 42)', () => {
  test('the page reads this month and each month the server lists, and a cap or alert save reads this month again', async () => {
    let total = 1000
    const { agent, calls } = await loaded({
      ...reads({ usage: usage({ months: ['2026-11', '2026-10'] }) }),
      'GET /api/usage': () => ({ body: usage({ total: { minor: total, currency: 'USD' }, months: ['2026-11', '2026-10'] }) }),
      'GET /api/usage?month=2026-10': { body: usage({ month: 'October', monthKey: '2026-10', months: ['2026-11', '2026-10'] }) },
      'PUT /api/settings/brand/s:cap': { body: record('s:cap', '$500', 2) },
    })
    expect(agent.read().usageMonths.map(m => m.monthKey)).toEqual(['2026-11', '2026-10'])
    total = 7000
    await agent.setSetting('s:cap', '$500')
    expect(agent.read().usage.total.minor).toBe(7000)
    expect(agent.read().usageMonths.map(m => m.monthKey)).toEqual(['2026-11', '2026-10'])
    expect(agent.read().usageMonths[0].total.minor).toBe(7000)
    expect(calls.filter(c => c.path === '/api/usage')).toHaveLength(2)
  })

  test('a failed first read of the spending is that resource\'s error, and the rest of the app is up', async () => {
    const { agent } = await loaded({ ...reads(), 'GET /api/usage': refusal(503, 'unavailable') })
    expect(agent.read().resources.usage).toMatchObject({ status: 'error', error: 'unavailable' })
    expect(agent.read().resources.models.status).toBe('ready')
  })
})

describe('uploadFile (route 39) on the chat client', () => {
  const FILE = 'f_SERVERSERVERSERVERSERV'
  const kept = { fileId: FILE, kind: 'input', path: `inputs/${FILE}-a.csv`, name: 'a.csv', bytes: 4, contentType: 'text/csv', atMs: 5 }
  test('it is a real-client capability', async () => {
    const { agent } = await loaded(reads())
    expect(agent.uploadsFiles()).toBe(true)
  })

  test('it waits for the chat\'s own save, and the turn after it names the id the server gave', async () => {
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const s = server({
      ...reads(),
      'POST /api/chats': { body: chatRow('c1') },
      'POST /api/chats/c1/attachments': { status: 201, body: kept },
      'POST /api/chats/c1/turns': { status: 202, body: { runId: 'r_aaaaaaaaaaaaaaaaaaaaaa', turnId: 't_aaaaaaaaaaaaaaaaaaaaaa', messageId: 't_aaaaaaaaaaaaaaaaaaaaaa.u', position: 'starting' } },
    })
    const slow: typeof fetch = async (i, init) => { if (String(i).endsWith('/api/chats') && init?.method === 'POST') await held; return s.fetch(i, init) }
    const agent = new HttpAgent({ fetch: slow, now: () => 5000 })
    await agent.whenLoaded()
    void agent.createChat({ id: 'c1', title: 'Hi' })
    const up = agent.uploadFile('c1', new File(['a,1\n'], 'a.csv'))
    await new Promise(r => setTimeout(r, 0))
    expect(s.calls.filter(c => c.path.endsWith('/attachments'))).toHaveLength(0)
    release()
    const got = await up
    expect(got).toEqual({ fileId: FILE, name: 'a.csv' })
    await agent.send('c1', { clientTurnKey: 'key-0001', text: 'hi', model: 'sonnet', attachments: [got] })
    const order = s.calls.map(c => `${c.method} ${c.path}`).filter(p => p.includes('/api/chats/c1') || p === 'POST /api/chats')
    expect(order).toEqual(['POST /api/chats', 'POST /api/chats/c1/attachments', 'POST /api/chats/c1/turns'])
    expect(json(s.calls.at(-1)!).attachments).toEqual([{ fileId: FILE, name: 'a.csv' }])
  })

  test('a 401 is the signed-out state; a refusal is not', async () => {
    const a = await loaded({ ...reads(), 'POST /api/chats/c1/attachments': refusal(401, 'unauthorized') })
    expect(await errorOf(a.agent.uploadFile('c1', new File(['x'], 'a.csv')))).toMatchObject({ code: 'unauthorized' })
    expect(a.agent.read().resources.meta).toMatchObject({ status: 'error', error: 'unauthorized' })
    const b = await loaded({ ...reads(), 'POST /api/chats/c1/attachments': refusal(400, 'invalid', { reason: 'type_not_allowed' }) })
    expect(await errorOf(b.agent.uploadFile('c1', new File(['x'], 'a.csv')))).toMatchObject({ code: 'invalid', reason: 'type_not_allowed' })
    expect(b.agent.read().resources.meta).toMatchObject({ status: 'ready' })
  })
})

describe('refreshMemory: a fact saved after boot shows when the Memory page opens', () => {
  const line = (key: string, text: string) => ({ key, text, source: 'Sam told your Inhouse agent in a chat', at: iso(5), rev: 1, scope: 'person' })
  const K1 = 'mem_AAAAAAAAAAAAAAAAAAAAAA'
  const K2 = 'mem_BBBBBBBBBBBBBBBBBBBBBB'

  test('the page read at boot does not hold a fact saved since; refreshMemory brings it in', async () => {
    let page = { team: [], personal: [line(K1, 'We restock on Fridays')] }
    const { agent, calls } = await loaded({ ...reads(), 'GET /api/memory': () => ({ body: page }) })
    expect(agent.read().memory.personal.map(l => l.text)).toEqual(['We restock on Fridays'])
    page = { team: [], personal: [line(K2, 'Sort tables by date'), line(K1, 'We restock on Fridays')] }
    await agent.refreshMemory()
    expect(agent.read().memory.personal.map(l => l.text)).toEqual(['Sort tables by date', 'We restock on Fridays'])
    expect(calls.filter(c => c.path === '/api/memory')).toHaveLength(2)
  })

  test('opening twice at once is one read; a later open reads again', async () => {
    const { agent, calls } = await loaded({ ...reads(), 'GET /api/memory': { body: { team: [], personal: [] } } })
    const before = calls.filter(c => c.path === '/api/memory').length
    await Promise.all([agent.refreshMemory(), agent.refreshMemory()])
    expect(calls.filter(c => c.path === '/api/memory').length - before).toBe(1)
    await agent.refreshMemory()
    expect(calls.filter(c => c.path === '/api/memory').length - before).toBe(2)
  })

  test('the page does not flip to loading while it reads again', async () => {
    const { agent } = await loaded({ ...reads(), 'GET /api/memory': { body: { team: [], personal: [] } } })
    const seen: string[] = []
    agent.subscribe(() => { seen.push(agent.read().resources.memory.status) })
    await agent.refreshMemory()
    expect(seen.every(s => s === 'ready')).toBe(true)
  })

  test('a failed read says so on the page and keeps what it had', async () => {
    let fail = false
    const { agent } = await loaded({ ...reads(), 'GET /api/memory': () => (fail ? refusal(503, 'unavailable') : { body: { team: [], personal: [line(K1, 'We restock on Fridays')] } }) })
    fail = true
    await agent.refreshMemory().catch(() => undefined)
    expect(agent.read().resources.memory.status).toBe('error')
    expect(agent.read().memory.personal.map(l => l.text)).toEqual(['We restock on Fridays'])
  })
})

describe('a chat past the first page of the list (route 24 finds it)', () => {
  test('getChat adds the chat to the list, so a deep link to an older chat is known', async () => {
    const { agent } = await loaded({ ...reads({ chats: [chatRow('c1')] }), 'GET /api/chats/c_old': { body: { chat: chatRow('c_old', { title: 'An older chat' }), messages: [], nextCursor: null, runs: [] } } })
    expect(agent.allChatIds()).toEqual(['c1'])
    await agent.getChat('c_old')
    expect(agent.allChatIds().sort()).toEqual(['c1', 'c_old'])
  })

  test('a chat the server does not have is a 404 and stays out of the list', async () => {
    const { agent } = await loaded({ ...reads({ chats: [chatRow('c1')] }), 'GET /api/chats/c_nope': refusal(404, 'not_found') })
    expect(await errorOf(agent.getChat('c_nope'))).toMatchObject({ code: 'not_found' })
    expect(agent.allChatIds()).toEqual(['c1'])
  })
})
