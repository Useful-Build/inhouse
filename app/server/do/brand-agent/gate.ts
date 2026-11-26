// The model gate and the per-turn ledger queue (p3-design 8.2 revision 6, 8.3 and 9). The egress asks before every
// model call (`admit`), confirms a grant with its first renew, renews the call's 60 s lease every 20 s, and closes it
// from a `finally` (`release`); the `call-lease:<turnId>` task closes what the egress couldn't.
//
// The rules (8.2):
// - Up to 4 calls of a turn in flight: its `model_calls` rows in `deciding`, `granted` or `inflight` (counted from rows).
// - Admission decisions run one at a time per turn in arrival order (`n`): only the oldest waiter is ever decided, so a
//   later call never passes an earlier one. A waiter sent back for money (`money_wait`) is decided again only once a
//   sibling closes.
// - Every ledger write of a turn (`extend`, `close`, `settle`) goes through one queue (`ledger_queue`): one at a time,
//   each computed when it's sent from the state the previous answer left (`turns.ledger_hold_micro`), awaited, and
//   sent again (same arguments, every one idempotent) until it's answered while storage is down
//   (`StoreUnavailableError`); any other error is the ledger refusing for good: logged and dropped, never resent. A decision is made only when nothing is in
//   the queue, so a close never lowers the hold under a sibling being admitted, and after every ledger answer
//   `tally + Σ worst of deciding, granted and inflight ≤ the ledger's hold` (server-tool input aside, 8.2).
// - `need = tally + Σ worst of deciding, granted and inflight − ledgerHold`; `need ≤ 0` grants without a ledger call.
//   A refused extend sends the call back to wait while a sibling is `granted`/`inflight`; with nothing in flight, the
//   call is refused and the turn fenced (`cap_reached`, `turn_budget`, or `budget_busy` for `held`).
// - A grant runs only after the egress confirms it (the first renew, M2); unconfirmed for 10 s it's freed at 0. Each
//   `inflight` call holds its own 60 s lease; an expired lease cuts it at its admitted worst case (8.3's cut-stream
//   rule; at its running tally if that's higher, as the egress prices a cut). A release or renew for a closed row
//   answers `gone` and changes nothing: a call is priced once.
// - Every wait is bounded by 5 minutes from arrival (slot, money and a slow extend together), then that call alone gets
//   503 (`busy`); waiters also get 503 at the turn's fence, `ending`, interrupt or stop (`stopWaiters`).
// - Settle (from the tally; `release` for a turn that made no call, design 9) is queued once the turn is `ended` or
//   `cancelled`, no row is `deciding`, `granted` or `inflight` and every queued close was answered.
// Nothing that must happen after a reset lives only in memory: the rows and the queue are SQLite; the waiters' promises
// die with the instance (their RPCs fail with it), so `seeds()` frees what still waits and re-arms `call-lease`.
import type { TurnFailure } from '../../../shared/contract/runs.ts'
import type { AdmitAnswer, JobBudgetRefusal, LeaseAnswer, ModelCallUsage, ModelCallWorst, UsageExtendRefusal, UsageLedgerPort } from './ports.ts'
import type { Scheduler, TaskResult } from './scheduler.ts'
import { StoreUnavailableError } from '../../db/sql.ts'
import { safeError } from '../../safe-error.ts'

/** Calls of one turn in flight at once (Wasim, item 21(c)). */
export const MAX_CALLS = 4
/** A grant the egress hasn't confirmed by then is freed at 0 (M2). */
export const CONFIRM_MS = 10_000
/** An `inflight` call's lease from its last renew (N1). */
export const LEASE_MS = 60_000
/** Every wait in the gate, from the call's arrival. */
export const WAIT_MAX_MS = 5 * 60_000
/** A failed ledger call is sent again after this, doubling, at most `LEDGER_RETRY_MAX_MS` (never given up). */
export const LEDGER_RETRY_MS = 5_000
export const LEDGER_RETRY_MAX_MS = 60_000

const OPEN = "('deciding', 'granted', 'inflight')"
const CLOSED = "('done', 'cut', 'freed')"

export type GateRefusal = 'cap_reached' | 'turn_budget' | 'budget_busy' | JobBudgetRefusal

interface CallRow {
  [k: string]: SqlStorageValue
  turn_id: string; call_id: string; n: number; worst_micro: number
  state: 'waiting' | 'deciding' | 'granted' | 'inflight' | 'done' | 'cut' | 'freed'
  money_wait: number; arrived_at_ms: number; granted_at_ms: number | null; lease_until_ms: number | null
  usage_json: string | null; micro: number | null
}
interface QueueRow {
  [k: string]: SqlStorageValue
  turn_id: string; n: number; op: 'extend' | 'close' | 'settle'; call_id: string | null; args_json: string | null
  state: 'pending' | 'sent' | 'answered'; answer_json: string | null
}
interface TurnMoney {
  [k: string]: SqlStorageValue
  state: string; reserved: number; settled: number; ledger_hold_micro: number; start_hold_micro: number
  ledger_retry_at_ms: number | null; ledger_fails: number; runner_cost_micro: number | null
}
type ExtendArgs = { need: number }
type CloseArgs = { actual: number; hold: number }
type SettleArgs = { micro: number; release: boolean; atMs: number; runnerCostMicro: number | null }
type ExtendAnswer = Awaited<ReturnType<UsageLedgerPort['extend']>>

export interface GateDeps {
  sql: SqlStorage
  scheduler: Scheduler
  usage: UsageLedgerPort
  now: () => number
  /** Whether the turn takes new model calls now (running, not fenced, not interrupted). */
  admits(turnId: string): boolean
  /** An extend refused with nothing of the turn in flight: the BrandAgent fences the turn with this failure. */
  refuseTurn(turnId: string, reason: TurnFailure): void
}

const refusalOf = (r: UsageExtendRefusal): GateRefusal => (r === 'held' ? 'budget_busy' : r)

export class ModelGate {
  private readonly d: GateDeps
  private readonly sql: SqlStorage
  /** The answers the egress awaits, by `${turnId} ${callId}` (only this instance's: a reset fails those RPCs). */
  private readonly waiters = new Map<string, (a: AdmitAnswer) => void>()
  /** Turns whose ledger queue this instance is working through (one at a time per turn). */
  private readonly pumping = new Set<string>()

  constructor(deps: GateDeps) {
    this.d = deps
    this.sql = deps.sql
  }

  // ---------- reads ----------

  private call(turnId: string, callId: string): CallRow | null {
    return this.sql.exec<CallRow>('SELECT * FROM model_calls WHERE turn_id = ? AND call_id = ?', turnId, callId).toArray()[0] ?? null
  }
  private money(turnId: string): TurnMoney | null {
    return this.sql.exec<TurnMoney>(
      'SELECT state, reserved, settled, ledger_hold_micro, start_hold_micro, ledger_retry_at_ms, ledger_fails, runner_cost_micro FROM turns WHERE turn_id = ?', turnId,
    ).toArray()[0] ?? null
  }
  /** Closed calls at their price (cut ones at their cut price, freed ones at 0). */
  private tally(turnId: string): number {
    return this.sql.exec<{ s: number }>(`SELECT COALESCE(SUM(micro), 0) AS s FROM model_calls WHERE turn_id = ? AND state IN ${CLOSED}`, turnId).one().s
  }
  /** Σ worst of the calls that hold money: deciding, granted, inflight. */
  private openWorst(turnId: string): number {
    return this.sql.exec<{ s: number }>(`SELECT COALESCE(SUM(worst_micro), 0) AS s FROM model_calls WHERE turn_id = ? AND state IN ${OPEN}`, turnId).one().s
  }
  private count(where: string, ...args: SqlStorageValue[]): number {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM model_calls WHERE ${where}`, ...args).one().n
  }

  private answer(turnId: string, callId: string, a: AdmitAnswer) {
    const key = `${turnId} ${callId}`
    const resolve = this.waiters.get(key)
    this.waiters.delete(key)
    resolve?.(a)
  }

  // ---------- the egress's three calls ----------

  /** A call's admission: answered once it's granted, refused, or bounded (`busy`). */
  admit(turnId: string, callId: string, worst: ModelCallWorst): Promise<AdmitAnswer> {
    if (!this.d.admits(turnId)) return Promise.resolve({ busy: true })
    if (this.call(turnId, callId)) return Promise.resolve({ busy: true })
    const now = this.d.now()
    const n = this.sql.exec<{ n: number | null }>('SELECT MAX(n) AS n FROM model_calls WHERE turn_id = ?', turnId).one().n ?? 0
    this.sql.exec(
      `INSERT INTO model_calls (turn_id, call_id, n, model, input_tokens, max_tokens, modifiers_json, worst_micro, state, arrived_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`,
      turnId, callId, n + 1, worst.model, worst.inputTokens, worst.maxTokens, JSON.stringify(worst.modifiers), worst.micro, now)
    const answer = new Promise<AdmitAnswer>(resolve => this.waiters.set(`${turnId} ${callId}`, resolve))
    this.arm(turnId)
    void this.pump(turnId)
    return answer
  }

  /** The confirming renew (granted → inflight) and every later one: the lease runs 60 s from now. */
  renew(turnId: string, callId: string, usage: ModelCallUsage): LeaseAnswer {
    const c = this.call(turnId, callId)
    if (!c || (c.state !== 'granted' && c.state !== 'inflight')) return { gone: true }
    const now = this.d.now()
    this.sql.exec(
      "UPDATE model_calls SET state = 'inflight', admitted_at_ms = COALESCE(admitted_at_ms, ?), lease_until_ms = ?, usage_json = ? WHERE turn_id = ? AND call_id = ?",
      now, now + LEASE_MS, JSON.stringify(usage), turnId, callId)
    this.arm(turnId)
    return { ok: true }
  }

  /** The egress's close: priced from its usage, a cut at its admitted worst case (or its tally, if higher). */
  release(turnId: string, callId: string, end: { usage: ModelCallUsage; cut: boolean }): LeaseAnswer {
    const c = this.call(turnId, callId)
    if (!c || (c.state !== 'granted' && c.state !== 'inflight')) return { gone: true }
    const price = end.cut ? Math.max(c.worst_micro, end.usage.micro) : end.usage.micro
    this.close(c, end.cut ? 'cut' : 'done', price, end.usage)
    return { ok: true }
  }

  // ---------- the turn's end ----------

  /** The turn reached a fence, `ending`, an interrupt or a stop: every waiter (and the call being decided) gets 503. */
  stopWaiters(turnId: string): void {
    const rows = this.sql.exec<CallRow>("SELECT * FROM model_calls WHERE turn_id = ? AND state IN ('waiting', 'deciding') ORDER BY n", turnId).toArray()
    for (const c of rows) this.reject(c)
    if (rows.length > 0) this.arm(turnId)
  }

  /** Queues the turn's settle once it's over and every call closed and every close was answered. */
  maybeSettle(turnId: string): void {
    const t = this.money(turnId)
    if (!t || (t.state !== 'ended' && t.state !== 'cancelled') || t.reserved === 0 || t.settled === 1) return
    if (this.count(`turn_id = ? AND state IN ('waiting', ${OPEN.slice(1, -1)})`, turnId) > 0) return
    if (this.sql.exec("SELECT 1 FROM ledger_queue WHERE turn_id = ? AND state != 'answered' LIMIT 1", turnId).toArray().length > 0) return
    this.enqueue(turnId, 'settle', null)
    void this.pump(turnId)
  }

  /**
   * A reservation that may have landed after the turn's hold was given back: settle once more. Queued behind a settle
   * still out (which would otherwise mark the turn settled with the late reservation still held).
   */
  settleAgain(turnId: string): void {
    this.sql.exec('UPDATE turns SET settled = 0 WHERE turn_id = ?', turnId)
    if (this.sql.exec("SELECT 1 FROM ledger_queue WHERE turn_id = ? AND op = 'settle' AND state != 'answered' LIMIT 1", turnId).toArray().length === 0) {
      return this.maybeSettle(turnId)
    }
    this.enqueue(turnId, 'settle', null)
    void this.pump(turnId)
  }

  // ---------- the `call-lease:<turnId>` task ----------

  /** Expired leases cut, unconfirmed grants freed, waits past 5 minutes answered 503; then the queue; then re-armed. */
  async leaseTask(turnId: string): Promise<TaskResult> {
    const now = this.d.now()
    for (const c of this.sql.exec<CallRow>("SELECT * FROM model_calls WHERE turn_id = ? AND state = 'inflight' AND lease_until_ms <= ? ORDER BY n", turnId, now).toArray()) {
      const running = c.usage_json === null ? 0 : (JSON.parse(c.usage_json) as ModelCallUsage).micro
      this.close(c, 'cut', Math.max(c.worst_micro, running), null)
    }
    for (const c of this.sql.exec<CallRow>("SELECT * FROM model_calls WHERE turn_id = ? AND state = 'granted' AND granted_at_ms <= ? ORDER BY n", turnId, now - CONFIRM_MS).toArray()) {
      this.close(c, 'freed', 0, null)
    }
    for (const c of this.sql.exec<CallRow>("SELECT * FROM model_calls WHERE turn_id = ? AND state IN ('waiting', 'deciding') AND arrived_at_ms <= ? ORDER BY n", turnId, now - WAIT_MAX_MS).toArray()) {
      this.reject(c)
    }
    this.maybeSettle(turnId)
    await this.pump(turnId)
    this.arm(turnId)
    return { done: true }
  }

  /**
   * `call-lease:<turnId>` at the earliest of: an `inflight` lease's end, a grant's confirm deadline, a wait's 5-minute
   * bound, the ledger's retry. Cancelled when there's none. Idempotent.
   */
  arm(turnId: string): void {
    const now = this.d.now()
    const r = this.sql.exec<{ a: number | null; b: number | null; c: number | null }>(
      `SELECT (SELECT MIN(lease_until_ms) FROM model_calls WHERE turn_id = ? AND state = 'inflight') AS a,
        (SELECT MIN(granted_at_ms) FROM model_calls WHERE turn_id = ? AND state = 'granted') AS b,
        (SELECT MIN(arrived_at_ms) FROM model_calls WHERE turn_id = ? AND state IN ('waiting', 'deciding')) AS c`, turnId, turnId, turnId).one()
    const at: number[] = []
    if (r.a !== null) at.push(r.a)
    if (r.b !== null) at.push(r.b + CONFIRM_MS)
    if (r.c !== null) at.push(r.c + WAIT_MAX_MS)
    const t = this.money(turnId)
    if (t?.ledger_retry_at_ms != null && this.sql.exec("SELECT 1 FROM ledger_queue WHERE turn_id = ? AND state != 'answered' LIMIT 1", turnId).toArray().length > 0) {
      at.push(t.ledger_retry_at_ms)
    }
    const id = `call-lease:${turnId}`
    if (at.length === 0) return this.d.scheduler.cancel(id)
    const due = Math.max(Math.min(...at), now)
    const cur = this.sql.exec<{ due_at_ms: number; state: string }>('SELECT due_at_ms, state FROM due_tasks WHERE id = ?', id).toArray()[0]
    if (cur && cur.state === 'ready' && cur.due_at_ms === due) return
    this.d.scheduler.schedule({ id, kind: 'call-lease', dueAtMs: due })
  }

  /** After a reset: what still waited lost its caller (freed, never priced); every turn with work gets its task now. */
  seeds(): void {
    const now = this.d.now()
    this.sql.exec("UPDATE model_calls SET state = 'freed', micro = 0, closed_at_ms = ? WHERE state = 'waiting'", now)
    const turns = this.sql.exec<{ turn_id: string }>(
      `SELECT DISTINCT turn_id FROM model_calls WHERE state IN ${OPEN}
        UNION SELECT DISTINCT turn_id FROM ledger_queue WHERE state != 'answered'`).toArray()
    for (const r of turns) this.d.scheduler.schedule({ id: `call-lease:${r.turn_id}`, kind: 'call-lease', dueAtMs: now })
  }

  // ---------- closing a call ----------

  /** A call that held money closes: its slot frees in this step, its siblings may be decided again, its close is queued. */
  private close(c: CallRow, state: 'done' | 'cut' | 'freed', price: number, usage: ModelCallUsage | null) {
    this.sql.exec(
      'UPDATE model_calls SET state = ?, micro = ?, closed_at_ms = ?, usage_json = COALESCE(?, usage_json) WHERE turn_id = ? AND call_id = ?',
      state, price, this.d.now(), usage === null ? null : JSON.stringify(usage), c.turn_id, c.call_id)
    this.sql.exec("UPDATE model_calls SET money_wait = 0 WHERE turn_id = ? AND state = 'waiting'", c.turn_id)
    this.enqueue(c.turn_id, 'close', c.call_id)
    this.arm(c.turn_id)
    void this.pump(c.turn_id)
  }

  /** A waiter (or the call being decided) answered 503. One whose extend may have raised the hold closes at 0. */
  private reject(c: CallRow) {
    this.sql.exec("UPDATE model_calls SET state = 'freed', micro = 0, closed_at_ms = ? WHERE turn_id = ? AND call_id = ?", this.d.now(), c.turn_id, c.call_id)
    if (c.state === 'deciding') {
      const ext = this.sql.exec<QueueRow>("SELECT * FROM ledger_queue WHERE turn_id = ? AND op = 'extend' AND call_id = ? ORDER BY n DESC LIMIT 1", c.turn_id, c.call_id).toArray()[0]
      const granted = ext?.state === 'answered' && ext.answer_json !== null && 'ok' in (JSON.parse(ext.answer_json) as object)
      if (ext && (ext.state === 'sent' || granted)) {
        this.enqueue(c.turn_id, 'close', c.call_id)
        void this.pump(c.turn_id)
      }
    }
    this.answer(c.turn_id, c.call_id, { busy: true })
  }

  private grant(c: CallRow) {
    const now = this.d.now()
    this.sql.exec("UPDATE model_calls SET state = 'granted', granted_at_ms = ?, money_wait = 0 WHERE turn_id = ? AND call_id = ?", now, c.turn_id, c.call_id)
    this.arm(c.turn_id)
    this.answer(c.turn_id, c.call_id, { granted: true })
  }

  // ---------- the ledger queue ----------

  private enqueue(turnId: string, op: QueueRow['op'], callId: string | null) {
    const n = this.sql.exec<{ n: number | null }>('SELECT MAX(n) AS n FROM ledger_queue WHERE turn_id = ?', turnId).one().n ?? 0
    this.sql.exec("INSERT INTO ledger_queue (turn_id, n, op, call_id, state) VALUES (?, ?, ?, ?, 'pending')", turnId, n + 1, op, callId)
  }

  /** Works through the turn's queue, then its next decision, until there's nothing it can do now. */
  async pump(turnId: string): Promise<void> {
    if (this.pumping.has(turnId)) return
    this.pumping.add(turnId)
    try {
      // Bounded: each step answers a queue row or decides a waiter, both finite per turn.
      for (let i = 0; i < 10_000; i++) if (!(await this.step(turnId))) return
      console.error({ event: 'gate_pump_bound', turnId })
    } finally {
      this.pumping.delete(turnId)
    }
  }

  /** One queue row sent and answered, or one decision started. False when there's nothing to do now. */
  private async step(turnId: string): Promise<boolean> {
    const q = this.sql.exec<QueueRow>("SELECT * FROM ledger_queue WHERE turn_id = ? AND state != 'answered' ORDER BY n LIMIT 1", turnId).toArray()[0]
    if (q) return this.sendRow(q)
    return this.decide(turnId)
  }

  /** The oldest waiter becomes `deciding` (a slot and a share of the money from here) and its extend is queued. */
  private decide(turnId: string): boolean {
    const head = this.sql.exec<CallRow>("SELECT * FROM model_calls WHERE turn_id = ? AND state = 'waiting' ORDER BY n LIMIT 1", turnId).toArray()[0]
    if (!head || head.money_wait === 1) return false
    if (!this.d.admits(turnId)) {
      // A turn that stopped taking calls has no waiters (`stopWaiters`); one that slipped through is answered too.
      this.stopWaiters(turnId)
      return false
    }
    if (this.count(`turn_id = ? AND state IN ${OPEN}`, turnId) >= MAX_CALLS) return false
    this.sql.exec("UPDATE model_calls SET state = 'deciding' WHERE turn_id = ? AND call_id = ?", turnId, head.call_id)
    this.enqueue(turnId, 'extend', head.call_id)
    return true
  }

  private async sendRow(q: QueueRow): Promise<boolean> {
    const turnId = q.turn_id
    const t = this.money(turnId)
    if (!t) throw new Error(`ledger queue for an unknown turn ${turnId}`)
    const now = this.d.now()
    if (t.ledger_retry_at_ms !== null && t.ledger_retry_at_ms > now) return false
    let args: ExtendArgs | CloseArgs | SettleArgs
    if (q.state === 'pending') {
      const computed = this.compute(q, t)
      if (computed === null) return true
      args = computed
      this.sql.exec("UPDATE ledger_queue SET state = 'sent', args_json = ? WHERE turn_id = ? AND n = ?", JSON.stringify(args), turnId, q.n)
      if (q.op === 'close') this.sql.exec('UPDATE model_calls SET close_sent = 1 WHERE turn_id = ? AND call_id = ?', turnId, q.call_id)
    } else {
      args = JSON.parse(q.args_json!) as typeof args
    }
    let answer: ExtendAnswer | { ledgerHold: number } | null
    try {
      answer = await this.send(q, args)
    } catch (err) {
      if (!(err instanceof StoreUnavailableError)) {
        // Not storage being down: the ledger refused the call for good (no row for the turn, e.g. after a D1 restore).
        // Sending it again would only spin, so it's dropped, loudly, and the queue goes on (#154's review).
        console.error({ event: 'ledger_call_dropped', op: q.op, turnId, callId: q.call_id, error: safeError(err) })
        this.drop(q)
        return true
      }
      const fails = t.ledger_fails + 1
      const wait = Math.min(LEDGER_RETRY_MS * 2 ** (fails - 1), LEDGER_RETRY_MAX_MS)
      console.error({ event: 'ledger_call_failed', op: q.op, fails, error: safeError(err) })
      this.sql.exec('UPDATE turns SET ledger_fails = ?, ledger_retry_at_ms = ? WHERE turn_id = ?', fails, this.d.now() + wait, turnId)
      this.arm(turnId)
      return false
    }
    this.apply(q, answer)
    return true
  }

  /**
   * A queued row's arguments, from the state the previous answer left; null when it needs no ledger call (answered
   * here: an extend whose call is no longer being decided, or whose need is ≤ 0, which grants it).
   */
  private compute(q: QueueRow, t: TurnMoney): ExtendArgs | CloseArgs | SettleArgs | null {
    const turnId = q.turn_id
    const skip = (why: string) => this.sql.exec(
      "UPDATE ledger_queue SET state = 'answered', answer_json = ? WHERE turn_id = ? AND n = ?", JSON.stringify({ skipped: why }), turnId, q.n)
    switch (q.op) {
      case 'extend': {
        const c = this.call(turnId, q.call_id!)
        if (!c || c.state !== 'deciding') { skip('not_deciding'); return null }
        const need = this.tally(turnId) + this.openWorst(turnId) - t.ledger_hold_micro
        if (need <= 0) {
          skip('fits')
          this.grant(c)
          return null
        }
        return { need }
      }
      case 'close': {
        const c = this.call(turnId, q.call_id!)!
        return { actual: c.micro ?? 0, hold: Math.max(this.tally(turnId) + this.openWorst(turnId), t.start_hold_micro) }
      }
      case 'settle':
        return { micro: this.tally(turnId), release: this.count('turn_id = ?', turnId) === 0, atMs: this.d.now(), runnerCostMicro: t.runner_cost_micro }
    }
  }

  private async send(q: QueueRow, args: ExtendArgs | CloseArgs | SettleArgs): Promise<ExtendAnswer | { ledgerHold: number } | null> {
    const u = this.d.usage
    switch (q.op) {
      case 'extend': return u.extend(q.turn_id, q.call_id!, (args as ExtendArgs).need)
      case 'close': return u.close(q.turn_id, q.call_id!, (args as CloseArgs).actual, (args as CloseArgs).hold)
      case 'settle': {
        const s = args as SettleArgs
        if (s.release) await u.release(q.turn_id, s.atMs)
        else await u.settle(q.turn_id, s.micro, s.atMs, s.runnerCostMicro)
        return null
      }
    }
  }

  /**
   * A queue row the ledger refused for good: answered as dropped. An extend's call is answered 503 (no money was added);
   * a close leaves the hold as the ledger last said; a settle marks the turn settled (nothing more can be booked).
   */
  private drop(q: QueueRow) {
    const turnId = q.turn_id
    this.sql.exec("UPDATE ledger_queue SET state = 'answered', answer_json = ? WHERE turn_id = ? AND n = ?", JSON.stringify({ dropped: true }), turnId, q.n)
    this.sql.exec('UPDATE turns SET ledger_fails = 0, ledger_retry_at_ms = NULL WHERE turn_id = ?', turnId)
    switch (q.op) {
      case 'extend': {
        const c = this.call(turnId, q.call_id!)
        if (!c || c.state !== 'deciding') return
        this.sql.exec("UPDATE model_calls SET state = 'freed', micro = 0, closed_at_ms = ? WHERE turn_id = ? AND call_id = ?", this.d.now(), turnId, c.call_id)
        this.answer(turnId, c.call_id, { busy: true })
        this.arm(turnId)
        return
      }
      case 'close':
        this.sql.exec('UPDATE model_calls SET close_answered = 1 WHERE turn_id = ? AND call_id = ?', turnId, q.call_id)
        this.maybeSettle(turnId)
        return
      case 'settle':
        this.sql.exec('UPDATE turns SET settled = 1 WHERE turn_id = ?', turnId)
        return
    }
  }

  /** The answer, in one synchronous step: the hold as the ledger left it, then what it decides. */
  private apply(q: QueueRow, answer: ExtendAnswer | { ledgerHold: number } | null) {
    const turnId = q.turn_id
    this.sql.exec("UPDATE ledger_queue SET state = 'answered', answer_json = ? WHERE turn_id = ? AND n = ?", JSON.stringify(answer ?? {}), turnId, q.n)
    this.sql.exec('UPDATE turns SET ledger_fails = 0, ledger_retry_at_ms = NULL WHERE turn_id = ?', turnId)
    if (answer !== null) this.sql.exec('UPDATE turns SET ledger_hold_micro = ? WHERE turn_id = ?', answer.ledgerHold, turnId)
    switch (q.op) {
      case 'extend': {
        const c = this.call(turnId, q.call_id!)
        // Answered 503 while its extend was out: its close (queued then) gives back what this extend added.
        if (!c || c.state !== 'deciding') return
        const a = answer as ExtendAnswer
        if ('ok' in a) return this.grant(c)
        // Something of the turn still holds money: a sibling running, or one closed whose close isn't answered yet (its
        // money comes back with that answer, #159 round 1). Wait: after a sibling's close (`money_wait`), or right after
        // the pending close lands (it's ahead in the queue, so the call is decided again from its answer).
        const running = this.count(`turn_id = ? AND state IN ('granted', 'inflight')`, turnId) > 0
        const closing = this.sql.exec(
          "SELECT 1 FROM ledger_queue WHERE turn_id = ? AND op = 'close' AND state != 'answered' AND call_id != ? LIMIT 1", turnId, c.call_id,
        ).toArray().length > 0
        if (running || closing) {
          this.sql.exec("UPDATE model_calls SET state = 'waiting', money_wait = ? WHERE turn_id = ? AND call_id = ?", closing ? 0 : 1, turnId, c.call_id)
          return
        }
        // Nothing of the turn runs: the call is refused (400) and the turn ends with the reason.
        const reason = refusalOf(a.refused)
        this.sql.exec("UPDATE model_calls SET state = 'freed', micro = 0, closed_at_ms = ? WHERE turn_id = ? AND call_id = ?", this.d.now(), turnId, c.call_id)
        this.answer(turnId, c.call_id, { refused: reason })
        this.d.refuseTurn(turnId, reason)
        return
      }
      case 'close':
        this.sql.exec('UPDATE model_calls SET close_answered = 1 WHERE turn_id = ? AND call_id = ?', turnId, q.call_id)
        this.maybeSettle(turnId)
        return
      case 'settle':
        this.sql.exec('UPDATE turns SET settled = 1 WHERE turn_id = ?', turnId)
        return
    }
  }
}
