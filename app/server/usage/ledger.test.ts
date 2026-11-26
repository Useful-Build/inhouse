// The usage ledger on literal fixtures (p3-w4.md "Tests first"). Every expected number below is written out by hand from
// the scenario, never read back from the ledger's tables or computed by its code. Ways it can fail, written down first:
//  1. the cap boundary: a reserve refused as `cap_reached` at $0 spent (it's others' holds: `budget_busy`), or a reserve
//     let through past the cap;
//  2. an extend blocked only by others' holds called `cap_reached` (must be `held`), an extend past the model's ceiling
//     not `turn_budget`;
//  3. a close that doesn't free its hold, so a waiting extend stays refused;
//  4. a lost reply's retry adding a second time (reserve, extend, close, settle);
//  5. a lowered cap not refusing at once, a raised one not clearing;
//  6. the runner's cumulative `costUsd` added to spend on a resumed session;
//  7. a close that commits after settle moving money (a leak, or a hold released twice);
//  8. parallel calls: a close shrinking the hold below what siblings still in flight need, or closes in another order
//     ending at another hold;
//  9. the month taken in UTC (or the server's zone) instead of the brand's `g:tz`, at 23:59, 00:00 and across DST.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { inAgent, settle } from '../testing/brand-agent/core-harness.ts'
import { sweepOnce } from './sweep.ts'
import { createUsageLedger } from './ledger.ts'
import { monthOf } from './month.ts'
import { MONTH, NOV, db, lossyDb, monthRow, resetUsage, setSetting, turnIn, turnRow } from './test-fixtures.ts'

const ledger = createUsageLedger({ db })
const jobRow = (jobId = 'job') => db.prepare('SELECT * FROM usage_jobs WHERE job_id = ?').bind(jobId).first()

/** Fixture holds of other turns, written straight into the tables (not through the ledger). */
async function otherHolds(n: number, each: number, spent: number) {
  await db.prepare(`INSERT INTO usage_months (month, cap_micro, reserved_micro, spent_micro) VALUES (?, 0, ?, ?)
    ON CONFLICT (month) DO UPDATE SET reserved_micro = excluded.reserved_micro, spent_micro = excluded.spent_micro`).bind(MONTH, n * each, spent).run()
  for (let i = 0; i < n; i++) {
    await db.prepare(`INSERT INTO usage_turns (turn_id, run_id, chat_id, member_id, model, month, reserved_micro, created_at_ms)
      VALUES (?, 'r_x', 'c_x', 'm_x', 'claude-sonnet-5-5', ?, ?, 1)`).bind(`t_other_${i}`, MONTH, each).run()
  }
}

describe('job budget', () => {
  beforeEach(async () => {
    await resetUsage('$10')
    await setSetting('s:job_cap', '$1.00')
    await ledger.reserve(turnIn('root'))
  })

  const open = { jobId: 'job', rootTurnId: 'root', nowMs: NOV }
  const jobTurn = (id: string, nowMs = NOV) => ({ ...turnIn(id, { nowMs }), jobId: 'job' })

  it('distinguishes a temporary hold from exhausted job headroom at the port', async () => {
    await ledger.openJob(open)
    expect(await ledger.extend('root', 'c', 750_000)).toEqual({ ok: true, ledgerHold: 1_000_000 })
    expect(await ledger.reserve(jobTurn('next'))).toEqual({ refused: 'budget_busy' })
    expect(await ledger.extend('root', 'more', 50_000)).toEqual({ refused: 'job_budget', ledgerHold: 1_000_000 })
    await ledger.settle('root', 800_000, NOV)
    expect(await ledger.reserve(jobTurn('next'))).toEqual({ refused: 'job_budget' })
    expect(await jobRow()).toMatchObject({ reserved_micro: 0, spent_micro: 800_000 })
  })

  it('carries job_budget through the model gate instead of mapping it to budget_busy', () => inAgent(async h => {
    const turn = await h.submit('c1', 'key-job-gate')
    if ('refused' in turn) throw new Error('fixture turn refused')
    await settle()
    h.usage.extendRefusal = 'job_budget'
    expect(await h.core.admitModelCall(turn.turnId, 'c1', {
      model: 'claude-sonnet-5-5', inputTokens: 0, maxTokens: 1000, modifiers: {}, micro: 400_000,
    })).toEqual({ refused: 'job_budget' })
    await settle()
  }))

  it('closes once even when the reply is lost, and still books a late settle', async () => {
    await ledger.openJob(open)
    expect(await ledger.reserve(jobTurn('next'))).toEqual({ reservedMicro: 250_000 })
    let nowMs = NOV + 1
    const lossy = lossyDb()
    const retry = createUsageLedger({ db: lossy.db, now: () => nowMs })
    lossy.loseNext()
    await expect(retry.closeJob('job')).rejects.toThrow()
    nowMs++
    await retry.closeJob('job')
    await retry.openJob(open)
    expect(await jobRow()).toMatchObject({ state: 'closed', closed_at_ms: NOV + 1, reserved_micro: 500_000 })
    expect(await retry.reserve(jobTurn('late'))).toEqual({ refused: 'job_budget' })
    await retry.release('next', nowMs)
    await retry.settle('root', 350_000, nowMs)
    expect(await jobRow()).toMatchObject({ state: 'closed', reserved_micro: 0, spent_micro: 350_000 })
  })

  it('uses the saved budget across a month boundary while each turn books to its own month', async () => {
    await ledger.settle('root', 600_000, NOV)
    await ledger.openJob(open)
    await setSetting('s:job_cap', '$8.00')
    const dec = Date.UTC(2026, 11, 1)
    expect(await ledger.reserve(jobTurn('dec', dec))).toEqual({ reservedMicro: 250_000 })
    expect(await ledger.extend('dec', 'call', 200_000)).toEqual({ refused: 'job_budget', ledgerHold: 250_000 })
    await ledger.settle('dec', 250_000, dec)
    expect(await monthRow(MONTH)).toMatchObject({ reserved_micro: 0, spent_micro: 600_000 })
    expect(await monthRow('2026-12')).toMatchObject({ reserved_micro: 0, spent_micro: 250_000 })
    expect(await jobRow()).toMatchObject({ budget_micro: 1_000_000, spent_micro: 850_000 })
  })

  it('defaults an unset cap and clamps an out-of-range stored cap', async () => {
    await setSetting('s:job_cap', null)
    await ledger.openJob(open)
    expect(await jobRow()).toMatchObject({ budget_micro: 25_000_000 })
    await setSetting('s:job_cap', '$101.00')
    await ledger.reserve(turnIn('second-root'))
    await ledger.openJob({ jobId: 'second-job', rootTurnId: 'second-root', nowMs: NOV })
    expect(await jobRow('second-job')).toMatchObject({ budget_micro: 100_000_000 })
  })

  it('books actual sweep replay once, even when it goes over the job budget', async () => {
    await ledger.openJob(open)
    await ledger.reserve(jobTurn('next'))
    await ledger.closeJob('job')
    await runInDurableObject(env.BRAND_AGENT.getByName('job-usage-sweep'), async (_agent, state) => {
      const run = () => sweepOnce({ db, sql: state.storage.sql, nowMs: NOV + 3 * 60 * 60_000, turnCalls: id => ({ micro: id === 'root' ? 700_000 : 400_000 }) })
      expect(await run()).toMatchObject({ settled: 2, failed: 0 })
      expect(await run()).toMatchObject({ settled: 0, failed: 0 })
    })
    expect(await jobRow()).toMatchObject({ state: 'closed', reserved_micro: 0, spent_micro: 1_100_000 })
    expect(await monthRow()).toMatchObject({ reserved_micro: 0, spent_micro: 1_100_000 })
  })
})

describe('reserve at the cap boundary (failure 1)', () => {
  beforeEach(() => resetUsage('$1.00'))

  it('cap $1.00, $0 spent: four $0.25 holds fit, the fifth is budget_busy, never cap_reached', async () => {
    for (const t of ['t1', 't2', 't3', 't4']) expect(await ledger.reserve(turnIn(t))).toEqual({ reservedMicro: 250_000 })
    expect(await ledger.reserve(turnIn('t5'))).toEqual({ refused: 'budget_busy' })
    expect(await monthRow()).toMatchObject({ cap_micro: 1_000_000, reserved_micro: 1_000_000, spent_micro: 0 })
    expect(await turnRow('t5')).toBeNull()
  })

  it('cap $1.00, $0.80 spent: the next reserve is cap_reached', async () => {
    await otherHolds(0, 0, 800_000)
    expect(await ledger.reserve(turnIn('t1'))).toEqual({ refused: 'cap_reached' })
    expect(await monthRow()).toMatchObject({ reserved_micro: 0, spent_micro: 800_000 })
  })

  it('no cap, or a cap that is not a valid amount, reserves nothing', async () => {
    await resetUsage(null)
    expect(await ledger.reserve(turnIn('t1'))).toEqual({ refused: 'cap_reached' })
    await setSetting('s:cap', '$1,000')
    expect(await ledger.reserve(turnIn('t2'))).toEqual({ refused: 'cap_reached' })
    await setSetting('s:cap', null)
    expect(await ledger.reserve(turnIn('t3'))).toEqual({ refused: 'cap_reached' })
    expect(await monthRow()).toMatchObject({ cap_micro: 0, reserved_micro: 0 })
  })
})

describe('extend refusals (failure 2) and a close freeing room (failure 3)', () => {
  it('cap $60, spent $45, five holds of $2.78: the sixth turn\'s $2.53 extend is held, not cap_reached', async () => {
    await resetUsage('$60')
    await otherHolds(5, 2_780_000, 45_000_000)
    expect(await ledger.reserve(turnIn('t6'))).toEqual({ reservedMicro: 250_000 })
    // $2.53 rounds up to $2.55; free = 60 - 45 - 13.90 - 0.25 = $0.85.
    expect(await ledger.extend('t6', 'c1', 2_530_000)).toEqual({ refused: 'held', ledgerHold: 250_000 })
    expect(await monthRow()).toMatchObject({ reserved_micro: 14_150_000, spent_micro: 45_000_000 })
  })

  it('an extend past the model\'s ceiling is turn_budget (Haiku 5.5, $5.32)', async () => {
    await resetUsage('$100')
    await ledger.reserve(turnIn('t1', { model: 'claude-haiku-5-5' }))
    // 0.25 + 5.10 = 5.35 > 5.32.
    expect(await ledger.extend('t1', 'c1', 5_100_000)).toEqual({ refused: 'turn_budget', ledgerHold: 250_000 })
    // 0.25 + 5.05 = 5.30 fits.
    expect(await ledger.extend('t1', 'c2', 5_050_000)).toEqual({ ok: true, ledgerHold: 5_300_000 })
  })

  it('an extend refused by the ceiling succeeds after a close frees room', async () => {
    await resetUsage('$100')
    await ledger.reserve(turnIn('t1', { model: 'claude-haiku-5-5' }))
    expect(await ledger.extend('t1', 'c1', 2_500_000)).toEqual({ ok: true, ledgerHold: 2_750_000 })
    expect(await ledger.extend('t1', 'c2', 2_600_000)).toEqual({ refused: 'turn_budget', ledgerHold: 2_750_000 })
    // c1 closed at $0.20, nothing else in flight: hold = max(0.20, 0.25) = 0.25.
    expect(await ledger.close('t1', 'c1', 200_000, 250_000)).toEqual({ ledgerHold: 250_000 })
    expect(await ledger.extend('t1', 'c2', 2_600_000)).toEqual({ ok: true, ledgerHold: 2_850_000 })
    expect(await monthRow()).toMatchObject({ reserved_micro: 2_850_000 })
  })

  it('a turn blocked only by its own hold is cap_reached: cap $10, one turn holding $9.90, need $0.50', async () => {
    await resetUsage('$10')
    await ledger.reserve(turnIn('t1'))
    expect(await ledger.extend('t1', 'c1', 9_650_000)).toEqual({ ok: true, ledgerHold: 9_900_000 })
    expect(await ledger.close('t1', 'c1', 9_000_000, 9_900_000)).toEqual({ ledgerHold: 9_900_000 })
    expect(await ledger.extend('t1', 'c2', 500_000)).toEqual({ refused: 'cap_reached', ledgerHold: 9_900_000 })
  })

  it('a hold freed by another turn\'s close lets the held extend through', async () => {
    await resetUsage('$10')
    await ledger.reserve(turnIn('tA'))
    expect(await ledger.extend('tA', 'a1', 9_000_000)).toEqual({ ok: true, ledgerHold: 9_250_000 })
    await ledger.reserve(turnIn('tB'))
    expect(await ledger.extend('tB', 'b1', 1_000_000)).toEqual({ refused: 'held', ledgerHold: 250_000 })
    expect(await ledger.close('tA', 'a1', 500_000, 500_000)).toEqual({ ledgerHold: 500_000 })
    expect(await ledger.extend('tB', 'b1', 1_000_000)).toEqual({ ok: true, ledgerHold: 1_250_000 })
    expect(await monthRow()).toMatchObject({ reserved_micro: 1_750_000, spent_micro: 0 })
  })
})

describe('a lost reply, retried, counts once (failure 4)', () => {
  it('reserve, extend, close and settle each commit once when their reply is lost', async () => {
    await resetUsage('$20')
    const lossy = lossyDb()
    const l = createUsageLedger({ db: lossy.db })
    const retry = async <T>(f: () => Promise<T>): Promise<T> => {
      lossy.loseNext()
      await expect(f()).rejects.toThrow()
      return f()
    }
    expect(await retry(() => l.reserve(turnIn('t1')))).toEqual({ reservedMicro: 250_000 })
    expect(await retry(() => l.extend('t1', 'c1', 1_000_000))).toEqual({ ok: true, ledgerHold: 1_250_000 })
    expect(await monthRow()).toMatchObject({ reserved_micro: 1_250_000 })
    expect(await retry(() => l.close('t1', 'c1', 400_000, 400_000))).toEqual({ ledgerHold: 400_000 })
    expect(await monthRow()).toMatchObject({ reserved_micro: 400_000 })
    await retry(() => l.settle('t1', 400_000, NOV))
    expect(lossy.lost()).toBe(4)
    expect(await monthRow()).toMatchObject({ reserved_micro: 0, spent_micro: 400_000 })
    expect(await turnRow('t1')).toMatchObject({ final: 1, settled_micro: 400_000 })
  })
})

describe('a changed cap applies at once (failure 5)', () => {
  it('lowered below spend refuses reserve and extend; raised, both pass', async () => {
    await resetUsage('$2')
    await ledger.reserve(turnIn('t1'))
    await ledger.extend('t1', 'c1', 1_250_000)
    await ledger.close('t1', 'c1', 1_500_000, 1_500_000)
    await ledger.settle('t1', 1_500_000, NOV)
    await ledger.reserve(turnIn('t2'))
    await setSetting('s:cap', '$1')
    expect(await ledger.reserve(turnIn('t3'))).toEqual({ refused: 'cap_reached' })
    expect(await ledger.extend('t2', 'c1', 100_000)).toEqual({ refused: 'cap_reached', ledgerHold: 250_000 })
    await setSetting('s:cap', '$5')
    expect(await ledger.reserve(turnIn('t3'))).toEqual({ reservedMicro: 250_000 })
    expect(await ledger.extend('t2', 'c1', 100_000)).toEqual({ ok: true, ledgerHold: 350_000 })
    expect(await monthRow()).toMatchObject({ cap_micro: 5_000_000, spent_micro: 1_500_000, reserved_micro: 600_000 })
  })
})

describe('a resumed session (failure 6)', () => {
  it('runner costUsd $0.03 then $0.06 (cumulative), tallies $0.03 each: spent $0.06', async () => {
    await resetUsage('$10')
    for (const [t, runner] of [['t1', 30_000], ['t2', 60_000]] as const) {
      await ledger.reserve(turnIn(t, { chatId: 'c_same' }))
      await ledger.close(t, 'c1', 30_000, 250_000)
      await ledger.settle(t, 30_000, NOV, runner)
    }
    expect(await monthRow()).toMatchObject({ spent_micro: 60_000, reserved_micro: 0 })
    expect(await turnRow('t2')).toMatchObject({ settled_micro: 30_000, runner_cost_micro: 60_000 })
  })
})

describe('a close after settle (failure 7)', () => {
  it('is a no-op: the month holds exactly the open turns\' holds, nothing released twice', async () => {
    await resetUsage('$10')
    await ledger.reserve(turnIn('tA'))
    await ledger.extend('tA', 'a1', 1_000_000)
    await ledger.reserve(turnIn('tB'))
    // The last close of tA failed; settle went first (from the tally, $0.70), then the close's retry commits.
    await ledger.settle('tA', 700_000, NOV)
    expect(await ledger.close('tA', 'a1', 700_000, 700_000)).toEqual({ ledgerHold: 0 })
    await ledger.release('tA', NOV)
    await ledger.settle('tA', 700_000, NOV)
    expect(await monthRow()).toMatchObject({ reserved_micro: 250_000, spent_micro: 700_000 })
    expect(await turnRow('tA')).toMatchObject({ final: 1, settled_micro: 700_000, reserved_micro: 1_250_000 })
  })

  it('release books the closed calls\' actual costs, and nothing for a turn with no call', async () => {
    await resetUsage('$10')
    await ledger.reserve(turnIn('t1'))
    await ledger.release('t1', NOV)
    await ledger.reserve(turnIn('t2'))
    await ledger.close('t2', 'c1', 120_000, 250_000)
    await ledger.close('t2', 'c2', 30_000, 250_000)
    await ledger.release('t2', NOV)
    expect(await monthRow()).toMatchObject({ reserved_micro: 0, spent_micro: 150_000 })
    expect(await turnRow('t1')).toMatchObject({ final: 1, settled_micro: 0 })
  })

  it('settle with a cost for a turn that never reserved refuses loudly; release of one is a no-op', async () => {
    await resetUsage('$10')
    await expect(ledger.settle('t_none', 10_000, NOV)).rejects.toThrow()
    await ledger.release('t_none', NOV)
    expect(await turnRow('t_none')).toBeNull()
  })
})

describe('parallel calls (failure 8)', () => {
  /** Two calls of $1.00 worst each on one turn, both granted: hold $2.00. */
  async function twoInFlight(t: string) {
    await ledger.reserve(turnIn(t))
    // need = 0 + 1.00 - 0.25 = 0.75; then 0 + 2.00 - 1.00 = 1.00.
    expect(await ledger.extend(t, 'c1', 750_000)).toEqual({ ok: true, ledgerHold: 1_000_000 })
    expect(await ledger.extend(t, 'c2', 1_000_000)).toEqual({ ok: true, ledgerHold: 2_000_000 })
  }

  it('a close with a sibling in flight keeps tally + the sibling\'s worst: $0.20 + $1.00 = $1.20', async () => {
    await resetUsage('$10')
    await twoInFlight('t1')
    expect(await ledger.close('t1', 'c1', 200_000, 1_200_000)).toEqual({ ledgerHold: 1_200_000 })
    expect(await ledger.close('t1', 'c2', 300_000, 500_000)).toEqual({ ledgerHold: 500_000 })
    expect(await ledger.close('t1', 'c1', 200_000, 500_000)).toEqual({ ledgerHold: 500_000 })
    expect(await monthRow()).toMatchObject({ reserved_micro: 500_000 })
  })

  it('closes in the other order, and repeated, end at the same hold', async () => {
    await resetUsage('$10')
    await twoInFlight('t2')
    expect(await ledger.close('t2', 'c2', 300_000, 1_300_000)).toEqual({ ledgerHold: 1_300_000 })
    expect(await ledger.close('t2', 'c2', 300_000, 1_300_000)).toEqual({ ledgerHold: 1_300_000 })
    expect(await ledger.close('t2', 'c1', 200_000, 500_000)).toEqual({ ledgerHold: 500_000 })
    expect(await monthRow()).toMatchObject({ reserved_micro: 500_000 })
    await ledger.settle('t2', 500_000, NOV)
    expect(await monthRow()).toMatchObject({ reserved_micro: 0, spent_micro: 500_000 })
  })

  it('a close never raises the hold past what extends granted', async () => {
    await resetUsage('$10')
    await ledger.reserve(turnIn('t3'))
    expect(await ledger.close('t3', 'c1', 100_000, 900_000)).toEqual({ ledgerHold: 250_000 })
    expect(await monthRow()).toMatchObject({ reserved_micro: 250_000 })
  })
})

describe('the brand\'s month (failure 9)', () => {
  it('New York: 23:59 on Nov 30 is November, 00:00 on Dec 1 is December', () => {
    expect(monthOf(Date.UTC(2026, 11, 1, 4, 59), 'America/New_York')).toBe('2026-11')
    expect(monthOf(Date.UTC(2026, 11, 1, 5, 0), 'America/New_York')).toBe('2026-12')
  })
  it('London in summer time: 00:00 BST on Apr 1 is April while UTC is still Mar 31', () => {
    expect(monthOf(Date.UTC(2026, 2, 31, 22, 59), 'Europe/London')).toBe('2026-03')
    expect(monthOf(Date.UTC(2026, 2, 31, 23, 0), 'Europe/London')).toBe('2026-04')
  })
  it('Sydney after its DST start (Oct 4): 00:00 AEDT on Nov 1 is 13:00 UTC on Oct 31', () => {
    expect(monthOf(Date.UTC(2026, 9, 31, 12, 59), 'Australia/Sydney')).toBe('2026-10')
    expect(monthOf(Date.UTC(2026, 9, 31, 13, 0), 'Australia/Sydney')).toBe('2026-11')
  })
  it('London on the day DST starts (Mar 29) is still March either side of the change', () => {
    expect(monthOf(Date.UTC(2026, 2, 29, 0, 59), 'Europe/London')).toBe('2026-03')
    expect(monthOf(Date.UTC(2026, 2, 29, 1, 0), 'Europe/London')).toBe('2026-03')
  })
  it('a reserve takes the month in the brand\'s zone and keeps it on the turn', async () => {
    await resetUsage('$10', 'America/New_York')
    await ledger.reserve(turnIn('t_late', { nowMs: Date.UTC(2026, 11, 1, 4, 59) }))
    await ledger.reserve(turnIn('t_early', { nowMs: Date.UTC(2026, 11, 1, 5, 0) }))
    expect((await turnRow('t_late'))?.month).toBe('2026-11')
    expect((await turnRow('t_early'))?.month).toBe('2026-12')
    expect(await monthRow('2026-11')).toMatchObject({ reserved_micro: 250_000 })
    expect(await monthRow('2026-12')).toMatchObject({ reserved_micro: 250_000 })
  })
})

describe('boundaries and guards (review round 1)', () => {
  it('(a) reserve with exactly $0.25 left: budget_busy while another turn holds, reserved when nothing else is held', async () => {
    await resetUsage('$1')
    await otherHolds(1, 250_000, 750_000)
    expect(await ledger.reserve(turnIn('t1'))).toEqual({ refused: 'budget_busy' })
    await resetUsage('$1')
    await otherHolds(0, 0, 750_000)
    expect(await ledger.reserve(turnIn('t1'))).toEqual({ reservedMicro: 250_000 })
  })

  it('(b) an extend to exactly the ceiling passes; one micro over is turn_budget (Sonnet 5.5, $14.68)', async () => {
    await resetUsage('$100')
    await ledger.reserve(turnIn('t1'))
    expect(await ledger.close('t1', 'c0', 0, 180_000)).toEqual({ ledgerHold: 180_000 })
    expect(await ledger.extend('t1', 'c1', 14_500_000)).toEqual({ ok: true, ledgerHold: 14_680_000 })
    await ledger.reserve(turnIn('t2'))
    expect(await ledger.close('t2', 'c0', 0, 180_001)).toEqual({ ledgerHold: 180_001 })
    expect(await ledger.extend('t2', 'c1', 14_500_000)).toEqual({ refused: 'turn_budget', ledgerHold: 180_001 })
  })

  it('(c) with cap − spent − own hold exactly the need it is held (others block it); $0.05 more is cap_reached', async () => {
    await resetUsage('$10')
    await otherHolds(1, 1_000_000, 8_000_000)
    await ledger.reserve(turnIn('t1'))
    // 10 − 8 − 0.25 = 1.75: equal → others' $1.00 is what blocks it.
    expect(await ledger.extend('t1', 'c1', 1_750_000)).toEqual({ refused: 'held', ledgerHold: 250_000 })
    expect(await ledger.extend('t1', 'c2', 1_800_000)).toEqual({ refused: 'cap_reached', ledgerHold: 250_000 })
  })

  it('(d) an extend on a final turn is turn_budget and leaves the month\'s reserved alone', async () => {
    await resetUsage('$10')
    await ledger.reserve(turnIn('t1'))
    await ledger.reserve(turnIn('t2'))
    await ledger.settle('t1', 100_000, NOV)
    expect(await ledger.extend('t1', 'c1', 500_000)).toEqual({ refused: 'turn_budget', ledgerHold: 0 })
    expect(await monthRow()).toMatchObject({ reserved_micro: 250_000, spent_micro: 100_000 })
  })

  it('(e) a cap lowered between reserve and extend refuses the extend on the new cap', async () => {
    await resetUsage('$10')
    await ledger.reserve(turnIn('t1'))
    await setSetting('s:cap', '$0.50')
    expect(await ledger.extend('t1', 'c1', 300_000)).toEqual({ refused: 'cap_reached', ledgerHold: 250_000 })
    expect(await monthRow()).toMatchObject({ cap_micro: 500_000, reserved_micro: 250_000 })
  })

  it('(f) the first alert crossing is kept when spend crosses again', async () => {
    await resetUsage('$10')
    await setSetting('s:alert', '50%')
    await ledger.reserve(turnIn('t1'))
    await ledger.reserve(turnIn('t2'))
    await ledger.settle('t1', 6_000_000, 1_111)
    expect((await monthRow())?.alert_crossed_at_ms).toBe(1_111)
    await ledger.settle('t2', 1_000_000, 2_222)
    expect((await monthRow())?.alert_crossed_at_ms).toBe(1_111)
  })

  it('(g) a stale replay of an earlier close doesn\'t shrink a later extend\'s hold', async () => {
    await resetUsage('$10')
    await ledger.reserve(turnIn('t1'))
    expect(await ledger.extend('t1', 'c1', 2_000_000)).toEqual({ ok: true, ledgerHold: 2_250_000 })
    expect(await ledger.close('t1', 'c1', 500_000, 500_000)).toEqual({ ledgerHold: 500_000 })
    expect(await ledger.extend('t1', 'c2', 1_000_000)).toEqual({ ok: true, ledgerHold: 1_500_000 })
    expect(await ledger.close('t1', 'c1', 500_000, 500_000)).toEqual({ ledgerHold: 1_500_000 })
    expect(await monthRow()).toMatchObject({ reserved_micro: 1_500_000 })
  })

  it('release with a call still open throws and changes nothing; once closed it books the call', async () => {
    await resetUsage('$10')
    await ledger.reserve(turnIn('t1'))
    await ledger.extend('t1', 'c1', 1_000_000)
    await expect(ledger.release('t1', NOV)).rejects.toThrow('call still open')
    expect(await monthRow()).toMatchObject({ reserved_micro: 1_250_000, spent_micro: 0 })
    expect(await turnRow('t1')).toMatchObject({ final: 0 })
    await ledger.close('t1', 'c1', 400_000, 400_000)
    await ledger.release('t1', NOV)
    expect(await monthRow()).toMatchObject({ reserved_micro: 0, spent_micro: 400_000 })
  })
})
