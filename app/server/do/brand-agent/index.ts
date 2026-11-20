// The BrandAgent Durable Object (P3, p3-design section 4): one per brand, `env.BRAND_AGENT.getByName('brand')`. Owner:
// W1 (p3-w1.md). The class wires the object's SQLite, its scheduler (the one owner of the alarm), the run tokens and
// the ports (compose.ts) to the turn engine (core.ts), and answers the RPC surface (`BrandAgentRpc`, ports.ts). The
// socket (`fetch`, route 34) is PR 4's.
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
import { modelUsable } from './model-check.ts'
import { openStores } from '../../db/stores.ts'
import { alarmPort, createScheduler, registrySeeds } from './scheduler.ts'
import { internalSubmit, poke, revive } from './task-ops.ts'
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
        context: (nowMs): TaskContext => ({
          nowMs, env, sql, scheduler: sched, tokens, ports: this.ports, agent: this.core,
          runs: { submit: t => internalSubmit(this.core, taskHandlers, t) },
        }),
      })
      this.sched = sched
      this.ports = composePorts(env, {
        sql, scheduler: sched, now,
        hooks: { retryPlacement: id => this.core.retryPlacement(id), placementExpired: id => this.core.placementExpired(id) },
      })
      this.core = new AgentCore({
        sql, scheduler: sched, tokens, ports: this.ports, now, systemPrompt: SYSTEM_PROMPT_V1, db: env.DB,
        modelUsable: modelUsable(openStores(env)), taskSeeds: registrySeeds(taskHandlers),
      })
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
  /** The model gate (8.2, gate.ts): answered once the call is granted, refused, or 503 (`busy`). */
  async admitModelCall(turnId: string, callId: string, worst: ModelCallWorst): Promise<AdmitAnswer> {
    return this.core.admitModelCall(turnId, callId, worst)
  }
  async renewModelCall(turnId: string, callId: string, usage: ModelCallUsage): Promise<LeaseAnswer> {
    return this.core.renewModelCall(turnId, callId, usage)
  }
  async releaseModelCall(turnId: string, callId: string, end: { usage: ModelCallUsage; cut: boolean }): Promise<LeaseAnswer> {
    return this.core.releaseModelCall(turnId, callId, end)
  }
  async writeToolCall(turnId: string, n: number, entry: AuditEntry): Promise<void> {
    await this.core.writeToolCall(turnId, n, entry)
  }

  // ---------- the API (routes 29-31, 35-37, 49) ----------
  /** Route 29's turn only: a structured-output format or an end task sent over RPC is dropped (`TaskContext.runs.submit` adds them). */
  async submitTurn(turn: SubmitTurn): Promise<SendTurnResult | Refusal> {
    const { chatId, input, by, model, pickerId, effort, sideModel, maxTurns, webFetchDomains } = turn
    return this.core.submitTurn({ chatId, input, by, model, pickerId, effort, sideModel, maxTurns, webFetchDomains })
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
  /** Route 32: live runs and ended ones with a turn not yet in D1, in the scope. */
  async activeRuns(scope: RunScope): Promise<ActiveRun[]> {
    return this.core.activeRuns(scope)
  }
  /** Route 33: a run's or a turn's trace, null when it isn't there or isn't in the scope. */
  async getTrace(id: string, scope: RunScope): Promise<Trace | null> {
    return this.core.readTrace(id, scope)
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
  /** The runs signal (ops/signals/runs.ts): failures, stuck turns, damaged sessions, quarantined tasks. */
  async runsHealth(): Promise<RunsHealth> {
    return this.core.runsHealth(this.sched.quarantinedCount())
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

  // ---------- due tasks (PR 5, asks D and E, `revive`) ----------
  async poke(p: { kind: string; id: string; dueAtMs?: number }): Promise<void> {
    poke(this.sched, this.ctx.storage.sql, taskHandlers, Date.now(), p)
  }
  async revive(p: { kind: string; id: string }): Promise<'revived' | 'not_quarantined' | 'not_found'> {
    return revive(this.sched, taskHandlers, p)
  }
}
