// Push delivery (protocol v2), the pusher alone on a fake clock and a fake egress. Ways it could fail, written first:
// - an egress that drops, delays, duplicates or 500s batches ends up holding a different event list than was pushed
//   (a loss, a repeat, a reorder), or a resent batch differs from the first send of it;
// - a second batch goes while an earlier one is unacked (a resend could overtake it and look like a seq gap);
// - a quiet run gets no heartbeat for 30 s (the Worker's watchdog fails it), or gets one after its terminal event;
// - a batch's body passes the egress's byte cap when the buffer has run past its own;
// - a slow egress lets the buffer grow without bound, or a full buffer drops events instead of pausing the session;
// - a 410 is retried, or events after it are still sent;
// - an ack with stop is acted on twice, or stops the pushing (the checkpoint, terminal and released must still go);
// - an ack below the batch's last seq counts as delivered;
// - the pusher never finishes after `released` is acked, or finishes before.
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { PUSH_BATCH_MAX_BYTES, PushBatch, type RunEvent } from '../../../shared/protocol/index.ts'
import { HEARTBEAT_MS, LINGER_MS, createPusher, type PushFetch, type Timers } from '../../src/server/pusher.ts'

/** A fake clock: timers fire only when the test advances it. */
function fakeClock(): Timers & { advance(ms: number): Promise<void>; pending(): number } {
  let now = 0
  let id = 0
  const due = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      due.set(++id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (h) => void due.delete(h as number),
    pending: () => due.size,
    async advance(ms) {
      const until = now + ms
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at
        due.delete(next[0])
        next[1].fn()
        await settle()
      }
      now = until
      await settle()
    },
  }
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

const RUN = 't_run'
const ev = (seq: number, body: Record<string, unknown>): RunEvent => ({ runId: RUN, seq, ...body }) as RunEvent
/** A literal run: started, 23 sdk messages, a checkpoint, finished, released. */
const LITERAL: RunEvent[] = [
  ev(0, { type: 'started', sessionId: '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11', resume: false }),
  ...Array.from({ length: 23 }, (_, i) => ev(i + 1, { type: 'sdk', message: { type: 'assistant', i }, truncated: false })),
  ev(24, { type: 'checkpoint', mainEntries: 30, lastUuid: 'u-29', lastUuidIndex: 29, runEntries: 24 }),
  ev(25, { type: 'finished', subtype: 'success', isError: false, numTurns: 3, costUsd: 0.01, usage: {} }),
  ev(26, { type: 'released', checkpoint: { mainEntries: 30, lastUuid: 'u-29', lastUuidIndex: 29 }, queryRan: true }),
]

type Fault = 'ok' | 'drop' | 'fail500' | 'duplicate' | 'lostAck'
/** A fake egress: what it holds (deduped by seq), every batch body sent, and whether two were ever in flight at once. */
function fakeEgress(faults: () => Fault, opts: { stop?: boolean; gone?: (n: number) => boolean } = {}) {
  const held: RunEvent[] = []
  const bodies: string[] = []
  let inFlight = 0
  let overlapped = false
  let calls = 0
  const take = (events: RunEvent[]) => {
    for (const e of events) if (e.seq === held.length) held.push(e)
  }
  const fetch: PushFetch = async (_url, init) => {
    const n = calls++
    bodies.push(init.body)
    if (inFlight > 0) overlapped = true
    inFlight++
    try {
      await settle()
      const batch = PushBatch.parse(JSON.parse(init.body))
      if (opts.gone?.(n)) return new Response('ended', { status: 410 })
      const f = faults()
      if (f === 'drop') throw new Error('connection reset')
      if (f === 'fail500') return new Response('down', { status: 500 })
      take(batch.events)
      // The batch landed but its ack was lost on the way back: the sender must send it again; the egress dedupes.
      if (f === 'lostAck') throw new Error('socket hang up')
      if (f === 'duplicate') take(batch.events)
      return Response.json({ ackSeq: held.length - 1, stop: opts.stop ?? false })
    } finally {
      inFlight--
    }
  }
  return { fetch, held, bodies, overlapped: () => overlapped }
}

function pusherOn(clock: ReturnType<typeof fakeClock>, egress: { fetch: PushFetch }, over: Partial<Parameters<typeof createPusher>[0]> = {}) {
  const calls = { heartbeats: 0, stops: 0, gone: 0, full: [] as boolean[] }
  const p = createPusher({
    runId: RUN,
    token: 'tok_0123456789abcdef0123',
    egressUrl: 'http://egress.internal',
    fetch: egress.fetch,
    timers: clock,
    log: () => {},
    heartbeat: () => void calls.heartbeats++,
    onStop: () => void calls.stops++,
    onGone: () => void calls.gone++,
    onFull: (f) => void calls.full.push(f),
    ...over,
  })
  return { p, calls }
}

describe('the pusher', () => {
  it.prop([fc.array(fc.constantFrom<Fault>('ok', 'drop', 'fail500', 'duplicate', 'lostAck'), { minLength: 1, maxLength: 40 }), fc.array(fc.nat(30), { minLength: 1, maxLength: 10 })])(
    'whatever the egress drops, delays, duplicates or 500s: it ends holding exactly the literal list, and never two batches in flight',
    async (faultList, gaps) => {
      const clock = fakeClock()
      let i = 0
      // The faults run out into 'ok', so delivery always ends.
      const egress = fakeEgress(() => faultList[i++] ?? 'ok')
      const { p } = pusherOn(clock, egress)
      let done = false
      void p.done.then(() => (done = true))
      for (const [k, e] of LITERAL.entries()) {
        p.push(e)
        await clock.advance(gaps[k % gaps.length]!)
      }
      for (let t = 0; t < 200 && !done; t++) await clock.advance(1000)
      expect(done).toBe(true)
      expect(egress.held).toEqual(LITERAL)
      expect(egress.overlapped()).toBe(false)
      // A resend is the same batch, byte for byte: each body sent is a run of consecutive seqs starting where the
      // egress's ack left off or at a batch sent before.
      const firsts = egress.bodies.map((b) => (JSON.parse(b) as { events: RunEvent[] }).events[0]!.seq)
      for (const [k, b] of egress.bodies.entries()) {
        const prev = egress.bodies.slice(0, k).find((x) => (JSON.parse(x) as { events: RunEvent[] }).events[0]!.seq === firsts[k])
        if (prev !== undefined) expect(b).toBe(prev)
      }
      expect(p.ackedSeq()).toBe(26)
    },
  )

  it('flushes at 20 events without waiting for the clock, and on the terminal event', async () => {
    const clock = fakeClock()
    const egress = fakeEgress(() => 'ok')
    const { p } = pusherOn(clock, egress)
    for (const e of LITERAL.slice(0, 19)) p.push(e)
    await settle()
    expect(egress.bodies).toHaveLength(0)
    p.push(LITERAL[19]!)
    await settle()
    expect(egress.bodies).toHaveLength(1)
    expect((JSON.parse(egress.bodies[0]!) as { events: RunEvent[] }).events.map((e) => e.seq)).toEqual([...Array(20).keys()])
    for (const e of LITERAL.slice(20, 26)) p.push(e)
    await settle()
    expect(egress.held.map((e) => e.seq)).toEqual([...Array(26).keys()])
  })

  it('the linger: an event at t=0 is pushed by 250 ms, not before; later events in the window ride along', async () => {
    const clock = fakeClock()
    const egress = fakeEgress(() => 'ok')
    const { p } = pusherOn(clock, egress)
    p.push(LITERAL[0]!)
    await clock.advance(100)
    p.push(LITERAL[1]!)
    await clock.advance(LINGER_MS - 101)
    expect(egress.bodies).toHaveLength(0)
    await clock.advance(1)
    expect(egress.held.map((e) => e.seq)).toEqual([0, 1])
    expect(egress.bodies).toHaveLength(1)
  })

  it('events that queue while a batch is in flight go in the next batch right after its ack, with no linger', async () => {
    const clock = fakeClock()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const base = fakeEgress(() => 'ok')
    let first = true
    const egress = {
      fetch: (async (url, init) => {
        if (first) {
          first = false
          await gate
        }
        return base.fetch(url, init)
      }) as PushFetch,
    }
    const { p } = pusherOn(clock, egress)
    p.push(LITERAL[0]!)
    await clock.advance(LINGER_MS)
    p.push(LITERAL[1]!)
    p.push(LITERAL[2]!)
    await clock.advance(10 * LINGER_MS)
    expect(base.bodies).toHaveLength(0)
    release()
    // Each fake push takes a few turns of the loop; the clock doesn't move.
    for (let i = 0; i < 4; i++) await settle()
    // The ack came with no clock moving: the queued two went at once.
    expect(base.held.map((e) => e.seq)).toEqual([0, 1, 2])
    expect(base.bodies.map((b) => (JSON.parse(b) as { events: RunEvent[] }).events.length)).toEqual([1, 2])
  })

  it('a silent run gets one heartbeat per 30 s with nothing sent, and none after its terminal event', async () => {
    const clock = fakeClock()
    const egress = fakeEgress(() => 'ok')
    let seq = 1
    const holder: { p?: ReturnType<typeof createPusher> } = {}
    const { p } = pusherOn(clock, egress, { heartbeat: () => holder.p!.push(ev(seq++, { type: 'heartbeat' })) })
    holder.p = p
    p.push(LITERAL[0]!)
    await clock.advance(LINGER_MS)
    expect(egress.held.map((e) => e.type)).toEqual(['started'])
    // 30 s after that send, one heartbeat; none before.
    await clock.advance(HEARTBEAT_MS - 1)
    expect(egress.held.map((e) => e.type)).toEqual(['started'])
    await clock.advance(1)
    expect(egress.held.map((e) => e.type)).toEqual(['started', 'heartbeat'])
    await clock.advance(HEARTBEAT_MS)
    expect(egress.held.map((e) => e.type)).toEqual(['started', 'heartbeat', 'heartbeat'])
    // Traffic resets the clock: an event 20 s in means no heartbeat at 30 s.
    await clock.advance(20_000)
    p.push(ev(seq++, { type: 'sdk', message: { type: 'assistant' }, truncated: false }))
    await clock.advance(HEARTBEAT_MS - 20_000)
    expect(egress.held.filter((e) => e.type === 'heartbeat')).toHaveLength(2)
    p.push(ev(seq++, { type: 'failed', reason: 'stopped', message: 'stopped' }))
    await settle()
    await clock.advance(5 * HEARTBEAT_MS)
    expect(egress.held.map((e) => e.type)).toEqual(['started', 'heartbeat', 'heartbeat', 'sdk', 'failed'])
  })

  it('a slow egress: the buffer goes over its cap, says full once, and says so again only after acks bring it under', async () => {
    const clock = fakeClock()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const base = fakeEgress(() => 'ok')
    const egress = {
      fetch: (async (url, init) => {
        await held
        return base.fetch(url, init)
      }) as PushFetch,
    }
    const { p, calls } = pusherOn(clock, egress, { maxBytes: 4096 })
    const big = (seq: number) => ev(seq, { type: 'sdk', message: { type: 'assistant', blob: 'b'.repeat(1000) }, truncated: false })
    for (let s = 0; s < 30; s++) p.push(big(s))
    await settle()
    // Nothing dropped: every event is still held, over the cap.
    expect(calls.full).toEqual([true])
    expect(p.bufferedBytes()).toBeGreaterThan(4096)
    release()
    await clock.advance(HEARTBEAT_MS)
    await clock.advance(HEARTBEAT_MS)
    expect(base.held.map((e) => e.seq)).toEqual([...Array(30).keys()])
    expect(calls.full).toEqual([true, false])
    expect(p.bufferedBytes()).toBe(0)
  })

  it('a buffer run past its cap still goes in batches under the egress body cap (PUSH_BATCH_MAX_BYTES), all delivered in order', async () => {
    const clock = fakeClock()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const base = fakeEgress(() => 'ok')
    const egress = {
      fetch: (async (url, init) => {
        await held
        return base.fetch(url, init)
      }) as PushFetch,
    }
    const { p } = pusherOn(clock, egress)
    // 60 events of about 200 KB: about 12 MB queued behind a held push (a stopping session is read on past the cap).
    const big = (seq: number) => ev(seq, { type: 'sdk', message: { type: 'assistant', blob: 'b'.repeat(200 * 1024) }, truncated: false })
    for (let s = 0; s < 60; s++) p.push(big(s))
    release()
    for (let i = 0; i < 40 && base.held.length < 60; i++) await clock.advance(LINGER_MS)
    expect(base.held.map((e) => e.seq)).toEqual([...Array(60).keys()])
    for (const b of base.bodies) expect(new TextEncoder().encode(b).length).toBeLessThanOrEqual(PUSH_BATCH_MAX_BYTES)
    expect(base.bodies.length).toBeGreaterThan(5)
  })

  it('a 410 drops the batch, says gone once, sends nothing after it and finishes', async () => {
    const clock = fakeClock()
    const egress = fakeEgress(() => 'ok', { gone: (n) => n >= 1 })
    const { p, calls } = pusherOn(clock, egress)
    for (const e of LITERAL.slice(0, 20)) p.push(e)
    await settle()
    for (const e of LITERAL.slice(20, 26)) p.push(e)
    await settle()
    await p.done
    for (const e of LITERAL.slice(26)) p.push(e)
    await clock.advance(10 * HEARTBEAT_MS)
    expect(calls.gone).toBe(1)
    expect(egress.bodies).toHaveLength(2)
    expect(egress.held.map((e) => e.seq)).toEqual([...Array(20).keys()])
  })

  it('an ack with stop: onStop once, and every later event (checkpoint, terminal, released) is still pushed', async () => {
    const clock = fakeClock()
    const egress = fakeEgress(() => 'ok', { stop: true })
    const { p, calls } = pusherOn(clock, egress)
    for (const e of LITERAL) {
      p.push(e)
      await settle()
    }
    await p.done
    expect(calls.stops).toBe(1)
    expect(egress.held).toEqual(LITERAL)
  })

  it('an ack below the batch is not a delivery: the batch is sent again', async () => {
    const clock = fakeClock()
    const sent: number[] = []
    let first = true
    const egress = {
      fetch: (async (_url, init) => {
        const b = PushBatch.parse(JSON.parse(init.body))
        sent.push(b.events.length)
        // The first answer acks one short of the batch's last seq.
        const ack = b.events.at(-1)!.seq - (first ? 1 : 0)
        first = false
        return Response.json({ ackSeq: ack, stop: false })
      }) as PushFetch,
    }
    const { p } = pusherOn(clock, egress)
    for (const e of LITERAL.slice(0, 20)) p.push(e)
    await settle()
    expect(p.ackedSeq()).toBeNull()
    await clock.advance(1000)
    expect(sent).toEqual([20, 20])
    expect(p.ackedSeq()).toBe(19)
  })
})

// #137 review round 1 (lows).
describe('the pusher, round 1', () => {
  it('a non-200 answer has its body cancelled (the connection is freed); a 200 is read', async () => {
    const clock = fakeClock()
    const cancelled: number[] = []
    let n = 0
    const egress = {
      fetch: (async () => {
        const status = [500, 401, 429][n++] ?? 200
        const body = new ReadableStream({ cancel: () => void cancelled.push(status) })
        return status === 200 ? Response.json({ ackSeq: 0, stop: false }) : new Response(body, { status })
      }) as PushFetch,
    }
    const { p } = pusherOn(clock, egress)
    p.push(LITERAL[0]!)
    for (let i = 0; i < 10 && p.ackedSeq() === null; i++) await clock.advance(20_000)
    expect(p.ackedSeq()).toBe(0)
    expect(cancelled).toEqual([500, 401, 429])
  })

  it('after released, delivery gives up once it has failed for giveUpMs, and finishes', async () => {
    const clock = fakeClock()
    const egress = fakeEgress(() => 'fail500')
    const { p } = pusherOn(clock, egress, { giveUpMs: 60_000 })
    let done = false
    void p.done.then(() => (done = true))
    for (const e of LITERAL) p.push(e)
    await clock.advance(59_000)
    expect(done).toBe(false)
    for (let i = 0; i < 20 && !done; i++) await clock.advance(15_000)
    expect(done).toBe(true)
    const sends = egress.bodies.length
    await clock.advance(10 * 60_000)
    expect(egress.bodies.length).toBe(sends)
  })

  it('before released, delivery never gives up (the run is still live)', async () => {
    const clock = fakeClock()
    const egress = fakeEgress(() => 'fail500')
    const { p } = pusherOn(clock, egress, { giveUpMs: 60_000 })
    let done = false
    void p.done.then(() => (done = true))
    p.push(LITERAL[0]!)
    for (let i = 0; i < 40; i++) await clock.advance(15_000)
    expect(done).toBe(false)
    expect(egress.bodies.length).toBeGreaterThan(5)
  })
})
