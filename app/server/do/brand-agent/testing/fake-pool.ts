// A fake RunnerPoolPort (p3-design section 12) for the BrandAgent's tests until W2's real pool lands, and the pool
// anchor's answer in compose.ts until then. Records every call; each answer is a field a test sets.
import type { DrainState, PoolHealth, Refusal, RunnerPoolPort, RunnerTurnStatus } from '../ports.ts'
import type { RunStart } from '../../../../shared/protocol/index.ts'

type PlaceAnswer = Awaited<ReturnType<RunnerPoolPort['place']>>

export class FakeRunnerPool implements RunnerPoolPort {
  calls: { method: keyof RunnerPoolPort; args: unknown[] }[] = []
  placeAnswer: PlaceAnswer | ((rs: RunStart, gen: number) => Promise<PlaceAnswer>) = { admitted: 'runner-0' }
  statusAnswer: { state: RunnerTurnStatus; containerGone: boolean } = { state: 'unknown', containerGone: false }
  drainAnswer: DrainState = { live: 0, starting: 0, ending: 0, queued: 0, drainingUntilMs: null }
  warmupAnswer: { ok: true } | Refusal = { ok: true }
  /** Each runner's turns, as `containerExited` reports them; a generation reported twice answers null. */
  runnerTurns = new Map<string, string[]>()
  private exited = new Set<string>()
  /** The placement queue: a `place` answered `{ queued: true }` adds the turn, in order. */
  queue: string[] = []
  healthAnswer: PoolHealth = { protocol: { ok: true }, restarts: { ok: true }, shortfall: { ok: true } }

  async place(rs: RunStart, gen: number): Promise<PlaceAnswer> {
    this.calls.push({ method: 'place', args: [rs, gen] })
    const answer = typeof this.placeAnswer === 'function' ? await this.placeAnswer(rs, gen) : this.placeAnswer
    if ('queued' in answer && !this.queue.includes(rs.runId)) this.queue.push(rs.runId)
    if ('admitted' in answer) this.queue = this.queue.filter(t => t !== rs.runId)
    return answer
  }
  async interrupt(runner: string, turnId: string) { this.calls.push({ method: 'interrupt', args: [runner, turnId] }) }
  async stop(runner: string, turnId: string) { this.calls.push({ method: 'stop', args: [runner, turnId] }) }
  async status(runner: string, turnId: string) {
    this.calls.push({ method: 'status', args: [runner, turnId] })
    return this.statusAnswer
  }
  turnEnded(runner: string, turnId: string) { this.calls.push({ method: 'turnEnded', args: [runner, turnId] }) }
  health() { return this.healthAnswer }
  /** Like the real one: the drain holds 30 minutes from `nowMs`; `drainState` reports it. */
  drain(nowMs: number) {
    this.calls.push({ method: 'drain', args: [nowMs] })
    this.drainAnswer = { ...this.drainAnswer, drainingUntilMs: nowMs + 30 * 60_000 }
    return this.drainAnswer
  }
  drainState() { this.calls.push({ method: 'drainState', args: [] }); return this.drainAnswer }
  /** Like the real one: a warm-up that succeeds clears the drain. */
  async warmup() {
    this.calls.push({ method: 'warmup', args: [] })
    if ('ok' in this.warmupAnswer) this.drainAnswer = { ...this.drainAnswer, drainingUntilMs: null }
    return this.warmupAnswer
  }
  containerExited(runner: string, gen: number) {
    this.calls.push({ method: 'containerExited', args: [runner, gen] })
    const key = `${runner} ${gen}`
    if (this.exited.has(key)) return null
    this.exited.add(key)
    return this.runnerTurns.get(runner) ?? []
  }
  async retryQueue() { this.calls.push({ method: 'retryQueue', args: [] }) }
  dequeue(turnId: string) {
    this.calls.push({ method: 'dequeue', args: [turnId] })
    this.queue = this.queue.filter(t => t !== turnId)
  }
  clearQueue() {
    this.calls.push({ method: 'clearQueue', args: [] })
    const held = this.queue
    this.queue = []
    return held
  }
}
