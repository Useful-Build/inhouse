// N14's `report`: who tells the agent an action's result. A fast-check property over random interleavings of one turn's
// parallel cards: each action settling (final) before or after its waiter registers, the waiter claiming `tool`, polling,
// giving up at its deadline or dying without a word, the turn ending (`done` or not, also between the claim's write and
// its second look), the deliver task running at any point, a refused resume submit, a deleted chat, and the clock past
// every wait. The functions under test are the shipped ones (asks.ts: `claimTool`, `waiterGaveUp`, `turnEndedReports`,
// `deliverReport`) over an in-memory report store; the D1 store's conditional update is tested in asks.test.ts.
//
// Invariants, once everything settles (the turn ended, every action final, every wait past its deadline, the turn-end
// step and the deliver task run):
//  1. never zero reports: each action is `tool` (its waiter returned the final result inline and the turn ended `done`),
//     `resume` (a resume turn was submitted for it), or `none` (no one to tell: its chat was deleted);
//  2. a resume turn is only ever submitted with the key `act_<id>`, only for an action whose report is `resume`;
//  3. while resumes are off (the action texts port is null until M2-G), nothing is submitted and nothing is lost: the
//     report stays `later` or NULL for M2-G's deliver to claim.
import { fc } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import type { ActionState } from '../../../shared/contract/actions.ts'
import type { OutboxReport } from '../../outbox/types.ts'
import { claimTool, deliverReport, resumeKey, turnEndedReports, waiterGaveUp, WAIT_AFTER_APPROVAL_MS, WAIT_MARGIN_MS, WAIT_MAX_MS } from './asks.ts'
import type { ReportRow, ReportStore, WaitRecord } from './asks.ts'

const TURN = 't_prop'
const WAIT_SPAN = WAIT_MAX_MS + WAIT_AFTER_APPROVAL_MS + WAIT_MARGIN_MS

class MemStore implements ReportStore {
  rows = new Map<string, ReportRow>()
  async read(id: string) {
    const r = this.rows.get(id)
    return r ? { ...r } : null
  }
  async set(id: string, to: OutboxReport, from: readonly (OutboxReport | null)[]) {
    const r = this.rows.get(id)
    if (!r || !from.includes(r.report)) return false
    r.report = to
    return true
  }
}

type Waiter = 'none' | 'registered' | 'claimed' | 'done' | 'dead'

type Step =
  | { k: 'settle'; i: number }
  | { k: 'register'; i: number }
  | { k: 'claim'; i: number; dieBetween: boolean }
  | { k: 'poll'; i: number }
  | { k: 'deadline'; i: number }
  | { k: 'die'; i: number }
  | { k: 'turnEnd'; outcome: 'done' | 'failed' | 'interrupted' | 'stopped' }
  | { k: 'deliver'; i: number }
  | { k: 'clock'; ms: number }

const stepArb = (n: number): fc.Arbitrary<Step> => {
  const i = fc.integer({ min: 0, max: n - 1 })
  return fc.oneof(
    i.map(i => ({ k: 'settle' as const, i })),
    i.map(i => ({ k: 'register' as const, i })),
    fc.record({ i, dieBetween: fc.boolean() }).map(r => ({ k: 'claim' as const, ...r })),
    i.map(i => ({ k: 'poll' as const, i })),
    i.map(i => ({ k: 'deadline' as const, i })),
    i.map(i => ({ k: 'die' as const, i })),
    fc.constantFrom('done', 'failed', 'interrupted', 'stopped').map(outcome => ({ k: 'turnEnd' as const, outcome })),
    i.map(i => ({ k: 'deliver' as const, i })),
    fc.integer({ min: 1_000, max: 200_000 }).map(ms => ({ k: 'clock' as const, ms })),
  )
}

const world = fc.integer({ min: 1, max: 4 }).chain(n => fc.record({
  n: fc.constant(n),
  steps: fc.array(stepArb(n), { minLength: 5, maxLength: 40 }),
  gone: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
  /** How many times a resume submit is refused (paused, a full queue) before it goes in. */
  refusals: fc.integer({ min: 0, max: 2 }),
  finalOutcome: fc.constantFrom('done', 'failed'),
  resumes: fc.boolean(),
}))

async function run(w: { n: number; steps: Step[]; gone: boolean[]; refusals: number; finalOutcome: 'done' | 'failed'; resumes: boolean }) {
  const store = new MemStore()
  const ids = Array.from({ length: w.n }, (_, i) => `ac_prop${i}`)
  for (const id of ids) store.rows.set(id, { id, state: 'waiting', report: null, turnId: TURN, chatId: 'c_prop', askedBy: 'm_prop', jobId: null })
  const turn = { live: true, outcome: null as string | null }
  const waiter: Waiter[] = ids.map(() => 'none')
  const waits = new Map<string, WaitRecord>()
  const inline = new Set<string>()
  const submits: { key: string; actionId: string }[] = []
  let refusals = w.refusals
  let now = 0

  const endTurn = async (outcome: string) => {
    if (!turn.live) return
    turn.live = false
    turn.outcome = outcome
    await turnEndedReports(store, ids, outcome)
  }
  const liveWaits = () => [...waits.values()].filter(x => !x.finished && now < x.untilMs).length
  const finish = (id: string, delivered: boolean) => {
    const x = waits.get(id)
    if (x) { x.finished = true; x.delivered = delivered }
  }
  const isFinal = (id: string) => store.rows.get(id)!.state !== 'waiting'

  const deliver = (id: string) => deliverReport({
    store, nowMs: now,
    turnLive: () => turn.live,
    wait: x => waits.get(x) ?? null,
    gone: async row => w.gone[ids.indexOf(row.id)]!,
    resumes: w.resumes,
    submitResume: async row => {
      if (refusals > 0) { refusals--; return 'retry' }
      submits.push({ key: resumeKey(row.id), actionId: row.id })
      return 'submitted'
    },
  }, id)

  for (const s of w.steps) {
    switch (s.k) {
      case 'settle':
        store.rows.get(ids[s.i]!)!.state = 'sent' satisfies ActionState
        break
      case 'register': {
        const id = ids[s.i]!
        if (waiter[s.i] !== 'none') break
        // beginWait: only a live turn, at most 3 live waits; otherwise the egress doesn't wait and writes `later`.
        if (turn.live && liveWaits() < 3) {
          waits.set(id, { untilMs: now + WAIT_SPAN, finished: false, delivered: false })
          waiter[s.i] = 'registered'
        } else {
          await waiterGaveUp(store, id, false)
          waiter[s.i] = 'done'
        }
        break
      }
      case 'claim': {
        const id = ids[s.i]!
        if (waiter[s.i] !== 'registered') break
        let looks = 0
        const claimed = await claimTool(store, id, async () => {
          // The turn may die between the claim's write and its second look.
          if (++looks === 2 && s.dieBetween) await endTurn('failed')
          return turn.live
        })
        if (claimed) waiter[s.i] = 'claimed'
        else {
          finish(id, false)
          waiter[s.i] = 'done'
        }
        break
      }
      case 'poll': {
        const id = ids[s.i]!
        if (waiter[s.i] !== 'claimed' || !isFinal(id)) break
        inline.add(id)
        finish(id, true)
        waiter[s.i] = 'done'
        break
      }
      case 'deadline': {
        const id = ids[s.i]!
        if (waiter[s.i] !== 'claimed' || isFinal(id)) break
        await waiterGaveUp(store, id, true)
        finish(id, false)
        waiter[s.i] = 'done'
        break
      }
      case 'die':
        if (waiter[s.i] === 'registered' || waiter[s.i] === 'claimed') waiter[s.i] = 'dead'
        break
      case 'turnEnd':
        await endTurn(s.outcome)
        break
      case 'deliver':
        await deliver(ids[s.i]!)
        break
      case 'clock':
        now += s.ms
        break
    }
  }

  // Settle everything: the turn ends, every action is final, every wait is past its deadline, and the turn-end step and
  // the deliver task run (each of them more than once: they must be safe to repeat).
  await endTurn(w.finalOutcome)
  for (const id of ids) store.rows.get(id)!.state = 'sent'
  now += WAIT_SPAN + 1
  for (let round = 0; round < 2 + w.refusals; round++) {
    await turnEndedReports(store, ids, turn.outcome)
    for (const id of ids) await deliver(id)
  }

  for (const [i, id] of ids.entries()) {
    const r = store.rows.get(id)!.report
    const mine = submits.filter(x => x.actionId === id)
    if (!w.resumes) {
      // 3. Resumes off: nothing submitted, and the report waits for M2-G (or says there's no one / it was told inline).
      expect(submits).toEqual([])
      if (r === 'tool') expect(inline.has(id) && turn.outcome === 'done', `${id}: tool without an inline result`).toBe(true)
      else if (r === 'none') expect(w.gone[i], `${id}: none, but its chat is there`).toBe(true)
      else expect(r === null || r === 'later', `${id}: ${String(r)} with resumes off`).toBe(true)
      continue
    }
    // 1. Never zero reports.
    expect(r, `${id}: no one tells the agent`).not.toBeNull()
    expect(r, `${id}: left at later`).not.toBe('later')
    if (r === 'tool') expect(inline.has(id) && turn.outcome === 'done', `${id}: tool, but the agent never got it`).toBe(true)
    if (r === 'resume') expect(mine.length, `${id}: resume claimed, none submitted`).toBeGreaterThan(0)
    if (r === 'none') expect(w.gone[i], `${id}: none, but its chat is there`).toBe(true)
  }
  // 2. Keys: only act_<id>, only for an action whose report is resume.
  for (const x of submits) {
    expect(x.key).toBe(`act_${x.actionId}`)
    expect(store.rows.get(x.actionId)!.report).toBe('resume')
  }
}

describe('report (N14): never zero reports; a resume only with the key act_<id>', () => {
  it('holds over random deadlines, early settles, waiter deaths, parallel cards and turn ends', async () => {
    await fc.assert(fc.asyncProperty(world, async w => { await run(w) }), { numRuns: 500 })
  })

  it('the cases written out: settle before the waiter registers; the waiter dies; the turn dies mid-claim', async () => {
    const base = { n: 1, gone: [false], refusals: 0, finalOutcome: 'done' as const, resumes: true }
    await run({ ...base, steps: [{ k: 'settle', i: 0 }, { k: 'register', i: 0 }, { k: 'claim', i: 0, dieBetween: false }, { k: 'poll', i: 0 }] })
    await run({ ...base, steps: [{ k: 'register', i: 0 }, { k: 'claim', i: 0, dieBetween: false }, { k: 'die', i: 0 }, { k: 'settle', i: 0 }, { k: 'deliver', i: 0 }] })
    await run({ ...base, steps: [{ k: 'register', i: 0 }, { k: 'claim', i: 0, dieBetween: true }, { k: 'settle', i: 0 }] })
    await run({ ...base, refusals: 2, steps: [{ k: 'turnEnd', outcome: 'failed' }, { k: 'settle', i: 0 }, { k: 'deliver', i: 0 }] })
    await run({ ...base, gone: [true], steps: [{ k: 'register', i: 0 }, { k: 'settle', i: 0 }] })
  })
})
