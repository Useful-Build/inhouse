// A fake UsageLedgerPort (p3-design section 12) until W4's real ledger lands, and the usage anchor's answer in
// compose.ts until then. Records every call; `reserve` and `extend` answer what a test sets, and the hold it reports
// is the sum the fake was told (no month, no cap: W4's tests own those).
import type { ReserveInput, UsageLedgerPort } from '../ports.ts'

type ReserveAnswer = Awaited<ReturnType<UsageLedgerPort['reserve']>>
type ExtendRefusal = 'cap_reached' | 'turn_budget' | 'held'

export class FakeUsageLedger implements UsageLedgerPort {
  calls: { method: keyof UsageLedgerPort; args: unknown[] }[] = []
  reserveAnswer: ReserveAnswer = { reservedMicro: 250_000 }
  extendRefusal: ExtendRefusal | null = null
  /** Each turn's hold, as this fake moved it. */
  holds = new Map<string, number>()

  async reserve(t: ReserveInput): Promise<ReserveAnswer> {
    this.calls.push({ method: 'reserve', args: [t] })
    if ('reservedMicro' in this.reserveAnswer && !this.holds.has(t.turnId)) this.holds.set(t.turnId, this.reserveAnswer.reservedMicro)
    return this.reserveAnswer
  }
  async extend(turnId: string, callId: string, needMicro: number) {
    this.calls.push({ method: 'extend', args: [turnId, callId, needMicro] })
    const hold = this.holds.get(turnId) ?? 0
    if (this.extendRefusal) return { refused: this.extendRefusal, ledgerHold: hold }
    this.holds.set(turnId, hold + needMicro)
    return { ok: true as const, ledgerHold: hold + needMicro }
  }
  async close(turnId: string, callId: string, actualMicro: number, holdMicro: number) {
    this.calls.push({ method: 'close', args: [turnId, callId, actualMicro, holdMicro] })
    this.holds.set(turnId, holdMicro)
    return { ledgerHold: holdMicro }
  }
  async settle(turnId: string, micro: number, nowMs: number) { this.calls.push({ method: 'settle', args: [turnId, micro, nowMs] }) }
  async release(turnId: string, nowMs: number) { this.calls.push({ method: 'release', args: [turnId, nowMs] }) }
}
