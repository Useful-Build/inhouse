// The fake ledger and W4's real one keep one contract (A4, 2026-11-20): one script of reserve, extend, close, settle and
// release, with the refusal edges, run against `FakeUsageLedger` (cap mode) and `createUsageLedger` on D1. Every answer
// and the end state are written here from W4's rules (design 9 and #154's rounds: the start hold, the $0.05 unit, the
// cap and ceiling refusals, idempotence, finality), and both must give exactly them. Ways it can fail: the fake answers
// a refusal, an idempotent retry, a final turn or an unknown turn differently from the ledger, or ends with other money.
import { describe, expect, it } from 'vitest'
import type { UsageLedgerPort } from '../ports.ts'
import { FakeUsageLedger } from './fake-usage.ts'
import { createUsageLedger } from '../../../usage/ledger.ts'
import { NOV, monthRow, resetUsage, setSetting, turnIn, turnRow } from '../../../usage/test-fixtures.ts'
import { TURN_CEILING_MICRO } from '../../../model/catalog.ts'
import { env } from 'cloudflare:workers'

type Step =
  | { op: 'cap'; cap: string; micro: number }
  | { op: 'reserve'; turn: string; model?: string; want: unknown }
  | { op: 'extend'; turn: string; call: string; need: number; want: unknown }
  | { op: 'close'; turn: string; call: string; actual: number; hold: number; want: unknown }
  | { op: 'settle'; turn: string; micro: number; want: unknown }
  | { op: 'release'; turn: string; want: unknown }

const THROWS = 'throws'
const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-5-5'

/** The script. Month money after each step in the comments (reserved / spent), from W4's rules. */
const SCRIPT: Step[] = [
  { op: 'cap', cap: '$1', micro: 1_000_000 },
  { op: 'reserve', turn: 'tA', want: { reservedMicro: 250_000 } }, // 250k / 0
  { op: 'reserve', turn: 'tB', model: HAIKU, want: { reservedMicro: 250_000 } }, // 500k
  { op: 'reserve', turn: 'tC', want: { reservedMicro: 250_000 } }, // 750k
  // Exactly the start hold left: it fits.
  { op: 'reserve', turn: 'tD', want: { reservedMicro: 250_000 } }, // 1M
  // Nothing left, but the cap minus spend fits one: others' holds block it.
  { op: 'reserve', turn: 'tE', want: { refused: 'budget_busy' } },
  { op: 'reserve', turn: 'tA', want: { reservedMicro: 250_000 } }, // idempotent
  // 120k rounds up to 150k; the month is full: others' holds (`held`), the turn's own money would fit.
  { op: 'extend', turn: 'tA', call: 'a1', need: 120_000, want: { refused: 'held', ledgerHold: 250_000 } },
  { op: 'release', turn: 'tD', want: undefined }, // 750k / 0, tD booked 0
  { op: 'extend', turn: 'tA', call: 'a1', need: 120_000, want: { ok: true, ledgerHold: 400_000 } }, // 900k
  { op: 'extend', turn: 'tA', call: 'a1', need: 120_000, want: { ok: true, ledgerHold: 400_000 } }, // a retry: once
  // An extended call not closed: release refuses (its cost would be lost).
  { op: 'release', turn: 'tA', want: THROWS },
  { op: 'close', turn: 'tA', call: 'a1', actual: 90_000, hold: 300_000, want: { ledgerHold: 300_000 } }, // 800k
  // A double close changes nothing.
  { op: 'close', turn: 'tA', call: 'a1', actual: 999, hold: 260_000, want: { ledgerHold: 300_000 } },
  // A close never raises the hold; a call admitted without an extend closes too.
  { op: 'close', turn: 'tA', call: 'a2', actual: 30_000, hold: 280_000, want: { ledgerHold: 280_000 } }, // 780k
  { op: 'settle', turn: 'tA', micro: 120_000, want: undefined }, // 500k / 120k
  { op: 'close', turn: 'tA', call: 'a3', actual: 5, hold: 5, want: { ledgerHold: 0 } },
  { op: 'extend', turn: 'tA', call: 'a4', need: 50_000, want: { refused: 'turn_budget', ledgerHold: 0 } },
  { op: 'settle', turn: 'tA', micro: 999, want: undefined }, // final: nothing
  { op: 'release', turn: 'tA', want: undefined }, // final: nothing
  { op: 'reserve', turn: 'tE', want: { reservedMicro: 250_000 } }, // 750k / 120k
  // 380,001 rounds up to 400k; others' holds block it, its own money wouldn't (1M − 120k − 250k = 630k).
  { op: 'extend', turn: 'tC', call: 'c1', need: 380_001, want: { refused: 'held', ledgerHold: 250_000 } },
  // 700k is more than the cap leaves even with no other hold: `cap_reached`.
  { op: 'extend', turn: 'tC', call: 'c1', need: 700_000, want: { refused: 'cap_reached', ledgerHold: 250_000 } },
  // Unknown turns.
  { op: 'settle', turn: 'tZ', micro: 10, want: THROWS },
  { op: 'settle', turn: 'tZ', micro: 0, want: undefined },
  { op: 'release', turn: 'tZ', want: undefined },
  { op: 'close', turn: 'tZ', call: 'z1', actual: 1, hold: 1, want: THROWS },
  { op: 'extend', turn: 'tZ', call: 'z1', need: 50_000, want: THROWS },
  // The reserve's cap edge at exact equality: cap − spent = 250k fits a start hold, so others' holds block it.
  { op: 'cap', cap: '$0.37', micro: 370_000 },
  { op: 'reserve', turn: 'tF', want: { refused: 'budget_busy' } },
  // One cent less: the start hold can't fit even with no other hold.
  { op: 'cap', cap: '$0.36', micro: 360_000 },
  { op: 'reserve', turn: 'tF', want: { refused: 'cap_reached' } },
  // Haiku's ceiling is $5.32: 250k + 5.1M passes it, 250k + 5.05M is under it.
  { op: 'cap', cap: '$20', micro: 20_000_000 },
  { op: 'extend', turn: 'tB', call: 'b1', need: 5_100_000, want: { refused: 'turn_budget', ledgerHold: 250_000 } },
  { op: 'extend', turn: 'tB', call: 'b1', need: 5_050_000, want: { ok: true, ledgerHold: 5_300_000 } }, // 5.8M
  { op: 'close', turn: 'tB', call: 'b1', actual: 1_000_000, hold: 250_000, want: { ledgerHold: 250_000 } }, // 750k
  { op: 'release', turn: 'tB', want: undefined }, // 500k / 1.12M, tB booked its closed calls: 1M
]

/** The end state: the month, and per turn its hold while open or what it booked. */
const END = {
  month: { reserved: 500_000, spent: 1_120_000 },
  turns: {
    tA: { final: true, booked: 120_000 }, tB: { final: true, booked: 1_000_000 }, tC: { final: false, hold: 250_000 },
    tD: { final: true, booked: 0 }, tE: { final: false, hold: 250_000 },
  },
}

async function run(ledger: UsageLedgerPort, setCap: (cap: string, micro: number) => Promise<void>): Promise<unknown[]> {
  const out: unknown[] = []
  const attempt = async (f: () => Promise<unknown>) => { try { out.push(await f()) } catch { out.push(THROWS) } }
  for (const s of SCRIPT) {
    switch (s.op) {
      case 'cap': await setCap(s.cap, s.micro); break
      case 'reserve': await attempt(() => ledger.reserve(turnIn(s.turn, { model: s.model ?? SONNET, nowMs: NOV }))); break
      case 'extend': await attempt(() => ledger.extend(s.turn, s.call, s.need)); break
      case 'close': await attempt(() => ledger.close(s.turn, s.call, s.actual, s.hold)); break
      case 'settle': await attempt(() => ledger.settle(s.turn, s.micro, NOV)); break
      case 'release': await attempt(() => ledger.release(s.turn, NOV)); break
    }
  }
  return out
}
const wanted = SCRIPT.filter(s => s.op !== 'cap').map(s => (s as { want: unknown }).want)

describe('the fake ledger keeps W4\'s contract', () => {
  it('the real ledger on D1 gives the script\'s answers and end state', async () => {
    await resetUsage(null)
    const real = createUsageLedger({ db: env.DB, now: () => NOV })
    expect(await run(real, cap => setSetting('s:cap', cap))).toEqual(wanted)
    const m = (await monthRow())!
    expect({ reserved: m.reserved_micro, spent: m.spent_micro }).toEqual(END.month)
    for (const [turn, want] of Object.entries(END.turns)) {
      const r = (await turnRow(turn))!
      expect(r.final === 1 ? { final: true, booked: r.settled_micro } : { final: false, hold: r.reserved_micro }, turn).toEqual(want)
    }
  })

  it('the fake in cap mode gives the same answers and end state', async () => {
    const fake = new FakeUsageLedger()
    fake.ceilings = TURN_CEILING_MICRO
    fake.unitMicro = 50_000
    expect(await run(fake, async (_cap, micro) => { fake.capMicro = micro })).toEqual(wanted)
    expect({ reserved: fake.monthReserved, spent: fake.spent }).toEqual(END.month)
    for (const [turn, want] of Object.entries(END.turns)) {
      const got = fake.final.has(turn) ? { final: true, booked: fake.booked.get(turn) } : { final: false, hold: fake.holds.get(turn) }
      expect(got, turn).toEqual(want)
    }
  })
})
