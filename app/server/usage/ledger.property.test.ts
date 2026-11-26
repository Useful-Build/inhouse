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
import { MONTH, NOV, db, lossyDb, monthRow, resetUsage, setSetting, turnIn } from './test-fixtures.ts'

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
              : { refused: cap - model.spent - d.hold < rounded ? 'cap_reached' : d.hold + rounded > CEILING[d.plan.model] ? 'turn_budget' : 'held', ledgerHold: d.hold }
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


  // Job budgets (N5): two jobs and turns with no job share one month. Ops are generated and interleaved (several extends
  // per turn, closes, settles, releases, closeJob at any point), each request's reply may be lost (then retried) or sent
  // twice. The reference model keeps the month and each job as plain numbers and predicts every answer, refusal codes
  // included. Ways it can fail: a job's spent + reserved passing its budget, the month cap passing, `job_budget` and
  // `cap_reached` and `budget_busy`/`held` confused, a closed job taking a hold, the root counted twice or not at all
  // (settled before or after openJob), a retry moving either pool twice.
  it('charges each root once and keeps both pools under their limits through generated job histories', async () => {
    const SONNET_CEILING = CEILING['claude-sonnet-5-5']
    const jobArb = fc.record({ budgetUnits: fc.integer({ min: 5, max: 60 }), finalRoot: fc.boolean(), rootCost: fc.integer({ min: 0, max: START }) })
    const opArb = fc.record({
      kind: fc.constantFrom('reserve', 'reserve', 'extend', 'extend', 'extend', 'close', 'close', 'settle', 'release', 'closeJob'),
      job: fc.nat(2), turn: fc.nat(2), units: fc.integer({ min: 1, max: 20 }), cost: fc.nat(100), lose: fc.boolean(), dup: fc.boolean(),
    })
    const arb = fc.record({ capDollars: fc.integer({ min: 1, max: 4 }), jobs: fc.tuple(jobArb, jobArb), ops: fc.array(opArb, { minLength: 10, maxLength: 40 }) })
    await fc.assert(fc.asyncProperty(arb, async h => {
      await resetUsage(`$${h.capDollars}`)
      const cap = h.capDollars * 1_000_000
      const lossy = lossyDb()
      const ledger = createUsageLedger({ db: lossy.db })
      const send = async <T>(o: { lose: boolean; dup: boolean }, f: () => Promise<T>): Promise<T> => {
        if (o.lose) {
          lossy.loseNext()
          await expect(f()).rejects.toThrow()
        }
        const a = await f()
        if (o.dup) expect(await f()).toEqual(a)
        return a
      }

      // Job 2 stands for "no job": its turns charge the month only.
      type Turn = { id: string; job: number; phase: 'new' | 'open' | 'done'; hold: number; tally: number; calls: { id: string; need: number }[]; n: number }
      const turns: Turn[] = [0, 1, 2].flatMap(job => [0, 1, 2].map(i => ({ id: `j${job}t${i}`, job, phase: 'new' as const, hold: 0, tally: 0, calls: [], n: 0 })))
      const turnOf = (job: number, i: number) => turns[job * 3 + i]
      const jobs = h.jobs.map((j, i) => ({ id: `job${i}`, budget: j.budgetUnits * UNIT, state: 'open' as 'open' | 'closed', spent: 0 }))
      let spent = 0
      let opened = 0
      const open = (job?: number) => turns.filter(t => t.phase === 'open' && (job === undefined || t.job === job))
      const reserved = (job?: number) => open(job).reduce((s, t) => s + t.hold, 0)
      const book = (t: Turn) => {
        spent += t.tally
        if (t.job < 2) jobs[t.job].spent += t.tally
        t.phase = 'done'
        t.hold = 0
      }

      const check = async () => {
        expect(await monthRow(MONTH)).toMatchObject({ spent_micro: spent, reserved_micro: reserved() })
        expect(spent + reserved()).toBeLessThanOrEqual(cap)
        for (const [i, j] of jobs.slice(0, opened).entries()) {
          expect(await db.prepare('SELECT budget_micro, state, spent_micro, reserved_micro FROM usage_jobs WHERE job_id = ?').bind(j.id).first())
            .toEqual({ budget_micro: j.budget, state: j.state, spent_micro: j.spent, reserved_micro: reserved(i) })
          expect(j.spent + reserved(i)).toBeLessThanOrEqual(j.budget)
        }
      }

      // Each job's root: reserved with no job, maybe settled, then opened (twice, the second a no-op) under its budget.
      for (const [i, j] of h.jobs.entries()) {
        const root = turnOf(i, 0)
        expect(await ledger.reserve(turnIn(root.id))).toEqual({ reservedMicro: START })
        root.phase = 'open'
        root.hold = START
        if (j.finalRoot) {
          await ledger.settle(root.id, j.rootCost, NOV)
          root.tally = j.rootCost
          spent += j.rootCost
          root.phase = 'done'
          root.hold = 0
          jobs[i].spent = j.rootCost
        }
        await setSetting('s:job_cap', `$${(jobs[i].budget / 1_000_000).toFixed(2)}`)
        const input = { jobId: jobs[i].id, rootTurnId: root.id, nowMs: NOV }
        await send({ lose: j.finalRoot, dup: true }, () => ledger.openJob(input))
        opened++
        await check()
      }

      for (const o of h.ops) {
        const t = turnOf(o.job, o.turn)
        const job = o.job < 2 ? jobs[o.job] : null
        const jobId = job === null ? {} : { jobId: job.id }
        if (o.kind === 'closeJob') {
          if (!job) continue
          await send(o, () => ledger.closeJob(job.id))
          job.state = 'closed'
        } else if (o.kind === 'reserve' && t.phase === 'new') {
          const monthFree = cap - spent - reserved()
          const jobFree = job ? job.budget - job.spent - reserved(o.job) : Infinity
          const answer = await send(o, () => ledger.reserve({ ...turnIn(t.id), ...jobId }))
          if (job && (job.state === 'closed' || job.budget - job.spent < START)) expect(answer).toEqual({ refused: 'job_budget' })
          else if (monthFree >= START && jobFree >= START) {
            expect(answer).toEqual({ reservedMicro: START })
            t.phase = 'open'
            t.hold = START
          } else expect(answer).toEqual({ refused: cap - spent < START ? 'cap_reached' : 'budget_busy' })
        } else if (o.kind === 'reserve' && t.phase === 'open') {
          // A repeat for an open turn is answered from its row.
          expect(await send(o, () => ledger.reserve({ ...turnIn(t.id), ...jobId }))).toEqual({ reservedMicro: t.hold })
        } else if (o.kind === 'extend' && t.phase === 'open') {
          const need = o.units * UNIT
          const callId = `c${t.n++}`
          const monthFree = cap - spent - reserved()
          const jobOk = !job || (job.state === 'open' && job.budget - job.spent - reserved(o.job) >= need)
          const answer = await send(o, () => ledger.extend(t.id, callId, need))
          if (monthFree >= need && t.hold + need <= SONNET_CEILING && jobOk) {
            expect(answer).toEqual({ ok: true, ledgerHold: t.hold + need })
            t.hold += need
            t.calls.push({ id: callId, need })
          } else {
            const refused = job && (job.state === 'closed' || job.budget - job.spent - t.hold < need) ? 'job_budget'
              : cap - spent - t.hold < need ? 'cap_reached'
                : t.hold + need > SONNET_CEILING ? 'turn_budget' : 'held'
            expect(answer).toEqual({ refused, ledgerHold: t.hold })
          }
        } else if (o.kind === 'close' && t.phase === 'open' && t.calls.length > 0) {
          const call = t.calls.shift()!
          const actual = Math.floor(call.need * o.cost / 100)
          t.tally += actual
          const holdArg = Math.max(START, t.tally + t.calls.reduce((s, c) => s + c.need, 0))
          expect(await send(o, () => ledger.close(t.id, call.id, actual, holdArg))).toEqual({ ledgerHold: Math.min(holdArg, t.hold) })
          t.hold = Math.min(holdArg, t.hold)
        } else if ((o.kind === 'settle' || o.kind === 'release') && t.phase === 'open' && t.calls.length === 0) {
          // Release books the closed calls' actuals, which is the tally: both end the turn at the same spend.
          await send(o, () => (o.kind === 'settle' ? ledger.settle(t.id, t.tally, NOV) : ledger.release(t.id, NOV)))
          book(t)
        } else continue
        await check()
      }

      // Then both jobs close and every open turn drains: a closed job takes no hold, and its turns still book.
      for (const j of jobs) {
        await ledger.closeJob(j.id)
        j.state = 'closed'
        expect(await ledger.reserve({ ...turnIn(`late-${j.id}`), jobId: j.id })).toEqual({ refused: 'job_budget' })
      }
      for (const t of open()) {
        if (t.job < 2) expect(await ledger.extend(t.id, 'after-close', UNIT)).toEqual({ refused: 'job_budget', ledgerHold: t.hold })
        for (let call = t.calls.shift(); call; call = t.calls.shift()) {
          t.tally += call.need
          const holdArg = Math.max(START, t.tally + t.calls.reduce((s, c) => s + c.need, 0))
          expect(await ledger.close(t.id, call.id, call.need, holdArg)).toEqual({ ledgerHold: Math.min(holdArg, t.hold) })
          t.hold = Math.min(holdArg, t.hold)
        }
        await ledger.settle(t.id, t.tally, NOV)
        book(t)
        await check()
      }
      // Each root counts exactly once, settled before or after its job opened: spent is every turn's tally, once.
      expect(spent).toBe(turns.reduce((s, t) => s + t.tally, 0))
      for (const [i, j] of jobs.entries()) expect(j.spent).toBe(turns.filter(t => t.job === i).reduce((s, t) => s + t.tally, 0))
      expect(await monthRow(MONTH)).toMatchObject({ spent_micro: spent, reserved_micro: 0 })
    }), { numRuns: 40 })
  }, 300_000)
})
