// The ask flow's object side (Stage 1 M2-D, N14): BrandAgent's part in a write the agent proposes.
//  - Admission (invocations.ts): a proposal is bound to an unused call of this turn by the main agent.
//  - The chat: the asking turn gets an `ask` part (`{ type: 'ask', actionId }`) once per action, and the chat an
//    `action.updated` event on every change of the row (the `action-deliver` task, run on each change and by the sweep).
//  - The waits: the egress polls D1 for the answer (egress/actions.ts). A turn holds at most 3 waits at once; each is
//    recorded here with its deadline, so a waiter that dies is noticed.
//  - Who tells the agent the result (`outbox_actions.report`, the functions below): `tool` (the waiter returned it inline),
//    `later` (it couldn't, so a resume turn will), `resume` (a resume turn was claimed and is submitted with the key
//    `act_<id>`) or `none` (no one to tell: the chat deleted, the asker removed, the job cancelled). A doubled report is
//    harmless; a missing one is not. The rules (N14):
//     * the waiter claims `tool` only from NULL and only while the asking turn is live, and checks again after the write:
//       a turn that died in between flips the row to `later`;
//     * a waiter that returns without a final state writes `later`;
//     * a turn that ends any way but `done` flips its `tool` rows to `later` (its answer may never have reached the model);
//     * when an action is final, `action-deliver:<id>` claims `resume` when the report is `later`, or NULL with the asking
//       turn gone, or `tool` whose waiter died without returning the result; and submits one turn into the chat. A
//       refused submit is tried again later with the same key.
//  The resume turn's text comes from the action texts port (`ActionTexts`), `null` until M2-G: while it is null no resume
//  turn is ever sent (the report stays `later` or NULL for M2-G to pick up).
import type { ActionState } from '../../../shared/contract/actions.ts'
import type { SendTurnResult } from '../../../shared/contract/runs.ts'
import { SYSTEM_MEMBER_ID } from '../../db/ids.ts'
import { all, first, stmt } from '../../db/sql.ts'
import type { StoredCard } from '../../outbox/card.ts'
import { FINAL_STATES } from '../../outbox/sql.ts'
import type { OutboxActionRow, OutboxReport } from '../../outbox/types.ts'
import { safeError } from '../../safe-error.ts'
import type { AgentCore } from './core.ts'
import { admitAction, pruneInvocations, turnProposed } from './invocations.ts'
import type { AdmitRefusal, Admitted } from './invocations.ts'
import type { JobTurnSettings } from './jobs/types.ts'
import type { Refusal, SubmitTurn } from './ports.ts'
import type { DueTask, Scheduler, TaskContext, TaskHandler, TaskResult } from './scheduler.ts'
import { withSeed } from './scheduler.ts'
import { asksDeps } from './compose.ts'

// ---------- numbers (N14) ----------

/** The egress reads the action row this often while it waits. */
export const WAIT_POLL_MS = 2_000
/** The longest wait for a person's answer. */
export const WAIT_MAX_MS = 120_000
/** Once approved, how much longer the waiter waits for a final state (the 10 s hold, the claim and the hub's 15 s). */
export const WAIT_AFTER_APPROVAL_MS = 30_000
/** A wait's record outlives the longest wait by this much before the object takes its waiter for dead. */
export const WAIT_MARGIN_MS = 15_000
/** Waits one turn may hold at once; the next ask answers "waiting" at once. */
export const MAX_WAITS_PER_TURN = 3
/** A refused resume submit is tried again this much later (the same key). */
export const RESUME_RETRY_MS = 60_000
/** The sweep's period. */
export const ASKS_SWEEP_EVERY_MS = 60_000
/** Finished waits and seen revisions are kept this long. */
export const ASKS_KEEP_MS = 8 * 24 * 60 * 60_000

export const DELIVER_KIND = 'action-deliver'
export const TURN_END_KIND = 'ask-turn-end'
export const ASKS_SWEEP_KIND = 'asks-sweep'
export const deliverTaskId = (actionId: string): string => `${DELIVER_KIND}:${actionId}`
export const turnEndTaskId = (turnId: string): string => `${TURN_END_KIND}:${turnId}`
/** A resume turn's key: one per action, so a retried submit answers the same turn. */
export const resumeKey = (actionId: string): string => `act_${actionId}`

const isFinal = (state: ActionState): boolean => (FINAL_STATES as readonly string[]).includes(state)

// ---------- the report column (shared with the egress's waiter) ----------

/** What the report rules read of an action. */
export interface ReportRow {
  id: string
  state: ActionState
  report: OutboxReport | null
  turnId: string | null
  chatId: string
  askedBy: string
  jobId: string | null
}

/** The report column's store: D1's `outbox_actions` in the product (`d1Reports`), a map in the property test. */
export interface ReportStore {
  read(actionId: string): Promise<ReportRow | null>
  /** Sets `report` to `to` only where it is one of `from` now; true when it changed. Nothing else on the row moves. */
  set(actionId: string, to: OutboxReport, from: readonly (OutboxReport | null)[]): Promise<boolean>
}

export function d1Reports(db: D1Database): ReportStore {
  return {
    async read(actionId) {
      const r = await first<Pick<OutboxActionRow, 'id' | 'state' | 'report' | 'turn_id' | 'chat_id' | 'asked_by' | 'job_id'>>(db, stmt(
        'SELECT id, state, report, turn_id, chat_id, asked_by, job_id FROM outbox_actions WHERE id = ?', actionId))
      return r && { id: r.id, state: r.state, report: r.report, turnId: r.turn_id, chatId: r.chat_id, askedBy: r.asked_by, jobId: r.job_id }
    },
    async set(actionId, to, from) {
      const nullable = from.includes(null)
      const named = from.filter((x): x is OutboxReport => x !== null)
      const where = [...(nullable ? ['report IS NULL'] : []), ...(named.length > 0 ? [`report IN (${named.map(() => '?').join(', ')})`] : [])]
      if (where.length === 0) return false
      const r = await db.prepare(`UPDATE outbox_actions SET report = ? WHERE id = ? AND (${where.join(' OR ')})`).bind(to, actionId, ...named).run()
      return r.meta.changes > 0
    },
  }
}

/**
 * The waiter's claim (N14): `tool`, only from NULL and only while the asking turn is live, checked again after the
 * write. A turn that died in between flips the row to `later` here. True: this waiter now owns the report.
 */
export async function claimTool(store: ReportStore, actionId: string, live: () => Promise<boolean>): Promise<boolean> {
  if (!(await live())) return false
  if (!(await store.set(actionId, 'tool', [null]))) return false
  if (await live()) return true
  await store.set(actionId, 'later', ['tool'])
  return false
}

/** A waiter that returns without the result: `later`, from its own `tool` (or from NULL when it never claimed). */
export async function waiterGaveUp(store: ReportStore, actionId: string, claimed: boolean): Promise<void> {
  await store.set(actionId, 'later', claimed ? ['tool'] : [null])
}

/** A recorded wait, as the object keeps it. */
export interface WaitRecord { untilMs: number; finished: boolean; delivered: boolean }

/** What `deliverReport` needs besides the store. */
export interface DeliverFacts {
  store: ReportStore
  nowMs: number
  turnLive(turnId: string): boolean
  wait(actionId: string): WaitRecord | null
  /** No one to tell: the chat deleted or missing, the asker removed, the action's job cancelled. */
  gone(row: ReportRow): Promise<boolean>
  /** Whether resume turns are on (the action texts port is wired, M2-G). */
  resumes: boolean
  /** Submits the resume turn with the key `act_<id>`. `retry`: refused for now, try again with the same key. */
  submitResume(row: ReportRow): Promise<'submitted' | 'retry' | 'gone'>
}

export type DeliverOutcome = 'not_final' | 'reported' | 'waiting_turn' | 'waiting_waiter' | 'none' | 'off' | 'submitted' | 'retry'

/**
 * One delivery pass for one action (the `action-deliver` task). Safe to run any number of times: every change is a
 * conditional update of the report column, and the resume submit is keyed.
 */
export async function deliverReport(f: DeliverFacts, actionId: string): Promise<{ outcome: DeliverOutcome; retryAtMs?: number }> {
  let row = await f.store.read(actionId)
  if (!row || !isFinal(row.state)) return { outcome: 'not_final' }
  if (row.report === 'tool') {
    const w = f.wait(actionId)
    if (w && !w.finished && f.nowMs < w.untilMs) return { outcome: 'waiting_waiter', retryAtMs: w.untilMs }
    if (w && w.finished && w.delivered) return { outcome: 'reported' }
    // The waiter died, or returned without the result: someone else tells the agent.
    await f.store.set(actionId, 'later', ['tool'])
    row = await f.store.read(actionId)
    if (!row) return { outcome: 'not_final' }
  }
  if (row.report === 'none') return { outcome: 'none' }
  if (row.report === null && row.turnId !== null && f.turnLive(row.turnId)) return { outcome: 'waiting_turn' }
  if (row.report === null || row.report === 'later') {
    if (await f.gone(row)) {
      await f.store.set(actionId, 'none', [null, 'later'])
      return { outcome: 'none' }
    }
    if (!f.resumes) return { outcome: 'off' }
    await f.store.set(actionId, 'resume', [null, 'later'])
    row = await f.store.read(actionId)
    if (!row || row.report !== 'resume') return { outcome: row?.report === 'none' ? 'none' : 'reported' }
  }
  if (row.report !== 'resume') return { outcome: 'reported' }
  const r = await f.submitResume(row)
  if (r === 'retry') return { outcome: 'retry', retryAtMs: f.nowMs + RESUME_RETRY_MS }
  if (r === 'gone') {
    await f.store.set(actionId, 'none', ['resume'])
    return { outcome: 'none' }
  }
  return { outcome: 'submitted' }
}

/** A turn's end (N14): its `tool` rows flip to `later` unless it ended `done`. Returns the turn's actions, for delivery. */
export async function turnEndedReports(store: ReportStore, actionIds: readonly string[], outcome: string | null): Promise<void> {
  if (outcome === 'done') return
  for (const id of actionIds) await store.set(id, 'later', ['tool'])
}

// ---------- the action texts port (M2-G) ----------

/** The resume turn's text: the card's title and the outcome in server words, never connector output (N14, N20). */
export interface ActionTexts {
  result(p: { title: string; lines: string[]; state: ActionState; result: string | null }): string
}

export interface AsksDeps {
  /** `null` until M2-G: no resume turn is sent. */
  texts: ActionTexts | null
  /** Route 29's settings for the asking turn's picker id, read now (as a job's continuation, compose.ts `jobDeps`). */
  settings(pickerId: string): Promise<JobTurnSettings | { refused: 'model_off' | 'invalid' }>
}

/** Whether any write operation is enabled for the brand (N2): the turn's start then carries `actions: true`. */
export async function actionsOn(db: D1Database): Promise<boolean> {
  return (await first<{ one: number }>(db, stmt('SELECT 1 AS one FROM permission_ceiling WHERE enabled = 1 LIMIT 1'))) !== null
}

// ---------- the object's tables ----------

export function createAskTables(sql: SqlStorage): void {
  // No person key: actions, turns and chats by id. Pruned by the sweep after `ASKS_KEEP_MS`.
  sql.exec(`CREATE TABLE IF NOT EXISTS ask_waits (action_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, started_at_ms INTEGER NOT NULL,
    until_ms INTEGER NOT NULL, finished INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0)`)
  sql.exec('CREATE INDEX IF NOT EXISTS ask_waits_turn ON ask_waits(turn_id, finished)')
  sql.exec(`CREATE TABLE IF NOT EXISTS ask_parts (turn_id TEXT NOT NULL, action_id TEXT NOT NULL, at_ms INTEGER NOT NULL,
    PRIMARY KEY (turn_id, action_id))`)
  sql.exec('CREATE TABLE IF NOT EXISTS ask_seen (action_id TEXT PRIMARY KEY, rev INTEGER NOT NULL, at_ms INTEGER NOT NULL)')
}

/** The core's parts the asks use (core.ts). */
export type AsksCore = Pick<AgentCore, 'turn' | 'isPaused' | 'chatEvent' | 'askPart' | 'submitTurn'>

export interface AsksParts {
  sql: SqlStorage
  scheduler: Scheduler
  db: D1Database
  core: AsksCore
  deps: AsksDeps
  now: () => number
}

const RETRY_REFUSALS = new Set(['paused', 'draining', 'queue_full', 'budget_busy', 'waiting_answer'])

/** BrandAgent's side of N14. Stateless: everything lives in the object's SQLite and in D1, so one is built per call. */
export class Asks {
  private readonly p: AsksParts
  constructor(p: AsksParts) { this.p = p }

  private turnLiveNow(turnId: string): boolean {
    const t = this.p.core.turn(turnId)
    return t !== null && t.fenced === 0 && (t.state === 'live' || t.state === 'starting')
  }

  /** N14's `admitAction`, one synchronous step (invocations.ts). */
  admit(turnId: string, tool: string, inputSha256: string): Admitted | { refused: AdmitRefusal } {
    const { sql, core } = this.p
    return admitAction(sql, {
      turn: core.turn(turnId), paused: core.isPaused(),
      removed: id => sql.exec("SELECT 1 FROM authority WHERE kind = 'member' AND id = ?", id).toArray().length > 0,
    }, tool, inputSha256)
  }

  turnLive(turnId: string): boolean { return this.turnLiveNow(turnId) }

  /**
   * A request made or found an action for this turn: the turn's `ask` part (once per action) and the chat's
   * `action.updated` (the deliver task, now). Answers whether the part was added.
   */
  noted(turnId: string, actionId: string): boolean {
    const { sql } = this.p
    const now = this.p.now()
    let added = false
    const fresh = sql.exec('INSERT INTO ask_parts (turn_id, action_id, at_ms) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING action_id', turnId, actionId, now).toArray()
    if (fresh.length > 0) {
      added = this.p.core.askPart(turnId, actionId)
      if (!added) sql.exec('DELETE FROM ask_parts WHERE turn_id = ? AND action_id = ?', turnId, actionId)
    }
    this.changed(actionId)
    return added
  }

  /** An action changed (a route, the egress, the dispatcher): its deliver task, due now. */
  changed(actionId: string): void {
    this.p.scheduler.schedule({ id: deliverTaskId(actionId), kind: DELIVER_KIND, dueAtMs: this.p.now() })
  }

  /** A waiter starts. Refused when the turn isn't live, or already holds `MAX_WAITS_PER_TURN` live waits. */
  beginWait(turnId: string, actionId: string): { wait: true; untilMs: number } | { wait: false; why: 'turn_not_live' | 'busy' } {
    const { sql } = this.p
    const now = this.p.now()
    if (!this.turnLiveNow(turnId)) return { wait: false, why: 'turn_not_live' }
    const held = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ask_waits WHERE turn_id = ? AND finished = 0 AND until_ms > ?', turnId, now).one().n
    if (held >= MAX_WAITS_PER_TURN) return { wait: false, why: 'busy' }
    const untilMs = now + WAIT_MAX_MS + WAIT_AFTER_APPROVAL_MS + WAIT_MARGIN_MS
    const live = sql.exec<{ action_id: string }>('SELECT action_id FROM ask_waits WHERE action_id = ? AND finished = 0 AND until_ms > ?', actionId, now).toArray()
    // One live waiter per action: a second (a replay of the same call) doesn't wait.
    if (live.length > 0) return { wait: false, why: 'busy' }
    sql.exec(
      `INSERT INTO ask_waits (action_id, turn_id, started_at_ms, until_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT (action_id) DO UPDATE SET turn_id = excluded.turn_id, started_at_ms = excluded.started_at_ms, until_ms = excluded.until_ms,
         finished = 0, delivered = 0`,
      actionId, turnId, now, untilMs,
    )
    return { wait: true, untilMs }
  }

  /** A waiter returned: `delivered` when it returned the action's final result inline. Its deliver task runs now. */
  endWait(actionId: string, delivered: boolean): void {
    this.p.sql.exec('UPDATE ask_waits SET finished = 1, delivered = ? WHERE action_id = ?', delivered ? 1 : 0, actionId)
    this.changed(actionId)
  }

  private wait(actionId: string): WaitRecord | null {
    const w = this.p.sql.exec<{ until_ms: number; finished: number; delivered: number }>(
      'SELECT until_ms, finished, delivered FROM ask_waits WHERE action_id = ?', actionId).toArray()[0]
    return w ? { untilMs: w.until_ms, finished: w.finished === 1, delivered: w.delivered === 1 } : null
  }

  /** `storeFinal`'s hook (core.ts `addFinalHook`): a turn that proposed a write gets its turn-end task. */
  onTurnFinal(t: { turn_id: string }): void {
    if (!turnProposed(this.p.sql, t.turn_id)) return
    this.p.scheduler.ensure({ id: turnEndTaskId(t.turn_id), kind: TURN_END_KIND, dueAtMs: this.p.now() })
  }

  /** The `ask-turn-end:<turnId>` task: N14's flip for a turn that didn't end `done`, then each of its actions delivered. */
  async turnEnded(turnId: string): Promise<void> {
    const t = this.p.core.turn(turnId)
    const ids = (await all<{ id: string }>(this.p.db, stmt('SELECT id FROM outbox_actions WHERE turn_id = ?', turnId))).map(r => r.id)
    await turnEndedReports(d1Reports(this.p.db), ids, t?.outcome ?? null)
    for (const id of ids) this.changed(id)
  }

  /** The `action-deliver:<id>` task: the chat's `action.updated` for a new revision, then the report (N14). */
  async deliver(actionId: string): Promise<TaskResult> {
    const { sql, db } = this.p
    const now = this.p.now()
    const row = await first<OutboxActionRow>(db, stmt('SELECT * FROM outbox_actions WHERE id = ?', actionId))
    if (!row) return { done: true }
    const seen = sql.exec<{ rev: number }>('SELECT rev FROM ask_seen WHERE action_id = ?', actionId).toArray()[0]
    if (!seen || seen.rev < row.rev) {
      this.p.core.chatEvent(row.chat_id, { type: 'action.updated', actionId: row.id, rev: row.rev, state: row.state })
      sql.exec('INSERT INTO ask_seen (action_id, rev, at_ms) VALUES (?, ?, ?) ON CONFLICT (action_id) DO UPDATE SET rev = excluded.rev, at_ms = excluded.at_ms', actionId, row.rev, now)
    }
    const r = await deliverReport({
      store: d1Reports(db), nowMs: now,
      turnLive: id => this.turnLiveNow(id),
      wait: id => this.wait(id),
      gone: rr => this.gone(rr),
      resumes: this.p.deps.texts !== null,
      submitResume: rr => this.submitResume(rr, row),
    }, actionId)
    if (r.outcome !== 'not_final' && r.outcome !== 'waiting_turn') console.log({ event: 'action_report', actionId, outcome: r.outcome })
    if (r.retryAtMs !== undefined) this.p.scheduler.schedule({ id: deliverTaskId(actionId), kind: DELIVER_KIND, dueAtMs: r.retryAtMs })
    return { done: true }
  }

  /** No one to tell (N14): the chat deleted or not there, the asker no longer an active member, the job cancelled. */
  private async gone(row: ReportRow): Promise<boolean> {
    const chat = await first<{ deleted_at_ms: number | null }>(this.p.db, stmt('SELECT deleted_at_ms FROM chats WHERE id = ?', row.chatId))
    if (!chat || chat.deleted_at_ms !== null) return true
    const asker = await first<{ status: string; kind: string }>(this.p.db, stmt('SELECT status, kind FROM members WHERE id = ?', row.askedBy))
    if (!asker || asker.status !== 'active' || asker.kind !== 'person') return true
    if (row.jobId !== null) {
      const job = this.p.sql.exec<{ outcome: string | null }>('SELECT outcome FROM jobs WHERE job_id = ?', row.jobId).toArray()[0]
      if (job?.outcome === 'cancelled') return true
    }
    return false
  }

  /** The resume turn: by the chat's owner, priority `next`, key `act_<id>`, `source: 'action'`, the asking turn's model. */
  private async submitResume(row: ReportRow, full: OutboxActionRow): Promise<'submitted' | 'retry' | 'gone'> {
    const texts = this.p.deps.texts
    if (!texts) throw new Error('asks: a resume claimed with no action texts')
    const asking = row.turnId === null ? null : this.p.core.turn(row.turnId)
    if (!asking) return 'gone'
    const settings = await this.p.deps.settings(asking.picker_id)
    if ('refused' in settings) return 'gone'
    const card = JSON.parse(full.card_json) as StoredCard
    const result = full.state === 'sent' && full.result_json !== null ? (JSON.parse(full.result_json) as { ref?: string }).ref ?? null : null
    const owner = asking.owner_id
    const turn: SubmitTurn = {
      chatId: row.chatId, by: { kind: owner === SYSTEM_MEMBER_ID ? 'service' : 'person', memberId: owner },
      model: settings.model, pickerId: settings.pickerId, effort: settings.effort, sideModel: settings.sideModel,
      maxTurns: settings.maxTurns, webFetchDomains: settings.webFetchDomains, webSearch: settings.webSearch,
      input: { clientTurnKey: resumeKey(row.id), text: texts.result({ title: card.title, lines: card.lines, state: full.state, result }), priority: 'next', model: settings.pickerId, attachments: [] },
    }
    let answer: SendTurnResult | Refusal
    try {
      answer = await this.p.core.submitTurn(turn, { source: 'action' })
    } catch (err) {
      console.error({ event: 'action_resume_failed', actionId: row.id, error: safeError(err) })
      return 'retry'
    }
    if (!('refused' in answer)) return 'submitted'
    const { code, reason } = answer.refused
    if (reason !== undefined && RETRY_REFUSALS.has(reason)) return 'retry'
    if (code === 'not_found' || code === 'forbidden') return 'gone'
    console.error({ event: 'action_resume_refused', actionId: row.id, code, reason: reason ?? null })
    return 'gone'
  }

  /**
   * The asks sweep (seeded, every minute): every action changed since the last pass gets its deliver task (a change
   * made outside this object, by a route or the outbox's sweep, that no one told the object about), and old records go.
   */
  async sweep(): Promise<void> {
    const { sql, db } = this.p
    const now = this.p.now()
    const cursor = Number(sql.exec<{ value: number }>("SELECT value FROM flags WHERE key = 'asks_cursor'").toArray()[0]?.value ?? 0)
    const rows = await all<{ id: string; updated_at_ms: number }>(db, stmt(
      'SELECT id, updated_at_ms FROM outbox_actions WHERE updated_at_ms > ? ORDER BY updated_at_ms LIMIT 200', cursor))
    for (const r of rows) this.changed(r.id)
    const next = rows.length > 0 ? rows[rows.length - 1]!.updated_at_ms : cursor
    sql.exec("INSERT INTO flags (key, value) VALUES ('asks_cursor', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", next)
    pruneInvocations(sql, now)
    sql.exec('DELETE FROM ask_waits WHERE until_ms < ?', now - ASKS_KEEP_MS)
    sql.exec('DELETE FROM ask_parts WHERE at_ms < ?', now - ASKS_KEEP_MS)
    sql.exec('DELETE FROM ask_seen WHERE at_ms < ?', now - ASKS_KEEP_MS)
  }
}

// ---------- the tasks (tasks/index.ts) ----------

/** The asks of a task's object: the context's core (task-ops.ts sets `agent` to the AgentCore) and compose.ts's deps. */
function asksOf(ctx: TaskContext): Asks {
  return new Asks({ sql: ctx.sql, scheduler: ctx.scheduler, db: ctx.env.DB, core: ctx.agent as unknown as AsksCore, deps: asksDeps(ctx.env), now: () => ctx.nowMs })
}

export const actionDeliver: TaskHandler = async (task: DueTask, ctx: TaskContext) =>
  asksOf(ctx).deliver(task.id.slice(DELIVER_KIND.length + 1))

export const askTurnEnd: TaskHandler = async (task: DueTask, ctx: TaskContext) => {
  await asksOf(ctx).turnEnded(task.id.slice(TURN_END_KIND.length + 1))
  return { done: true }
}

export const asksSweep: TaskHandler = withSeed(async (task: DueTask, ctx: TaskContext) => {
  await asksOf(ctx).sweep()
  ctx.scheduler.schedule({ id: task.id, kind: ASKS_SWEEP_KIND, dueAtMs: ctx.nowMs + ASKS_SWEEP_EVERY_MS })
  return { done: true }
}, { id: ASKS_SWEEP_KIND })

/** The outbox's send task, then its action's delivery (the result reaches the chat and the agent without the sweep's wait). */
export const withDelivery = (send: TaskHandler): TaskHandler => async (task, ctx) => {
  const r = await send(task, ctx)
  const actionId = task.id.slice(task.id.indexOf(':') + 1)
  ctx.scheduler.schedule({ id: deliverTaskId(actionId), kind: DELIVER_KIND, dueAtMs: ctx.nowMs })
  return r
}
