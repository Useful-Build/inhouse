// A fake UsageLedgerPort (p3-design section 12) until W4's real ledger lands, and the usage anchor's answer in
// compose.ts until then. Records every call; `reserve` and `extend` answer what a test sets, and the hold it reports
// is the sum the fake was told (no month, no cap: W4's tests own those). Like the real one, a granted `extend` is idempotent by
// `(turnId, callId)` (a retry answers it again; a refused one may be tried again) and `close` is a no-op once `settle` or `release` made
// the turn final.
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
  private extends = new Map<string, Awaited<ReturnType<UsageLedgerPort['extend']>>>()

  async reserve(t: ReserveInput): Promise<ReserveAnswer> {
    this.calls.push({ method: 'reserve', args: [t] })
    if ('reservedMicro' in this.reserveAnswer && !this.holds.has(t.turnId)) this.holds.set(t.turnId, this.reserveAnswer.reservedMicro)
    return this.reserveAnswer
  }
  async extend(turnId: string, callId: string, needMicro: number) {
    this.calls.push({ method: 'extend', args: [turnId, callId, needMicro] })
    const key = `${turnId} ${callId}`
    const before = this.extends.get(key)
    if (before) return before
    const hold = this.holds.get(turnId) ?? 0
    const answer = this.extendRefusal
      ? { refused: this.extendRefusal, ledgerHold: hold }
      : { ok: true as const, ledgerHold: hold + needMicro }
    // Only a granted extend is remembered: a refused call may be extended again once a sibling closes.
    if (!this.extendRefusal) {
      this.holds.set(turnId, hold + needMicro)
      this.extends.set(key, answer)
    }
    return answer
  }
  async close(turnId: string, callId: string, actualMicro: number, holdMicro: number) {
    this.calls.push({ method: 'close', args: [turnId, callId, actualMicro, holdMicro] })
    if (!this.final.has(turnId)) this.holds.set(turnId, holdMicro)
    return { ledgerHold: this.holds.get(turnId) ?? 0 }
  }
  async settle(turnId: string, micro: number, nowMs: number) {
    this.calls.push({ method: 'settle', args: [turnId, micro, nowMs] })
    this.final.add(turnId)
  }
  async release(turnId: string, nowMs: number) {
    this.calls.push({ method: 'release', args: [turnId, nowMs] })
    this.final.add(turnId)
  }
}
