// The BrandAgent Durable Object (P3, p3-design section 4): one per brand, `env.BRAND_AGENT.getByName('brand')`. Owner:
// W1 (p3-w1.md). The class wires the object's SQLite, its scheduler (the one owner of the alarm), the run tokens and
// the ports (compose.ts) to the turn engine (core.ts), and answers the RPC surface (`BrandAgentRpc`, ports.ts). Route
// 34's socket (`fetch`, then the hibernation handlers) runs on the socket hub (sockets.ts, 4.10).
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
import { PRINCIPAL_HEADER, SocketHub } from './sockets.ts'
import type { HubSocket, SocketPrincipal } from './sockets.ts'
import { SWEEP_EVERY_MS, sweepBy } from './authority.ts'
import { auditInsert } from '../../db/audit.ts'
import { runBatch } from '../../db/sql.ts'
import type { EgressRoute, RunGrant, TokenRefusal } from './tokens.ts'

export class BrandAgent extends DurableObject<Env> implements BrandAgentRpc {
  private core!: AgentCore
  private sched!: SqlScheduler
  private ports!: BrandAgentPorts
  private hub!: SocketHub

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
          runs: { submit: t => internalSubmit(this.core, sql, taskHandlers, t) },
        }),
      })
      this.sched = sched
      this.ports = composePorts(env, {
        sql, scheduler: sched, now,
        hooks: { retryPlacement: id => this.core.retryPlacement(id), placementExpired: id => this.core.placementExpired(id) },
      })
      this.hub = new SocketHub({
        sql, now,
        sockets: () => ctx.getWebSockets() as HubSocket[],
        auditAttach: (p, runId) => supportAttachLine(env.DB, p, runId, now()),
        wakeBy: atMs => sweepBy(sql, sched, Math.min(atMs, now() + SWEEP_EVERY_MS)),
      })
      this.core = new AgentCore({
        sql, scheduler: sched, tokens, ports: this.ports, now, systemPrompt: SYSTEM_PROMPT_V1, db: env.DB,
        modelUsable: modelUsable(openStores(env)), taskSeeds: registrySeeds(taskHandlers),
        onEvent: e => this.hub.onEvent(e),
        sockets: this.hub,
      })
      this.core.ensureSeeds()
      await sched.syncAlarm()
    })
  }

  async alarm(): Promise<void> {
    await this.sched.alarm()
  }

  /**
   * Route 34's socket upgrade (4.10). Reached only through route 34's handler, which verified the caller and set
   * `x-inhouse-principal`. A sign-in past its end is refused (401); a version this build doesn't speak, or a window of
   * 0, is accepted and closed at once with its code (`4409`, `4401`), so the browser reads why.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return apiError('invalid')
    const opened = this.hub.open(request.headers.get(PRINCIPAL_HEADER), new URL(request.url).searchParams.get('v'))
    if ('refuse' in opened) return apiError(opened.refuse)
    const [client, server] = Object.values(new WebSocketPair())
    if ('close' in opened) {
      server.accept()
      server.close(opened.close, opened.reason)
    } else {
      this.ctx.acceptWebSocket(server, opened.tags)
      this.hub.accepted(server, opened.accept)
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.hub.message(ws, message)
  }
  // The runtime answers a Close frame itself (`web_socket_auto_reply_to_close`, compatibility date 2026-11-13), and a
  // closed socket leaves `getWebSockets()`; nothing else is kept per socket.
  async webSocketClose(): Promise<void> {}
  async webSocketError(): Promise<void> {}

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

  // ---------- the API (routes 24, 27, 29-31, 35-37, 49) ----------
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
  /** Route 24's `runs` and every summary's `running` (4.8): the chats' live runs and ended runs not yet all in D1. */
  async chatRuns(chatIds: string[]): Promise<ActiveRun[]> {
    return this.core.chatRuns(chatIds)
  }
  /** Route 27: the chats were deleted (each with its D1 rev); their queued turns are cancelled, their running ones fenced. */
  async endChats(chats: { id: string; rev: number }[]): Promise<void> {
    this.core.endChats(chats)
  }
  /** Route 28: the chats are being restored (each with the D1 rev it was read deleted at); sends into them are admitted again. */
  async restoreChats(chats: { id: string; rev: number }[]): Promise<void> {
    this.core.restoreChats(chats)
  }
  /** Route 32: live runs and ended ones with a turn not yet in D1, in the scope. */
  async activeRuns(scope: RunScope): Promise<ActiveRun[]> {
    return this.core.activeRuns(scope)
  }
  /** Route 33: a run's or a turn's trace, null when it isn't there or isn't in the scope. */
  async getTrace(id: string, scope: RunScope): Promise<Trace | null> {
    return this.core.readTrace(id, scope)
  }

  // ---------- authority (4.10) ----------
  async onMemberRemoved(memberId: string): Promise<void> {
    this.core.onMemberRemoved(memberId)
  }
  async onGrantEnded(grantId: string): Promise<void> {
    this.core.onGrantEnded(grantId)
  }
  async onGrantCreated(grantId: string, endsAtMs: number): Promise<void> {
    this.core.onGrantCreated(grantId, endsAtMs)
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
  async undrain(): Promise<DrainState> {
    return this.ports.pool.undrain()
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

/** The `support.attach` line (4.10): written, and awaited, before any frame of the run goes to the Inhouse socket. */
async function supportAttachLine(db: D1Database, p: SocketPrincipal, runId: string, atMs: number): Promise<void> {
  if (p.kind !== 'inhouse' || p.grantId === null) throw new Error('support.attach for a principal without a grant')
  await runBatch(db, [auditInsert({
    atMs, actorId: p.memberId, args: { action: 'support.attach', grantId: p.grantId, runId },
    target: { kind: 'grant', id: p.grantId }, requestId: p.requestId,
  }, null)])
}
