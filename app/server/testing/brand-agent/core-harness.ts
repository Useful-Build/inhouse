// The turn engine's test harness: an `AgentCore` over a fresh BrandAgent's real SQLite, with the port fakes, the real
// run tokens and scheduler, a fake clock and an alarm that only the test fires (`tick`). Everything runs inside one
// `runInDurableObject` callback: the object's storage can't be used from outside it.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { ChatEvent, SendTurnInput } from '../../../shared/contract/runs.ts'
import type { RunEvent, RunEventBody } from '../../../shared/protocol/index.ts'
import { AgentCore } from '../../do/brand-agent/core.ts'
import type { TurnRow } from '../../do/brand-agent/core.ts'
import type { SubmitTurn } from '../../do/brand-agent/ports.ts'
import { createAgentTables } from '../../do/brand-agent/schema.ts'
import { createScheduler } from '../../do/brand-agent/scheduler.ts'
import type { AlarmPort, SqlScheduler, TaskContext } from '../../do/brand-agent/scheduler.ts'
import { taskHandlers } from '../../do/brand-agent/tasks/index.ts'
import { createRunTokens } from '../../do/brand-agent/tokens.ts'
import type { RunTokens } from '../../do/brand-agent/tokens.ts'
import { FakeFileLedger } from '../../do/brand-agent/testing/fake-files.ts'
import { FakeRunnerPool } from '../../do/brand-agent/testing/fake-pool.ts'
import { FakeUsageLedger } from '../../do/brand-agent/testing/fake-usage.ts'

/** Far past the wall clock, so the runtime never fires an alarm itself. */
export const T0 = 4_102_444_800_000
export const SEC = 1000
export const MIN = 60 * SEC

export interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Lets every queued microtask and macrotask run (no time passes on the fake clock). */
export const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) }

export interface Harness {
  core: AgentCore
  sql: SqlStorage
  clock: { now: number }
  pool: FakeRunnerPool
  usage: FakeUsageLedger
  files: FakeFileLedger
  tokens: RunTokens
  sched: SqlScheduler
  /** A new instance over the same storage, as after a reset: the old one's pending awaits are simply never resumed. */
  restart(): Harness
  /** Moves the clock and runs every due task (one alarm pass, as many as are due). */
  tick(ms: number): Promise<void>
  submit(chatId: string, key: string, o?: Partial<SendTurnInput> & { member?: string }): ReturnType<AgentCore['submitTurn']>
  turns(): TurnRow[]
  turn(id: string): TurnRow
  /** The run's stored chat events, in seq order, with their seqs. */
  events(runId: string): (ChatEvent & { seq: number })[]
  /** Pushes `bodies` for a turn, numbering them from the turn's next runner seq. */
  push(turnId: string, ...bodies: RunEventBody[]): ReturnType<AgentCore['ingest']>
  /** The `place` calls, as turn ids, in order. */
  placed(): string[]
  dueTasks(): { id: string; due_at_ms: number }[]
  /** Picker ids the start's model check finds switched off (shared across a restart). */
  modelsOff: Set<string>
}

let objects = 0
export const MEMBER = 'm_owner'
export const OTHER = 'm_other'

export async function inAgent(fn: (h: Harness) => Promise<void>): Promise<void> {
  const stub = env.BRAND_AGENT.getByName(`core-${++objects}-${Math.random()}`)
  await runInDurableObject(stub, async (_i, state) => {
    const sql = state.storage.sql
    const clock = { now: T0 }
    const pool = new FakeRunnerPool()
    const usage = new FakeUsageLedger()
    const files = new FakeFileLedger()
    const alarm: AlarmPort = { get: async () => null, set: async () => {}, delete: async () => {} }
    let sessions = 0
    const modelsOff = new Set<string>()
    const build = (): Harness => {
      createAgentTables(sql)
      const now = () => clock.now
      const tokens = createRunTokens(sql, now)
      let core!: AgentCore
      const sched: SqlScheduler = createScheduler<TaskContext>({
        sql, alarm, now, handlers: taskHandlers,
        context: (nowMs): TaskContext => ({ nowMs, env, sql, scheduler: sched, tokens, ports: { pool, usage, files }, agent: core }),
      })
      core = new AgentCore({
        sql, scheduler: sched, tokens, ports: { pool, usage, files }, now, systemPrompt: 'You are a test agent.', db: env.DB,
        newSessionId: () => `00000000-0000-4000-8000-${String(++sessions).padStart(12, '0')}`,
        modelUsable: async id => !modelsOff.has(id),
      })
      const h: Harness = {
        core, sql, clock, pool, usage, files, tokens, sched, modelsOff,
        restart: () => { const n = build(); n.core.ensureSeeds(); return n },
        async tick(ms) {
          clock.now += ms
          for (let i = 0; i < 20; i++) {
            const due = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM due_tasks WHERE state = 'ready' AND due_at_ms <= ?", clock.now).one().n
            if (due === 0) break
            await sched.alarm()
            await settle()
          }
        },
        submit(chatId, key, o = {}) {
          const { member = MEMBER, ...input } = o
          const t: SubmitTurn = {
            chatId, by: { kind: 'person', memberId: member }, model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium',
            sideModel: 'claude-haiku-5-5', maxTurns: 25, webFetchDomains: null,
            input: { clientTurnKey: key, text: `question ${key}`, priority: 'next', model: 'sonnet', attachments: [], ...input },
          }
          return core.submitTurn(t)
        },
        turns: () => sql.exec<TurnRow>('SELECT * FROM turns ORDER BY created_at_ms, ord').toArray(),
        turn: id => sql.exec<TurnRow>('SELECT * FROM turns WHERE turn_id = ?', id).one(),
        events: runId => sql.exec<{ seq: number; json: string }>('SELECT seq, json FROM events WHERE run_id = ? ORDER BY seq', runId)
          .toArray().map(r => ({ ...(JSON.parse(r.json) as ChatEvent), seq: r.seq })),
        push(turnId, ...bodies) {
          const from = sql.exec<{ s: number }>('SELECT runner_last_seq AS s FROM turns WHERE turn_id = ?', turnId).one().s + 1
          return core.ingest(turnId, bodies.map((b, i) => ({ ...b, runId: turnId, seq: from + i }) as RunEvent))
        },
        placed: () => pool.calls.filter(c => c.method === 'place').map(c => (c.args[0] as { runId: string }).runId),
        dueTasks: () => sql.exec<{ id: string; due_at_ms: number }>("SELECT id, due_at_ms FROM due_tasks WHERE state = 'ready' ORDER BY id").toArray().map(r => ({ ...r })),
      }
      return h
    }
    await fn(build())
  })
}

// ---------- literal runner events (protocol v2) ----------
export const ev = {
  started: (): RunEventBody => ({ type: 'started', sessionId: '00000000-0000-4000-8000-000000000001', resume: false }),
  text: (text: string): RunEventBody => ({ type: 'sdk', truncated: false, message: { type: 'assistant', message: { content: [{ type: 'text', text }] } } }),
  tool: (name: string): RunEventBody => ({ type: 'sdk', truncated: false, message: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name, input: {} }] } } }),
  heartbeat: (): RunEventBody => ({ type: 'heartbeat' }),
  checkpoint: (mainEntries: number, lastUuid: string | null = null, lastUuidIndex: number | null = null): RunEventBody =>
    ({ type: 'checkpoint', mainEntries, lastUuid, lastUuidIndex, runEntries: mainEntries }),
  success: (): RunEventBody => ({ type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 0.01, usage: {} }),
  finished: (subtype: string, isError = true): RunEventBody => ({ type: 'finished', subtype, isError, numTurns: 3, costUsd: 0.2, usage: {} }),
  failed: (reason: Extract<RunEventBody, { type: 'failed' }>['reason']): RunEventBody => ({ type: 'failed', reason, message: 'scripted' }),
  released: (checkpoint: { mainEntries: number; lastUuid: string | null; lastUuidIndex: number | null } | null, queryRan = true): RunEventBody =>
    ({ type: 'released', checkpoint, queryRan }),
  mirrorError: (): RunEventBody => ({ type: 'mirror_error', message: 'store write failed' }),
  deferred: (): RunEventBody => ({ type: 'deferred', toolUseId: 'tu_9', toolName: 'mcp__inhouse__ask_approval', input: { q: 1 } }),
  fileSaved: (path: string, sha: string): RunEventBody => ({ type: 'file_saved', path, bytes: 10, contentType: 'text/plain', sha256: sha }),
  filesRestored: (): RunEventBody => ({ type: 'files_restored', restored: 1, bytes: 10, leftOut: [] }),
}

/** A whole answer: started, text, checkpoint, success, released. */
export const fullAnswer = (text: string, entries: number): RunEventBody[] =>
  [ev.started(), ev.text(text), ev.checkpoint(entries, `u${entries}`, entries - 1), ev.success(), ev.released({ mainEntries: entries, lastUuid: `u${entries}`, lastUuidIndex: entries - 1 })]

export const typesOf = (events: { type: string }[]) => events.map(e => e.type)
