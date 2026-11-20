// The model gate and the per-turn ledger queue (p3-design 8.2 revision 6, 8.3, 9; p3-w1.md "Model gate", both gate test
// lists, "Lease"). Every expected amount is written here from the design's formulas and the script's own numbers (the
// worst cases and actual costs each test sends); the money is read from the ledger fake (its hold, its month, what it
// booked), never from the gate's own numbers. The start hold is the fake's 250,000 micro-USD (every close's floor). Ways it can fail, written
// down first:
//  1. a fifth call runs beside four; a waiter is never woken, or a later call is decided ahead of an earlier one;
//  2. two calls share the last headroom (both admitted on one extend), or a close computed before a sibling's extend
//     lowers the hold under what's admitted: `tally + Σ worst of deciding, granted and inflight > ledger hold`;
//  3. a call is priced twice (release and lease), at the wrong price (a cut not at its admitted worst case, a freed
//     grant not at 0), or a slot is freed twice or never;
//  4. settle goes out before every close was answered, while a call is open, twice, or not at all; a failed ledger call
//     is given up; a reset loses the queue;
//  5. a wait has no bound, or the bound fences the turn; a refusal fences the turn while a sibling still runs;
//  6. a waiter survives a fence, `ending`, an interrupt or a stop;
//  7. the sweep's reader counts a waiting call, misses an open one, or prices a cut call other than by 8.3.
import { describe, expect, it } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import type { SendTurnResult } from '../../../shared/contract/runs.ts'
import type { AdmitAnswer, ModelCallUsage, ModelCallWorst, Refusal, UsageLedgerPort } from './ports.ts'
import { turnCalls } from './turn-calls.ts'
import { MEMBER, SEC, deferred, ev, fullAnswer, inAgent, settle } from '../../testing/brand-agent/core-harness.ts'
import type { Harness } from '../../testing/brand-agent/core-harness.ts'

const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}
const W = (micro: number): ModelCallWorst => ({ model: 'claude-sonnet-5-5', inputTokens: 1000, maxTokens: 1000, modifiers: {}, micro })
const U = (micro: number): ModelCallUsage => ({ inputTokens: 100, outputTokens: 50, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, webSearches: 0, micro })

/** A live turn on chat `chat`. */
async function liveTurn(h: Harness, chat = 'c1', key = 'key-gate1'): Promise<SendTurnResult> {
  const a = ok(await h.submit(chat, key))
  await settle()
  expect(h.turn(a.turnId).state).toBe('live')
  return a
}

/** An admit whose answer the test reads once it came (undefined while the call waits). */
interface Asked { v?: AdmitAnswer }
const ask = (h: Harness, turnId: string, callId: string, worst: number): Asked => {
  const r: Asked = {}
  void h.core.admitModelCall(turnId, callId, W(worst)).then(v => { r.v = v })
  return r
}
const GRANTED = { granted: true }
const BUSY = { busy: true }

/** The ledger calls after the reserves, in order, as `[op, callId, amounts...]` (settle: `[op, micro]`). */
const ledger = (h: Harness) => h.usage.calls.filter(c => c.method !== 'reserve').map(c => {
  const a = c.args
  switch (c.method) {
    case 'extend': return ['extend', a[1], a[2]]
    case 'close': return ['close', a[1], a[2], a[3]]
    case 'settle': return ['settle', a[1]]
    default: return [c.method]
  }
})

/**
 * The money invariant (8.2), checked whenever the gate makes its next ledger call (the previous answer applied) and at
 * the test's checkpoints: `tally + Σ worst of deciding, granted and inflight calls ≤ the ledger fake's hold`. Which calls
 * are open comes from the rows; every amount comes from the script (`worst`, `price`), the hold from the fake.
 */
function guardMoney(h: Harness, turnId: string, worst: Map<string, number>, price: Map<string, number>) {
  const check = (exclude: string | null) => {
    const rows = h.sql.exec<{ call_id: string; state: string }>('SELECT call_id, state FROM model_calls WHERE turn_id = ?', turnId).toArray()
    let sum = 0
    for (const r of rows) {
      if (['done', 'cut', 'freed'].includes(r.state)) {
        const p = price.get(r.call_id)
        if (p === undefined) throw new Error(`the script has no price for ${r.call_id} (${r.state})`)
        sum += p
      } else if (['deciding', 'granted', 'inflight'].includes(r.state) && r.call_id !== exclude) {
        sum += worst.get(r.call_id)!
      }
    }
    if (h.usage.final.has(turnId)) return
    expect(sum, `tally + open worst vs the hold (${rows.map(r => `${r.call_id}:${r.state}`).join(' ')})`).toBeLessThanOrEqual(h.usage.holds.get(turnId)!)
  }
  for (const m of ['extend', 'close', 'settle'] as const) {
    const real = h.usage[m].bind(h.usage) as (...a: unknown[]) => Promise<unknown>
    ;(h.usage as unknown as Record<string, unknown>)[m] = async (...a: unknown[]) => {
      // The call being extended is deciding: its money is what this extend asks for.
      if (a[0] === turnId) check(m === 'extend' ? a[1] as string : null)
      return real(...a)
    }
  }
  return () => check(null)
}

describe('four slots, one decision at a time (8.2 rule 1)', () => {
  it('five concurrent calls: four admitted, the fifth waits and is admitted when one closes', () => inAgent(async h => {
    const a = await liveTurn(h)
    const t = a.turnId
    const c = [1, 2, 3, 4, 5].map(i => ask(h, t, `c${i}`, 100_000))
    await settle()
    expect(c.map(x => x.v)).toEqual([GRANTED, GRANTED, GRANTED, GRANTED, undefined])
    // c1: 100k ≤ 250k; c2: 200k ≤ 250k; c3: 300k − 250k = 50k; c4: 400k − 300k = 100k.
    expect(ledger(h)).toEqual([['extend', 'c3', 50_000], ['extend', 'c4', 100_000]])
    for (const i of [1, 2, 3, 4]) expect(await h.core.renewModelCall(t, `c${i}`, U(0))).toEqual({ ok: true })
    expect(await h.core.releaseModelCall(t, 'c1', { usage: U(30_000), cut: false })).toEqual({ ok: true })
    await settle()
    expect(c[4].v).toEqual(GRANTED)
    // close c1: max(30k + 300k open, 250k) = 330k; then c5: 30k + 400k − 330k = 100k.
    expect(ledger(h).slice(2)).toEqual([['close', 'c1', 30_000, 330_000], ['extend', 'c5', 100_000]])
    expect(h.usage.holds.get(t)).toBe(430_000)
  }))

  it('the lease: one call cancelled mid-stream (no release) frees only its slot at 60 s, cut at its worst case', () => inAgent(async h => {
    const t = (await liveTurn(h)).turnId
    const c = [1, 2, 3, 4, 5].map(i => ask(h, t, `c${i}`, 50_000))
    await settle()
    for (const i of [1, 2, 3, 4]) await h.core.renewModelCall(t, `c${i}`, U(0))
    expect(c[4].v).toBeUndefined()
    // c1 streams 20 s and dies (its invocation cancelled, no release); the others renew every 20 s.
    await h.core.renewModelCall(t, 'c1', U(20_000))
    for (let s = 20; s <= 60; s += 20) {
      await h.tick(20 * SEC)
      for (const i of [2, 3, 4]) expect(await h.core.renewModelCall(t, `c${i}`, U(1_000))).toEqual({ ok: true })
    }
    // c1's lease ran from its last renew at T0 (all four confirmed at T0, its 20k renew too): over at 60 s.
    expect(c[4].v).toEqual(GRANTED)
    // The cut-stream rule (8.3): its admitted worst case, 50k, not the 20k it had streamed.
    // close c1: max(50k + 150k, 250k) = 250k; c5: 50k + 150k + 50k − 250k = 0, no extend.
    expect(ledger(h)).toEqual([['close', 'c1', 50_000, 250_000]])
    expect(await h.core.renewModelCall(t, 'c1', U(25_000))).toEqual({ gone: true })
    expect(h.turn(t).state).toBe('live')
  }))
})

describe('racing for money (8.2 rule 2, the ledger queue)', () => {
  it('two calls racing for the last headroom: exactly one is admitted, the other waits then is admitted', () => inAgent(async h => {
    const t = (await liveTurn(h)).turnId
    const worst = new Map([['c1', 250_000], ['c2', 100_000], ['c3', 100_000]])
    const price = new Map<string, number>()
    const money = guardMoney(h, t, worst, price)
    const c1 = ask(h, t, 'c1', 250_000)
    await settle()
    expect(c1.v).toEqual(GRANTED)
    await h.core.renewModelCall(t, 'c1', U(0))
    // A barrier inside c2's extend; c3 arrives while it's awaited. The ledger has headroom for one 100k extend only.
    const inExtend = deferred()
    const real = h.usage.extend.bind(h.usage)
    h.usage.extend = async (...a) => {
      const answer = await real(...a)
      if (a[1] === 'c2') { await inExtend.promise; h.usage.extendRefusal = 'held' }
      return answer
    }
    const c2 = ask(h, t, 'c2', 100_000)
    await settle()
    const c3 = ask(h, t, 'c3', 100_000)
    await settle()
    expect([c2.v, c3.v]).toEqual([undefined, undefined])
    expect(ledger(h)).toEqual([['extend', 'c2', 100_000]])
    inExtend.resolve()
    await settle()
    // c2 took the headroom; c3's extend (450k − 350k = 100k) is refused `held` with siblings running: it waits.
    expect([c2.v, c3.v]).toEqual([GRANTED, undefined])
    expect(ledger(h)).toEqual([['extend', 'c2', 100_000], ['extend', 'c3', 100_000]])
    money()
    await h.core.renewModelCall(t, 'c2', U(0))
    h.usage.extendRefusal = null
    price.set('c1', 200_000)
    await h.core.releaseModelCall(t, 'c1', { usage: U(200_000), cut: false })
    await settle()
    // close c1: max(200k + 100k (c2), 250k) = 300k; c3 again: 200k + 100k + 100k − 300k = 100k.
    expect(c3.v).toEqual(GRANTED)
    expect(ledger(h).slice(2)).toEqual([['close', 'c1', 200_000, 300_000], ['extend', 'c3', 100_000]])
    expect(h.usage.holds.get(t)).toBe(400_000)
    money()
  }))

  for (const order of ['the extend lands first', 'the close lands first'] as const) {
    it(`a close while a sibling's extend is awaited (${order}): the money stays covered after every answer`, () => inAgent(async h => {
      const t = (await liveTurn(h)).turnId
      const worst = new Map([['c1', 200_000], ['c2', 150_000]])
      const price = new Map<string, number>([['c1', 120_000]])
      const money = guardMoney(h, t, worst, price)
      const c1 = ask(h, t, 'c1', 200_000)
      await settle()
      await h.core.renewModelCall(t, 'c1', U(0))
      const barrier = deferred()
      const op = order === 'the extend lands first' ? 'extend' : 'close'
      const real = h.usage[op].bind(h.usage) as (...a: unknown[]) => Promise<never>
      ;(h.usage as unknown as Record<string, unknown>)[op] = async (...a: unknown[]) => { const r = await real(...a); await barrier.promise; return r }
      let c2: Asked
      if (order === 'the extend lands first') {
        c2 = ask(h, t, 'c2', 150_000)
        await settle()
        await h.core.releaseModelCall(t, 'c1', { usage: U(120_000), cut: false })
      } else {
        await h.core.releaseModelCall(t, 'c1', { usage: U(120_000), cut: false })
        await settle()
        c2 = ask(h, t, 'c2', 150_000)
      }
      await settle()
      // Nothing else is sent while one ledger call is awaited.
      expect(h.usage.calls.filter(x => x.method !== 'reserve')).toHaveLength(1)
      barrier.resolve()
      await settle()
      expect([c1.v, c2.v]).toEqual([GRANTED, GRANTED])
      money()
      if (order === 'the extend lands first') {
        // extend c2: 350k − 250k = 100k → 350k; close c1: max(120k + 150k, 250k) = 270k.
        expect(ledger(h)).toEqual([['extend', 'c2', 100_000], ['close', 'c1', 120_000, 270_000]])
        expect(h.usage.holds.get(t)).toBe(270_000)
      } else {
        // close c1: max(120k, 250k) = 250k; extend c2: 120k + 150k − 250k = 20k → 270k.
        expect(ledger(h)).toEqual([['close', 'c1', 120_000, 250_000], ['extend', 'c2', 20_000]])
        expect(h.usage.holds.get(t)).toBe(270_000)
      }
    }))
  }

  it('one call aborts while another closes: both slots free once, both priced once, the hold ends at the script value', () => inAgent(async h => {
    const t = (await liveTurn(h)).turnId
    ask(h, t, 'c1', 100_000)
    ask(h, t, 'c2', 200_000)
    await settle()
    await h.core.renewModelCall(t, 'c1', U(0))
    await h.core.renewModelCall(t, 'c2', U(0))
    expect(ledger(h)).toEqual([['extend', 'c2', 50_000]])
    const inClose = deferred()
    const real = h.usage.close.bind(h.usage)
    h.usage.close = async (...a) => { const r = await real(...a); if (a[1] === 'c2') await inClose.promise; return r }
    expect(await h.core.releaseModelCall(t, 'c2', { usage: U(120_000), cut: false })).toEqual({ ok: true })
    await settle()
    // c1's abort lands between c2's close being sent and answered: priced by the cut-stream rule, max(100k, 30k).
    expect(await h.core.releaseModelCall(t, 'c1', { usage: U(30_000), cut: true })).toEqual({ ok: true })
    expect(await h.core.releaseModelCall(t, 'c1', { usage: U(30_000), cut: true })).toEqual({ gone: true })
    inClose.resolve()
    await settle()
    // close c2: max(120k + 100k (c1 open when it was sent), 250k) = 250k; close c1: max(220k, 250k) = 250k.
    expect(ledger(h)).toEqual([['extend', 'c2', 50_000], ['close', 'c2', 120_000, 250_000], ['close', 'c1', 100_000, 250_000]])
    expect(h.usage.holds.get(t)).toBe(250_000)
    // Both slots are free: four new calls run at once.
    const more = [5, 6, 7, 8].map(i => ask(h, t, `c${i}`, 1_000))
    await settle()
    expect(more.map(x => x.v)).toEqual([GRANTED, GRANTED, GRANTED, GRANTED])
  }))
})

describe('interrupt, fence and settle (8.2, 4.6, 9)', () => {
  it('interrupt with 4 in flight: three close by their finally, one by its lease; the next turn starts at released; settle books the sum', () => inAgent(async h => {
    const a = await liveTurn(h)
    const t = a.turnId
    const b = ok(await h.submit('c1', 'key-gate2'))
    ;[1, 2, 3, 4].forEach(i => ask(h, t, `c${i}`, 50_000))
    await settle()
    for (const i of [1, 2, 3, 4]) await h.core.renewModelCall(t, `c${i}`, U(0))
    expect(h.core.interrupt(t, { kind: 'person', memberId: MEMBER })).toEqual({ ok: true })
    for (const i of [1, 2, 3]) expect(await h.core.releaseModelCall(t, `c${i}`, { usage: U(10_000), cut: true })).toEqual({ ok: true })
    h.push(t, ev.started(), ev.finished('error_during_execution'), ev.released({ mainEntries: 2, lastUuid: 'u2', lastUuidIndex: 1 }))
    await settle()
    expect(h.turn(t)).toMatchObject({ state: 'ended', outcome: 'interrupted' })
    expect(h.placed()).toEqual([t, b.turnId])
    expect(ledger(h).map(x => x[0])).toEqual(['close', 'close', 'close'])
    await h.tick(60 * SEC)
    // Each cut at its admitted worst case (8.3): 4 × 50k = 200k booked; every close's hold max(…, 250k) = 250k.
    expect(ledger(h)).toEqual([
      ['close', 'c1', 50_000, 250_000], ['close', 'c2', 50_000, 250_000], ['close', 'c3', 50_000, 250_000],
      ['close', 'c4', 50_000, 250_000], ['settle', 200_000],
    ])
    expect(h.usage.booked.get(t)).toBe(200_000)
    expect(h.usage.holds.get(t)).toBe(0)
  }))

  it('the last close fails once and is retried after the turn ended: settle only after it; the month holds the open turns', () => inAgent(async h => {
    const t = (await liveTurn(h)).turnId
    const other = (await liveTurn(h, 'c2', 'key-gate3')).turnId
    ask(h, t, 'c1', 100_000)
    await settle()
    await h.core.renewModelCall(t, 'c1', U(0))
    h.push(t, ...fullAnswer('done', 2))
    await settle()
    expect(h.turn(t).state).toBe('ended')
    // The reply is lost after the ledger committed the close.
    let lose = true
    const real = h.usage.close.bind(h.usage)
    h.usage.close = async (...a) => { const r = await real(...a); if (lose) { lose = false; throw new Error('reply lost') } return r }
    await h.core.releaseModelCall(t, 'c1', { usage: U(40_000), cut: false })
    await settle()
    expect(ledger(h)).toEqual([['close', 'c1', 40_000, 250_000]])
    await h.tick(5 * SEC)
    await settle()
    expect(ledger(h)).toEqual([['close', 'c1', 40_000, 250_000], ['close', 'c1', 40_000, 250_000], ['settle', 40_000]])
    expect(h.usage.holds.get(t)).toBe(0)
    expect(h.usage.monthReserved).toBe(250_000)
    expect(h.usage.holds.get(other)).toBe(250_000)
    // A duplicate release after settle changes nothing and sends nothing.
    expect(await h.core.releaseModelCall(t, 'c1', { usage: U(40_000), cut: false })).toEqual({ gone: true })
    await h.tick(60 * SEC)
    expect(ledger(h)).toHaveLength(3)
    expect([h.usage.spent, h.usage.booked.get(t)]).toEqual([40_000, 40_000])
  }))

  it('a reset with a close awaited on a live turn: the new instance sends it again; settle at the end', () => inAgent(async h => {
    const t = (await liveTurn(h)).turnId
    ask(h, t, 'c1', 100_000)
    await settle()
    await h.core.renewModelCall(t, 'c1', U(0))
    const never = deferred()
    const real = h.usage.close.bind(h.usage)
    h.usage.close = async (...a) => { const r = await real(...a); await never.promise; return r }
    await h.core.releaseModelCall(t, 'c1', { usage: U(70_000), cut: false })
    await settle()
    h.usage.close = real
    const h2 = h.restart()
    await h2.tick(0)
    expect(ledger(h2)).toEqual([['close', 'c1', 70_000, 250_000], ['close', 'c1', 70_000, 250_000]])
    h2.push(t, ...fullAnswer('done', 2))
    await settle()
    expect(ledger(h2)).toEqual([['close', 'c1', 70_000, 250_000], ['close', 'c1', 70_000, 250_000], ['settle', 70_000]])
    expect(h2.usage.booked.get(t)).toBe(70_000)
  }))

  it('a turn with no model call gives its hold back with release (design 9)', () => inAgent(async h => {
    const t = (await liveTurn(h)).turnId
    h.push(t, ...fullAnswer('done', 2))
    await h.tick(0)
    expect(ledger(h)).toEqual([['release']])
  }))

  it("the run's cost is its turns' tally", () => inAgent(async h => {
    const a = await liveTurn(h)
    ask(h, a.turnId, 'c1', 200_000)
    await settle()
    await h.core.renewModelCall(a.turnId, 'c1', U(0))
    await h.core.releaseModelCall(a.turnId, 'c1', { usage: U(123_456), cut: false })
    h.push(a.turnId, ...fullAnswer('done', 2))
    await settle()
    const finished = h.events(a.runId).find(e => e.type === 'run.finished')
    // 123,456 micro-USD is 12 cents (rounded to the cent).
    expect(finished).toMatchObject({ cost: { minor: 12, currency: 'USD' } })
  }))
})

describe('waits: money, order, bounds (8.2 rules 1 and 3)', () => {
  it('a money wait with a sibling that runs 3 minutes: admitted when it closes, the turn lives', () => inAgent(async h => {
    const t = (await liveTurn(h)).turnId
    ask(h, t, 'c1', 250_000)
    await settle()
    await h.core.renewModelCall(t, 'c1', U(0))
    h.usage.extendRefusal = 'held'
    const c2 = ask(h, t, 'c2', 100_000)
    await settle()
    expect(ledger(h)).toEqual([['extend', 'c2', 100_000]])
    for (let s = 0; s < 9; s++) {
      await h.tick(20 * SEC)
      h.push(t, ev.heartbeat())
      expect(await h.core.renewModelCall(t, 'c1', U(10_000 * s))).toEqual({ ok: true })
      expect(c2.v).toBeUndefined()
    }
    h.usage.extendRefusal = null
    await h.core.releaseModelCall(t, 'c1', { usage: U(150_000), cut: false })
    await settle()
    // close c1: max(150k, 250k) = 250k; c2: 150k + 100k − 250k = 0: granted without an extend.
    expect(c2.v).toEqual(GRANTED)
    expect(ledger(h)).toEqual([['extend', 'c2', 100_000], ['close', 'c1', 150_000, 250_000]])
    expect(h.turn(t)).toMatchObject({ state: 'live', fenced: 0 })
  }))

  it('a later small call cannot pass a large call waiting for money', () => inAgent(async h => {
    const t = (await liveTurn(h)).turnId
    ask(h, t, 'c1', 200_000)
    await settle()
    await h.core.renewModelCall(t, 'c1', U(0))
    h.usage.extendRefusal = 'held'
    const c2 = ask(h, t, 'c2', 500_000)
    await settle()
    const c3 = ask(h, t, 'c3', 10_000)
    await settle()
    // c3 alone would fit (210k ≤ 250k), but it's behind c2.
    expect([c2.v, c3.v]).toEqual([undefined, undefined])
    expect(ledger(h)).toEqual([['extend', 'c2', 450_000]])
    h.usage.extendRefusal = null
    await h.core.releaseModelCall(t, 'c1', { usage: U(100_000), cut: false })
    await settle()
    // close c1: max(100k, 250k) = 250k; c2: 100k + 500k − 250k = 350k → 600k; c3: 100k + 510k − 600k = 10k.
    expect(ledger(h).slice(1)).toEqual([['close', 'c1', 100_000, 250_000], ['extend', 'c2', 350_000], ['extend', 'c3', 10_000]])
    expect([c2.v, c3.v]).toEqual([GRANTED, GRANTED])
  }))

  it('a grant whose caller left is never confirmed: freed at 10 s at zero, the hold unchanged by it', () => inAgent(async h => {
    const t = (await liveTurn(h)).turnId
    ask(h, t, 'c1', 200_000)
    await settle()
    await h.core.renewModelCall(t, 'c1', U(0))
    h.usage.extendRefusal = 'held'
    const c2 = ask(h, t, 'c2', 100_000)
    await settle()
    h.usage.extendRefusal = null
    await h.core.releaseModelCall(t, 'c1', { usage: U(50_000), cut: false })
    await settle()
    // close c1: max(50k, 250k) = 250k; c2: 50k + 100k − 250k ≤ 0: granted, but its caller is gone (no renew).
    expect(c2.v).toEqual(GRANTED)
    const before = h.usage.holds.get(t)
    await h.tick(10 * SEC)
    expect(ledger(h).slice(1)).toEqual([['close', 'c1', 50_000, 250_000], ['close', 'c2', 0, 250_000]])
    expect(h.usage.holds.get(t)).toBe(before)
    expect(await h.core.renewModelCall(t, 'c2', U(0))).toEqual({ gone: true })
    h.push(t, ...fullAnswer('done', 2))
    await h.tick(0)
    expect(h.usage.booked.get(t)).toBe(50_000)
  }))

  it('a release after its lease closed the call prices it once', () => inAgent(async h => {
    const t = (await liveTurn(h)).turnId
    ask(h, t, 'c1', 100_000)
    await settle()
    await h.core.renewModelCall(t, 'c1', U(0))
    await h.tick(20 * SEC)
    await h.core.renewModelCall(t, 'c1', U(30_000))
    await h.tick(59 * SEC)
    expect(ledger(h)).toEqual([])
    await h.tick(1 * SEC)
    expect(ledger(h)).toEqual([['close', 'c1', 100_000, 250_000]])
    expect(await h.core.releaseModelCall(t, 'c1', { usage: U(40_000), cut: false })).toEqual({ gone: true })
    h.push(t, ...fullAnswer('done', 2))
    await h.tick(0)
    expect(ledger(h)).toEqual([['close', 'c1', 100_000, 250_000], ['settle', 100_000]])
  }))

  it('a wait past 5 minutes in all (slot, money, a slow extend) answers 503 for that call; the turn goes on', () => inAgent(async h => {
    const t = (await liveTurn(h)).turnId
    ;[1, 2, 3, 4].forEach(i => ask(h, t, `c${i}`, 50_000))
    await settle()
    for (const i of [1, 2, 3, 4]) await h.core.renewModelCall(t, `c${i}`, U(0))
    const c5 = ask(h, t, 'c5', 100_000)
    const slow = deferred()
    const real = h.usage.extend.bind(h.usage)
    h.usage.extend = async (...a) => { const r = await real(...a); await slow.promise; return r }
    // The runner keeps pushing heartbeats (so the watchdog leaves the turn alone) and the calls keep renewing.
    const renewAll = async (ids: number[]) => {
      h.push(t, ev.heartbeat())
      for (const i of ids) expect(await h.core.renewModelCall(t, `c${i}`, U(0))).toEqual({ ok: true })
    }
    for (let s = 0; s < 6; s++) { await h.tick(20 * SEC); await renewAll([1, 2, 3, 4]) }
    // At 2 minutes c1 closes; c5 is decided: 50k + 150k + 100k − 250k = 50k, an extend that hangs.
    await h.core.releaseModelCall(t, 'c1', { usage: U(50_000), cut: false })
    await settle()
    expect(ledger(h)).toEqual([['close', 'c1', 50_000, 250_000], ['extend', 'c5', 50_000]])
    for (let s = 0; s < 8; s++) { await h.tick(20 * SEC); await renewAll([2, 3, 4]) }
    expect(c5.v).toBeUndefined()
    await h.tick(20 * SEC)
    expect(c5.v).toEqual(BUSY)
    expect(h.turn(t)).toMatchObject({ state: 'live', fenced: 0 })
    slow.resolve()
    await settle()
    // The late extend landed (300k); c5 never ran, so a close at 0 brings the hold back: max(50k + 150k, 250k).
    expect(ledger(h).slice(2)).toEqual([['close', 'c5', 0, 250_000]])
    expect(h.usage.holds.get(t)).toBe(250_000)
  }))
})

describe('refusals and waiters at the turn\'s end (8.2)', () => {
  for (const [refusal, answer, reason] of [['cap_reached', 'cap_reached', 'cap_reached'], ['turn_budget', 'turn_budget', 'turn_budget'], ['held', 'budget_busy', 'budget_busy']] as const) {
    it(`an extend refused ${refusal} with nothing in flight refuses the call and fences the turn ${reason}`, () => inAgent(async h => {
      const a = await liveTurn(h)
      h.usage.extendRefusal = refusal
      const c1 = ask(h, a.turnId, 'c1', 300_000)
      await settle()
      expect(c1.v).toEqual({ refused: answer })
      expect(h.turn(a.turnId)).toMatchObject({ state: 'ending', fenced: 1, outcome: 'failed', failure: reason })
      expect(h.events(a.runId).filter(e => e.type === 'turn.finished')).toEqual([expect.objectContaining({ outcome: 'failed', reason })])
    }))
  }

  for (const how of ['interrupt', 'stop', 'terminal', 'pause'] as const) {
    it(`a waiting call is answered 503 at ${how}`, () => inAgent(async h => {
      const t = (await liveTurn(h)).turnId
      ;[1, 2, 3, 4].forEach(i => ask(h, t, `c${i}`, 10_000))
      const c5 = ask(h, t, 'c5', 10_000)
      await settle()
      expect(c5.v).toBeUndefined()
      if (how === 'interrupt') h.core.interrupt(t, { kind: 'person', memberId: MEMBER })
      if (how === 'stop') h.core.stop(t, { kind: 'person', memberId: MEMBER })
      if (how === 'terminal') h.push(t, ev.started(), ev.success())
      if (how === 'pause') h.core.pause({ kind: 'person', memberId: 'm_admin' })
      await settle()
      expect(c5.v).toEqual(BUSY)
      // And no new call is admitted on that turn.
      const c6 = ask(h, t, 'c6', 10_000)
      await settle()
      expect(c6.v).toEqual(BUSY)
    }))
  }

  it('unknown calls and turns: busy for admit, gone for renew and release', () => inAgent(async h => {
    expect(await h.core.admitModelCall('t_AAAAAAAAAAAAAAAAAAAAAA', 'c1', W(1))).toEqual(BUSY)
    expect(await h.core.renewModelCall('t_AAAAAAAAAAAAAAAAAAAAAA', 'c1', U(1))).toEqual({ gone: true })
    expect(await h.core.releaseModelCall('t_AAAAAAAAAAAAAAAAAAAAAA', 'c1', { usage: U(1), cut: false })).toEqual({ gone: true })
  }))
})

describe('the scripted property: the tally never passes the hold', () => {
  type Op = { op: 'ask'; worst: number } | { op: 'confirm'; i: number } | { op: 'close'; i: number; frac: number; cut: boolean }
    | { op: 'tick' } | { op: 'refuse'; on: boolean }
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    { weight: 4, arbitrary: fc.record({ op: fc.constant('ask' as const), worst: fc.integer({ min: 1, max: 40 }).map(n => n * 10_000) }) },
    { weight: 3, arbitrary: fc.record({ op: fc.constant('confirm' as const), i: fc.nat(30) }) },
    { weight: 4, arbitrary: fc.record({ op: fc.constant('close' as const), i: fc.nat(30), frac: fc.double({ min: 0, max: 1, noNaN: true }), cut: fc.boolean() }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('tick' as const) }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('refuse' as const), on: fc.boolean() }) },
  )
  test.prop([fc.array(opArb, { minLength: 1, maxLength: 40 })], { numRuns: 25 })('parallel worst cases and actual usages', ops => inAgent(async h => {
    const t = (await liveTurn(h)).turnId
    // The runner answers `live` (the watchdog may still end a silent turn at 6.5 minutes: the money holds either way).
    h.pool.statusAnswer = { state: 'live', containerGone: false }
    const worst = new Map<string, number>()
    const price = new Map<string, number>()
    const money = guardMoney(h, t, worst, price)
    const granted: string[] = []
    const asked: Asked[] = []
    for (const o of ops) {
      if (o.op === 'ask') {
        const id = `c${asked.length + 1}`
        worst.set(id, o.worst)
        const r = ask(h, t, id, o.worst)
        asked.push(r)
      } else if (o.op === 'confirm' || o.op === 'close') {
        const done = asked.map((r, i) => (r.v && 'granted' in r.v ? `c${i + 1}` : null)).filter((x): x is string => x !== null)
        const id = done[o.i % Math.max(done.length, 1)]
        if (id === undefined) continue
        if (o.op === 'confirm') await h.core.renewModelCall(t, id, U(0))
        else {
          const actual = Math.floor(worst.get(id)! * o.frac)
          const row = h.sql.exec<{ state: string }>('SELECT state FROM model_calls WHERE turn_id = ? AND call_id = ?', t, id).one()
          const answer = await h.core.releaseModelCall(t, id, { usage: U(actual), cut: o.cut })
          if (row.state === 'granted' || row.state === 'inflight') {
            expect(answer).toEqual({ ok: true })
            price.set(id, o.cut ? worst.get(id)! : actual)
            granted.push(id)
          } else {
            expect(answer).toEqual({ gone: true })
          }
        }
      } else if (o.op === 'tick') {
        // Past the confirm deadline: an unconfirmed grant is freed at 0; a confirmed one past 60 s is cut at its worst.
        const rows = h.sql.exec<{ call_id: string; state: string }>("SELECT call_id, state FROM model_calls WHERE turn_id = ? AND state IN ('granted', 'inflight')", t).toArray()
        await h.tick(61 * SEC)
        for (const r of rows) if (!price.has(r.call_id)) price.set(r.call_id, r.state === 'granted' ? 0 : worst.get(r.call_id)!)
        // A waiter past its 5 minutes is answered busy (never priced).
      } else {
        h.usage.extendRefusal = o.on ? 'held' : null
      }
      await settle()
      // A call answered `refused` or `busy` never ran: it costs nothing.
      asked.forEach((r, i) => { if (r.v && !('granted' in r.v) && !price.has(`c${i + 1}`)) price.set(`c${i + 1}`, 0) })
      money()
    }
  }))
})

describe("the usage sweep's reader (8.3, 9; W4's `TurnCallsReader`)", () => {
  it('closed calls at their price, open ones at their worst case, waiting ones not at all; unknown turn null', () => inAgent(async h => {
    const t = (await liveTurn(h)).turnId
    ;[['c1', 30_000], ['c2', 100_000], ['c3', 70_000], ['c4', 20_000]].forEach(([id, w]) => ask(h, t, id as string, w as number))
    await settle()
    const c5 = ask(h, t, 'c5', 999_000)
    await settle()
    expect(c5.v).toBeUndefined()
    await h.core.renewModelCall(t, 'c1', U(0))
    await h.core.renewModelCall(t, 'c2', U(0))
    await h.core.renewModelCall(t, 'c3', U(0))
    // c5 stays waiting for money when slots free.
    h.usage.extendRefusal = 'held'
    await h.core.releaseModelCall(t, 'c1', { usage: U(12_000), cut: false })
    await h.core.releaseModelCall(t, 'c2', { usage: U(5_000), cut: true })
    await settle()
    // c1 12k (done) + c2 100k (cut: its worst) + c3 70k (inflight) + c4 20k (granted) + c5 waiting (none).
    expect(turnCalls(h.sql, t)).toEqual({ micro: 202_000 })
    expect(turnCalls(h.sql, 't_AAAAAAAAAAAAAAAAAAAAAA')).toBeNull()
  }))
})

// Keeps the port's type in view for the wrappers above.
export type _Ledger = UsageLedgerPort
