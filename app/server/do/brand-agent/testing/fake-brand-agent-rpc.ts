// A fake BrandAgentRpc (p3-design section 12) for the egress's (W3) and the pool's (W2) tests: it records every call
// and answers what a test sets. Token checks go through a real `RunTokens` when one is given (W3's scope property runs
// on the real tokens.ts), else through `grants`, a map from token hash to grant.
import type {
  Actor, AdmitAnswer, BrandAgentRpc, DeferDecision, RunScope, DrainState, LeaseAnswer, ModelCallUsage, ModelCallWorst, PersonDataAnswer, PoolHealth, Refusal, RunsHealth,
  SubmitTurn,
} from '../ports.ts'
import type { EgressRoute, RunGrant, RunTokens, TokenRefusal } from '../tokens.ts'
import type { AuditEntry, PushAck, RunEvent } from '../../../../shared/protocol/index.ts'
import type { ActiveRun, PauseState, SendTurnResult } from '../../../../shared/contract/runs.ts'
import type { Trace } from '../../../../shared/contract/trace.ts'

const ok = { ok: true } as const
const green = { ok: true }

export class FakeBrandAgentRpc implements BrandAgentRpc {
  calls: { method: keyof BrandAgentRpc; args: unknown[] }[] = []
  grants = new Map<string, RunGrant>()
  /** Each turn's count_tokens calls so far. */
  countTokens = new Map<string, number>()
  ingestAnswer: PushAck | { gone: true } | ((turnId: string, events: RunEvent[]) => Promise<PushAck | { gone: true }>) =
    async (_t, events) => ({ ackSeq: events.length === 0 ? 0 : events[events.length - 1].seq, stop: false })
  admitAnswer: AdmitAnswer | ((turnId: string, callId: string, worst: ModelCallWorst) => Promise<AdmitAnswer>) = { granted: true }
  renewAnswer: LeaseAnswer = ok
  releaseAnswer: LeaseAnswer = ok
  submitAnswer: SendTurnResult | Refusal = { refused: { code: 'unavailable' } }
  /** What `getPause()` answers; `pause` and `resume` change it. */
  pauseState: PauseState = { paused: false, at: null, by: null }
  /** The turns `noteCountTokens` knows (an unknown turn answers false, like the real counter). */
  turns = new Set<string>()
  drainAnswer: DrainState = { live: 0, starting: 0, ending: 0, queued: 0, drainingUntilMs: null }
  poolHealthAnswer: PoolHealth = { protocol: green, restarts: green, shortfall: green }
  runsHealthAnswer: RunsHealth = { failures: green, stuck: green, damaged: green, quarantined: green }
  reviveAnswer: 'revived' | 'not_quarantined' | 'not_found' = 'revived'

  private readonly tokens: RunTokens | undefined
  private readonly now: () => number
  constructor(tokens?: RunTokens, now: () => number = () => Date.now()) {
    this.tokens = tokens
    this.now = now
  }

  private log(method: keyof BrandAgentRpc, ...args: unknown[]) { this.calls.push({ method, args }) }

  async ingest(turnId: string, events: RunEvent[]) {
    this.log('ingest', turnId, events)
    return typeof this.ingestAnswer === 'function' ? this.ingestAnswer(turnId, events) : this.ingestAnswer
  }
  async checkRunToken(tokenHash: string, route: EgressRoute): Promise<RunGrant | { refused: TokenRefusal }> {
    this.log('checkRunToken', tokenHash, route)
    if (this.tokens) return this.tokens.check(tokenHash, route, this.now())
    return this.grants.get(tokenHash) ?? { refused: 'unknown' }
  }
  async noteCountTokens(turnId: string) {
    this.log('noteCountTokens', turnId)
    if (!this.turns.has(turnId)) return false
    const n = this.countTokens.get(turnId) ?? 0
    if (n >= 50) return false
    this.countTokens.set(turnId, n + 1)
    return true
  }
  async admitModelCall(turnId: string, callId: string, worst: ModelCallWorst) {
    this.log('admitModelCall', turnId, callId, worst)
    return typeof this.admitAnswer === 'function' ? this.admitAnswer(turnId, callId, worst) : this.admitAnswer
  }
  async renewModelCall(turnId: string, callId: string, usage: ModelCallUsage) { this.log('renewModelCall', turnId, callId, usage); return this.renewAnswer }
  async releaseModelCall(turnId: string, callId: string, end: { usage: ModelCallUsage; cut: boolean }) {
    this.log('releaseModelCall', turnId, callId, end)
    return this.releaseAnswer
  }
  async submitTurn(turn: SubmitTurn) { this.log('submitTurn', turn); return this.submitAnswer }
  async interrupt(turnId: string, by: Actor) { this.log('interrupt', turnId, by); return ok }
  async stop(turnId: string, by: Actor) { this.log('stop', turnId, by); return ok }
  async pause(by: Actor) {
    this.log('pause', by)
    if (!this.pauseState.paused) {
      const ms = this.now()
      this.pauseState = { paused: true, at: { iso: new Date(ms).toISOString(), ms }, by: by.memberId }
    }
    return this.pauseState
  }
  async resume(by: Actor) {
    this.log('resume', by)
    this.pauseState = { paused: false, at: null, by: null }
    return this.pauseState
  }
  async getPause() { this.log('getPause'); return this.pauseState }
  async resetSession(chatId: string, by: Actor) { this.log('resetSession', chatId, by); return ok }
  async activeRuns(scope: RunScope): Promise<ActiveRun[]> { this.log('activeRuns', scope); return [] }
  async getTrace(id: string, scope: RunScope): Promise<Trace | null> { this.log('getTrace', id, scope); return null }
  async onMemberRemoved(memberId: string) { this.log('onMemberRemoved', memberId) }
  async onGrantEnded(grantId: string) { this.log('onGrantEnded', grantId) }
  async onGrantCreated(grantId: string, endsAtMs: number) { this.log('onGrantCreated', grantId, endsAtMs) }
  async containerExited(runner: string, gen: number) { this.log('containerExited', runner, gen) }
  async poolHealth() { this.log('poolHealth'); return this.poolHealthAnswer }
  async runsHealth() { this.log('runsHealth'); return this.runsHealthAnswer }
  async drain() { this.log('drain'); return this.drainAnswer }
  async drainState() { this.log('drainState'); return this.drainAnswer }
  async undrain() { this.log('undrain'); return this.drainAnswer }
  async warmup() { this.log('warmup'); return ok }
  async writeToolCall(turnId: string, n: number, entry: AuditEntry) { this.log('writeToolCall', turnId, n, entry) }
  async poke(p: { kind: string; id: string; dueAtMs?: number }) { this.log('poke', p) }
  async revive(p: { kind: string; id: string }) { this.log('revive', p); return this.reviveAnswer }
  async resumeDeferred(chatId: string, decision: DeferDecision, questionId: string): Promise<SendTurnResult | Refusal> {
    this.log('resumeDeferred', { chatId, decision, questionId })
    return { refused: { code: 'not_found' } }
  }
  async personData(p: { personId: string; mode: 'count' | 'delete' }): Promise<PersonDataAnswer> {
    this.log('personData', p)
    return { busy: true }
  }
}
