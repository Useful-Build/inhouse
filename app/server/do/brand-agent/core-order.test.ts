// Ordering (p3-design 4.2, 4.3, 4.6, 4.11) as a property: random interleavings of two chats' sends (new keys and
// retried ones, every priority), answers that finish and release early or late, resent batches, interrupt and stop
// with live, queued, ended and stale ids, and pause and resume, checked after every step against a reference model
// written below. The model shares no code with core.ts: it knows only the rules (one turn per chat in flight, the next
// one only after `released`, `now` > `next` > `later` then FIFO, stop ends that turn only, pause cancels the queue and
// fences what runs, resume starts nothing). Also checked on the stored rows: per-run seqs are 1..n with no gap, and no
// chat ever has two turns in `starting|live|ending`.
import { fc, test } from '@fast-check/vitest'
import { expect } from 'vitest'
import { MEMBER, ev, inAgent, settle } from '../../testing/brand-agent/core-harness.ts'
import type { RunEventBody } from '../../../shared/protocol/index.ts'

type Prio = 'now' | 'next' | 'later'
type Op =
  | { op: 'submit'; chat: 0 | 1; prio: Prio; retry: boolean }
  | { op: 'finish'; chat: 0 | 1 }
  | { op: 'release'; chat: 0 | 1 }
  | { op: 'resend'; chat: 0 | 1 }
  | { op: 'interrupt' | 'stop'; target: number }
  | { op: 'pause' } | { op: 'resume' }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ op: fc.constant('submit' as const), chat: fc.constantFrom(0 as const, 1 as const), prio: fc.constantFrom<Prio>('now', 'next', 'later'), retry: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('finish' as const), chat: fc.constantFrom(0 as const, 1 as const) }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('release' as const), chat: fc.constantFrom(0 as const, 1 as const) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('resend' as const), chat: fc.constantFrom(0 as const, 1 as const) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constantFrom('interrupt' as const, 'stop' as const), target: fc.integer({ min: -1, max: 12 }) }) },
  { weight: 1, arbitrary: fc.constant({ op: 'pause' as const }) },
  { weight: 1, arbitrary: fc.constant({ op: 'resume' as const }) },
)

// ---------- the reference model ----------
type Phase = 'queued' | 'live' | 'ending' | 'done'
interface MTurn { n: number; chat: number; prio: Prio; phase: Phase; arrival: number }
class Model {
  turns: MTurn[] = []
  paused = false
  private arrivals = 0
  inFlight(chat: number) { return this.turns.find(t => t.chat === chat && (t.phase === 'live' || t.phase === 'ending')) }
  queued(chat: number) {
    const rank = { now: 0, next: 1, later: 2 }
    return this.turns.filter(t => t.chat === chat && t.phase === 'queued').sort((a, b) => rank[a.prio] - rank[b.prio] || a.arrival - b.arrival)
  }
  startNext(chat: number) {
    if (this.paused || this.inFlight(chat)) return
    const next = this.queued(chat)[0]
    if (next) next.phase = 'live'
  }
  /** The new turn's number, or the refusal. */
  submit(chat: number, prio: Prio): number | 'paused' | 'queue_full' {
    if (this.paused) return 'paused'
    if (this.queued(chat).length >= 10 || this.turns.filter(t => t.phase === 'queued').length >= 20) return 'queue_full'
    const t: MTurn = { n: this.turns.length, chat, prio, phase: 'queued', arrival: this.arrivals++ }
    this.turns.push(t)
    this.startNext(chat)
    return t.n
  }
  finish(chat: number) { const t = this.inFlight(chat); if (t && t.phase === 'live') t.phase = 'ending' }
  release(chat: number) { const t = this.inFlight(chat); if (t && t.phase === 'ending') { t.phase = 'done'; this.startNext(chat) } }
  /** Stop and interrupt alike end a queued turn; a live one goes to `ending` on stop (interrupt waits for its answer). */
  act(op: 'interrupt' | 'stop', n: number): 'ok' | 'turn_ended' | 'not_found' {
    const t = this.turns[n]
    if (!t) return 'not_found'
    if (t.phase === 'queued') { t.phase = 'done'; return 'ok' }
    if (t.phase === 'live') { if (op === 'stop') t.phase = 'ending'; return 'ok' }
    return 'turn_ended'
  }
  pause() {
    this.paused = true
    for (const t of this.turns) { if (t.phase === 'queued') t.phase = 'done'; if (t.phase === 'live') t.phase = 'ending' }
  }
  resume() { this.paused = false }
}

const CHATS = ['c-a', 'c-b']
const checkpoint = { mainEntries: 2, lastUuid: 'u1', lastUuidIndex: 1 }

test.prop([fc.array(opArb, { minLength: 1, maxLength: 30 })], { numRuns: 60 })('the engine follows the reference model', ops => inAgent(async h => {
  const m = new Model()
  const ids: string[] = []
  const keys: string[] = []
  const lastBatch = new Map<string, RunEventBody[]>()
  let k = 0
  for (const o of ops) {
    if (o.op === 'submit') {
      const reuse = o.retry && keys.length > 0
      const key = reuse ? keys[keys.length - 1] : `key-${String(++k).padStart(5, '0')}`
      const chat = reuse ? h.turns().find(t => t.client_key === key)?.chat_id ?? CHATS[o.chat] : CHATS[o.chat]
      const prio = reuse ? h.turns().find(t => t.client_key === key)!.priority : o.prio
      const r = await h.submit(chat, key, { priority: prio })
      if (reuse) {
        // A retried POST answers the same turn and changes nothing.
        expect('turnId' in r && r.turnId).toBe(ids[keys.indexOf(key)])
      } else {
        const want = m.submit(CHATS.indexOf(chat), prio)
        if (typeof want === 'number') {
          if (!('turnId' in r)) throw new Error(`refused ${JSON.stringify(r)}`)
          ids.push(r.turnId)
          keys.push(key)
        } else {
          expect(r).toEqual({ refused: { code: want === 'paused' ? 'forbidden' : 'rate_limited', reason: want } })
        }
      }
    } else if (o.op === 'finish' || o.op === 'release' || o.op === 'resend') {
      const chat = CHATS[o.chat]
      const row = h.turns().find(t => t.chat_id === chat && (t.state === 'live' || t.state === 'ending'))
      if (row && o.op === 'finish' && row.state === 'live') {
        const batch = [ev.started(), ev.text('x'), ev.checkpoint(2, 'u1', 1), ev.success()]
        lastBatch.set(row.turn_id, batch)
        h.push(row.turn_id, ...batch)
        m.finish(o.chat)
      } else if (row && o.op === 'release' && row.state === 'ending') {
        h.push(row.turn_id, ev.released(checkpoint, true))
        m.release(o.chat)
      } else if (row && o.op === 'resend' && lastBatch.has(row.turn_id)) {
        const batch = lastBatch.get(row.turn_id)!
        const from = row.runner_last_seq + 1 - batch.length
        h.core.ingest(row.turn_id, batch.map((b, i) => ({ ...b, runId: row.turn_id, seq: from + i })) as never)
      }
    } else if (o.op === 'interrupt' || o.op === 'stop') {
      const id = o.target >= 0 && o.target < ids.length ? ids[o.target] : 't_AAAAAAAAAAAAAAAAAAAAAA'
      const r = o.op === 'stop' ? h.core.stop(id, { kind: 'person', memberId: MEMBER }) : h.core.interrupt(id, { kind: 'person', memberId: MEMBER })
      const want = m.act(o.op, o.target >= 0 && o.target < ids.length ? o.target : -1)
      expect(r).toEqual(want === 'ok' ? { ok: true } : want === 'turn_ended' ? { refused: { code: 'conflict', reason: 'turn_ended' } } : { refused: { code: 'not_found' } })
      // An interrupted live turn answers (the runner's partial result) like any other.
      if (o.op === 'interrupt' && want === 'ok') {
        const row = h.turns().find(t => t.turn_id === id)!
        if (row.state === 'live') { h.push(id, ev.started(), ev.finished('error_during_execution'), ev.checkpoint(2, 'u1', 1)); m.finish(CHATS.indexOf(row.chat_id)) }
      }
    } else if (o.op === 'pause') {
      h.core.pause({ kind: 'person', memberId: 'm_admin' })
      m.pause()
    } else {
      void h.core.resume({ kind: 'person', memberId: 'm_admin' })
      m.resume()
    }
    await settle()

    // The stored states match the model, turn by turn.
    const phaseOf = (state: string): Phase => (state === 'queued' ? 'queued' : state === 'starting' || state === 'live' ? 'live' : state === 'ending' ? 'ending' : 'done')
    expect(ids.map(id => phaseOf(h.turn(id).state))).toEqual(m.turns.map(t => t.phase))
    // One turn per chat in flight.
    for (const chat of CHATS) expect(h.turns().filter(t => t.chat_id === chat && ['starting', 'live', 'ending'].includes(t.state)).length).toBeLessThanOrEqual(1)
  }
  // Per-run seqs 1..n, no gap; each turn placed at most once (one attempt each, no requeue here).
  for (const r of h.sql.exec<{ run_id: string; last_seq: number }>('SELECT run_id, last_seq FROM runs').toArray()) {
    expect(h.events(r.run_id).map(e => e.seq)).toEqual(Array.from({ length: r.last_seq }, (_, i) => i + 1))
  }
  const placed = h.placed()
  expect(new Set(placed).size).toBe(placed.length)
}))
