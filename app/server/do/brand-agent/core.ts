// The BrandAgent's turn engine (p3-design 4.2-4.7 and 4.11): admission and the queue, starting a turn, ingest, the
// handoff at `released`, the fence, session state, pause and drain, and the watchdog the `turn-watch` and
// `run-advance` tasks run. It runs on the object's SQLite through injected parts (ports, scheduler, tokens, clock), so
// tests drive it inside a Durable Object with fakes and barriers.
//
// The rules that hold it together (4.2):
// - Claim before await: every step that creates or changes a turn writes its row synchronously before its first await.
//   Each awaited result commits only while the turn's `gen` and state are the ones it started with; otherwise it undoes
//   its own effect (a reservation goes back through the `call-lease` task, a minted token is revoked, an admission the
//   turn no longer wants is stopped).
// - One writer per chat: at most one turn of a chat in `starting|live|ending`; the next one is claimed only after the
//   previous one is `ended` (at `released`, the grace's end or the watchdog's verdict).
// - Every chat event is stored with its seq in the same synchronous step that bumps `runs.last_seq`.
// - Terminal once: a turn's outcome is written once (by its terminal event or by the fence that ended it), and its
//   `ended` write (routes closed, the next turn's chance, the run's end) is one synchronous step.
// - Nothing that must happen after a reset lives only in memory: the watchdog, the queue and the hold's return are due
//   tasks; `ensureSeeds()` re-arms them on every start.
import type { ChatEvent, SendTurnResult, TurnFailure } from '../../../shared/contract/runs.ts'
import type { AuditEntry, PushAck, RunEvent, RunEventBody } from '../../../shared/protocol/index.ts'
import { RunStart as RunStartSchema } from '../../../shared/protocol/index.ts'
import type { Actor, BrandAgentPorts, ChatFile, DrainState, Refusal, SubmitTurn } from './ports.ts'
import type { Scheduler, TaskResult } from './scheduler.ts'
import type { EgressRoute, RunGrant, RunTokens, TokenRefusal } from './tokens.ts'
import { hashRunToken } from './tokens.ts'
import { mapSdkMessage, outcomeOf } from './map-events.ts'
import type { TurnOutcome } from './map-events.ts'
import { buildStart, newId, submitPayloadHash } from './run-start.ts'
import type { StartWithoutToken, StoredAttachment } from './run-start.ts'
import { noteCountTokens } from './count-tokens.ts'
import { FLUSH_RETRY_MS, FLUSH_TURN_PREFIX, fixTurnRows, storedProjection, writeProjection } from './projection.ts'
import { ModelGate } from './gate.ts'
import { callsMicro } from './turn-calls.ts'
import { ensureUsageTasks } from '../../usage/seeds.ts'
import { activeRuns, runsHealth, traceOf } from './runs-read.ts'
import type { RunScope, RunsHealth } from './ports.ts'
import type { ActiveRun } from '../../../shared/contract/runs.ts'
import type { Trace } from '../../../shared/contract/trace.ts'
import type { AdmitAnswer, LeaseAnswer, ModelCallUsage, ModelCallWorst } from './ports.ts'

// ---------- numbers (p3-design 1.3, 4.3, 4.4, 4.6, 4.11) ----------
export const STARTING_DEADLINE_MS = 3 * 60_000
export const WATCH_EVERY_MS = 60_000
/** No push for this long on a live turn: ask the runner. */
export const PUSH_SILENT_MS = 90_000
/** A runner that says `live` but sends nothing for this long after the first silence: stop, fail `protocol`. */
export const PUSH_PROBLEM_MS = 5 * 60_000
/** Two `unknown` answers this far apart confirm a lost turn. */
export const CONFIRM_GAP_MS = 30_000
/** No progress event (heartbeats don't count) for this long: fence with `timeout` (CHOICE, Fable: above Bash's 10 min). */
export const INACTIVITY_MS = 12 * 60_000
/** The token's life bounds every turn. */
export const TURN_MAX_MS = 45 * 60_000
/** A fenced turn's flush grace. */
export const GRACE_MS = 60_000
/** An `ending` turn without `released` for this long: ask the runner. */
export const RELEASE_WAIT_MS = 90_000
export const BUDGET_RETRY_MS = 15_000
export const BUDGET_WAIT_MAX_MS = 2 * 60_000
export const MAX_REQUEUES = 2
/** Backlog bounds (CHOICE, 4.3): queued turns per chat, per member and per brand. */
export const QUEUE_MAX_CHAT = 10
export const QUEUE_MAX_MEMBER = 20
export const QUEUE_MAX_BRAND = 200
const EFFECT_RETRY_MS = 30_000

const PRIORITY_ORDER = "CASE priority WHEN 'now' THEN 0 WHEN 'next' THEN 1 ELSE 2 END"
const ACTIVE = "('starting', 'live', 'ending')"
const FIRST_ROUTES: EgressRoute[] = ['model', 'mcp', 'files', 'audit']
const LAST_ROUTES: EgressRoute[] = ['store', 'events']

type CancelWhy = Extract<ChatEvent, { type: 'turn.cancelled' }>['why']
type TurnState = 'queued' | 'starting' | 'live' | 'ending' | 'ended' | 'cancelled'

export interface TurnRow {
  [k: string]: SqlStorageValue
  turn_id: string; run_id: string; chat_id: string; owner_id: string; ord: number; client_key: string; payload_hash: string
  gen: number; state: TurnState; priority: 'now' | 'next' | 'later'; text: string; quote: string | null
  attachments_json: string; model: string; picker_id: string; side_model: string; effort: string; max_turns: number
  web_fetch_json: string | null; answer_position: 'starting' | 'queued'; runner: string | null; runner_last_seq: number
  session_id: string | null; last_push_ms: number | null; last_progress_ms: number | null
  starting_deadline_ms: number | null; placed: number; pool_queued: number; query_ran: number; reserved: number
  interrupt_asked: number; budget_wait_since_ms: number | null; requeues: number; fenced: number
  grace_until_ms: number | null; ending_since_ms: number | null; watch_json: string | null; saw_checkpoint: number
  mirror_error: number; deferred_json: string | null; start_json: string | null; settled: number; ledger_hold_micro: number
  start_hold_micro: number; ledger_fails: number; ledger_retry_at_ms: number | null; runner_cost_micro: number | null; parts_n: number
  steps_n: number; outcome: string | null; failure: string | null; cancel_why: string | null
  pos_from: number | null; pos_to: number | null; d1_flushed: number
  created_at_ms: number; claimed_at_ms: number | null; started_at_ms: number | null; ended_at_ms: number | null
}

interface ChatStateRow {
  [k: string]: SqlStorageValue
  chat_id: string; owner_id: string; live_run_id: string | null; session_id: string | null; provider: string | null
  session: 'none' | 'resumable' | 'waiting' | 'damaged'; checkpoint_main_entries: number | null
  checkpoint_last_uuid: string | null; checkpoint_last_uuid_index: number | null
}

/** The watchdog's memory between two checks of one attempt (cleared by every push). */
interface Watch { ambiguous?: true; stopped?: true; unknownAt?: number; unreachable?: number; silentSince?: number }

export interface CoreDeps {
  sql: SqlStorage
  scheduler: Scheduler
  tokens: RunTokens
  ports: BrandAgentPorts
  now: () => number
  /** The system prompt every run carries (the orchestrator's `app/server/prompt/`). */
  systemPrompt: string
  /** D1, for the redacted `tool_calls` rows (8.7). */
  db: D1Database
  /** A new session id (a UUID); tests pass literal ones. */
  newSessionId?: () => string
  /**
   * Whether the turn's model (its picker id) is still on and priced in the brand's settings, read when the turn starts
   * (it may have waited in the queue since route 29 resolved it). Throws when the settings can't be read.
   */
  modelUsable: (pickerId: string) => Promise<boolean>
  /** Every stored chat event, for the sockets (PR 4). */
  onEvent?: (e: { runId: string; seq: number; atMs: number; chatId: string; event: ChatEvent }) => void
}

const refuse = (code: Refusal['refused']['code'], reason?: Refusal['refused']['reason']): Refusal =>
  ({ refused: reason === undefined ? { code } : { code, reason } })

const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : 'unknown').slice(0, 300)

export class AgentCore {
  private readonly d: CoreDeps
  private readonly sql: SqlStorage
  /** Turns whose effects queue is being drained by this instance (one drain per turn at a time). */
  private readonly draining = new Set<string>()
  /** Runs whose `advance` waits while one synchronous step ends several of their turns (`endChats`): none is claimed half-way. */
  private readonly holding = new Set<string>()
  /** The model gate and the per-turn ledger queue (8.2, gate.ts). */
  readonly gate: ModelGate

  constructor(deps: CoreDeps) {
    this.d = deps
    this.sql = deps.sql
    this.gate = new ModelGate({
      sql: deps.sql, scheduler: deps.scheduler, usage: deps.ports.usage, now: deps.now,
      admits: turnId => this.admitsCalls(turnId),
      refuseTurn: (turnId, reason) => {
        const t = this.turn(turnId)
        if (t && t.fenced === 0 && (t.state === 'live' || t.state === 'starting')) this.fence(t, { outcome: 'failed', reason })
      },
    })
  }

  /** A turn takes model calls while it runs on a runner, unfenced and not interrupted (8.2). */
  private admitsCalls(turnId: string): boolean {
    const t = this.turn(turnId)
    if (!t || t.fenced === 1 || t.interrupt_asked === 1) return false
    // Admitted and pushing before the placement's answer came back is running too (obligation 6).
    return t.state === 'live' || (t.state === 'starting' && t.placed === 1 && t.pool_queued === 0)
  }

  // ---------- reads ----------

  turn(turnId: string): TurnRow | null {
    return this.sql.exec<TurnRow>('SELECT * FROM turns WHERE turn_id = ?', turnId).toArray()[0] ?? null
  }
  /** The turn only while it still has this generation and one of these states. */
  private current(turnId: string, gen: number, ...states: TurnState[]): TurnRow | null {
    const t = this.turn(turnId)
    return t && t.gen === gen && states.includes(t.state) ? t : null
  }
  private chatState(chatId: string): ChatStateRow | null {
    return this.sql.exec<ChatStateRow>('SELECT * FROM chat_state WHERE chat_id = ?', chatId).toArray()[0] ?? null
  }
  private flag(key: string): number | string | null {
    const row = this.sql.exec<{ value: number | string | null }>('SELECT value FROM flags WHERE key = ?', key).toArray()[0]
    return row ? row.value : null
  }
  private paused(): boolean { return this.flag('paused_at_ms') !== null }
  /**
   * A drain holds only while its expiry is ahead (obligation 1), read through the pool (`drainState`, synchronous, the
   * owner of the drain's flags: obligation 11), never from the flag's presence.
   */
  private draining_(): boolean {
    const until = this.d.ports.pool.drainState().drainingUntilMs
    return until !== null && until > this.d.now()
  }
  private count(where: string, ...args: SqlStorageValue[]): number {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM turns WHERE ${where}`, ...args).one().n
  }
  private attachments(t: TurnRow): StoredAttachment[] { return JSON.parse(t.attachments_json) as StoredAttachment[] }
  private watchOf(t: TurnRow): Watch { return t.watch_json === null ? {} : JSON.parse(t.watch_json) as Watch }
  private setWatch(turnId: string, gen: number, w: Watch) {
    this.sql.exec('UPDATE turns SET watch_json = ? WHERE turn_id = ? AND gen = ?', JSON.stringify(w), turnId, gen)
  }

  // ---------- events ----------

  /** Stores one chat event under the run's next seq (one synchronous step, 4.2.4). */
  private emit(runId: string, turnId: string | null, event: ChatEvent): number {
    const now = this.d.now()
    const run = this.sql.exec<{ last_seq: number; chat_id: string }>(
      'UPDATE runs SET last_seq = last_seq + 1 WHERE run_id = ? RETURNING last_seq, chat_id', runId).one()
    this.sql.exec('INSERT INTO events (run_id, seq, turn_id, at_ms, json) VALUES (?, ?, ?, ?, ?)', runId, run.last_seq, turnId, now, JSON.stringify(event))
    this.d.onEvent?.({ runId, seq: run.last_seq, atMs: now, chatId: run.chat_id, event })
    return run.last_seq
  }

  private watchTask(turnId: string, dueAtMs: number) {
    this.d.scheduler.schedule({ id: `turn-watch:${turnId}`, kind: 'turn-watch', dueAtMs })
  }

  // ---------- submit (4.3) ----------

  async submitTurn(t: SubmitTurn): Promise<SendTurnResult | Refusal> {
    // Computed before the key check: it writes nothing, so the claim is still before any write's await (4.2.1).
    const hash = await submitPayloadHash(t.input)
    // A retried POST answers what the first one did, before any other rule (4.3).
    const prior = this.byKey(t.chatId, t.input.clientTurnKey)
    if (prior) return this.replay(prior, hash, t.by.memberId)
    // The runner refuses a start that names an attachment twice; route 29's schema refuses it, and so does the engine
    // for callers that skip the schema (L9).
    const ids = t.input.attachments.map(a => a.fileId)
    if (new Set(ids).size !== ids.length) return refuse('invalid')
    let files: ChatFile[] = []
    if (t.input.attachments.length > 0) {
      const found = await this.d.ports.files.inputsOf(t.chatId, t.input.attachments.map(a => a.fileId))
      if ('missing' in found) return refuse('invalid')
      files = found.files
    }
    return this.admit(t, hash, files)
  }

  private byKey(chatId: string, key: string): TurnRow | null {
    return this.sql.exec<TurnRow>('SELECT * FROM turns WHERE chat_id = ? AND client_key = ?', chatId, key).toArray()[0] ?? null
  }

  private replay(prior: TurnRow, hash: string, memberId: string): SendTurnResult | Refusal {
    if (prior.owner_id !== memberId) return refuse('not_found')
    if (prior.payload_hash !== hash) return refuse('conflict', 'key_reused')
    return { runId: prior.run_id, turnId: prior.turn_id, messageId: `${prior.turn_id}.u`, position: prior.answer_position }
  }

  /** The admission and the claim, in one synchronous step. */
  private admit(t: SubmitTurn, hash: string, files: ChatFile[]): SendTurnResult | Refusal {
    const prior = this.byKey(t.chatId, t.input.clientTurnKey)
    if (prior) return this.replay(prior, hash, t.by.memberId)
    const member = t.by.memberId
    if (this.sql.exec("SELECT 1 FROM authority WHERE kind = 'member' AND id = ?", member).toArray().length > 0) return refuse('forbidden', 'removed')
    // A deleted chat is not found, as route 29 answers it from D1 (that read may predate the delete).
    if (this.sql.exec('SELECT 1 FROM chat_deletion WHERE chat_id = ? AND deleted = 1', t.chatId).toArray().length > 0) return refuse('not_found')
    if (this.paused()) return refuse('forbidden', 'paused')
    if (this.draining_()) return refuse('unavailable', 'draining')
    const cs = this.chatState(t.chatId)
    if (cs && cs.owner_id !== member) return refuse('not_found')
    if (cs?.session === 'damaged') return refuse('conflict', 'session_damaged')
    if (cs?.session === 'waiting') return refuse('conflict', 'waiting_answer')
    if (cs?.provider !== undefined && cs.provider !== null && cs.provider !== 'anthropic') return refuse('conflict', 'provider_changed')
    if (this.count("chat_id = ? AND state = 'queued'", t.chatId) >= QUEUE_MAX_CHAT
      || this.count("owner_id = ? AND state = 'queued'", member) >= QUEUE_MAX_MEMBER
      || this.count("state = 'queued'") >= QUEUE_MAX_BRAND) return refuse('rate_limited', 'queue_full')

    const now = this.d.now()
    if (!cs) {
      this.sql.exec("INSERT INTO chat_state (chat_id, owner_id, provider, session, next_pos, last_at_ms) VALUES (?, ?, 'anthropic', 'none', 0, ?)", t.chatId, member, now)
    } else if (cs.provider === null) {
      this.sql.exec("UPDATE chat_state SET provider = 'anthropic' WHERE chat_id = ?", t.chatId)
    }
    let runId = this.liveRun(t.chatId)
    if (runId === null) {
      runId = newId('r_')
      this.sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, last_seq, started_at_ms) VALUES (?, ?, ?, 'live', 0, ?)", runId, t.chatId, member, now)
      this.sql.exec('UPDATE chat_state SET live_run_id = ?, last_at_ms = ? WHERE chat_id = ?', runId, now, t.chatId)
      this.emit(runId, null, { type: 'run.started', runId, chatId: t.chatId })
    }
    const turnId = newId('t_')
    const atts: StoredAttachment[] = files.map(f => ({ fileId: f.id, name: f.name, path: f.path }))
    const ord = this.sql.exec<{ o: number | null }>('SELECT MAX(ord) AS o FROM turns WHERE run_id = ?', runId).one().o ?? -1
    this.sql.exec(
      `INSERT INTO turns (turn_id, run_id, chat_id, owner_id, ord, client_key, payload_hash, gen, state, priority, text, quote,
        attachments_json, model, picker_id, side_model, effort, max_turns, web_fetch_json, answer_position, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      turnId, runId, t.chatId, member, ord + 1, t.input.clientTurnKey, hash, t.input.priority, t.input.text,
      t.input.quote ?? null, JSON.stringify(atts), t.model, t.pickerId, t.sideModel, t.effort, t.maxTurns,
      t.webFetchDomains === null ? null : JSON.stringify(t.webFetchDomains), now,
    )
    this.emit(runId, turnId, {
      type: 'turn.queued', turnId, messageId: `${turnId}.u`, text: t.input.text,
      ...(t.input.quote === undefined ? {} : { quote: t.input.quote }),
      attachments: atts.map(a => ({ fileId: a.fileId, name: a.name })), priority: t.input.priority, by: member,
    })
    // `now` interrupts the live turn (not one already ending or interrupted) and goes next (4.3).
    if (t.input.priority === 'now') {
      const live = this.sql.exec<TurnRow>("SELECT * FROM turns WHERE run_id = ? AND state = 'live' AND interrupt_asked = 0 AND fenced = 0", runId).toArray()[0]
      if (live) this.askInterrupt(live)
    }
    const claimed = this.advance(runId)
    const position = claimed === turnId ? 'starting' : 'queued'
    this.sql.exec('UPDATE turns SET answer_position = ? WHERE turn_id = ?', position, turnId)
    return { runId, turnId, messageId: `${turnId}.u`, position }
  }

  private liveRun(chatId: string): string | null {
    const row = this.sql.exec<{ run_id: string }>("SELECT run_id FROM runs WHERE chat_id = ? AND state = 'live'", chatId).toArray()[0]
    return row ? row.run_id : null
  }

  // ---------- advance (1.3.4) ----------

  /**
   * If the run has no turn in `starting|live|ending`, start its next queued turn (unless paused or draining), or end it
   * when nothing is queued and no file confirm is pending. Idempotent. The turn it claimed, or null.
   */
  advance(runId: string): string | null {
    const run = this.sql.exec<{ state: string; chat_id: string; started_at_ms: number }>('SELECT state, chat_id, started_at_ms FROM runs WHERE run_id = ?', runId).toArray()[0]
    if (!run || run.state !== 'live' || this.holding.has(runId)) return null
    if (this.count(`run_id = ? AND state IN ${ACTIVE}`, runId) > 0) return null
    const next = this.sql.exec<TurnRow>(`SELECT * FROM turns WHERE run_id = ? AND state = 'queued' ORDER BY ${PRIORITY_ORDER}, ord LIMIT 1`, runId).toArray()[0]
    if (next) {
      if (this.paused()) return null
      if (this.draining_()) {
        // Comes back at the drain's expiry, whatever re-armed this run's advance earlier (a budget retry, a file
        // confirm's retry), so the expiry's advance is never overwritten into nothing (L5).
        const until = this.d.ports.pool.drainState().drainingUntilMs!
        this.d.scheduler.schedule({ id: `run-advance:${runId}`, kind: 'run-advance', dueAtMs: until })
        return null
      }
      this.claim(next)
      return next.turn_id
    }
    const pending = this.sql.exec('SELECT 1 FROM turn_effects e JOIN turns t ON t.turn_id = e.turn_id WHERE t.run_id = ? LIMIT 1', runId).toArray()
    if (pending.length > 0) return null
    const now = this.d.now()
    const turns = this.count("run_id = ? AND state = 'ended'", runId)
    // The run's cost from the tally (8.3): closed calls at their price, any still open at their worst case; in cents.
    let micro = 0
    for (const r of this.sql.exec<{ turn_id: string }>('SELECT turn_id FROM turns WHERE run_id = ?', runId).toArray()) micro += callsMicro(this.sql, r.turn_id)
    this.emit(runId, null, { type: 'run.finished', runId, turns, durationMs: Math.max(0, now - run.started_at_ms), cost: { minor: Math.round(micro / 10_000), currency: 'USD' } })
    this.sql.exec("UPDATE runs SET state = 'ended', ended_at_ms = ? WHERE run_id = ?", now, runId)
    this.sql.exec('UPDATE chat_state SET live_run_id = NULL WHERE chat_id = ? AND live_run_id = ?', run.chat_id, runId)
    return null
  }

  /** The claim (4.4 step 1), synchronous, then the start's awaited steps. */
  private claim(t: TurnRow) {
    const now = this.d.now()
    const gen = t.gen + 1
    this.sql.exec(
      `UPDATE turns SET state = 'starting', gen = ?, starting_deadline_ms = ?, claimed_at_ms = ?, placed = 0, pool_queued = 0,
        runner = NULL, runner_last_seq = -1, watch_json = NULL WHERE turn_id = ?`, gen, now + STARTING_DEADLINE_MS, now, t.turn_id)
    this.watchTask(t.turn_id, now + WATCH_EVERY_MS)
    void this.start(t.turn_id, gen).catch(err => console.error({ event: 'turn_start_failed', error: errorText(err) }))
  }

  // ---------- start (4.4) ----------

  /** Testing seam: runs before each awaited step of a start (a barrier, or a reset injected there). */
  beforeStep?: (step: 'files' | 'model' | 'reserve' | 'mint' | 'place', turnId: string) => Promise<void>

  private async start(turnId: string, gen: number): Promise<void> {
    let t = this.current(turnId, gen, 'starting')
    if (!t) return
    const atts = this.attachments(t)
    // The attachments are checked again when a queued turn starts (4.9).
    if (atts.length > 0) {
      await this.beforeStep?.('files', turnId)
      const found = await this.d.ports.files.inputsOf(t.chat_id, atts.map(a => a.fileId))
      t = this.current(turnId, gen, 'starting')
      if (!t) return
      if ('missing' in found) return this.failUnstarted(t, { outcome: 'failed', reason: 'files' })
    }

    // The model again (A3, from #153's review): switched off or unpriced while the turn waited → `model_off`, before
    // any hold or runner is spent (the egress would refuse its every call anyway). A settings read that fails leaves the
    // turn `starting`: the watchdog requeues it at the deadline (counted, so it can't loop).
    await this.beforeStep?.('model', turnId)
    let usable: boolean
    try {
      usable = await this.d.modelUsable(t.picker_id)
    } catch (err) {
      console.error({ event: 'turn_model_check_failed', error: errorText(err) })
      return
    }
    t = this.current(turnId, gen, 'starting')
    if (!t) return
    if (!usable) return this.failUnstarted(t, { outcome: 'failed', reason: 'model_off' })

    // The start hold (section 9). `reserved = 1` before the await: a cancel during it gives the hold back.
    this.sql.exec('UPDATE turns SET reserved = MAX(reserved, 1) WHERE turn_id = ?', turnId)
    await this.beforeStep?.('reserve', turnId)
    const r = await this.d.ports.usage.reserve({ turnId, runId: t.run_id, chatId: t.chat_id, memberId: t.owner_id, model: t.model, nowMs: this.d.now() })
    t = this.current(turnId, gen, 'starting')
    if (!t) {
      // Fenced while the reservation was in flight: it may have landed after the hold was given back, so give it back
      // again once the turn has ended (a turn back in the queue keeps it: the next attempt's reserve finds the same one).
      const now_ = this.turn(turnId)
      if (now_ && (now_.state === 'ended' || now_.state === 'cancelled')) this.queueSettle(turnId, true)
      else if (now_ && now_.state === 'ending') this.sql.exec('UPDATE turns SET settled = 0 WHERE turn_id = ?', turnId)
      return
    }
    if ('refused' in r) {
      if (r.refused === 'cap_reached') {
        this.emit(t.run_id, null, { type: 'notice', code: 'cap_reached' })
        return this.cancelUnstarted(t, 'cap_reached')
      }
      return this.budgetBusy(t)
    }
    // The ledger's first answer is the start hold (the floor of every close's hold, 8.2); a later attempt's reserve
    // answers the same reservation and leaves the queue's last answer alone.
    this.sql.exec(
      `UPDATE turns SET reserved = 2, budget_wait_since_ms = NULL,
        ledger_hold_micro = CASE WHEN start_hold_micro = 0 THEN ? ELSE ledger_hold_micro END,
        start_hold_micro = CASE WHEN start_hold_micro = 0 THEN ? ELSE start_hold_micro END WHERE turn_id = ?`,
      r.reservedMicro, r.reservedMicro, turnId)

    // The session (sync).
    const cs = this.chatState(t.chat_id)
    let sessionId: string
    let expect: StartWithoutToken['expect'] = null
    if (!cs || cs.session === 'none' || cs.session_id === null) {
      sessionId = this.d.newSessionId?.() ?? crypto.randomUUID()
      this.sql.exec("UPDATE chat_state SET session_id = ?, session = 'none' WHERE chat_id = ?", sessionId, t.chat_id)
    } else if (cs.session === 'resumable' && cs.checkpoint_main_entries !== null && cs.checkpoint_main_entries >= 1) {
      sessionId = cs.session_id
      expect = { mainEntries: cs.checkpoint_main_entries, lastUuid: cs.checkpoint_last_uuid, lastUuidIndex: cs.checkpoint_last_uuid_index }
    } else {
      return this.cancelUnstarted(t, 'session_unusable')
    }
    let start: StartWithoutToken
    try {
      start = buildStart({
        turnId, chatId: t.chat_id, sessionId, expect, text: t.text, quote: t.quote, attachments: atts, model: t.model,
        sideModel: t.side_model, effort: t.effort as StartWithoutToken['effort'], maxTurns: t.max_turns,
        webFetchDomains: t.web_fetch_json === null ? null : JSON.parse(t.web_fetch_json) as string[], systemPrompt: this.d.systemPrompt,
      })
    } catch (err) {
      console.error({ event: 'turn_start_unbuildable', error: errorText(err) })
      return this.failUnstarted(t, { outcome: 'failed', reason: 'protocol' })
    }
    this.sql.exec('UPDATE turns SET session_id = ?, start_json = ? WHERE turn_id = ?', sessionId, JSON.stringify(start), turnId)
    await this.mintAndPlace(turnId, gen)
  }

  /** 4.4 steps 4 and 5: a fresh token (fenced on return: obligation 2), then the placement. */
  private async mintAndPlace(turnId: string, gen: number): Promise<void> {
    let t = this.current(turnId, gen, 'starting')
    if (!t || t.start_json === null || t.session_id === null) return
    await this.beforeStep?.('mint', turnId)
    const token = await this.d.tokens.mint({
      turnId, runId: t.run_id, chatId: t.chat_id, memberId: t.owner_id, sessionId: t.session_id, model: t.model, sideModel: t.side_model,
    }, this.d.now())
    const tokenHash = await hashRunToken(token)
    t = this.current(turnId, gen, 'starting')
    if (!t || t.placed === 1 && t.pool_queued === 0) {
      // Fenced (or another attempt placed it) while the token was minted: this token never leaves.
      this.d.tokens.revokeToken(tokenHash, 'fenced')
      return
    }
    let rs
    try {
      rs = RunStartSchema.parse({ ...JSON.parse(t.start_json!), runToken: token })
    } catch (err) {
      this.d.tokens.revokeToken(tokenHash, 'unbuildable')
      console.error({ event: 'turn_start_unbuildable', error: errorText(err) })
      return this.failUnstarted(t, { outcome: 'failed', reason: 'protocol' })
    }
    this.sql.exec('UPDATE turns SET placed = 1, pool_queued = 0 WHERE turn_id = ? AND gen = ?', turnId, gen)
    await this.beforeStep?.('place', turnId)
    const answer = await this.d.ports.pool.place(rs, gen)
    this.placed(turnId, gen, answer, tokenHash)
  }

  /** The pool's answer to a placement (4.4 step 5; obligations 6 and 7). */
  private placed(turnId: string, gen: number, answer: Awaited<ReturnType<BrandAgentPorts['pool']['place']>>, tokenHash: string) {
    const t = this.turn(turnId)
    if (!t) return
    const named = 'admitted' in answer ? answer.admitted : 'ambiguous' in answer ? answer.ambiguous : null
    if (t.gen === gen && t.state === 'starting') {
      if ('admitted' in answer) return this.goLive(t, answer.admitted)
    } else {
      // A late answer (obligation 6, H1 of #153's review). This attempt is still the turn's own while its token stands
      // (a requeue or a cancel before admission revokes it; a terminal event or a fence only closes routes): then it
      // is the attempt a push made live, or that ended or was fenced since, so keep its token (the grace still needs
      // `store` and `events`), name the runner if none is, and never stop it.
      if (this.tokenStands(tokenHash)) {
        if (named !== null && (t.state === 'live' || t.state === 'ending')) {
          this.sql.exec('UPDATE turns SET runner = ? WHERE turn_id = ? AND runner IS NULL', named, turnId)
        }
        // Fenced while the placement was in flight: the fence's own stop may have reached the runner before the run was
        // admitted there (a 404 the runner takes as done), so stop it again now that it is (round 2 low). The token
        // stays: the grace still flushes through `store` and `events`.
        if (named !== null && t.fenced === 1) {
          void this.d.ports.pool.stop(named, turnId).catch(err => console.error({ event: 'turn_fenced_stop_failed', error: errorText(err) }))
        }
        return
      }
      // An attempt requeued or cancelled before admission: its token goes, and a runner it reached is stopped (best
      // effort), unless a newer attempt of the turn (same turn id) is on that runner now.
      this.d.tokens.revokeToken(tokenHash, 'fenced')
      const newerThere = t.runner === named && (t.state === 'starting' || t.state === 'live' || t.state === 'ending')
      if (named !== null && !newerThere) {
        void this.d.ports.pool.stop(named, turnId).catch(err => console.error({ event: 'turn_undo_stop_failed', error: errorText(err) }))
      }
      return
    }
    if ('queued' in answer) {
      this.d.tokens.revokeToken(tokenHash, 'queued')
      // Once per turn, whatever its later attempts do (L6).
      const told = this.sql.exec("SELECT 1 FROM events WHERE turn_id = ? AND json = ? LIMIT 1", turnId, JSON.stringify({ type: 'notice', code: 'pool_busy' })).toArray().length > 0
      if (!told) this.emit(t.run_id, turnId, { type: 'notice', code: 'pool_busy' })
      this.sql.exec('UPDATE turns SET pool_queued = 1 WHERE turn_id = ?', turnId)
      return
    }
    if ('ambiguous' in answer) {
      // Never another runner: stop it there, then ask until the answer is certain (1.3, `starting`).
      this.sql.exec('UPDATE turns SET runner = ?, watch_json = ? WHERE turn_id = ?', answer.ambiguous, JSON.stringify({ ambiguous: true } satisfies Watch), turnId)
      this.watchTask(turnId, this.d.now())
      return
    }
    this.d.tokens.revokeToken(tokenHash, 'refused')
    switch (answer.refused) {
      case 'pool_full': return this.cancelUnstarted(this.turn(turnId)!, 'pool_full')
      case 'files': return this.failUnstarted(this.turn(turnId)!, { outcome: 'failed', reason: 'files' })
      case 'rejected': return this.failUnstarted(this.turn(turnId)!, { outcome: 'failed', reason: 'protocol' })
      // Back to the run's queue, tried again by `run-advance` (not at once: a pool that answers `draining` while
      // `drainState` says none would otherwise loop the claim).
      case 'draining': return this.requeue(this.turn(turnId)!, false, false)
    }
  }

  /** Whether this token was never revoked (its routes may be closed). */
  private tokenStands(tokenHash: string): boolean {
    return this.sql.exec('SELECT 1 FROM run_tokens WHERE token_hash = ? AND revoked_at_ms IS NULL', tokenHash).toArray().length > 0
  }

  private goLive(t: TurnRow, runner: string | null) {
    const now = this.d.now()
    this.sql.exec(
      `UPDATE turns SET state = 'live', runner = COALESCE(?, runner), pool_queued = 0, last_push_ms = COALESCE(last_push_ms, ?),
        last_progress_ms = COALESCE(last_progress_ms, ?), started_at_ms = ?, watch_json = NULL WHERE turn_id = ?`,
      runner, now, now, now, t.turn_id)
    this.emit(t.run_id, t.turn_id, { type: 'turn.started', turnId: t.turn_id, model: t.picker_id })
    this.watchTask(t.turn_id, now + WATCH_EVERY_MS)
  }

  /** `budget_busy`: back to `queued`, tried again in 15 s, failed after 2 minutes of waiting (4.4 step 2). */
  private budgetBusy(t: TurnRow) {
    const now = this.d.now()
    const since = t.budget_wait_since_ms ?? now
    if (now - since >= BUDGET_WAIT_MAX_MS) return this.failUnstarted(t, { outcome: 'failed', reason: 'budget_busy' })
    if (t.budget_wait_since_ms === null) this.emit(t.run_id, null, { type: 'notice', code: 'budget_busy' })
    this.sql.exec(
      `UPDATE turns SET state = 'queued', gen = gen + 1, budget_wait_since_ms = ?, placed = 0, starting_deadline_ms = NULL
        WHERE turn_id = ?`, since, t.turn_id)
    this.d.scheduler.cancel(`turn-watch:${t.turn_id}`)
    this.d.scheduler.schedule({ id: `run-advance:${t.run_id}`, kind: 'run-advance', dueAtMs: now + BUDGET_RETRY_MS })
  }

  /**
   * Back to `queued` for another attempt (1.3): the attempt's tokens are revoked first; past 2 requeues (counted when
   * `counts`) the turn fails `session_crashed`.
   */
  private requeue(t: TurnRow, counts: boolean, advanceNow = true) {
    this.d.tokens.revokeTurn(t.turn_id, 'requeued')
    this.gate.stopWaiters(t.turn_id)
    if (counts && t.requeues >= MAX_REQUEUES) return this.failUnstarted(t, { outcome: 'failed', reason: 'session_crashed' })
    if (t.pool_queued === 1) this.d.ports.pool.dequeue(t.turn_id)
    this.sql.exec(
      `UPDATE turns SET state = 'queued', gen = gen + 1, placed = 0, pool_queued = 0, runner = NULL, runner_last_seq = -1,
        watch_json = NULL, starting_deadline_ms = NULL, requeues = requeues + ? WHERE turn_id = ?`, counts ? 1 : 0, t.turn_id)
    this.d.scheduler.cancel(`turn-watch:${t.turn_id}`)
    if (advanceNow) this.advance(t.run_id)
    else this.d.scheduler.schedule({ id: `run-advance:${t.run_id}`, kind: 'run-advance', dueAtMs: this.d.now() + BUDGET_RETRY_MS })
  }

  // ---------- the placement hooks (W2 fit point 3; obligation 9) ----------

  /** A turn in the placement queue may try again: revoke the old attempt's token, mint a new one, place again. */
  async retryPlacement(turnId: string): Promise<void> {
    const t = this.turn(turnId)
    if (!t || t.state !== 'starting' || t.pool_queued !== 1) return
    this.d.tokens.revokeTurn(turnId, 'placement_retry')
    await this.mintAndPlace(turnId, t.gen)
  }

  /** The turn waited 60 s in the placement queue: it fails `pool_full`. */
  placementExpired(turnId: string): void {
    const t = this.turn(turnId)
    if (!t || t.state !== 'starting' || t.pool_queued !== 1) return
    this.sql.exec('UPDATE turns SET pool_queued = 0 WHERE turn_id = ?', turnId)
    this.cancelUnstarted(this.turn(turnId)!, 'pool_full')
  }

  // ---------- endings ----------

  /** A turn that never ran ends here (`cancelled` with a why). */
  private cancelUnstarted(t: TurnRow, why: CancelWhy) {
    this.emit(t.run_id, t.turn_id, { type: 'turn.cancelled', turnId: t.turn_id, why })
    this.closeUnstarted(t, 'cancelled', null, null, why)
  }
  /** A turn that never ran fails here (`ended`, `turn.finished`). */
  private failUnstarted(t: TurnRow, o: TurnOutcome) {
    this.emit(t.run_id, t.turn_id, { type: 'turn.finished', turnId: t.turn_id, ...o })
    this.closeUnstarted(t, 'ended', o.outcome, 'reason' in o ? o.reason : null, null)
  }
  private closeUnstarted(t: TurnRow, state: 'ended' | 'cancelled', outcome: string | null, failure: string | null, why: string | null) {
    const now = this.d.now()
    this.d.tokens.revokeTurn(t.turn_id, state)
    if (t.pool_queued === 1) this.d.ports.pool.dequeue(t.turn_id)
    this.storeFinal(t.turn_id, state, { outcome, failure, why }, now)
    this.d.scheduler.cancel(`turn-watch:${t.turn_id}`)
    this.gate.stopWaiters(t.turn_id)
    if (t.reserved > 0) this.queueSettle(t.turn_id, false)
    this.advance(t.run_id)
  }

  /**
   * THE one synchronous step that stores a turn as final (`ended` or `cancelled`), on every path: finished, failed,
   * stopped, interrupted, cancelled while queued or starting (pause, stop, removal, delete), fence and watchdog
   * deadlines. An outcome already fixed (by the terminal event or the fence) is kept. PR 5's `onEnd` task is ensured
   * here, in the same step; `onFinal` is that seam (tests count it).
   */
  private storeFinal(turnId: string, state: 'ended' | 'cancelled', o: { outcome: string | null; failure: string | null; why: string | null }, now: number) {
    this.sql.exec(
      `UPDATE turns SET state = ?, gen = gen + 1, outcome = COALESCE(outcome, ?), failure = COALESCE(failure, ?),
        cancel_why = COALESCE(cancel_why, ?), pool_queued = 0, ended_at_ms = ? WHERE turn_id = ?`,
      state, o.outcome, o.failure, o.why, now, turnId)
    // The D1 projection (4.8): the rows fixed here, the batch after; the task is its durable retry.
    fixTurnRows(this.sql, turnId, now)
    this.d.scheduler.schedule({ id: `${FLUSH_TURN_PREFIX}${turnId}`, kind: 'flush-turn', dueAtMs: now + FLUSH_RETRY_MS })
    void this.flushTurn(turnId)
    this.onFinal?.(this.turn(turnId)!)
  }

  /**
   * Writes the turn's fixed rows to D1 (idempotent: the same ids and positions every time). True once they're in; a
   * failure stays for the `flush-turn` task, which retries with the scheduler's backoff.
   */
  async flushTurn(turnId: string): Promise<boolean> {
    // The whole flush under one error path: a stored row that won't read fails like a batch that won't land (the task
    // retries it, then quarantines it), never an unhandled rejection of the immediate flush.
    try {
      const p = storedProjection(this.sql, turnId)
      if (!p) return true
      if (this.turn(turnId)?.d1_flushed === 1) return true
      await writeProjection(this.d.db, p)
      this.sql.exec('UPDATE turns SET d1_flushed = 1 WHERE turn_id = ?', turnId)
      this.d.scheduler.cancel(`${FLUSH_TURN_PREFIX}${turnId}`)
      return true
    } catch (err) {
      console.error({ event: 'flush_turn_failed', turnId, error: errorText(err) })
      return false
    }
  }

  /** Testing seam (and PR 5's join point): called once per turn, inside `storeFinal`'s synchronous step. */
  onFinal?: (t: TurnRow) => void

  /**
   * The fence (4.6): `gen++`, the outcome fixed now (terminal once), `model|mcp|files|audit` closed, the runner asked to
   * stop; its `checkpoint`, `mirror_error` and `released` are still ingested for a 60 s grace, then it's `ended`. A turn
   * that never reached a runner just ends.
   */
  fence(t: TurnRow, end: TurnOutcome | { cancel: CancelWhy }): void {
    if (t.state === 'queued' || (t.state === 'starting' && t.placed === 0) || (t.state === 'starting' && t.pool_queued === 1)) {
      if ('cancel' in end) return this.cancelUnstarted(t, end.cancel)
      return this.failUnstarted(t, end)
    }
    if (t.state === 'ended' || t.state === 'cancelled' || t.fenced === 1) return
    const now = this.d.now()
    const terminalAlready = t.state === 'ending'
    if (!terminalAlready) {
      if ('cancel' in end) this.emit(t.run_id, t.turn_id, { type: 'turn.cancelled', turnId: t.turn_id, why: end.cancel })
      else this.emit(t.run_id, t.turn_id, { type: 'turn.finished', turnId: t.turn_id, ...end })
    }
    this.sql.exec(
      `UPDATE turns SET state = 'ending', gen = gen + 1, fenced = 1, grace_until_ms = ?, ending_since_ms = COALESCE(ending_since_ms, ?),
        outcome = COALESCE(outcome, ?), failure = COALESCE(failure, ?), cancel_why = COALESCE(cancel_why, ?) WHERE turn_id = ?`,
      now + GRACE_MS, now, 'cancel' in end ? 'cancelled' : end.outcome, 'reason' in end ? end.reason : null,
      'cancel' in end ? end.cancel : null, t.turn_id)
    this.d.tokens.closeRoutes(t.turn_id, FIRST_ROUTES, 'fenced')
    this.gate.stopWaiters(t.turn_id)
    this.watchTask(t.turn_id, now + GRACE_MS)
    if (t.runner !== null) {
      const runner = t.runner
      void this.d.ports.pool.stop(runner, t.turn_id).catch(err => console.error({ event: 'turn_stop_failed', error: errorText(err) }))
    }
  }

  /**
   * `ended` (4.6), one synchronous step: the session rule for a turn that ended without a checkpoint, every route
   * closed, the runner's slot freed, the watchdog cancelled, the hold's return queued, the run's next turn or end.
   */
  private endTurn(t: TurnRow, noCheckpointMeansDamage: boolean) {
    const now = this.d.now()
    if (noCheckpointMeansDamage && t.query_ran === 1 && t.saw_checkpoint === 0 && t.mirror_error === 0) this.damage(t)
    if (t.outcome === null) {
      // The runner released without a terminal event: a protocol break, never a silent success.
      this.emit(t.run_id, t.turn_id, { type: 'turn.finished', turnId: t.turn_id, outcome: 'failed', reason: 'protocol' })
      this.sql.exec("UPDATE turns SET outcome = 'failed', failure = 'protocol' WHERE turn_id = ?", t.turn_id)
    }
    this.storeFinal(t.turn_id, 'ended', { outcome: null, failure: null, why: null }, now)
    this.d.tokens.closeRoutes(t.turn_id, [...FIRST_ROUTES, ...LAST_ROUTES], 'ended')
    this.d.tokens.prune(now)
    if (t.runner !== null) this.d.ports.pool.turnEnded(t.runner, t.turn_id)
    this.d.scheduler.cancel(`turn-watch:${t.turn_id}`)
    this.gate.stopWaiters(t.turn_id)
    if (t.reserved > 0) this.queueSettle(t.turn_id, false)
    this.sql.exec('UPDATE chat_state SET last_at_ms = MAX(last_at_ms, ?) WHERE chat_id = ?', now, t.chat_id)
    this.advance(t.run_id)
  }

  private damage(t: TurnRow) {
    this.sql.exec("UPDATE chat_state SET session = 'damaged', waiting_json = NULL, damaged_at_ms = ? WHERE chat_id = ?", this.d.now(), t.chat_id)
    this.emit(t.run_id, null, { type: 'notice', code: 'session_damaged' })
  }

  /**
   * The turn's hold goes back through its ledger queue (gate.ts: settle once every call closed and every close was
   * answered; retried until answered). `again`: a reservation that may have landed after an earlier return; send it
   * once more.
   */
  private queueSettle(turnId: string, again: boolean) {
    if (again) this.gate.settleAgain(turnId)
    else this.gate.maybeSettle(turnId)
  }

  /** The `call-lease:<turnId>` task: leases, confirm deadlines, 5-minute waits, the ledger queue (gate.ts). */
  leaseTask(turnId: string): Promise<TaskResult> {
    return this.gate.leaseTask(turnId)
  }

  // ---------- reads (routes 32, 33; the runs signal; runs-read.ts) ----------

  activeRuns(scope: RunScope): ActiveRun[] { return activeRuns(this.sql, scope) }
  readTrace(id: string, scope: RunScope): Trace | null { return traceOf(this.sql, id, scope, this.d.now()) }
  runsHealth(quarantined: number): RunsHealth { return runsHealth(this.sql, this.d.now(), quarantined) }

  // ---------- the model gate (8.2; the egress's calls) ----------

  admitModelCall(turnId: string, callId: string, worst: ModelCallWorst): Promise<AdmitAnswer> {
    return this.gate.admit(turnId, callId, worst)
  }
  renewModelCall(turnId: string, callId: string, usage: ModelCallUsage): LeaseAnswer {
    return this.gate.renew(turnId, callId, usage)
  }
  releaseModelCall(turnId: string, callId: string, end: { usage: ModelCallUsage; cut: boolean }): LeaseAnswer {
    return this.gate.release(turnId, callId, end)
  }

  // ---------- ingest (4.5, 4.2.6, 4.2.7) ----------

  ingest(turnId: string, events: RunEvent[]): PushAck | { gone: true } {
    let t = this.turn(turnId)
    if (!t || t.state === 'ended' || t.state === 'cancelled') return { gone: true }
    const lastSeq = events.length === 0 ? t.runner_last_seq : events[events.length - 1].seq
    // An attempt that went back to the queue: nothing of it is kept; the runner stops it.
    if (t.state === 'queued') return { ackSeq: Math.max(0, lastSeq), stop: true }
    if (t.state === 'starting') {
      if (t.placed === 0) return { ackSeq: Math.max(0, lastSeq), stop: true }
      // Admitted: the runner pushes before (or instead of) the placement's answer (obligation 6).
      this.goLive(t, null)
      t = this.turn(turnId)!
    }
    const now = this.d.now()
    for (const ev of events) {
      if (ev.seq <= t.runner_last_seq) continue
      if (ev.seq !== t.runner_last_seq + 1) {
        if (t.fenced === 0) this.fence(t, { outcome: 'failed', reason: 'protocol' })
        return { ackSeq: Math.max(0, this.turn(turnId)!.runner_last_seq), stop: true }
      }
      this.sql.exec('UPDATE turns SET runner_last_seq = ?, last_push_ms = ?, watch_json = NULL WHERE turn_id = ?', ev.seq, now, turnId)
      t = this.turn(turnId)!
      const ended = this.ingestOne(t, ev, now)
      if (ev.type === 'file_saved') void this.drainEffects(turnId)
      if (ended) return { ackSeq: ev.seq, stop: false }
      t = this.turn(turnId)!
    }
    return { ackSeq: Math.max(0, t.runner_last_seq), stop: t.fenced === 1 }
  }

  /** One new event; true when it ended the turn. */
  private ingestOne(t: TurnRow, ev: RunEvent, now: number): boolean {
    const progress = () => this.sql.exec('UPDATE turns SET last_progress_ms = ? WHERE turn_id = ?', now, t.turn_id)
    // A fenced turn's grace keeps only what the session state needs (4.2.7).
    if (t.fenced === 1 && ev.type !== 'checkpoint' && ev.type !== 'mirror_error' && ev.type !== 'released') return false
    switch (ev.type) {
      case 'started': progress(); return false
      case 'heartbeat': return false
      case 'sdk': {
        progress()
        this.sql.exec('UPDATE turns SET query_ran = 1 WHERE turn_id = ?', t.turn_id)
        this.mapSdk(t, ev, now)
        return false
      }
      case 'file_saved':
        progress()
        this.sql.exec('INSERT INTO turn_effects (turn_id, seq, kind, json) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
          t.turn_id, ev.seq, 'confirm', JSON.stringify({ path: ev.path, sha256: ev.sha256 }))
        return false
      case 'file_refused':
        progress()
        this.emit(t.run_id, t.turn_id, { type: 'file.refused', turnId: t.turn_id, name: ev.path.replace(/^outputs\//, ''), reason: ev.reason })
        return false
      case 'file_refused_more': progress(); return false
      case 'files_restored':
        progress()
        this.emit(t.run_id, t.turn_id, { type: 'files.restored', turnId: t.turn_id, restored: ev.restored, leftOut: ev.leftOut })
        return false
      case 'audit':
        this.trace(t.turn_id, now, { audit: ev.entry.toolName, hook: ev.entry.hook, decision: ev.entry.decision })
        return false
      case 'deferred':
        progress()
        this.sql.exec('UPDATE turns SET deferred_json = ? WHERE turn_id = ?', JSON.stringify({ toolUseId: ev.toolUseId, toolName: ev.toolName, input: ev.input }), t.turn_id)
        return false
      case 'mirror_error':
        this.sql.exec('UPDATE turns SET mirror_error = 1 WHERE turn_id = ?', t.turn_id)
        this.damage(t)
        return false
      case 'checkpoint':
        this.checkpoint(t, ev)
        return false
      case 'finished':
      case 'failed':
        // The runner's own cost estimate, beside the tally at settle (design 9: logged, never booked).
        if (ev.type === 'finished') this.sql.exec('UPDATE turns SET runner_cost_micro = ? WHERE turn_id = ?', Math.round(ev.costUsd * 1_000_000), t.turn_id)
        this.terminal(t, ev)
        return false
      case 'released': {
        if (ev.checkpoint !== null) this.checkpoint(t, ev.checkpoint)
        const fresh = this.turn(t.turn_id)!
        if (!ev.queryRan && fresh.query_ran === 0) {
          // Nothing ran: the session keeps its last good state (a stop during the file restore, a root timeout).
          this.endTurn(fresh, false)
        } else {
          if (ev.queryRan) this.sql.exec('UPDATE turns SET query_ran = 1 WHERE turn_id = ?', t.turn_id)
          this.endTurn(this.turn(t.turn_id)!, true)
        }
        return true
      }
    }
  }

  private mapSdk(t: TurnRow, ev: Extract<RunEvent, { type: 'sdk' }>, now: number) {
    const blocks = mapSdkMessage(ev.message, ev.truncated)
    if (blocks.length === 0) return
    let parts = t.parts_n
    let steps = t.steps_n
    const at = { iso: new Date(now).toISOString(), ms: now }
    for (const b of blocks) {
      if (b.kind === 'text') {
        this.emit(t.run_id, t.turn_id, { type: 'part', turnId: t.turn_id, messageId: `${t.turn_id}.${parts}`, part: { type: 'text', text: b.text }, model: t.picker_id, at })
        parts++
      } else {
        this.emit(t.run_id, t.turn_id, { type: 'step', turnId: t.turn_id, stepId: `${t.turn_id}.s${steps}`, label: b.label, tool: b.tool })
        this.trace(t.turn_id, now, { step: b.label, tool: b.tool })
        steps++
      }
    }
    this.sql.exec('UPDATE turns SET parts_n = ?, steps_n = ? WHERE turn_id = ?', parts, steps, t.turn_id)
  }

  private trace(turnId: string, now: number, record: Record<string, string>) {
    const n = this.sql.exec<{ n: number | null }>('SELECT MAX(n) AS n FROM turn_trace WHERE turn_id = ?', turnId).one().n ?? -1
    this.sql.exec('INSERT INTO turn_trace (turn_id, n, at_ms, json) VALUES (?, ?, ?, ?)', turnId, n + 1, now, JSON.stringify(record))
  }

  /** A checkpoint (in its event or in `released`): resumable, waiting after a `deferred`, none at 0 entries (R3). */
  private checkpoint(t: TurnRow, cp: { mainEntries: number; lastUuid: string | null; lastUuidIndex: number | null }) {
    this.sql.exec('UPDATE turns SET saw_checkpoint = 1 WHERE turn_id = ?', t.turn_id)
    const fresh = this.turn(t.turn_id)!
    if (fresh.mirror_error === 1) return
    if (cp.mainEntries === 0) {
      this.sql.exec(`UPDATE chat_state SET session = 'none', session_id = NULL, checkpoint_main_entries = NULL,
        checkpoint_last_uuid = NULL, checkpoint_last_uuid_index = NULL, waiting_json = NULL WHERE chat_id = ?`, t.chat_id)
      return
    }
    const waiting = fresh.deferred_json !== null
    this.sql.exec(
      `UPDATE chat_state SET session = ?, session_id = ?, checkpoint_main_entries = ?, checkpoint_last_uuid = ?,
        checkpoint_last_uuid_index = ?, waiting_json = ? WHERE chat_id = ?`,
      waiting ? 'waiting' : 'resumable', fresh.session_id, cp.mainEntries, cp.lastUuid, cp.lastUuidIndex,
      waiting ? fresh.deferred_json : null, t.chat_id)
  }

  /** The terminal event (terminal once): the outcome, `ending`, the first routes closed, `turn.finished`. */
  private terminal(t: TurnRow, ev: Extract<RunEventBody, { type: 'finished' | 'failed' }>) {
    if (t.outcome !== null || t.state !== 'live') return
    const o = outcomeOf(ev, t.interrupt_asked === 1)
    const now = this.d.now()
    this.sql.exec("UPDATE turns SET state = 'ending', ending_since_ms = ?, outcome = ?, failure = ? WHERE turn_id = ?",
      now, o.outcome, 'reason' in o ? o.reason : null, t.turn_id)
    this.d.tokens.closeRoutes(t.turn_id, FIRST_ROUTES, 'terminal')
    this.gate.stopWaiters(t.turn_id)
    this.emit(t.run_id, t.turn_id, { type: 'turn.finished', turnId: t.turn_id, ...o })
    this.watchTask(t.turn_id, now + RELEASE_WAIT_MS)
  }

  /** File confirms, one at a time per turn, each idempotent by `(turnId, seq)` (4.2.6). */
  async drainEffects(turnId: string): Promise<void> {
    if (this.draining.has(turnId)) return
    this.draining.add(turnId)
    try {
      for (let i = 0; i < 1000; i++) {
        const row = this.sql.exec<{ seq: number; json: string; chat_id: string; run_id: string }>(
          `SELECT e.seq, e.json, t.chat_id, t.run_id FROM turn_effects e JOIN turns t ON t.turn_id = e.turn_id
            WHERE e.turn_id = ? ORDER BY e.seq LIMIT 1`, turnId).toArray()[0]
        if (!row) break
        const { path, sha256 } = JSON.parse(row.json) as { path: string; sha256: string }
        let file: ChatFile | null
        try {
          file = await this.d.ports.files.confirm(row.chat_id, turnId, path, sha256, this.d.now())
        } catch (err) {
          console.error({ event: 'file_confirm_failed', error: errorText(err) })
          this.d.scheduler.schedule({ id: `run-advance:${row.run_id}`, kind: 'run-advance', dueAtMs: this.d.now() + EFFECT_RETRY_MS })
          return
        }
        const gone = this.sql.exec('DELETE FROM turn_effects WHERE turn_id = ? AND seq = ?', turnId, row.seq).rowsWritten === 0
        if (!gone && file) this.emit(row.run_id, turnId, { type: 'file', turnId, fileId: file.id, name: file.name, bytes: file.bytes, contentType: file.contentType })
        if (!gone) this.advance(row.run_id)
      }
    } finally {
      this.draining.delete(turnId)
    }
  }

  // ---------- the watchdog (`turn-watch`, 1.3 and 4.11) ----------

  async watch(turnId: string): Promise<TaskResult> {
    const t = this.turn(turnId)
    if (!t || t.state === 'ended' || t.state === 'cancelled' || t.state === 'queued') return { done: true }
    const now = this.d.now()
    if (t.state === 'starting') return this.watchStarting(t, now)
    if (t.state === 'live') return this.watchLive(t, now)
    return this.watchEnding(t, now)
  }

  /** The watchdog runs again at `atMs`: a fresh schedule (attempts 0), since a re-check isn't a failure. */
  private again(turnId: string, atMs: number): TaskResult {
    this.watchTask(turnId, Math.max(atMs, this.d.now()))
    return { done: true }
  }

  private async watchStarting(t: TurnRow, now: number): Promise<TaskResult> {
    const deadline = t.starting_deadline_ms ?? now
    const w = this.watchOf(t)
    if (t.placed === 0 || (t.runner === null && t.pool_queued === 0)) {
      // No runner named: requeue at the deadline (a placement whose answer was lost to a reset; a runner that admitted
      // it after all refuses the next attempt as `run_live`/`chat_live` until it ends).
      if (now < deadline) return this.again(t.turn_id, Math.min(deadline, now + WATCH_EVERY_MS))
      this.requeue(t, true)
      return { done: true }
    }
    if (t.pool_queued === 1) {
      if (now < deadline) return this.again(t.turn_id, deadline)
      this.cancelUnstarted(t, 'pool_full')
      return { done: true }
    }
    if (!w.ambiguous && now < deadline) return this.again(t.turn_id, Math.min(deadline, now + WATCH_EVERY_MS))
    // The ambiguous path: stop it there, then `status` until certain.
    const runner = t.runner!
    // Bounded like any turn (H3 of #153's review): a runner that never answers can't hold the chat past the token's life.
    if (now - (t.claimed_at_ms ?? t.created_at_ms) >= TURN_MAX_MS) {
      this.failUnstarted(t, { outcome: 'failed', reason: 'session_crashed' })
      return { done: true }
    }
    if (!w.stopped) {
      // A stop that fails (a dead container) is no answer at all: go on to `status`, never throw out of the watchdog.
      try {
        await this.d.ports.pool.stop(runner, t.turn_id)
      } catch (err) {
        console.error({ event: 'turn_ambiguous_stop_failed', error: errorText(err) })
      }
      if (!this.current(t.turn_id, t.gen, 'starting')) return { done: true }
      w.stopped = true
      this.setWatch(t.turn_id, t.gen, { ...w, ambiguous: true })
    }
    let st: Awaited<ReturnType<BrandAgentPorts['pool']['status']>>
    try {
      st = await this.d.ports.pool.status(runner, t.turn_id)
    } catch (err) {
      console.error({ event: 'turn_status_failed', error: errorText(err) })
      st = { state: 'unreachable', containerGone: false }
    }
    const fresh = this.current(t.turn_id, t.gen, 'starting')
    if (!fresh) return { done: true }
    const at = this.d.now()
    if (st.state === 'live') {
      // Admitted after all (and asked to stop): it's live until its `released`.
      this.goLive(fresh, runner)
      return { done: true }
    }
    if (st.state === 'unreachable') {
      const n = (w.unreachable ?? 0) + 1
      if (n >= 2 && st.containerGone) {
        this.failUnstarted(fresh, { outcome: 'failed', reason: 'session_crashed' })
        return { done: true }
      }
      this.setWatch(t.turn_id, t.gen, { ...w, ambiguous: true, stopped: true, unreachable: n })
      return this.again(t.turn_id, at + CONFIRM_GAP_MS)
    }
    // `unknown` or `ended`: the runner doesn't hold it. Confirmed by a second answer at least 30 s later.
    if (w.unknownAt !== undefined && at - w.unknownAt >= CONFIRM_GAP_MS) {
      this.requeue(fresh, true)
      return { done: true }
    }
    this.setWatch(t.turn_id, t.gen, { ...w, ambiguous: true, stopped: true, unreachable: 0, unknownAt: w.unknownAt ?? at })
    return this.again(t.turn_id, (w.unknownAt ?? at) + CONFIRM_GAP_MS)
  }

  private async watchLive(t: TurnRow, now: number): Promise<TaskResult> {
    if (now - (t.last_progress_ms ?? now) >= INACTIVITY_MS || now - (t.started_at_ms ?? now) >= TURN_MAX_MS) {
      this.fence(t, { outcome: 'failed', reason: 'timeout' })
      return { done: true }
    }
    const lastPush = t.last_push_ms ?? now
    if (now - lastPush < PUSH_SILENT_MS) return this.again(t.turn_id, Math.min(now + WATCH_EVERY_MS, lastPush + PUSH_SILENT_MS))
    const w = this.watchOf(t)
    const st = await this.d.ports.pool.status(t.runner!, t.turn_id)
    const fresh = this.current(t.turn_id, t.gen, 'live')
    // A push since we asked (it cleared the watch) or a change of state: the answer is stale.
    if (!fresh || fresh.last_push_ms !== t.last_push_ms) return this.again(t.turn_id, this.d.now() + WATCH_EVERY_MS)
    const at = this.d.now()
    if (st.state === 'live') {
      if (at - lastPush >= PUSH_SILENT_MS + PUSH_PROBLEM_MS) {
        this.fence(fresh, { outcome: 'failed', reason: 'protocol' })
        return { done: true }
      }
      this.setWatch(t.turn_id, t.gen, {})
      return this.again(t.turn_id, at + WATCH_EVERY_MS)
    }
    if (st.state === 'unreachable') {
      const n = (w.unreachable ?? 0) + 1
      if (n >= 2 && st.containerGone) {
        this.fence(fresh, { outcome: 'failed', reason: 'session_crashed' })
        return { done: true }
      }
      this.setWatch(t.turn_id, t.gen, { unreachable: n })
      return this.again(t.turn_id, at + CONFIRM_GAP_MS)
    }
    if (w.unknownAt !== undefined && at - w.unknownAt >= CONFIRM_GAP_MS) {
      this.fence(fresh, { outcome: 'failed', reason: 'session_crashed' })
      return { done: true }
    }
    this.setWatch(t.turn_id, t.gen, { unknownAt: w.unknownAt ?? at })
    return this.again(t.turn_id, (w.unknownAt ?? at) + CONFIRM_GAP_MS)
  }

  private async watchEnding(t: TurnRow, now: number): Promise<TaskResult> {
    if (t.fenced === 1) {
      if (now < (t.grace_until_ms ?? now)) return this.again(t.turn_id, t.grace_until_ms!)
      // The grace ran out: ended, damaged if the query ran and no checkpoint came (4.7).
      this.endTurn(t, true)
      return { done: true }
    }
    const since = t.ending_since_ms ?? now
    if (now - since < RELEASE_WAIT_MS) return this.again(t.turn_id, since + RELEASE_WAIT_MS)
    if (now - (t.started_at_ms ?? now) >= TURN_MAX_MS) {
      this.endTurn(t, true)
      return { done: true }
    }
    const w = this.watchOf(t)
    const st = await this.d.ports.pool.status(t.runner!, t.turn_id)
    const fresh = this.current(t.turn_id, t.gen, 'ending')
    if (!fresh || fresh.fenced === 1) return this.again(t.turn_id, this.d.now())
    const at = this.d.now()
    if (st.state === 'unknown' || st.state === 'ended') {
      // The runner no longer knows it: ended with its stored outcome, never a second failure.
      this.endTurn(fresh, true)
      return { done: true }
    }
    if (st.state === 'unreachable') {
      const n = (w.unreachable ?? 0) + 1
      if (n >= 2 && st.containerGone) {
        this.endTurn(fresh, true)
        return { done: true }
      }
      this.setWatch(t.turn_id, t.gen, { unreachable: n })
      return this.again(t.turn_id, at + CONFIRM_GAP_MS)
    }
    this.setWatch(t.turn_id, t.gen, {})
    return this.again(t.turn_id, at + WATCH_EVERY_MS)
  }

  /** The `run-advance` task: pending file confirms first, then the run's next turn or its end. */
  async advanceTask(runId: string): Promise<TaskResult> {
    const turns = this.sql.exec<{ turn_id: string }>('SELECT DISTINCT e.turn_id FROM turn_effects e JOIN turns t ON t.turn_id = e.turn_id WHERE t.run_id = ?', runId).toArray()
    for (const r of turns) await this.drainEffects(r.turn_id)
    this.advance(runId)
    return { done: true }
  }

  // ---------- interrupt, stop, session reset (4.3, 4.7) ----------

  /** A person's own turn, or null (another person's turn is not found everywhere). */
  turnOwner(turnId: string): string | null {
    return this.turn(turnId)?.owner_id ?? null
  }

  /**
   * Marks the interrupt asked and sends it. A failed send clears the mark, so the next click asks again (L4). A live turn
   * always has its runner named (the pool writes it before it awaits the admission); with none, nothing is sent and
   * the mark stays: the outcome reads `interrupted` when the runner's answer comes.
   */
  private askInterrupt(t: TurnRow) {
    this.sql.exec('UPDATE turns SET interrupt_asked = 1 WHERE turn_id = ?', t.turn_id)
    this.gate.stopWaiters(t.turn_id)
    const runner = t.runner
    if (runner === null) return
    const gen = t.gen
    void this.d.ports.pool.interrupt(runner, t.turn_id).catch(err => {
      console.error({ event: 'turn_interrupt_failed', error: errorText(err) })
      this.sql.exec("UPDATE turns SET interrupt_asked = 0 WHERE turn_id = ? AND gen = ? AND state = 'live' AND outcome IS NULL", t.turn_id, gen)
    })
  }

  /** The SDK interrupt of a live turn; a queued (or not yet placed) one is cancelled instead. */
  interrupt(turnId: string, by: Actor): { ok: true } | Refusal {
    const t = this.turn(turnId)
    if (!t || t.owner_id !== by.memberId) return refuse('not_found')
    // A turn not yet running (queued, or starting anywhere short of live) is ended `interrupted` instead.
    if (t.state === 'queued' || t.state === 'starting') {
      this.fence(t, { outcome: 'interrupted' })
      return { ok: true }
    }
    if (t.state === 'live' && t.fenced === 0) {
      if (t.interrupt_asked === 0) this.askInterrupt(t)
      return { ok: true }
    }
    return refuse('conflict', 'turn_ended')
  }

  /** The runner's hard stop of that turn only (plan S4): the run's queued turns carry on. */
  stop(turnId: string, by: Actor): { ok: true } | Refusal {
    const t = this.turn(turnId)
    if (!t || t.owner_id !== by.memberId) return refuse('not_found')
    if (t.state === 'queued' || t.state === 'starting' || (t.state === 'live' && t.fenced === 0)) {
      this.fence(t, { outcome: 'stopped' })
      return { ok: true }
    }
    return refuse('conflict', 'turn_ended')
  }

  /** Route 49: the owner's explicit recovery from a damaged (or any idle) session: a fresh session, the history kept. */
  resetSession(chatId: string, by: Actor): { ok: true } | Refusal {
    const cs = this.chatState(chatId)
    if (!cs) return { ok: true }
    if (cs.owner_id !== by.memberId) return refuse('not_found')
    if (this.count(`chat_id = ? AND state IN ('queued', ${ACTIVE.slice(1, -1)})`, chatId) > 0) return refuse('conflict')
    this.sql.exec(`UPDATE chat_state SET session = 'none', session_id = NULL, checkpoint_main_entries = NULL,
      checkpoint_last_uuid = NULL, checkpoint_last_uuid_index = NULL, waiting_json = NULL WHERE chat_id = ?`, chatId)
    return { ok: true }
  }

  // ---------- chats: history and delete (routes 24, 27; 4.8) ----------

  /**
   * The runs of these chats a reload attaches to (route 24): route 32's read narrowed to them (the live run, and every
   * ended run with a turn whose rows aren't in D1 yet). The route has checked the reader's access to each chat.
   */
  chatRuns(chatIds: string[]): ActiveRun[] { return activeRuns(this.sql, { all: true }, chatIds) }

  /**
   * Applies route 27's or 28's change for each chat only when it is newer than the last one applied: `rev` is the
   * chat's D1 rev after that change (every delete and restore that changes the chat moves it, and no two carry the same
   * rev), so a delete whose call arrives after a later restore changes nothing, nor the other way round (#163 reviews).
   * The same rev again (a retry whose first call landed) changes nothing. The chats it applied.
   */
  private markChats(chats: { id: string; rev: number }[], deleted: boolean): string[] {
    const now = this.d.now()
    const applied: string[] = []
    for (const c of chats) {
      const last = this.sql.exec<{ rev: number }>('SELECT rev FROM chat_deletion WHERE chat_id = ?', c.id).toArray()[0]
      if (last && last.rev >= c.rev) continue
      this.sql.exec(`INSERT INTO chat_deletion (chat_id, deleted, rev, at_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET deleted = excluded.deleted, rev = excluded.rev, at_ms = excluded.at_ms`, c.id, deleted ? 1 : 0, c.rev, now)
      applied.push(c.id)
    }
    return applied
  }

  /**
   * Route 27 (4.6): the chats were deleted (each with its D1 rev after the delete). Those not overtaken by a restore are
   * marked deleted in `chat_deletion` (sends refused until a restore), their queued turns are cancelled and their
   * running ones fenced, each through the fence's own paths, so every one ends in `storeFinal`. One synchronous step:
   * the runs' `advance` is held until every turn is ended or fenced, so no queued turn is claimed on the way.
   */
  endChats(chats: { id: string; rev: number }[]) {
    const chatIds = this.markChats(chats, true)
    if (chatIds.length === 0) return
    const marks = chatIds.map(() => '?').join(', ')
    const runs = this.sql.exec<{ run_id: string }>(`SELECT run_id FROM runs WHERE state = 'live' AND chat_id IN (${marks})`, ...chatIds).toArray().map(r => r.run_id)
    for (const r of runs) this.holding.add(r)
    try {
      const turns = this.sql.exec<{ turn_id: string }>(
        `SELECT turn_id FROM turns WHERE chat_id IN (${marks}) AND state IN ('queued', 'starting', 'live') ORDER BY created_at_ms, ord`, ...chatIds).toArray()
      for (const { turn_id } of turns) {
        const fresh = this.turn(turn_id)
        if (fresh && fresh.fenced === 0 && (fresh.state === 'queued' || fresh.state === 'starting' || fresh.state === 'live')) this.fence(fresh, { cancel: 'deleted' })
      }
    } finally {
      for (const r of runs) this.holding.delete(r)
    }
    for (const r of runs) this.advance(r)
  }

  /** Route 28: the chats are being restored (each with its D1 rev once restored); sends into them are admitted again. */
  restoreChats(chats: { id: string; rev: number }[]) {
    this.markChats(chats, false)
  }

  // ---------- pause, drain (4.11, 7) ----------

  pauseState(): { paused: boolean; at: { iso: string; ms: number } | null; by: string | null } {
    const at = this.flag('paused_at_ms')
    const by = this.flag('paused_by')
    if (typeof at !== 'number') return { paused: false, at: null, by: null }
    return { paused: true, at: { iso: new Date(at).toISOString(), ms: at }, by: typeof by === 'string' ? by : null }
  }

  /** Flag; fence every turn on a runner; cancel every queued turn and the placement queue. Starts nothing on resume. */
  pause(by: Actor) {
    if (!this.paused()) {
      const now = this.d.now()
      this.sql.exec("INSERT INTO flags (key, value) VALUES ('paused_at_ms', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", now)
      this.sql.exec("INSERT INTO flags (key, value) VALUES ('paused_by', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", by.memberId)
    }
    // The placement queue first (obligation 9): its turns fail `paused`.
    for (const id of this.d.ports.pool.clearQueue()) {
      const t = this.turn(id)
      if (t && t.state === 'starting') {
        this.sql.exec('UPDATE turns SET pool_queued = 0 WHERE turn_id = ?', id)
        this.cancelUnstarted(this.turn(id)!, 'paused')
      }
    }
    const runs = this.sql.exec<{ run_id: string }>("SELECT run_id FROM runs WHERE state = 'live'").toArray()
    for (const r of runs) {
      const turns = this.sql.exec<TurnRow>(`SELECT * FROM turns WHERE run_id = ? AND state IN ('queued', ${ACTIVE.slice(1, -1)}) ORDER BY ord`, r.run_id).toArray()
      if (turns.length === 0) continue
      this.emit(r.run_id, null, { type: 'notice', code: 'paused' })
      for (const t of turns) {
        const fresh = this.turn(t.turn_id)
        if (fresh) this.fence(fresh, { cancel: 'paused' })
      }
    }
    return this.pauseState()
  }

  resume() {
    this.sql.exec("DELETE FROM flags WHERE key IN ('paused_at_ms', 'paused_by')")
    return this.pauseState()
  }

  /** Route 46: the pool's drain, then `run-advance` for every live run at the drain's expiry (it has an event). */
  drain(): DrainState {
    const state = this.d.ports.pool.drain(this.d.now())
    if (state.drainingUntilMs !== null) {
      for (const r of this.sql.exec<{ run_id: string }>("SELECT run_id FROM runs WHERE state = 'live'").toArray()) {
        this.d.scheduler.schedule({ id: `run-advance:${r.run_id}`, kind: 'run-advance', dueAtMs: state.drainingUntilMs })
      }
    }
    return state
  }

  /** Route 48: once the pool warmed up and cleared the drain, every live run may start its queued turns. */
  async warmup() {
    const answer = await this.d.ports.pool.warmup()
    if ('ok' in answer) {
      for (const r of this.sql.exec<{ run_id: string }>("SELECT run_id FROM runs WHERE state = 'live'").toArray()) {
        this.d.scheduler.schedule({ id: `run-advance:${r.run_id}`, kind: 'run-advance', dueAtMs: this.d.now() })
      }
    }
    return answer
  }

  // ---------- authority (4.3, 4.10; the sockets are PR 4's) ----------

  onMemberRemoved(memberId: string) {
    this.sql.exec("INSERT INTO authority (kind, id, at_ms) VALUES ('member', ?, ?) ON CONFLICT DO NOTHING", memberId, this.d.now())
    this.d.tokens.revokeMember(memberId, 'removed')
    const turns = this.sql.exec<TurnRow>(`SELECT * FROM turns WHERE owner_id = ? AND state IN ('queued', ${ACTIVE.slice(1, -1)}) ORDER BY ord`, memberId).toArray()
    for (const t of turns) {
      const fresh = this.turn(t.turn_id)
      if (fresh) this.fence(fresh, { cancel: 'removed' })
    }
  }

  onGrantEnded(grantId: string) {
    this.sql.exec("INSERT INTO authority (kind, id, at_ms) VALUES ('grant', ?, ?) ON CONFLICT DO NOTHING", grantId, this.d.now())
  }

  /** A Runner's container exited: its turns (once per generation) end `session_crashed`; one still placing goes back. */
  containerExited(runner: string, gen: number) {
    const ids = this.d.ports.pool.containerExited(runner, gen)
    for (const id of ids ?? []) {
      const t = this.turn(id)
      if (!t) continue
      if (t.state === 'starting' && t.placed === 1 && t.pool_queued === 0) this.requeue(t, true)
      else if (t.state === 'live' || t.state === 'ending') this.fence(t, { outcome: 'failed', reason: 'session_crashed' })
    }
  }

  // ---------- the egress's calls (8.1, 8.7) ----------

  checkRunToken(tokenHash: string, route: EgressRoute): RunGrant | { refused: TokenRefusal } {
    return this.d.tokens.check(tokenHash, route, this.d.now())
  }

  noteCountTokens(turnId: string): boolean {
    return noteCountTokens(this.sql, turnId)
  }

  /** The redacted `tool_calls` row (8.7): the input's byte length and SHA-256, never the input. */
  async writeToolCall(turnId: string, n: number, entry: AuditEntry): Promise<void> {
    const t = this.turn(turnId)
    if (!t) throw new Error('writeToolCall: unknown turn')
    const input = new TextEncoder().encode(JSON.stringify(entry.input ?? null))
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', input))].map(b => b.toString(16).padStart(2, '0')).join('')
    await this.d.db.prepare(
      `INSERT INTO tool_calls (turn_id, n, chat_id, member_id, hook, tool, tool_use_id, decision, input_bytes, input_sha256, at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (turn_id, n) DO NOTHING`,
    ).bind(turnId, n, t.chat_id, t.owner_id, entry.hook, entry.toolName, entry.toolUseId ?? null, entry.decision, input.byteLength, sha, this.d.now()).run()
  }

  // ---------- seeds (4.11) ----------

  /**
   * Re-arms what a reset left: every `starting` turn is past its deadline at once (its awaited start died with the old
   * instance), every unfinished turn gets its `turn-watch` now, every live run its `run-advance`, every ended turn whose
   * hold wasn't given back its `call-lease`; the gate frees calls whose caller died with the old instance and gives
   * every turn with an open call or an unanswered ledger row its `call-lease` now (gate.ts `seeds`).
   */
  ensureSeeds() {
    const now = this.d.now()
    this.sql.exec("UPDATE turns SET starting_deadline_ms = ? WHERE state = 'starting' AND starting_deadline_ms > ?", now, now)
    for (const r of this.sql.exec<{ turn_id: string }>(`SELECT turn_id FROM turns WHERE state IN ${ACTIVE}`).toArray()) {
      this.watchTask(r.turn_id, now)
    }
    for (const r of this.sql.exec<{ run_id: string }>("SELECT run_id FROM runs WHERE state = 'live'").toArray()) {
      this.d.scheduler.ensure({ id: `run-advance:${r.run_id}`, kind: 'run-advance', dueAtMs: now })
    }
    for (const r of this.sql.exec<{ turn_id: string }>("SELECT turn_id FROM turns WHERE state IN ('ended', 'cancelled') AND reserved > 0 AND settled = 0").toArray()) {
      this.d.scheduler.ensure({ id: `call-lease:${r.turn_id}`, kind: 'call-lease', dueAtMs: now })
    }
    this.gate.seeds()
    // W4's usage tasks: the hourly sweep and today's audit copy (ensure: never moves one that exists).
    ensureUsageTasks(this.d.scheduler, now)
  }
}

export type { TurnFailure }
