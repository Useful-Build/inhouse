// The BrandAgent Durable Object (P3, p3-design section 4): one per brand, `env.BRAND_AGENT.getByName('brand')`. Owner:
// W1 (p3-w1.md). The class wires the object's SQLite, its scheduler (the one owner of the alarm), the run tokens and
// the ports (compose.ts) to the turn engine (core.ts), and answers the RPC surface (`BrandAgentRpc`, ports.ts). The
// socket (`fetch`, route 34) is PR 4's; the model gate's three calls answer "not admitted" until PR 2b builds it (no
// model is priced before W3's catalogue, so route 29 refuses every model until then anyway).
import { DurableObject } from 'cloudflare:workers'
import { apiError } from '../../http.ts'
import { SYSTEM_PROMPT_V1 } from '../../prompt/system.ts'
import type { AuditEntry, PushAck, RunEvent } from '../../../shared/protocol/index.ts'
import type { ActiveRun, PauseState, SendTurnResult } from '../../../shared/contract/runs.ts'
import type { Trace } from '../../../shared/contract/trace.ts'
import { composePorts } from './compose.ts'
import { AgentCore } from './core.ts'
import type {
  Actor, AdmitAnswer, BrandAgentPorts, BrandAgentRpc, DrainState, LeaseAnswer, ModelCallUsage, ModelCallWorst, PoolHealth, Refusal, RunScope, RunsHealth, SubmitTurn,
} from './ports.ts'
import { createAgentTables } from './schema.ts'
import { alarmPort, createScheduler } from './scheduler.ts'
import type { SqlScheduler, TaskContext } from './scheduler.ts'
import { taskHandlers } from './tasks/index.ts'
import { createRunTokens } from './tokens.ts'
import type { EgressRoute, RunGrant, TokenRefusal } from './tokens.ts'

export class BrandAgent extends DurableObject<Env> implements BrandAgentRpc {
  private core!: AgentCore
  private sched!: SqlScheduler
  private ports!: BrandAgentPorts

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql
      createAgentTables(sql)
      const now = () => Date.now()
      const tokens = createRunTokens(sql, now)
      const sched: SqlScheduler = createScheduler<TaskContext>({
        sql, alarm: alarmPort(ctx.storage), now, handlers: taskHandlers,
        context: (nowMs): TaskContext => ({ nowMs, env, sql, scheduler: sched, tokens, ports: this.ports, agent: this.core }),
      })
      this.sched = sched
      this.ports = composePorts(env, {
        sql, scheduler: sched, now,
        hooks: { retryPlacement: id => this.core.retryPlacement(id), placementExpired: id => this.core.placementExpired(id) },
      })
      this.core = new AgentCore({ sql, scheduler: sched, tokens, ports: this.ports, now, systemPrompt: SYSTEM_PROMPT_V1, db: env.DB })
      this.core.ensureSeeds()
      await sched.syncAlarm()
    })
  }

  async alarm(): Promise<void> {
    await this.sched.alarm()
  }

  /** Route 34's socket upgrade: PR 4. */
  async fetch(): Promise<Response> {
    return apiError('unavailable', { reason: 'not_built' })
  }

  // ---------- the egress (8.1, 8.2, 8.6, 8.7) ----------
  async ingest(turnId: string, events: RunEvent[]): Promise<PushAck | { gone: true }> {
    return this.core.ingest(turnId, events)
  }
  async checkRunToken(tokenHash: string, route: EgressRoute): Promise<RunGrant | { refused: TokenRefusal }> {
    return this.core.checkRunToken(tokenHash, route)
  }
  async noteCountTokens(turnId: string): Promise<boolean> {
    return this.core.noteCountTokens(turnId)
  }
  /** PR 2b builds the gate; until then no call is admitted (503 for that call). */
  async admitModelCall(_turnId: string, _callId: string, _worst: ModelCallWorst): Promise<AdmitAnswer> {
    return { busy: true }
  }
  async renewModelCall(_turnId: string, _callId: string, _usage: ModelCallUsage): Promise<LeaseAnswer> {
    return { gone: true }
  }
  async releaseModelCall(_turnId: string, _callId: string, _end: { usage: ModelCallUsage; cut: boolean }): Promise<LeaseAnswer> {
    return { gone: true }
  }
  async writeToolCall(turnId: string, n: number, entry: AuditEntry): Promise<void> {
    await this.core.writeToolCall(turnId, n, entry)
  }

  // ---------- the API (routes 24, 27, 29-31, 35-37, 49) ----------
  async submitTurn(turn: SubmitTurn): Promise<SendTurnResult | Refusal> {
    return this.core.submitTurn(turn)
  }
  /** The member who owns a turn, or null: route 30 and 31 answer another person's turn 404 before acting. */
  async turnOwner(turnId: string): Promise<string | null> {
    return this.core.turnOwner(turnId)
  }
  async interrupt(turnId: string, by: Actor): Promise<{ ok: true } | Refusal> {
    return this.core.interrupt(turnId, by)
  }
  async stop(turnId: string, by: Actor): Promise<{ ok: true } | Refusal> {
    return this.core.stop(turnId, by)
  }
  async pause(by: Actor): Promise<PauseState> {
    return this.core.pause(by)
  }
  async resume(_by: Actor): Promise<PauseState> {
    return this.core.resume()
  }
  async getPause(): Promise<PauseState> {
    return this.core.pauseState()
  }
  async resetSession(chatId: string, by: Actor): Promise<{ ok: true } | Refusal> {
    return this.core.resetSession(chatId, by)
  }
  /** Route 24's `runs` and every summary's `running` (4.8): the chats' live runs and ended runs not yet all in D1. */
  async chatRuns(chatIds: string[]): Promise<ActiveRun[]> {
    return this.core.chatRuns(chatIds)
  }
  /** Route 27: the chats were deleted; their queued turns are cancelled and their running ones fenced. */
  async endChats(chatIds: string[]): Promise<void> {
    this.core.endChats(chatIds)
  }
  /** Route 28: the chats were restored; the BrandAgent admits sends into them again. */
  async restoreChats(chatIds: string[]): Promise<void> {
    this.core.restoreChats(chatIds)
  }
  /** Route 32: PR 2b. */
  async activeRuns(_scope: RunScope): Promise<ActiveRun[]> {
    throw new Error('activeRuns: not built (PR 2b)')
  }
  /** Route 33: PR 2b. */
  async trace(_id: string, _scope: RunScope): Promise<Trace | null> {
    throw new Error('trace: not built (PR 2b)')
  }

  // ---------- authority (4.10; the sockets are PR 4's) ----------
  async onMemberRemoved(memberId: string): Promise<void> {
    this.core.onMemberRemoved(memberId)
  }
  async onGrantEnded(grantId: string): Promise<void> {
    this.core.onGrantEnded(grantId)
  }

  // ---------- the pool (W2) ----------
  async containerExited(runner: string, gen: number): Promise<void> {
    this.core.containerExited(runner, gen)
  }
  async poolHealth(): Promise<PoolHealth> {
    return this.ports.pool.health()
  }
  /** The runs signal: PR 2b. */
  async runsHealth(): Promise<RunsHealth> {
    throw new Error('runsHealth: not built (PR 2b)')
  }
  async drain(): Promise<DrainState> {
    return this.core.drain()
  }
  async drainState(): Promise<DrainState> {
    return this.ports.pool.drainState()
  }
  async warmup(): Promise<{ ok: true } | Refusal> {
    return this.core.warmup()
  }
}
