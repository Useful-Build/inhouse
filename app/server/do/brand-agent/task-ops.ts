// The routine seams for P4 (p3-w1.md "PR 5", asks A, D and E plus `revive`): generic, no P4 names. `poke` and `revive`
// act on one due task of a registered kind; `internalSubmit` is `TaskContext.runs.submit`, the same in-object path as
// `BrandAgentRpc.submitTurn` (core.ts `submitTurn`) with the checks route 29's schema would have made on what it adds.
import { OutputFormat } from '../../../shared/protocol/index.ts'
import type { SendTurnResult } from '../../../shared/contract/runs.ts'
import type { AgentCore } from './core.ts'
import type { BrandAgentPorts, InternalSubmit, Refusal } from './ports.ts'
import type { Scheduler, SqlScheduler, TaskContext, TaskHandler } from './scheduler.ts'
import type { RunTokens } from './tokens.ts'

type Registry = Readonly<Record<string, TaskHandler<never>>>

const registered = (registry: Registry, kind: string) => Object.hasOwn(registry, kind)

/** `BrandAgentRpc.poke`: schedules the task now (or at a later `dueAtMs`); refuses an unregistered kind or another kind's id. */
export function poke(sched: SqlScheduler, sql: SqlStorage, registry: Registry, nowMs: number, p: { kind: string; id: string; dueAtMs?: number }): void {
  if (!registered(registry, p.kind)) throw new Error(`poke: unregistered kind ${p.kind}`)
  const held = sql.exec<{ kind: string }>('SELECT kind FROM due_tasks WHERE id = ?', p.id).toArray()[0]
  if (held && held.kind !== p.kind) throw new Error(`poke: ${p.id} is a ${held.kind} task`)
  sched.schedule({ id: p.id, kind: p.kind, dueAtMs: Math.max(p.dueAtMs ?? nowMs, nowMs) })
}

/** `BrandAgentRpc.revive`: one quarantined task back to ready with its payload kept; an ops action, logged. */
export function revive(sched: SqlScheduler, registry: Registry, p: { kind: string; id: string }): 'revived' | 'not_quarantined' | 'not_found' {
  if (!registered(registry, p.kind)) throw new Error(`revive: unregistered kind ${p.kind}`)
  const answer = sched.revive(p.id, p.kind)
  console.log({ event: 'ops_task_revive', kind: p.kind, id: p.id, answer })
  return answer
}

/**
 * `TaskContext.runs.submit` (ask A). The caller skips route 29's schema, so what it adds is checked here: the format
 * against the protocol's `OutputFormat` (its size and depth caps), the end task's kind against the registry. The engine
 * itself refuses an attachment named twice (core.ts, L9) on every path.
 */
export async function internalSubmit(core: AgentCore, sql: SqlStorage, registry: Registry, t: InternalSubmit): Promise<SendTurnResult | Refusal> {
  const { outputFormat, onEnd, ...turn } = t
  if (outputFormat !== undefined && !OutputFormat.safeParse(outputFormat).success) return { refused: { code: 'invalid' } }
  if (onEnd !== undefined && (typeof onEnd.id !== 'string' || onEnd.id === '' || !registered(registry, onEnd.kind))) return { refused: { code: 'invalid' } }
  // An id another kind's task holds would make the final step's `ensure` a no-op: the end would be lost silently.
  if (onEnd !== undefined) {
    const held = sql.exec<{ kind: string }>('SELECT kind FROM due_tasks WHERE id = ?', onEnd.id).toArray()[0]
    if (held && held.kind !== onEnd.kind) return { refused: { code: 'invalid' } }
  }
  return core.submitTurn(turn, { outputFormat, onEnd })
}

/**
 * What a task handler gets (index.ts and the test harness build it here, so tests run the shipped context): the
 * object's parts, `runs.submit`, `paused` and `pauseGen` (getters: the stored flags at each access, never a value from
 * when the context was built), `resumeDeferred` and `chats.status`.
 */
export function taskContext(p: {
  nowMs: number; env: Env; sql: SqlStorage; scheduler: Scheduler; tokens: RunTokens; ports: BrandAgentPorts; core: AgentCore; registry: Registry
}): TaskContext {
  const { core, sql, registry } = p
  return {
    nowMs: p.nowMs, env: p.env, sql, scheduler: p.scheduler, tokens: p.tokens, ports: p.ports, agent: core,
    runs: { submit: t => internalSubmit(core, sql, registry, t) },
    get paused() { return core.isPaused() },
    get pauseGen() { return core.pauseGen() },
    resumeDeferred: (chatId, decision, questionId) => core.resumeDeferred(chatId, decision, questionId),
    chats: { status: chatId => core.chatStatus(chatId) },
  }
}
