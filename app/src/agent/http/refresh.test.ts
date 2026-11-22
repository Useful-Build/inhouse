// The lists the agent's work fills (Library, Today, Activity, the bell) read again when the work could have changed them.
// Seen in the P4 sandbox: the first read was empty, the agent saved a file in a chat, and the Library still said "All
// files 0" until a reload. Ways it could still show a person the wrong thing, written down first:
//  - opening the Library, Today or Activity shows the read from the app's start, not what the agent made since;
//  - a run's end (a chat turn) that leaves those lists and the bell as they were;
//  - a refresh that shows the page as loading, or reads a list whose first read isn't in yet (two reads for one open);
//  - the Inhouse team read on a run's end it didn't ask for, or its bell read at all (each read under a grant writes a
//    support.access line);
//  - a read that left before a write (a card set aside, a notice read) landing after it and undoing it on screen;
//  - a refresh that fails turning a list the person was reading into an error;
//  - a run's end during a page's read lost (the read joined, though it left before the run's work was saved).
import { describe, expect, test } from 'vitest'
import { HttpAgent } from './client'
import type { SocketLike } from './stream/socket'
import { chatRow, iso, me, reads, server } from './testing/fake-server'
import type { Routes } from './testing/fake-server'

const NOW = 10_000
const F = (k: string) => `f_${k.padEnd(22, 'x')}`
const file = (k: string) => ({
  id: F(k), name: `${k}.csv`, type: 'CSV', kind: 'documents', place: 'chats', from: 'From a chat by Ann Lee', by: 'Inhouse agent', madeByAgent: true,
  size: '4 B', at: iso(1000), rev: 1, canDelete: true,
})
const card = (id: string) => ({
  id: `p_${id.padEnd(22, 'x')}`, sev: 'red', area: 'Orders', title: id, sub: 's', logos: ['shopify'], cost: { minor: 0, currency: 'USD' }, costNote: '', next: 'n', doneText: 'Nothing done yet',
  found: [], sources: [], draft: { title: 'n', lines: [], cta: 'Approve' }, draftedAt: iso(1000),
})
const line = (ms: number, text: string) => ({
  at: iso(ms), kind: 'read', text, who: 'Your Inhouse agent', why: 'Its time came', result: 'It finished', by: { text: 'Your Inhouse agent, at {at:time}', times: { at: iso(ms) } },
})
const notice = (id: string) => ({ id, icon: 'notifications', text: `Notice ${id}`, who: 'Your Inhouse agent', at: iso(1000), unread: true, link: { to: 'page', page: 'today' } })
const routine = { id: 'rt_a', name: 'Routine rt_a', what: 'Check stock.', freq: 'Daily', day: '', time: { hour: 6, minute: 0 }, next: iso(NOW + 3_600_000), need: 1, canManage: true, rev: 1 }

/** What the server holds right now: the tests change it the way the agent's work would. */
function world() {
  const w = { library: [] as unknown[], today: [] as unknown[], activity: [] as unknown[], notifications: [] as unknown[] }
  const routes: Routes = {
    ...reads({ chats: [chatRow('c1')], routines: { routines: [routine], deleted: [], enabled: { rt_a: true } } }),
    'GET /api/library?limit=100': () => ({ body: { items: w.library, nextCursor: null } }),
    'GET /api/today': () => ({ body: { items: w.today, aside: {} } }),
    'GET /api/activity?limit=100': () => ({ body: { items: w.activity, nextCursor: null } }),
    'GET /api/notifications': () => ({ body: { items: w.notifications } }),
    'POST /api/routines/rt_a/run': { body: { routine: 'rt_a', at: iso(NOW) } },
  }
  return { w, routes }
}
async function loaded(routes: Routes) {
  const s = server(routes)
  const agent = new HttpAgent({ fetch: s.fetch, now: () => NOW })
  await agent.whenLoaded()
  return { agent, ...s }
}
/**
 * A fetch whose next answer to `path` is made when asked (the server's state then) but held back until `release()`: a read
 * that left before what the test does next, and lands after it.
 */
function held(routes: Routes, path: string) {
  const s = server(routes)
  let gate: Promise<void> | null = null
  let release = () => {}
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const res = await s.fetch(input, init)
    const url = new URL(String(input), 'http://x.test')
    if (gate && (init?.method ?? 'GET') === 'GET' && url.pathname + url.search === path) { const g = gate; gate = null; await g }
    return res
  }
  const hold = () => { gate = new Promise<void>(r => { release = r }) }
  return { fetch, calls: s.calls, hold, release: () => release() }
}
const countReads = (calls: { method: string; path: string }[], path: string) => calls.filter(c => c.method === 'GET' && c.path === path).length

describe('a list page opened reads its list again', () => {
  test('the Library opened after a chat saved a file shows the file, without a reload and without showing as loading', async () => {
    const { w, routes } = world()
    const { agent } = await loaded(routes)
    expect(agent.listFiles()).toEqual([])
    // The agent saves a file in a chat: the server lists it, and nothing has told this tab.
    w.library = [file('made')]
    const p = agent.refresh('library')
    expect(agent.read().resources.library).toEqual({ status: 'ready' })
    await p
    expect(agent.listFiles().map(f => f.id)).toEqual([F('made')])
  })

  test('Today opened after a Run now shows the cards the run found', async () => {
    const { w, routes } = world()
    const { agent } = await loaded(routes)
    expect(agent.read().problems).toEqual([])
    await agent.runRoutine('rt_a')
    w.today = [card('found')]
    await agent.refresh('problems')
    expect(agent.read().problems.map(p => p.title)).toEqual(['found'])
  })

  test('Activity and the bell read again too', async () => {
    const { w, routes } = world()
    const { agent } = await loaded(routes)
    w.activity = [line(NOW - 1000, 'Ran Routine rt_a')]
    w.notifications = [notice('n1')]
    await Promise.all([agent.refresh('activity'), agent.refresh('notifications')])
    expect([...agent.read().activity.today, ...agent.read().activity.earlier].map(l => l.text)).toEqual(['Ran Routine rt_a'])
    expect(agent.listNotifications().map(n => n.id)).toEqual(['n1'])
  })

  test('two opens at once make one read; an open before the first read is in makes none of its own', async () => {
    const { routes } = world()
    const { agent, calls } = await loaded(routes)
    await Promise.all([agent.refresh('library'), agent.refresh('library')])
    expect(countReads(calls, '/api/library?limit=100')).toBe(2)

    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const s = server(routes)
    const slow: typeof globalThis.fetch = async (input, init) => {
      if (new URL(String(input), 'http://x.test').pathname === '/api/library') await gate
      return s.fetch(input, init)
    }
    const early = new HttpAgent({ fetch: slow, now: () => NOW })
    await new Promise(r => setTimeout(r, 0))
    const opened = early.refresh('library')
    release()
    await Promise.all([early.whenLoaded(), opened])
    expect(countReads(s.calls, '/api/library?limit=100')).toBe(1)
  })

  test('the Inhouse team reads a page it opens (it asked)', async () => {
    const { w, routes } = world()
    const { agent, calls } = await loaded({ ...routes, 'GET /api/me': { body: me({ role: 'inhouse' }) } })
    expect(countReads(calls, '/api/library?limit=100')).toBe(0)
    w.library = [file('made')]
    await agent.refresh('library')
    expect(agent.listFiles().map(f => f.id)).toEqual([F('made')])
  })
})

describe('a refresh never undoes a write, never turns a list into an error, never loses a newer ask', () => {
  test('a card dismissed while a Today read is on its way stays dismissed, and Undo brings it back where it was', async () => {
    const { w, routes } = world()
    w.today = [card('a'), card('b')]
    let aside: Record<string, unknown> = {}
    const ID = card('a').id
    const h = held({
      ...routes,
      'GET /api/today': () => ({ body: { items: w.today, aside } }),
      [`PUT /api/today/${ID}/aside`]: r => {
        const reason = JSON.parse(r.body ?? '{}').reason as string | null
        const record = { reason, at: iso(2000), by: 'm_Sam', loggedAt: iso(2000), rev: (JSON.parse(r.body ?? '{}').ifRev as number) + 1 }
        aside = { [ID]: record }
        w.today = reason === null ? [card('a'), card('b')] : [card('b')]
        return { body: record }
      },
    }, '/api/today')
    const agent = new HttpAgent({ fetch: h.fetch, now: () => NOW })
    await agent.whenLoaded()
    h.hold()
    const reading = agent.refresh('problems')
    await new Promise(r => setTimeout(r, 0))
    await agent.setAside(ID, 'dismissed')
    h.release()
    await reading
    expect(agent.read().problems.map(p => p.title)).toEqual(['b'])
    await agent.setAside(ID, null)
    expect(agent.read().problems.map(p => p.title)).toEqual(['a', 'b'])
  })

  test('a notice marked read while a bell read is on its way stays read', async () => {
    const { w, routes } = world()
    w.notifications = [notice('n1')]
    const h = held({
      ...routes,
      'POST /api/notifications/read': r => { const ids = JSON.parse(r.body ?? '{}').ids as string[]; w.notifications = (w.notifications as { id: string }[]).map(n => (ids.includes(n.id) ? { ...n, unread: false } : n)); return { body: { ok: true } } },
    }, '/api/notifications')
    const agent = new HttpAgent({ fetch: h.fetch, now: () => NOW })
    await agent.whenLoaded()
    h.hold()
    const reading = agent.refresh('notifications')
    await new Promise(r => setTimeout(r, 0))
    await agent.markNoticesRead(['n1'])
    h.release()
    await reading
    expect(agent.listNotifications().map(n => [n.id, n.unread])).toEqual([['n1', false]])
  })

  test('a refresh that fails leaves the list as it was, ready, on a page open and on a run\'s end', async () => {
    const { w, routes } = world()
    w.library = [file('kept')]
    let fail = false
    const failing: Routes = { ...routes, 'GET /api/library?limit=100': () => (fail ? { status: 500, body: { error: { code: 'unavailable' } } } : { body: { items: w.library, nextCursor: null } }) }
    const { agent } = await loaded(failing)
    fail = true
    await agent.refresh('library')
    expect(agent.listFiles().map(f => f.id)).toEqual([F('kept')])
    expect(agent.read().resources.library).toEqual({ status: 'ready' })
    fail = false
    const t = await attached(failing)
    fail = true
    t.sockets[0].say(finished)
    await settle(); await settle(); await settle()
    expect(t.agent.listFiles().map(f => f.id)).toEqual([F('kept')])
    expect(t.agent.read().resources.library).toEqual({ status: 'ready' })
  })

  test('a run\'s end while a page\'s read is on its way reads once more after it', async () => {
    const { w, routes } = world()
    const sockets: FakeSocket[] = []
    const h = held(routes, '/api/library?limit=100')
    const agent = new HttpAgent({ fetch: h.fetch, now: () => NOW, origin: '', openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s }, after: () => {} })
    await agent.whenLoaded()
    agent.attach(RUN, () => {})
    await settle()
    sockets[0].onopen?.()
    h.hold()
    const reading = agent.refresh('library')
    await settle()
    // The run saved a file after the page's read left: that read can't hold it.
    w.library = [file('made')]
    sockets[0].say(finished)
    // The page's read lands last: it must not leave its older list on screen.
    await settle(); await settle(); await settle()
    h.release()
    await reading
    await settle(); await settle()
    expect(countReads(h.calls, '/api/library?limit=100')).toBe(3)
    expect(agent.listFiles().map(f => f.id)).toEqual([F('made')])
  })

  test('the Inhouse team: nothing of the four read on start, its bell never, and a page it opens once', async () => {
    const { routes } = world()
    const { agent, calls } = await loaded({ ...routes, 'GET /api/me': { body: me({ role: 'inhouse' }) } })
    const four = ['/api/library?limit=100', '/api/today', '/api/activity?limit=100', '/api/notifications']
    expect(calls.filter(c => four.includes(c.path))).toEqual([])
    await agent.refresh('notifications')
    await agent.refresh('library')
    expect(calls.filter(c => four.includes(c.path)).map(c => c.path)).toEqual(['/api/library?limit=100'])
  })
})

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  send() {}
  close() {}
  say(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }) }
}
const RUN = 'r_AAAAAAAAAAAAAAAAAAAAAA'
const finished = { type: 'frame', frame: { v: 1, chatId: 'c1', runId: RUN, seq: 1, at: iso(1000), event: { type: 'run.finished', runId: RUN, turns: 1, durationMs: 10, cost: { minor: 3, currency: 'USD' } } } }
const settle = () => new Promise<void>(r => setTimeout(r, 0))

async function attached(routes: Routes) {
  const sockets: FakeSocket[] = []
  const s = server(routes)
  const agent = new HttpAgent({ fetch: s.fetch, now: () => NOW, origin: '', openSocket: () => { const w = new FakeSocket(); sockets.push(w); return w }, after: () => {} })
  await agent.whenLoaded()
  agent.attach(RUN, () => {})
  await settle()
  sockets[0].onopen?.()
  return { agent, sockets, ...s }
}

describe('a run\'s end reads the lists its work fills', () => {
  test('a chat turn that saved a file, found a card, logged a line and sent a notice shows all four once its run finishes', async () => {
    const { w, routes } = world()
    const { agent, sockets } = await attached(routes)
    w.library = [file('made')]
    w.today = [card('found')]
    w.activity = [line(NOW - 1000, 'Saved made.csv')]
    w.notifications = [notice('n1')]
    sockets[0].say(finished)
    await settle(); await settle(); await settle()
    expect(agent.listFiles().map(f => f.id)).toEqual([F('made')])
    expect(agent.read().problems.map(p => p.title)).toEqual(['found'])
    expect([...agent.read().activity.today, ...agent.read().activity.earlier].map(l => l.text)).toEqual(['Saved made.csv'])
    expect(agent.listNotifications().map(n => n.id)).toEqual(['n1'])
  })

  test('the Inhouse team isn\'t read on a run\'s end it didn\'t ask for', async () => {
    const { routes } = world()
    const { calls, sockets } = await attached({ ...routes, 'GET /api/me': { body: me({ role: 'inhouse' }) } })
    sockets[0].say(finished)
    await settle(); await settle(); await settle()
    expect(calls.filter(c => ['/api/library?limit=100', '/api/today', '/api/activity?limit=100', '/api/notifications'].includes(c.path))).toEqual([])
  })
})
