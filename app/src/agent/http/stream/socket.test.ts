// The chat socket over a fake WebSocket, fake timers and a fake reauth. Ways it could break what a person sees, written
// down before the tests:
//  - a re-attach from the last frame seen instead of the last contiguous seq (a hole stays for ever, or a frame shows twice);
//  - a re-attach loop: `attached` that says "more" when nothing new can come, or an unreadable frame that asks again;
//  - a close code that does the wrong thing: 4401 that doesn't ask the sign-in, 4403 that reconnects (its data must stay
//    dropped), 4409 that reconnects (it would loop on a server this build can't read), 1012 that doesn't hold and reconnect;
//  - a socket that is left open after the last run is detached, or after sign out, or that reconnects after either;
//  - a refused run that keeps being followed.
import { describe, expect, test } from 'vitest'
import { ChatSocket } from './socket'
import type { SocketLike, SocketParts } from './socket'
import type { LinkState, RunFrame } from '../../types'

class FakeSocket implements SocketLike {
  sent: { type: string; runId: string; fromSeq?: number }[] = []
  closedWith: number | null = null
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close(code?: number) { this.closedWith = code ?? 1000 }
  // The server's side.
  open() { this.onopen?.() }
  say(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }) }
  drop(code: number) { this.onclose?.({ code }) }
}

const RUN = 'r_AAAAAAAAAAAAAAAAAAAAAA'
const AT = { iso: '2026-11-20T10:00:00.000Z', ms: 1 }
const frame = (seq: number, o: Record<string, unknown> = {}) => ({ type: 'frame', frame: { v: 1, chatId: 'c1', runId: RUN, seq, at: AT, event: { type: 'notice', code: 'paused', n: seq }, ...o } })
const attached = (lastSeq: number, runId = RUN) => ({ type: 'attached', runId, lastSeq, live: true })

const parts: SocketParts = {
  accepts: v => v === 1,
  // An event is readable when it has a string type (a test makes one unreadable by dropping it).
  parseEvent: raw => (typeof raw === 'object' && raw !== null && typeof (raw as { type?: unknown }).type === 'string' ? (raw as never) : null),
  parseControl: raw => {
    const m = raw as { type?: string; runId?: string; lastSeq?: number; code?: string }
    if (m.type === 'attached') return { type: 'attached', runId: m.runId!, lastSeq: m.lastSeq! }
    if (m.type === 'refused') return { type: 'refused', runId: m.runId!, code: m.code as never }
    return null
  },
}

function rig(o: { reauth?: () => Promise<boolean> } = {}) {
  const sockets: FakeSocket[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const grantEnded: number[] = []
  const reauths: number[] = []
  const links: LinkState[] = []
  const socket = new ChatSocket({
    open: () => { const s = new FakeSocket(); sockets.push(s); return s },
    parts: () => Promise.resolve(parts),
    onReauth: () => { reauths.push(1); return o.reauth ? o.reauth() : Promise.resolve(true) },
    onGrantEnded: () => { grantEnded.push(1) },
    after: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    cancel: () => undefined,
  })
  socket.onLink(s => links.push(s))
  const got: number[] = []
  const attach = (fromSeq = 0, onRefused?: (c: string) => void) => socket.attach(RUN, (f: RunFrame) => got.push(f.seq), fromSeq, onRefused as never)
  /** Lets the chunk load and the socket open. */
  const settle = () => new Promise<void>(r => setTimeout(r, 0))
  return { socket, sockets, timers, grantEnded, reauths, links, got, attach, settle }
}

describe('following a run', () => {
  test('opens with the first run, attaches from the seq asked for once it is open, and hands each frame on once and in order', async () => {
    const t = rig()
    t.attach(0)
    await t.settle()
    expect(t.sockets).toHaveLength(1)
    t.sockets[0].open()
    expect(t.sockets[0].sent).toEqual([{ type: 'attach', runId: RUN, fromSeq: 0 }])
    for (const seq of [1, 2, 2, 3, 1]) t.sockets[0].say(frame(seq))
    expect(t.got).toEqual([1, 2, 3])
  })

  test('a gap asks once for a re-attach from the last contiguous seq, and the frames that fill it come out in order', async () => {
    const t = rig()
    t.attach(0)
    await t.settle()
    const ws = t.sockets[0]
    ws.open()
    for (const seq of [1, 2, 4, 5]) ws.say(frame(seq))
    expect(t.got).toEqual([1, 2])
    expect(ws.sent.slice(1)).toEqual([{ type: 'attach', runId: RUN, fromSeq: 2 }])
    ws.say(frame(3)); ws.say(frame(4)); ws.say(frame(5))
    expect(t.got).toEqual([1, 2, 3, 4, 5])
  })

  test('after a drop it connects again and attaches from the last contiguous seq, not from the last frame seen', async () => {
    const t = rig()
    t.attach(0)
    await t.settle()
    t.sockets[0].open()
    for (const seq of [1, 2, 4]) t.sockets[0].say(frame(seq))
    t.sockets[0].drop(1006)
    expect(t.socket.link()).toBe('held')
    expect(t.timers.map(x => x.ms)).toEqual([500])
    t.timers[0].fn()
    expect(t.sockets).toHaveLength(2)
    t.sockets[1].open()
    expect(t.sockets[1].sent).toEqual([{ type: 'attach', runId: RUN, fromSeq: 2 }])
    expect(t.socket.link()).toBe('live')
    t.sockets[1].say(frame(3)); t.sockets[1].say(frame(4))
    expect(t.got).toEqual([1, 2, 3, 4])
  })

  test('a drop that keeps failing waits longer each time, up to 10 s, and a good open starts the wait again', async () => {
    const t = rig()
    t.attach(0)
    await t.settle()
    const waits: number[] = []
    for (let i = 0; i < 7; i++) {
      t.sockets[i].drop(1006)
      waits.push(t.timers.at(-1)!.ms)
      t.timers.at(-1)!.fn()
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000])
    t.sockets[7].open()
    t.sockets[7].drop(1006)
    expect(t.timers.at(-1)!.ms).toBe(500)
  })

  test('`attached` that says the server holds more than the feed has attaches again from the contiguous seq, and never twice from the same place', async () => {
    const t = rig()
    t.attach(0)
    await t.settle()
    const ws = t.sockets[0]
    ws.open()
    for (const seq of [1, 2, 3]) ws.say(frame(seq))
    ws.say(attached(10))
    ws.say(attached(10))
    ws.say(attached(10))
    expect(ws.sent.slice(1)).toEqual([{ type: 'attach', runId: RUN, fromSeq: 3 }])
    // Progress (a page of the replay came) lets it ask from further on.
    for (const seq of [4, 5]) ws.say(frame(seq))
    ws.say(attached(10))
    expect(ws.sent.slice(1)).toEqual([{ type: 'attach', runId: RUN, fromSeq: 3 }, { type: 'attach', runId: RUN, fromSeq: 5 }])
  })

  test('an event it can\'t read is skipped without a re-attach, and the frames after it still come', async () => {
    const t = rig()
    t.attach(0)
    await t.settle()
    const ws = t.sockets[0]
    ws.open()
    ws.say(frame(1)); ws.say(frame(2, { event: { nothing: true } })); ws.say(frame(3))
    expect(t.got).toEqual([1, 3])
    expect(ws.sent).toHaveLength(1)
  })

  test('a frame of a version this build can\'t read asks for a reload: the socket closes, nothing reconnects, nothing more is followed', async () => {
    const t = rig()
    t.attach(0)
    await t.settle()
    const ws = t.sockets[0]
    ws.open()
    ws.say(frame(1)); ws.say(frame(2, { v: 2 })); ws.say(frame(3))
    expect(t.got).toEqual([1])
    expect(t.socket.link()).toBe('reload')
    expect(ws.closedWith).not.toBeNull()
    expect(t.timers).toEqual([])
    t.attach(0)
    await t.settle()
    expect(t.sockets).toHaveLength(1)
  })

  test('a refused run calls onRefused with the code and is followed no more; the last one closes the socket', async () => {
    const t = rig()
    const refused: string[] = []
    t.attach(0, c => refused.push(c))
    await t.settle()
    const ws = t.sockets[0]
    ws.open()
    ws.say({ type: 'refused', runId: RUN, code: 'not_found' })
    ws.say(frame(1))
    expect(refused).toEqual(['not_found'])
    expect(t.got).toEqual([])
    expect(ws.closedWith).not.toBeNull()
  })

  test('a second run on an open socket attaches at once; detaching sends detach, and the last detach closes the socket', async () => {
    const t = rig()
    const other = 'r_BBBBBBBBBBBBBBBBBBBBBB'
    const off1 = t.attach(0)
    await t.settle()
    const ws = t.sockets[0]
    ws.open()
    const off2 = t.socket.attach(other, () => undefined, 7)
    expect(ws.sent.at(-1)).toEqual({ type: 'attach', runId: other, fromSeq: 7 })
    off1()
    expect(ws.sent.at(-1)).toEqual({ type: 'detach', runId: RUN })
    expect(ws.closedWith).toBeNull()
    off2()
    expect(ws.closedWith).not.toBeNull()
    expect(t.timers).toEqual([])
  })
})

describe('what each close code does (design 4.10)', () => {
  test('4401 asks the sign-in; still signed in reconnects at once and re-attaches from the contiguous seq', async () => {
    const t = rig()
    t.attach(0)
    await t.settle()
    t.sockets[0].open()
    t.sockets[0].say(frame(1))
    t.sockets[0].drop(4401)
    expect(t.reauths).toHaveLength(1)
    expect(t.socket.link()).toBe('held')
    await t.settle()
    expect(t.timers.map(x => x.ms)).toEqual([0])
    t.timers[0].fn()
    t.sockets[1].open()
    expect(t.sockets[1].sent).toEqual([{ type: 'attach', runId: RUN, fromSeq: 1 }])
  })

  test('4401 with the sign-in gone drops every run and does not reconnect', async () => {
    const t = rig({ reauth: () => Promise.resolve(false) })
    t.attach(0)
    await t.settle()
    t.sockets[0].open()
    t.sockets[0].drop(4401)
    await t.settle()
    expect(t.timers).toEqual([])
    expect(t.sockets).toHaveLength(1)
  })

  test('4403 drops every run, tells the client to drop the grant\'s data, shows grantEnded and never reconnects', async () => {
    const t = rig()
    t.attach(0)
    await t.settle()
    t.sockets[0].open()
    t.sockets[0].drop(4403)
    expect(t.socket.link()).toBe('grantEnded')
    expect(t.grantEnded).toHaveLength(1)
    expect(t.timers).toEqual([])
    t.attach(0)
    await t.settle()
    expect(t.sockets).toHaveLength(1)
  })

  test('4409 asks for a reload and never reconnects', async () => {
    const t = rig()
    t.attach(0)
    await t.settle()
    t.sockets[0].open()
    t.sockets[0].drop(4409)
    expect(t.socket.link()).toBe('reload')
    expect(t.timers).toEqual([])
  })

  test('1012 shows held, reconnects, and is live again once it is open', async () => {
    const t = rig()
    t.attach(0)
    await t.settle()
    t.sockets[0].open()
    t.sockets[0].drop(1012)
    expect(t.links).toEqual(['held'])
    t.timers[0].fn()
    t.sockets[1].open()
    expect(t.links).toEqual(['held', 'live'])
  })

  test('sign out closes the socket first: nothing reconnects, and a drop that follows does nothing', async () => {
    const t = rig()
    t.attach(0)
    await t.settle()
    const ws = t.sockets[0]
    ws.open()
    t.socket.close()
    expect(ws.closedWith).not.toBeNull()
    ws.drop(1006)
    expect(t.timers).toEqual([])
    expect(t.sockets).toHaveLength(1)
  })
})
