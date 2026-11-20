// A fake UsageLedgerPort (p3-design section 12) until W4's real ledger lands, and the usage anchor's answer in
// compose.ts until then. Records every call; `reserve` and `extend` answer what a test sets. It keeps the money the way
// W4's ledger does (design 9), in its own arithmetic, so the model gate's tests can assert on the ledger's side and
// never on the BrandAgent's own numbers:
// - a granted `extend` is idempotent by `(turnId, callId)` (a retry answers it again; a refused one may be tried
//   again); a final turn's extend is refused `turn_budget`;
// - `close` only ever lowers the turn's hold (`MIN(holdMicro, hold)`), is idempotent by the call's closed flag, and is a
//   no-op once `settle` or `release` made the turn final (answering a hold of 0, as W4's does);
// - the month's `reserved` moves by every hold change and drops by the turn's hold at settle, `spent` grows by it.
// No rounding of `need` (W4 rounds to $0.05): the gate's tests use exact amounts.
import type { ReserveInput, UsageLedgerPort } from '../ports.ts'

type ReserveAnswer = Awaited<ReturnType<UsageLedgerPort['reserve']>>
type ExtendRefusal = 'cap_reached' | 'turn_budget' | 'held'

export class FakeUsageLedger implements UsageLedgerPort {
  calls: { method: keyof UsageLedgerPort; args: unknown[] }[] = []
  reserveAnswer: ReserveAnswer = { reservedMicro: 250_000 }
  extendRefusal: ExtendRefusal | null = null
  /** Each turn's hold, as this fake moved it. */
  holds = new Map<string, number>()
  /** Turns `settle` or `release` made final. */
  final = new Set<string>()
  /** What each final turn booked. */
  booked = new Map<string, number>()
  /** The month's held and spent money (one month: the fake has no calendar). */
  monthReserved = 0
  spent = 0
  private extends = new Map<string, Awaited<ReturnType<UsageLedgerPort['extend']>>>()
  /** Closed calls and their actual cost, by `${turnId} ${callId}`. */
  closed = new Map<string, number>()

  private setHold(turnId: string, to: number) {
    this.monthReserved += to - (this.holds.get(turnId) ?? 0)
    this.holds.set(turnId, to)
  }

  async reserve(t: ReserveInput): Promise<ReserveAnswer> {
    this.calls.push({ method: 'reserve', args: [t] })
    if ('reservedMicro' in this.reserveAnswer && !this.holds.has(t.turnId)) this.setHold(t.turnId, this.reserveAnswer.reservedMicro)
    return this.reserveAnswer
  }
  async extend(turnId: string, callId: string, needMicro: number) {
    this.calls.push({ method: 'extend', args: [turnId, callId, needMicro] })
    const key = `${turnId} ${callId}`
    const before = this.extends.get(key)
    if (before) return { ...before, ledgerHold: this.final.has(turnId) ? 0 : this.holds.get(turnId) ?? 0 }
    if (this.final.has(turnId)) return { refused: 'turn_budget' as const, ledgerHold: 0 }
    const hold = this.holds.get(turnId) ?? 0
    if (this.extendRefusal) return { refused: this.extendRefusal, ledgerHold: hold }
    // Only a granted extend is remembered: a refused call may be extended again once a sibling closes.
    this.setHold(turnId, hold + needMicro)
    const answer = { ok: true as const, ledgerHold: hold + needMicro }
    this.extends.set(key, answer)
    return answer
  }
  async close(turnId: string, callId: string, actualMicro: number, holdMicro: number) {
    this.calls.push({ method: 'close', args: [turnId, callId, actualMicro, holdMicro] })
    const key = `${turnId} ${callId}`
    if (this.final.has(turnId)) return { ledgerHold: 0 }
    if (!this.closed.has(key)) {
      this.closed.set(key, actualMicro)
      this.setHold(turnId, Math.min(holdMicro, this.holds.get(turnId) ?? 0))
    }
    return { ledgerHold: this.holds.get(turnId) ?? 0 }
  }
  private finalize(turnId: string, micro: number) {
    if (this.final.has(turnId)) return
    this.final.add(turnId)
    this.booked.set(turnId, micro)
    this.spent += micro
    this.setHold(turnId, 0)
  }
  async settle(turnId: string, micro: number, nowMs: number) {
    this.calls.push({ method: 'settle', args: [turnId, micro, nowMs] })
    this.finalize(turnId, micro)
  }
  async release(turnId: string, nowMs: number) {
    this.calls.push({ method: 'release', args: [turnId, nowMs] })
    let tally = 0
    for (const [key, actual] of this.closed) if (key.startsWith(`${turnId} `)) tally += actual
    this.finalize(turnId, tally)
  }
}
