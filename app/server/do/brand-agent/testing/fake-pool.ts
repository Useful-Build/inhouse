// A fake RunnerPoolPort (p3-design section 12) for the BrandAgent's tests until W2's real pool lands, and the pool
// anchor's answer in compose.ts until then. Records every call; each answer is a field a test sets.
import type { PoolHealth, RunnerPoolPort, RunnerTurnStatus } from '../ports.ts'
import type { RunStart } from '../../../../shared/protocol/index.ts'

type PlaceAnswer = Awaited<ReturnType<RunnerPoolPort['place']>>

export class FakeRunnerPool implements RunnerPoolPort {
  calls: { method: keyof RunnerPoolPort; args: unknown[] }[] = []
  placeAnswer: PlaceAnswer | ((rs: RunStart, gen: number) => Promise<PlaceAnswer>) = { admitted: 'runner-0' }
  statusAnswer: RunnerTurnStatus = 'unknown'
  healthAnswer: PoolHealth = { protocol: { ok: true }, restarts: { ok: true }, shortfall: { ok: true } }

  async place(rs: RunStart, gen: number): Promise<PlaceAnswer> {
    this.calls.push({ method: 'place', args: [rs, gen] })
    return typeof this.placeAnswer === 'function' ? this.placeAnswer(rs, gen) : this.placeAnswer
  }
  async interrupt(runner: string, turnId: string) { this.calls.push({ method: 'interrupt', args: [runner, turnId] }) }
  async stop(runner: string, turnId: string) { this.calls.push({ method: 'stop', args: [runner, turnId] }) }
  async status(runner: string, turnId: string) {
    this.calls.push({ method: 'status', args: [runner, turnId] })
    return this.statusAnswer
  }
  turnEnded(runner: string, turnId: string) { this.calls.push({ method: 'turnEnded', args: [runner, turnId] }) }
  health() { return this.healthAnswer }
}
