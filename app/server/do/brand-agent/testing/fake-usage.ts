// A fake UsageLedgerPort (p3-design section 12): the BrandAgent's tests run on it. It keeps the money the way W4's ledger
// (`usage/ledger.ts`) does, in its own arithmetic, so the model gate's tests assert on the ledger's side and never on the
// BrandAgent's own numbers; `ledger-contract.test.ts` runs one script against both and asserts the same answers:
// - `reserve` is idempotent by turn id (a known turn answers its current hold);
// - a granted `extend` is idempotent by `(turnId, callId)` (a retry answers it again; a refused one may be tried
//   again); a final turn's extend is refused `turn_budget`; an unknown turn's throws;
// - `close` only ever lowers the turn's hold (`MIN(holdMicro, hold)`), is idempotent by the call's closed flag, and is a
//   no-op once `settle` or `release` made the turn final (answering a hold of 0); an unknown turn's throws;
// - `settle` books once (`final`); a cost for an unknown turn throws, nothing for one is a no-op;
// - `release` books the closed calls' actual costs; it throws while an extended call isn't closed (a final turn's is a
//   no-op), and is a no-op for an unknown turn;
// - the month's `reserved` moves by every hold change and drops by the turn's hold at settle, `spent` grows by it.
// Two modes. Scripted (the default): `reserve` and `extend` answer what a test sets (`reserveAnswer`, `extendRefusal`),
// no cap, no rounding. Cap mode (`capMicro` set, with `ceilings` and `unitMicro`): reserve and extend decide as W4 does
// (the start hold if it fits under the cap, an extend rounded up to `unitMicro` under the cap and the model's ceiling;
// a refusal says `cap_reached`, `turn_budget`, `held` or `budget_busy` by W4's rules).
import type { ReserveInput, UsageLedgerPort } from '../ports.ts'

type ReserveAnswer = Awaited<ReturnType<UsageLedgerPort['reserve']>>
type ExtendRefusal = 'cap_reached' | 'turn_budget' | 'held'
type ExtendAnswer = Awaited<ReturnType<UsageLedgerPort['extend']>>

export class FakeUsageLedger implements UsageLedgerPort {
  calls: { method: keyof UsageLedgerPort; args: unknown[] }[] = []
  reserveAnswer: ReserveAnswer = { reservedMicro: 250_000 }
  extendRefusal: ExtendRefusal | null = null
  /** Cap mode: the brand's cap (null: scripted mode), the per-model ceilings and the extend unit. */
  capMicro: number | null = null
  ceilings: Readonly<Record<string, number>> = {}
  unitMicro = 1
  startHoldMicro = 250_000
  /** Each turn's hold, as this fake moved it. */
  holds = new Map<string, number>()
  /** Each turn's model (its ceiling). */
  models = new Map<string, string>()
  /** Turns `settle` or `release` made final. */
  final = new Set<string>()
  /** What each final turn booked. */
  booked = new Map<string, number>()
  /** The month's held and spent money (one month: the fake has no calendar). */
  monthReserved = 0
  spent = 0
  private extends = new Map<string, ExtendAnswer>()
  /** Closed calls and their actual cost, by `${turnId} ${callId}`. */
  closed = new Map<string, number>()

  private setHold(turnId: string, to: number) {
    this.monthReserved += to - (this.holds.get(turnId) ?? 0)
    this.holds.set(turnId, to)
  }
  private known(turnId: string) { return this.holds.has(turnId) }

  async reserve(t: ReserveInput): Promise<ReserveAnswer> {
    this.calls.push({ method: 'reserve', args: [t] })
    if (this.known(t.turnId)) return { reservedMicro: this.holds.get(t.turnId)! }
    if (this.capMicro !== null) {
      if (this.capMicro - this.spent - this.monthReserved < this.startHoldMicro) {
        return { refused: this.capMicro - this.spent < this.startHoldMicro ? 'cap_reached' : 'budget_busy' }
      }
      this.models.set(t.turnId, t.model)
      this.setHold(t.turnId, this.startHoldMicro)
      return { reservedMicro: this.startHoldMicro }
    }
    if ('reservedMicro' in this.reserveAnswer) {
      this.models.set(t.turnId, t.model)
      this.setHold(t.turnId, this.reserveAnswer.reservedMicro)
    }
    return this.reserveAnswer
  }
  async extend(turnId: string, callId: string, needIn: number): Promise<ExtendAnswer> {
    this.calls.push({ method: 'extend', args: [turnId, callId, needIn] })
    if (!this.known(turnId)) throw new Error('usage: extend for a turn that holds nothing')
    const key = `${turnId} ${callId}`
    const isFinal = this.final.has(turnId)
    const hold = isFinal ? 0 : this.holds.get(turnId)!
    if (this.extends.has(key)) return { ok: true, ledgerHold: hold }
    if (isFinal) return { refused: 'turn_budget', ledgerHold: 0 }
    const need = Math.ceil(needIn / this.unitMicro) * this.unitMicro
    let refusal: ExtendRefusal | null = this.extendRefusal
    if (this.capMicro !== null) {
      const ceiling = this.ceilings[this.models.get(turnId) ?? '']
      const fits = this.capMicro - this.spent - this.monthReserved >= need && ceiling !== undefined && hold + need <= ceiling
      refusal = fits ? null
        : this.capMicro - this.spent - hold < need ? 'cap_reached'
          : ceiling === undefined || hold + need > ceiling ? 'turn_budget' : 'held'
    }
    if (refusal) return { refused: refusal, ledgerHold: hold }
    // Only a granted extend is remembered: a refused call may be extended again once a sibling closes.
    this.setHold(turnId, hold + need)
    this.extends.set(key, { ok: true, ledgerHold: hold + need })
    return { ok: true, ledgerHold: hold + need }
  }
  async close(turnId: string, callId: string, actualMicro: number, holdMicro: number) {
    this.calls.push({ method: 'close', args: [turnId, callId, actualMicro, holdMicro] })
    if (!this.known(turnId)) throw new Error('usage: close for a turn that holds nothing')
    const key = `${turnId} ${callId}`
    if (this.final.has(turnId)) return { ledgerHold: 0 }
    if (!this.closed.has(key)) {
      this.closed.set(key, actualMicro)
      this.setHold(turnId, Math.min(holdMicro, this.holds.get(turnId)!))
    }
    return { ledgerHold: this.holds.get(turnId)! }
  }
  private finalize(turnId: string, micro: number) {
    if (this.final.has(turnId)) return
    this.final.add(turnId)
    this.booked.set(turnId, micro)
    this.spent += micro
    this.setHold(turnId, 0)
  }
  async settle(turnId: string, micro: number, nowMs: number, runnerCostMicro: number | null = null) {
    this.calls.push({ method: 'settle', args: [turnId, micro, nowMs, runnerCostMicro] })
    if (!this.known(turnId)) {
      if (micro > 0) throw new Error('usage: settle with a cost for a turn that holds nothing')
      return
    }
    this.finalize(turnId, micro)
  }
  async release(turnId: string, nowMs: number) {
    this.calls.push({ method: 'release', args: [turnId, nowMs] })
    if (!this.known(turnId) || this.final.has(turnId)) return
    for (const key of this.extends.keys()) {
      if (key.startsWith(`${turnId} `) && !this.closed.has(key)) throw new Error('usage: release with a call still open (close it first)')
    }
    let tally = 0
    for (const [key, actual] of this.closed) if (key.startsWith(`${turnId} `)) tally += actual
    this.finalize(turnId, tally)
  }
}
