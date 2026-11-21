// The real client's socket, with the real schemas and a fake WebSocket: what the app sees on each close code, written
// first (the socket's own mechanics are in stream/socket.test.ts):
//  - a frame that doesn't parse as an event reaching the app, or one that does being lost;
//  - 4403 that leaves the chats or the memory on screen, or reconnects;
//  - 4401 that doesn't ask who is signed in, or that treats "offline" as signed out;
//  - sign out that leaves the socket open;
//  - a run's end that doesn't read the spending again.
import { describe, expect, test } from 'vitest'
import type { RunFrame } from '../types'
import { HttpAgent } from './client'
import type { SocketLike } from './stream/socket'
import { chatRow, iso, reads, refusal, server, usage } from './testing/fake-server'
import type { Routes } from './testing/fake-server'

class FakeSocket implements SocketLike {
  sent: unknown[] = []
  closedWith: number | null = null
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  send(d: string) { this.sent.push(JSON.parse(d)) }
  close(code?: number) { this.closedWith = code ?? 1000 }
  say(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }) }
}
const RUN = 'r_AAAAAAAAAAAAAAAAAAAAAA'
const frame = (seq: number, event: unknown, v = 1) => ({ type: 'frame', frame: { v, chatId: 'c1', runId: RUN, seq, at: iso(seq * 1000), event } })
const settle = () => new Promise<void>(r => setTimeout(r, 0))

async function rig(routes: Routes = reads({ chats: [chatRow('c1')] }), memory?: unknown) {
  const sockets: FakeSocket[] = []
  const timers: (() => void)[] = []
  const s = server(memory ? { ...routes, 'GET /api/memory': { body: memory } } : routes)
  const agent = new HttpAgent({ fetch: s.fetch, now: () => 5000, origin: '', openSocket: () => { const w = new FakeSocket(); sockets.push(w); return w }, after: fn => timers.push(fn) })
  await agent.whenLoaded()
  const got: RunFrame[] = []
  const attach = (fromSeq = 0) => agent.attach(RUN, f => got.push(f), fromSeq)
  const open = async () => { attach(); await settle(); sockets[0].onopen?.() }
  return { agent, sockets, timers, got, attach, open, ...s }
}

describe('frames through the real schemas', () => {
  test('a readable event reaches the app as a run frame, an unreadable one is skipped, and the run\'s end reads the spending again', async () => {
    let total = 1000
    const t = await rig({ ...reads({ chats: [chatRow('c1')] }), 'GET /api/usage': () => ({ body: usage({ total: { minor: total, currency: 'USD' } }) }) })
    await t.open()
    expect(t.sockets[0].sent).toEqual([{ type: 'attach', runId: RUN, fromSeq: 0 }])
    t.sockets[0].say(frame(1, { type: 'run.started', runId: RUN, chatId: 'c1' }))
    t.sockets[0].say(frame(2, { type: 'something.new', x: 1 }))
    total = 4000
    t.sockets[0].say(frame(3, { type: 'run.finished', runId: RUN, turns: 1, durationMs: 10, cost: { minor: 3, currency: 'USD' } }))
    await settle(); await settle()
    expect(t.got.map(f => [f.seq, f.event.type])).toEqual([[1, 'run.started'], [3, 'run.finished']])
    expect(t.agent.read().usage.total.minor).toBe(4000)
  })

  test('a frame of a version this build can\'t read puts the link in reload, and nothing after it is delivered', async () => {
    const t = await rig()
    await t.open()
    t.sockets[0].say(frame(1, { type: 'run.started', runId: RUN, chatId: 'c1' }, 2))
    t.sockets[0].say(frame(2, { type: 'run.started', runId: RUN, chatId: 'c1' }))
    expect(t.agent.link()).toBe('reload')
    expect(t.got).toEqual([])
  })

  test('a refused run calls onRefused with the code', async () => {
    const t = await rig()
    const refused: string[] = []
    t.agent.attach(RUN, () => undefined, 0, c => refused.push(c))
    await settle()
    t.sockets[0].onopen?.()
    t.sockets[0].say({ type: 'refused', runId: RUN, code: 'not_found' })
    expect(refused).toEqual(['not_found'])
  })
})

describe('close codes', () => {
  test('4403 drops the chats and the memory the grant showed, shows grantEnded and does not reconnect', async () => {
    const mem = { team: [{ group: 'Shared with the team', lines: [{ key: 'mem_AAAAAAAAAAAAAAAAAAAAAA', text: 'We restock on Fridays', source: 's', at: iso(1), rev: 1, scope: 'brand' }] }], personal: [] }
    const t = await rig(undefined, mem)
    expect(t.agent.allChatIds()).toEqual(['c1'])
    expect(t.agent.read().memory.team).toHaveLength(1)
    await t.open()
    t.sockets[0].onclose?.({ code: 4403 })
    expect(t.agent.link()).toBe('grantEnded')
    expect(t.agent.allChatIds()).toEqual([])
    expect(t.agent.read().memory).toEqual({ team: [], personal: [] })
    expect(t.timers).toEqual([])
  })

  test('4401 asks who is signed in: still signed in reconnects at once', async () => {
    const t = await rig()
    await t.open()
    t.sockets[0].onclose?.({ code: 4401 })
    await settle(); await settle()
    expect(t.calls.filter(c => c.path === '/api/me')).toHaveLength(2)
    expect(t.timers).toHaveLength(1)
    t.timers[0]()
    expect(t.sockets).toHaveLength(2)
  })

  test('4401 with a 401 on who is signed in is the signed-out state and does not reconnect; an offline answer is not signed out', async () => {
    let meCalls = 0
    const base = reads({ chats: [chatRow('c1')] })
    const t = await rig({ ...base, 'GET /api/me': () => (++meCalls === 1 ? base['GET /api/me'] as never : refusal(401, 'unauthorized')) })
    await t.open()
    t.sockets[0].onclose?.({ code: 4401 })
    await settle(); await settle()
    expect(t.agent.read().resources.meta).toMatchObject({ status: 'error', error: 'unauthorized' })
    expect(t.timers).toEqual([])
    expect(t.sockets).toHaveLength(1)

    // Offline: the fetch itself fails, so who is signed in isn't known to be gone: the socket tries again.
    const down = server(reads({ chats: [chatRow('c1')] }))
    let offline = false
    const sockets: FakeSocket[] = []
    const timers: (() => void)[] = []
    const agent = new HttpAgent({ fetch: (i, init) => (offline && String(i).endsWith('/api/me') ? Promise.reject(new TypeError('offline')) : down.fetch(i, init)), openSocket: () => { const w = new FakeSocket(); sockets.push(w); return w }, after: fn => timers.push(fn) })
    await agent.whenLoaded()
    agent.attach(RUN, () => undefined)
    await settle()
    sockets[0].onopen?.()
    offline = true
    sockets[0].onclose?.({ code: 4401 })
    await settle(); await settle()
    expect(agent.read().resources.meta.status).toBe('ready')
    expect(timers).toHaveLength(1)
  })

  test('sign out closes the socket first', async () => {
    const t = await rig()
    await t.open()
    t.agent.disconnect()
    expect(t.sockets[0].closedWith).not.toBeNull()
    t.sockets[0].onclose?.({ code: 1006 })
    expect(t.timers).toEqual([])
  })

  test('the link state follows: held on a drop, live once open again, and onLink tells each change once', async () => {
    const t = await rig()
    const seen: string[] = []
    t.agent.onLink(s => seen.push(s))
    await t.open()
    t.sockets[0].onclose?.({ code: 1012 })
    t.timers[0]()
    t.sockets[1].onopen?.()
    expect(seen).toEqual(['held', 'live'])
    expect(t.sockets[1].sent).toEqual([{ type: 'attach', runId: RUN, fromSeq: 0 }])
  })
})

describe('the socket\'s address', () => {
  test('opens /api/socket?v=1 on the page\'s origin with ws for http and wss for https', async () => {
    const urls: string[] = []
    class W extends FakeSocket { constructor(u: string) { super(); urls.push(u) } }
    const g = globalThis as unknown as { WebSocket?: unknown }
    const had = g.WebSocket
    g.WebSocket = W
    try {
      for (const origin of ['http://app.test', 'https://app.test']) {
        const s = server(reads())
        const agent = new HttpAgent({ fetch: s.fetch, origin })
        await agent.whenLoaded()
        agent.attach(RUN, () => undefined)
        await settle()
      }
    } finally { g.WebSocket = had }
    expect(urls).toEqual(['ws://app.test/api/socket?v=1', 'wss://app.test/api/socket?v=1'])
  })
})
