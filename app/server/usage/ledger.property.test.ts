// The usage ledger under generated histories (fast-check, D1 in the Workers pool; p3-w4.md "Tests first"). The oracle is
// a reference model written here that shares no code with ledger.ts: it keeps the month's cap, spent and reserved and
// each turn's hold as plain numbers and predicts every answer. Expected totals come from the generator's record:
// spent = Σ of the generator's literal call costs over settled turns, reserved = Σ of the holds still outstanding.
// The history is a BrandAgent-like driver per turn (8.2's rules: up to two calls in flight, `need = tally + Σ worst in
// flight − ledgerHold`, a close sends `max(tally + Σ worst still in flight, start hold)`), interleaved across turns in
// a generated order, with duplicated requests and batches that commit and then lose their reply (retried).
// Ways it can fail: an answer the model doesn't predict (refusal kind or ledgerHold), a retry adding twice, the month's
// reserved drifting from Σ open holds, reserved < 0, a turn's tally passing its hold, spent + reserved passing the cap.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createUsageLedger } from './ledger.ts'
import { MONTH, NOV, lossyDb, monthRow, resetUsage, turnIn } from './test-fixtures.ts'

const START = 250_000
const UNIT = 50_000
const CEILING: Record<string, number> = { 'claude-sonnet-5-5': 14_680_000, 'claude-haiku-5-5': 5_320_000 }

const callArb = fc.integer({ min: 10_000, max: 3_000_000 }).chain(worst =>
  fc.record({ worst: fc.constant(worst), actual: fc.integer({ min: 0, max: worst }) }))
const turnArb = fc.record({
  model: fc.constantFrom('claude-sonnet-5-5', 'claude-haiku-5-5'),
  calls: fc.array(callArb, { minLength: 0, maxLength: 5 }),
})
const historyArb = fc.record({
  capDollars: fc.integer({ min: 1, max: 20 }),
  turns: fc.array(turnArb, { minLength: 1, maxLength: 5 }),
  order: fc.array(fc.nat(), { minLength: 0, maxLength: 80 }),
  // Per request: lose the reply of its first try, send it twice, end the newest call first.
  lose: fc.array(fc.boolean(), { minLength: 200, maxLength: 200 }),
  dup: fc.array(fc.boolean(), { minLength: 200, maxLength: 200 }),
  admitFirst: fc.array(fc.boolean(), { minLength: 200, maxLength: 200 }),
})

type Plan = { model: string; calls: { worst: number; actual: number }[] }
interface Driver {
  id: string
  plan: Plan
  phase: 'new' | 'open' | 'done'
  tries: number
  hold: number
  tally: number
  next: number
  inflight: { callId: string; worst: number; actual: number }[]
  /** The head call was refused for money with siblings in flight: it waits for a close. */
  waiting: boolean
}

describe('the ledger under generated histories', () => {
  it('answers as the reference model predicts and keeps spent and reserved equal to the generator\'s record', async () => {
    await fc.assert(fc.asyncProperty(historyArb, async h => {
      const cap = h.capDollars * 1_000_000
      await resetUsage(`$${h.capDollars}`)
      const lossy = lossyDb()
      const ledger = createUsageLedger({ db: lossy.db })
      const model = { spent: 0 }
      const drivers: Driver[] = h.turns.map((plan, i) => ({ id: `t${i}`, plan, phase: 'new', tries: 0, hold: 0, tally: 0, next: 0, inflight: [], waiting: false }))
      const reservedNow = () => drivers.filter(d => d.phase === 'open').reduce((s, d) => s + d.hold, 0)
      let k = 0
      /** One request: maybe its first reply is lost (then retried), maybe sent twice; the answers must agree. */
      const send = async <T>(f: () => Promise<T>): Promise<T> => {
        const i = k++ % 200
        if (h.lose[i]) {
          lossy.loseNext()
          let threw = false
          try { await f() } catch { threw = true }
          expect(threw).toBe(true)
        }
        const a = await f()
        if (h.dup[i]) expect(await f()).toEqual(a)
        return a
      }

      const step = async (d: Driver) => {
        if (d.phase === 'done') return
        if (d.phase === 'new') {
          const free = cap - model.spent - reservedNow()
          const answer = await send(() => ledger.reserve(turnIn(d.id, { model: d.plan.model })))
          if (free >= START) {
            expect(answer).toEqual({ reservedMicro: START })
            d.phase = 'open'
            d.hold = START
          } else {
            expect(answer).toEqual({ refused: cap - model.spent < START ? 'cap_reached' : 'budget_busy' })
            if (++d.tries >= 3 || cap - model.spent < START) d.phase = 'done'
          }
          return
        }
        const worstInFlight = () => d.inflight.reduce((s, c) => s + c.worst, 0)
        const canAdmit = d.next < d.plan.calls.length && d.inflight.length < 2 && !d.waiting
        const admitNow = canAdmit && (d.inflight.length === 0 || h.admitFirst[k % 200])
        if (admitNow) {
          const call = d.plan.calls[d.next]
          const callId = `c${d.next}`
          const need = d.tally + worstInFlight() + call.worst - d.hold
          if (need > 0) {
            const rounded = Math.ceil(need / UNIT) * UNIT
            const free = cap - model.spent - reservedNow()
            const answer = await send(() => ledger.extend(d.id, callId, need))
            const expected = free >= rounded && d.hold + rounded <= CEILING[d.plan.model]
              ? { ok: true, ledgerHold: d.hold + rounded }
              : { refused: cap - model.spent < rounded ? 'cap_reached' : d.hold + rounded > CEILING[d.plan.model] ? 'turn_budget' : 'held', ledgerHold: d.hold }
            expect(answer).toEqual(expected)
            if (!('ok' in answer)) {
              // Refused: wait for a sibling's close, or, with nothing in flight, the turn is fenced (ends, settles its tally).
              if (d.inflight.length > 0) d.waiting = true
              else d.next = d.plan.calls.length
              return
            }
            d.hold = answer.ledgerHold
          }
          d.inflight.push({ callId, worst: call.worst, actual: call.actual })
          d.next++
        } else if (d.inflight.length > 0) {
          const c = h.admitFirst[(k + 7) % 200] ? d.inflight.pop()! : d.inflight.shift()!
          d.tally += c.actual
          const holdArg = Math.max(d.tally + worstInFlight(), START)
          const answer = await send(() => ledger.close(d.id, c.callId, c.actual, holdArg))
          expect(answer).toEqual({ ledgerHold: Math.min(holdArg, d.hold) })
          d.hold = answer.ledgerHold
          d.waiting = false
        } else {
          await send(() => ledger.settle(d.id, d.tally, NOV))
          model.spent += d.tally
          d.phase = 'done'
        }
        // A turn's tally plus its calls' worst cases never pass its hold (8.2's invariant, the generator's numbers).
        expect(d.tally + worstInFlight()).toBeLessThanOrEqual(d.hold)
      }

      const check = async () => {
        const m = await monthRow(MONTH)
        const reserved = reservedNow()
        expect(m?.reserved_micro ?? 0).toBe(reserved)
        expect(m?.spent_micro ?? 0).toBe(model.spent)
        expect(reserved).toBeGreaterThanOrEqual(0)
        expect(model.spent + reserved).toBeLessThanOrEqual(cap)
      }

      for (const n of h.order) {
        await step(drivers[n % drivers.length])
        await check()
      }
      // Then every turn runs to its end, round robin (each step makes progress, so this ends).
      for (let guard = 0; drivers.some(d => d.phase !== 'done'); guard++) {
        if (guard > 500) throw new Error('history did not end')
        for (const d of drivers) await step(d)
        await check()
      }
      // Spent is the generator's own sum: every call that ran, at its literal cost, over the turns that settled.
      const ran = drivers.reduce((s, d) => s + d.tally, 0)
      expect((await monthRow(MONTH))?.spent_micro ?? 0).toBe(ran)
      expect((await monthRow(MONTH))?.reserved_micro ?? 0).toBe(0)
    }), { numRuns: 40 })
  }, 300_000)
})
