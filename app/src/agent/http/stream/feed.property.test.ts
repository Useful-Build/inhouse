// The run feed and the chat view, against streams written by hand (testing/streams.ts). Ways this can fail, written first:
//  1. a frame seen twice (a replay, a stale tab) adds a message or an event twice;
//  2. a lost frame (the terminal one too) leaves the view short and nothing ever asks for it again;
//  3. a frame ahead of the next one is applied early, so a part shows before its turn started;
//  4. a replay cut in the middle, then resumed from the last contiguous seq, skips or repeats a frame;
//  5. an event this build can't read loops the re-attach, or stops later events;
//  6. a frame of an unaccepted version is read anyway, or asks to reload more than once.
// The oracle is each stream's hand-written message list; the harness shares no code with the feed or the reducer.
import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { ChatEventSchema, acceptsChatVersion } from '../../../../shared/contract/runs'
import { emptyView, reduce } from '../../../screens/chat/view'
import type { ChatView } from '../../../screens/chat/view'
import { RunFeed } from './feed'
import type { FeedParts } from './feed'
import { STREAMS, UNSUPPORTED } from './testing/streams'
import type { Frame, Row, Stream } from './testing/streams'

const parts = (log: string[] = []): FeedParts => ({
  accepts: acceptsChatVersion,
  parseEvent: raw => { const r = ChatEventSchema.safeParse(raw); return r.success ? r.data : null },
  logSkip: seq => { log.push(`skip ${seq}`) },
})

/** What a message is, in words, from the view (the oracle's own reading of a message, not the code's). */
const rowsOf = (v: ChatView): Row[] => v.messages.map(m => ({
  id: m.id, role: m.role,
  text: m.role === 'agent' ? (m.part.type === 'text' ? m.part.text : m.part.type === 'error' ? m.part.text : `[${m.part.type}]`) : m.text,
}))

/** A tab: a feed and the view it builds. Frames in; what the feed hands on goes through the reducer. */
function tab(stream: Stream, log: string[] = []) {
  const feed = new RunFeed(stream.runId, parts(log))
  let view = emptyView()
  const delivered: number[] = []
  const outcomes: string[] = []
  /** The contiguous seqs a re-attach was asked from: at most once each until the tab itself attaches again. */
  const asks = new Set<number>()
  const take = (f: Frame) => {
    const r = feed.push(f)
    if (r.reattachFrom !== null) {
      expect(r.reattachFrom, 'it asks from the last contiguous seq').toBe(feed.contiguous)
      expect(asks.has(r.reattachFrom), `one ask per gap, not again for ${r.reattachFrom}`).toBe(false)
      asks.add(r.reattachFrom)
    }
    for (const o of r.out) {
      if (o.kind === 'reload') { outcomes.push('reload'); continue }
      delivered.push(o.seq)
      view = reduce(view, o.event, o.at, o.runId)
    }
    return r
  }
  return { feed, take, asks, get view() { return view }, delivered, outcomes }
}

/** The server's replay: every frame after `from`, at most `cut` of them (a connection that drops mid-replay). */
const replay = (s: Stream, from: number, cut = Infinity) => s.frames.filter(f => f.seq > from).slice(0, cut)

describe('each stream renders its hand-written message list', () => {
  for (const s of STREAMS) {
    test(`${s.name}: in order`, () => {
      const t = tab(s)
      s.frames.forEach(f => t.take(f))
      expect(rowsOf(t.view)).toEqual(s.rows)
      expect(t.view.openRuns, 'the run ended').toEqual([])
    })
  }
})

/** One thing a flaky connection does to a tab, as a number the generator picks. */
const ops = fc.array(fc.oneof(
  fc.record({ op: fc.constant('deliver' as const), n: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ op: fc.constant('dup' as const), at: fc.nat(30) }),
  fc.record({ op: fc.constant('drop' as const), n: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ op: fc.constant('jump' as const), by: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ op: fc.constant('reconnect' as const), cut: fc.integer({ min: 0, max: 6 }) }),
), { maxLength: 30 })

describe('a flaky connection never changes what the chat shows', () => {
  test.prop([fc.constantFrom(...STREAMS), ops])('duplicates, stale frames, lost frames (the last too), jumps and replays cut short, then a full replay', (s, script) => {
    const log: string[] = []
    const t = tab(s, log)
    let next = 0 // the server's pointer: the next frame it would send live
    const asked: number[] = []
    for (const o of script) {
      if (o.op === 'deliver') for (let i = 0; i < o.n && next < s.frames.length; i++) t.take(s.frames[next++])
      else if (o.op === 'dup' && s.frames.length) t.take(s.frames[o.at % Math.min(next || 1, s.frames.length)])
      else if (o.op === 'drop') next = Math.min(s.frames.length, next + o.n)
      else if (o.op === 'jump' && next + o.by < s.frames.length) {
        // A frame ahead of the next one waits, and the feed asks to attach again from where it is contiguous.
        const f = s.frames[next + o.by]
        const ahead = f.seq > t.feed.contiguous + 1
        t.take(f)
        if (ahead) expect(t.asks.has(t.feed.contiguous), 'a frame ahead has asked to attach from the last contiguous seq').toBe(true)
      } else if (o.op === 'reconnect') {
        const from = t.feed.reattachFrom()
        t.asks.clear()
        asked.push(from)
        replay(s, from, o.cut).forEach(f => t.take(f))
        next = Math.max(next, Math.min(s.frames.length, from + o.cut))
      }
    }
    // However it went, the last reconnect replays the rest.
    const from = t.feed.reattachFrom()
    replay(s, from).forEach(f => t.take(f))
    expect(rowsOf(t.view), 'the same messages as a clean run').toEqual(s.rows)
    expect(t.delivered, 'each seq once, in order, none missing').toEqual(s.frames.map(f => f.seq).filter(seq => !log.some(l => l === `skip ${seq}`) && !isUnreadable(s, seq)))
    expect(t.feed.contiguous, 'it ended on the last frame').toBe(s.frames.length)
    expect(t.view.openRuns, 'the run ended even if its last frame was lost on the way').toEqual([])
    expect(asked.every(a => a >= 0 && a <= s.frames.length)).toBe(true)
  })

  /** Whether the stream's frame at `seq` is one this build can't read (the oracle reads the event type itself). */
  const isUnreadable = (s: Stream, seq: number) => (s.frames[seq - 1].event as { type: string }).type === 'future.event'

  test.prop([fc.constantFrom(...STREAMS), fc.array(fc.nat(7), { maxLength: 20 })])('a cut replay resumed from the last contiguous seq repeats and skips nothing', (s, cuts) => {
    const t = tab(s)
    for (const c of cuts) replay(s, t.feed.reattachFrom(), c % 4).forEach(f => t.take(f))
    replay(s, t.feed.reattachFrom()).forEach(f => t.take(f))
    expect(new Set(t.delivered).size, 'no seq twice').toBe(t.delivered.length)
    expect(t.delivered, 'in order').toEqual([...t.delivered].sort((a, b) => a - b))
    expect(rowsOf(t.view)).toEqual(s.rows)
  })
})

describe('an event this build cannot read', () => {
  const s = STREAMS[3]
  test('is skipped with its seq advanced, logged once, and never asks to attach again', () => {
    const log: string[] = []
    const t = tab(s, log)
    const asks = s.frames.map(f => t.take(f).reattachFrom)
    expect(asks.every(a => a === null), 'no re-attach for it').toBe(true)
    expect(log).toEqual(['skip 4'])
    expect(t.feed.contiguous).toBe(s.frames.length)
    expect(rowsOf(t.view)).toEqual(s.rows)
  })
  test('twice in a stream is still logged once', () => {
    const log: string[] = []
    const feed = new RunFeed(s.runId, parts(log))
    const odd = (seq: number): Frame => ({ ...s.frames[0], seq, event: { type: 'future.event' } })
    feed.push(odd(1)); feed.push(odd(2)); feed.push(odd(3))
    expect(log).toEqual(['skip 1'])
    expect(feed.contiguous).toBe(3)
  })
})

describe('a frame of a version this build does not accept', () => {
  test.prop([fc.array(fc.constantFrom('forward', 'dup', 'replay'), { maxLength: 15 })])('asks for a reload once, reads nothing after, and never asks to attach again', script => {
    const s = UNSUPPORTED
    const t = tab(s)
    let next = 0
    let reattaches = 0
    for (const o of script) {
      const r = o === 'forward' ? (next < s.frames.length ? t.take(s.frames[next++]) : null)
        : o === 'dup' ? t.take(s.frames[Math.max(0, next - 1)]) : (replay(s, t.feed.reattachFrom()).map(f => t.take(f)).at(-1) ?? null)
      if (r?.reattachFrom != null) reattaches++
    }
    s.frames.forEach(f => t.take(f))
    expect(t.outcomes, 'one reload prompt').toEqual(['reload'])
    expect(t.feed.reloadAsked).toBe(true)
    expect(Math.max(0, ...t.delivered), 'nothing at or after the unreadable frame').toBeLessThan(5)
    expect(reattaches, 'the feed never asked to attach again after the reload').toBeLessThanOrEqual(script.filter(o => o === 'forward').length)
  })
})

describe('the version rule, one frame at a time', () => {
  const feed = () => new RunFeed(STREAMS[0].runId, parts())
  const f = STREAMS[0].frames
  test('an envelope that is not one, or names another run, is dropped without a trace', () => {
    const r = feed()
    expect(r.push(null).out).toEqual([])
    expect(r.push({ v: 1 }).out).toEqual([])
    expect(r.push({ ...f[0], runId: 'r_Zzzzzzzzzzzzzzzzzzzzzz' }).out).toEqual([])
    expect(r.contiguous).toBe(0)
  })
  test('version 2 reloads before anything else about the frame is looked at', () => {
    const r = feed()
    expect(r.push({ ...f[0], v: 2, seq: 99, event: 'not even an object' }).out).toEqual([{ kind: 'reload' }])
    expect(r.contiguous, 'its seq did not move the feed').toBe(0)
  })
})

describe('an envelope that places but does not read', () => {
  const s = STREAMS[0]
  const f = s.frames
  test('is an unreadable event: its seq advances, it is skipped, logged once, and nothing asks to attach again', () => {
    const log: string[] = []
    const feed = new RunFeed(s.runId, parts(log))
    const broken = (seq: number, patch: Record<string, unknown>) => ({ ...f[seq - 1], ...patch })
    const results = [
      feed.push(f[0]),
      feed.push(broken(2, { at: 'yesterday' })), // no instant
      feed.push(broken(3, { chatId: 7 })), // no chat id
      feed.push(f[3]),
    ]
    expect(results.every(r => r.reattachFrom === null), 'no re-attach for any of them').toBe(true)
    expect(feed.contiguous, 'the seq moved past both').toBe(4)
    expect(log).toEqual(['skip 2'])
    expect(results.flatMap(r => r.out).map(o => (o.kind === 'event' ? o.seq : 0))).toEqual([1, 4])
  })
  test('a frame with no place at all (another run, no seq) is dropped, and the version is still read first', () => {
    const feed = new RunFeed(s.runId, parts())
    expect(feed.push({ ...f[0], seq: 'one' }).out).toEqual([])
    expect(feed.push({ ...f[0], seq: 0 }).out).toEqual([])
    expect(feed.push({ v: 1 }).out).toEqual([])
    expect(feed.contiguous).toBe(0)
    expect(feed.push({ v: 2, anything: 'at all' }).out, 'a newer version reloads whatever else is wrong with the frame').toEqual([{ kind: 'reload' }])
  })
})

describe('one re-attach per gap', () => {
  const s = STREAMS[0]
  test('frames landing beyond an open gap ask once, and again only after the tab attached itself', () => {
    const feed = new RunFeed(s.runId, parts())
    const asks = [s.frames[2], s.frames[3], s.frames[4], s.frames[2]].map(f => feed.push(f).reattachFrom)
    expect(asks).toEqual([0, null, null, null])
    expect(feed.reattachFrom(), 'the tab attaches from where it is contiguous').toBe(0)
    expect(feed.push(s.frames[5]).reattachFrom, 'a new attach that still leaves a gap may ask again').toBe(0)
    feed.push(s.frames[0]); feed.push(s.frames[1])
    expect(feed.contiguous, 'the gap closed and the waiting frames followed').toBe(6)
  })
  test('a frame ahead of a full waiting room is dropped, and the gap still asks', () => {
    const feed = new RunFeed(s.runId, parts())
    const at = s.frames[0].at
    const mk = (seq: number) => ({ ...s.frames[0], seq, at, event: { type: 'future.event' } })
    for (let seq = 2; seq < 2 + 2000; seq++) feed.push(mk(seq))
    const r = feed.push(mk(5000))
    expect(r.out).toEqual([])
    feed.push(mk(1))
    expect(feed.contiguous, 'everything that was kept followed seq 1').toBe(2001)
  })
})

describe('a frame seen twice', () => {
  const s = STREAMS[0]
  test('the first copy of a frame waiting ahead is the one delivered', () => {
    const feed = new RunFeed(s.runId, parts())
    const out: unknown[] = []
    const first = s.frames[2]
    const lookalike = { ...first, event: { type: 'turn.finished', turnId: 't_Aaaaaaaaaaaaaaaaaaaaaa', outcome: 'stopped' } }
    feed.push(first); feed.push(lookalike)
    feed.push(s.frames[0]); out.push(...feed.push(s.frames[1]).out)
    expect(out.map(o => (o as { event: { type: string } }).event.type)).toEqual(['turn.queued', 'turn.started'])
  })
})
