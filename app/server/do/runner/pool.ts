// The runner pool (p3-design section 7), run inside the BrandAgent on its SQLite. Owner: W2.
//
// - A runner's live count is derived from W1's `turns` (`runner = ? AND state IN ('starting','live','ending')`), never a
//   counter. `place` writes `turns.runner` before it awaits the admission, so a placement in flight counts, and clears
//   it again on a definite refusal (an ambiguous answer keeps it: the turn may be on that runner).
// - Fill-first: the lowest-index `up` runner under 25; else wake the lowest-index sleeping one; else queue.
// - The answers to an admission (runner.ts `AdmitResult`), and what each does to the turn and the runner:
//   | answer                         | turn                                   | runner                               |
//   | accepted                       | admitted                               | up, cool-down cleared                |
//   | ambiguous (no or untyped answer)| ambiguous: stays on it, never elsewhere | suspect: 60 s cool-down              |
//   | 409 run_live                   | ambiguous (the turn is live there)     | untouched                            |
//   | 409 chat_live                  | requeued                               | up                                   |
//   | 503 session_pool_exhausted     | next candidate                         | refused, 5 s cool-down               |
//   | 503 session_folder_parked      | refused `files`                        | up                                   |
//   | typed 5xx (stopping, no user)  | next candidate (queued when none left) | 5 s cool-down (state, protocol kept) |
//   | typed 4xx                      | refused `rejected` (W1 fails it)       | untouched                            |
//   | no shared version, 426         | next candidate                         | protocol (never picked)              |
//   | never answered /protocol       | next candidate                         | sleeping, protocol cleared, 5 s      |
// - The placement queue (`pool_queue`) is FIFO and holds turn ids only (a run token is never stored): a free slot or
//   the `pool-retry` task (5 s after) asks W1 to place the head again (`hooks.retryPlacement`, with a fresh token);
//   after 60 s `hooks.placementExpired` (W1 fails it `pool_full`).
// - Drain (route 46) and warm-up (route 48) write W1's `flags` keys `draining_since_ms` and `draining_until_ms`
//   synchronously, so W1's admission check, in the same object, sees them in the same step.
import type { RunStart } from '../../../shared/protocol/index.ts'
import type { BrandAgentParts, DrainState, PoolHealth, Refusal, RunnerPoolPort } from '../brand-agent/ports.ts'
import type { AdmitResult, StatusResult, WarmResult } from './runner.ts'

/** Turns per runner (decision log: 25 per container). */
export const PER_RUNNER = 25
/** The longest a turn waits in the placement queue before it fails `pool_full`. */
export const QUEUE_MAX_MS = 60_000
/** `pool-retry` runs this long after a turn queues, and again while the queue isn't empty. */
export const RETRY_AFTER_MS = 5_000
/** A runner that refused (its uid pool full, a failed start, a typed 503) isn't asked again for this long. */
export const REFUSED_COOLDOWN_MS = 5_000
/**
 * A runner whose admission went unanswered (or answered untyped) may be hung: new turns go elsewhere for this long. A
 * minute is four of `admit`'s 15 s windows, so a wedged runner costs at most one turn a minute until W1's watchdog
 * (status, then stop) settles the turn it holds.
 */
export const SUSPECT_COOLDOWN_MS = 60_000
/**
 * At most this many placements per `pool-retry` pass: each may wait up to `admit`'s 15 s (longer with a container
 * start), and every other due task of the BrandAgent waits behind the pass. The rest go in the next pass, at once.
 */
export const RETRY_PASS_MAX = 3
/**
 * A runner with an admission in flight longer than this isn't offered new turns until it answers: a healthy runner
 * admits in milliseconds, and without this every turn placed in the 15 s before a hung admission times out (and makes
 * the runner suspect) would pile onto it.
 */
export const SLOW_ADMIT_MS = 3_000
/** `pool_shortfall`: a turn queued longer than this, or a `pool_full`, within the window. */
export const SHORTFALL_WAIT_MS = 30_000
export const SHORTFALL_WINDOW_MS = 15 * 60_000
/** `pool_restarts`: more than this many container exits of one runner in an hour. */
export const RESTARTS_PER_HOUR = 3
/** A drain undoes itself after this long. */
export const DRAIN_MS = 30 * 60_000
/** Warm-up proves runners `0 .. min(2, N) - 1`. */
export const WARM_RUNNERS = 2
export const POOL_RETRY_TASK = 'pool-retry'

/** What the pool asks of one Runner object (its RPC methods, index.ts). */
export interface RunnerRpc {
  admit(rs: RunStart): Promise<AdmitResult>
  status(turnId: string): Promise<StatusResult>
  interrupt(turnId: string): Promise<void>
  stop(turnId: string): Promise<void>
  /** `newerThan`: the container generation at the drain; an older or equal one is replaced when idle. */
  warm(newerThan: number | null): Promise<WarmResult>
}

/** The BrandAgent's parts (its SQLite, scheduler, clock and W1's placement hooks), the pool size and the Runners. */
export interface PoolDeps extends BrandAgentParts {
  /** `RUNNER_POOL`. */
  size: number
  runner(name: string): RunnerRpc
}

type RunnerRowState = 'sleeping' | 'starting' | 'up' | 'refused' | 'protocol'
interface RunnerRow {
  runner: string
  idx: number
  state: RunnerRowState
  refused_until_ms: number | null
  protocol: number | null
  container_gen: number | null
  restarts_json: string
}
interface Restarts {
  /** The highest generation whose exit was taken (an exit of it or an older one again is a duplicate). */
  lastExitGen: number
  /** Exit times within the last hour. */
  exits: number[]
}

type PlaceAnswer = Awaited<ReturnType<RunnerPoolPort['place']>>

export const runnerName = (i: number) => `runner-${i}`
const RUNNER_IDX = 'CAST(substr(runner, 8) AS INTEGER)'
const UNFINISHED = "('starting', 'live', 'ending')"
const HOUR_MS = 3_600_000

export class RunnerPool implements RunnerPoolPort {
  readonly #d: PoolDeps
  /**
   * Admissions in flight (turn id → runner and start time): their own answer decides them, never a container exit
   * meanwhile; a second `place` of the same turn answers ambiguous (that admission decides it); a runner with one in
   * flight past `SLOW_ADMIT_MS` isn't picked.
   */
  readonly #placing = new Map<string, { runner: string; atMs: number }>()

  constructor(deps: PoolDeps) {
    if (!Number.isInteger(deps.size) || deps.size < 1) throw new Error(`RUNNER_POOL must be a whole number of at least 1, got ${deps.size}`)
    this.#d = deps
    const { sql } = deps
    sql.exec(`CREATE TABLE IF NOT EXISTS pool_runners (runner TEXT PRIMARY KEY, state TEXT NOT NULL, refused_until_ms INTEGER,
      protocol INTEGER, container_gen INTEGER, restarts_json TEXT NOT NULL DEFAULT '{"lastExitGen":0,"exits":[]}',
      drain_gen INTEGER)`)
    sql.exec('CREATE TABLE IF NOT EXISTS pool_queue (turn_id TEXT PRIMARY KEY, queued_at_ms INTEGER NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS pool_marks (key TEXT PRIMARY KEY, at_ms INTEGER NOT NULL)')
    for (let i = 0; i < deps.size; i++) sql.exec("INSERT OR IGNORE INTO pool_runners (runner, state) VALUES (?, 'sleeping')", runnerName(i))
  }

  // ---------- placement ----------

  async place(rs: RunStart, gen: number): Promise<PlaceAnswer> {
    const turnId = rs.runId
    // A second placement of a turn whose admission is in flight: that admission decides it.
    const inFlight = this.#placing.get(turnId)
    if (inFlight !== undefined) return { ambiguous: inFlight.runner }
    if (!this.#draining(this.#d.now()) && !this.#isQueued(turnId) && this.#queueHead() !== null) {
      // FIFO: a new turn waits behind the queue (the retry pass places queued turns in order).
      this.#enqueue(turnId)
      if (this.#pick(new Set()) !== null) this.#retrySoon()
      return { queued: true }
    }
    const tried = new Set<string>()
    for (;;) {
      if (this.#draining(this.#d.now())) {
        this.#dequeue(turnId)
        return { refused: 'draining' }
      }
      const r = this.#pick(tried)
      if (r === null) {
        this.#enqueue(turnId)
        return { queued: true }
      }
      tried.add(r.runner)
      this.#d.sql.exec('UPDATE turns SET runner = ? WHERE turn_id = ? AND gen = ?', r.runner, turnId, gen)
      if (r.state === 'sleeping') this.#setState(r.runner, 'starting')
      let a: AdmitResult
      this.#placing.set(turnId, { runner: r.runner, atMs: this.#d.now() })
      try {
        a = await this.#d.runner(r.runner).admit(rs)
      } catch {
        // The call to the Runner object failed: it may have sent the admission. Never another runner.
        a = { ambiguous: true, gen: -1 }
      } finally {
        this.#placing.delete(turnId)
      }
      if ('accepted' in a) {
        this.#d.sql.exec("UPDATE pool_runners SET state = 'up', refused_until_ms = NULL, protocol = ?, container_gen = ? WHERE runner = ?", a.protocol, a.gen, r.runner)
        this.#dequeue(turnId)
        return { admitted: r.runner }
      }
      if ('ambiguous' in a || ('refused' in a && a.refused === 'run_live')) {
        // The turn may be (run_live: is) on this runner: it stays there, and W1 settles it (stop, then status).
        if ('ambiguous' in a) this.#d.sql.exec('UPDATE pool_runners SET refused_until_ms = ? WHERE runner = ?', this.#d.now() + SUSPECT_COOLDOWN_MS, r.runner)
        this.#dequeue(turnId)
        return { ambiguous: r.runner }
      }
      // Definite: not admitted here.
      this.#d.sql.exec('UPDATE turns SET runner = NULL WHERE turn_id = ? AND gen = ? AND runner = ?', turnId, gen, r.runner)
      if ('rejected' in a) {
        // About this turn, not the runner.
        this.#dequeue(turnId)
        return { refused: 'rejected', status: a.rejected }
      }
      if ('unavailable' in a) {
        // The runner stated it didn't admit (any typed 5xx): cool it and try the next one; queued only when none is left.
        this.#d.sql.exec('UPDATE pool_runners SET refused_until_ms = ? WHERE runner = ?', this.#d.now() + REFUSED_COOLDOWN_MS, r.runner)
        continue
      }
      if ('placementError' in a) {
        this.#d.sql.exec("UPDATE pool_runners SET state = 'sleeping', refused_until_ms = ?, protocol = NULL WHERE runner = ?", this.#d.now() + REFUSED_COOLDOWN_MS, r.runner)
        continue
      }
      if ('protocol' in a) {
        this.#d.sql.exec("UPDATE pool_runners SET state = 'protocol', protocol = NULL, container_gen = ? WHERE runner = ?", a.gen, r.runner)
        continue
      }
      this.#d.sql.exec('UPDATE pool_runners SET container_gen = ? WHERE runner = ?', a.gen, r.runner)
      switch (a.refused) {
        case 'session_pool_exhausted':
          this.#d.sql.exec("UPDATE pool_runners SET state = 'refused', refused_until_ms = ? WHERE runner = ?", this.#d.now() + REFUSED_COOLDOWN_MS, r.runner)
          continue
        case 'session_folder_parked':
          this.#setState(r.runner, 'up')
          this.#dequeue(turnId)
          return { refused: 'files' }
        case 'chat_live':
          this.#setState(r.runner, 'up')
          this.#enqueue(turnId)
          return { queued: true }
      }
    }
  }

  /** The best candidate not yet tried: fill-first over `up` runners, then the lowest-index sleeping one. */
  #pick(tried: ReadonlySet<string>): RunnerRow | null {
    const now = this.#d.now()
    const live = this.#liveCounts()
    const rows = this.#d.sql
      .exec<Omit<RunnerRow, 'idx'> & { idx: number }>(`SELECT *, ${RUNNER_IDX} AS idx FROM pool_runners WHERE ${RUNNER_IDX} < ? ORDER BY idx`, this.#d.size)
      .toArray() as RunnerRow[]
    const slow = new Set([...this.#placing.values()].filter(p => now - p.atMs > SLOW_ADMIT_MS).map(p => p.runner))
    const free = (r: RunnerRow) =>
      !tried.has(r.runner) && !slow.has(r.runner) && (live.get(r.runner) ?? 0) < PER_RUNNER && (r.refused_until_ms ?? 0) <= now
    // `starting`: another placement is waking it; an admission there joins that start.
    const up = rows.find(r => (r.state === 'up' || r.state === 'starting' || r.state === 'refused') && free(r))
    if (up) return up
    return rows.find(r => r.state === 'sleeping' && free(r)) ?? null
  }

  #liveCounts(): Map<string, number> {
    const rows = this.#d.sql
      .exec<{ runner: string; n: number }>(`SELECT runner, COUNT(*) AS n FROM turns WHERE runner IS NOT NULL AND state IN ${UNFINISHED} GROUP BY runner`)
      .toArray()
    return new Map(rows.map(r => [r.runner, r.n]))
  }

  #setState(runner: string, state: RunnerRowState) {
    this.#d.sql.exec('UPDATE pool_runners SET state = ? WHERE runner = ?', state, runner)
  }

  // ---------- the placement queue ----------

  #isQueued(turnId: string): boolean {
    return this.#d.sql.exec('SELECT 1 FROM pool_queue WHERE turn_id = ?', turnId).toArray().length > 0
  }

  #retrySoon() {
    this.#d.scheduler.schedule({ id: POOL_RETRY_TASK, kind: POOL_RETRY_TASK, dueAtMs: this.#d.now() })
  }

  #queueHead(): { turnId: string; queuedAtMs: number } | null {
    const row = this.#d.sql.exec<{ turn_id: string; queued_at_ms: number }>('SELECT turn_id, queued_at_ms FROM pool_queue ORDER BY queued_at_ms, rowid LIMIT 1').toArray()[0]
    return row === undefined ? null : { turnId: row.turn_id, queuedAtMs: row.queued_at_ms }
  }

  /** Queues the turn (keeping its place if it's already queued) and makes sure a retry comes. */
  #enqueue(turnId: string) {
    const now = this.#d.now()
    this.#d.sql.exec('INSERT OR IGNORE INTO pool_queue (turn_id, queued_at_ms) VALUES (?, ?)', turnId, now)
    this.#d.scheduler.ensure({ id: POOL_RETRY_TASK, kind: POOL_RETRY_TASK, dueAtMs: now + RETRY_AFTER_MS })
  }

  /** Takes the turn off the queue; a wait over 30 s is a shortfall. */
  #dequeue(turnId: string) {
    const row = this.#d.sql.exec<{ queued_at_ms: number }>('DELETE FROM pool_queue WHERE turn_id = ? RETURNING queued_at_ms', turnId).toArray()[0]
    const now = this.#d.now()
    if (row !== undefined && now - row.queued_at_ms > SHORTFALL_WAIT_MS) this.#mark('shortfall', now)
  }

  #mark(key: 'shortfall' | 'pool_full', atMs: number) {
    this.#d.sql.exec('INSERT INTO pool_marks (key, at_ms) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at_ms = excluded.at_ms', key, atMs)
  }

  /** A turn left the placement queue some other way (cancelled, paused, deleted). */
  dequeue(turnId: string): void {
    this.#dequeue(turnId)
  }

  /** Pause cancels the placement queue (design 4.11); W1 cancels the turns themselves. Returns the turn ids it held. */
  clearQueue(): string[] {
    return this.#d.sql.exec<{ turn_id: string }>('DELETE FROM pool_queue RETURNING turn_id').toArray().map(r => r.turn_id)
  }

  queued(): string[] {
    return this.#d.sql.exec<{ turn_id: string }>('SELECT turn_id FROM pool_queue ORDER BY queued_at_ms, rowid').toArray().map(r => r.turn_id)
  }

  /**
   * The `pool-retry` task, over the queue in FIFO order: a turn queued 60 s is expired (`placementExpired`, its row
   * deleted only once that succeeded); the others are handed back to W1 while a slot is free (or a drain began: `place`
   * then answers `draining` and W1 requeues it in its run). At most `RETRY_PASS_MAX` turns leave the queue in a pass
   * (placed, failed or expired); a turn that stays queued (a `409 chat_live`, no runner left) doesn't count and doesn't
   * hold the ones behind it. Reschedules itself at once only when the cap stopped the pass, else after the usual 5 s.
   */
  async retryQueue(): Promise<void> {
    const rows = this.#d.sql.exec<{ turn_id: string; queued_at_ms: number }>('SELECT turn_id, queued_at_ms FROM pool_queue ORDER BY queued_at_ms, rowid').toArray()
    let left = 0
    let capped = false
    let full = false
    for (const row of rows) {
      if (!this.#isQueued(row.turn_id)) continue
      if (row.queued_at_ms + QUEUE_MAX_MS <= this.#d.now()) {
        await this.#d.hooks.placementExpired(row.turn_id)
        this.#d.sql.exec('DELETE FROM pool_queue WHERE turn_id = ?', row.turn_id)
        this.#mark('pool_full', this.#d.now())
        this.#mark('shortfall', this.#d.now())
        left++
        continue
      }
      if (full) continue
      if (left >= RETRY_PASS_MAX) {
        capped = true
        continue
      }
      if (!this.#draining(this.#d.now()) && this.#pick(new Set()) === null) {
        full = true
        continue
      }
      await this.#d.hooks.retryPlacement(row.turn_id)
      if (!this.#isQueued(row.turn_id)) left++
    }
    const head = this.#queueHead()
    if (head !== null) {
      const now = this.#d.now()
      const next = capped ? now : Math.max(now, Math.min(now + RETRY_AFTER_MS, head.queuedAtMs + QUEUE_MAX_MS))
      this.#d.scheduler.schedule({ id: POOL_RETRY_TASK, kind: POOL_RETRY_TASK, dueAtMs: next })
    }
  }

  turnEnded(_runner: string, turnId: string): void {
    this.#dequeue(turnId)
    // A slot freed: the queue's head tries at once (through the alarm, never inside W1's synchronous step).
    if (this.#queueHead() !== null) this.#d.scheduler.schedule({ id: POOL_RETRY_TASK, kind: POOL_RETRY_TASK, dueAtMs: this.#d.now() })
  }

  // ---------- calls on a placed turn ----------

  interrupt(runner: string, turnId: string): Promise<void> {
    return this.#d.runner(runner).interrupt(turnId)
  }

  stop(runner: string, turnId: string): Promise<void> {
    return this.#d.runner(runner).stop(turnId)
  }

  /** The runner's answer and whether the container is gone; a failed call to the Runner object is `unreachable`. */
  async status(runner: string, turnId: string): Promise<StatusResult> {
    try {
      return await this.#d.runner(runner).status(turnId)
    } catch {
      return { state: 'unreachable', containerGone: false }
    }
  }

  /**
   * A Runner's container of generation `gen` exited: the turns on it for W1 to fence, or null when this exit (or a later
   * one) was already taken. The runner sleeps until a placement or warm-up starts a new container.
   */
  containerExited(runner: string, gen: number): string[] | null {
    const row = this.#d.sql.exec<{ restarts_json: string; container_gen: number | null }>('SELECT restarts_json, container_gen FROM pool_runners WHERE runner = ?', runner).toArray()[0]
    if (row === undefined) return null
    const now = this.#d.now()
    const r = JSON.parse(row.restarts_json) as Restarts
    if (gen <= r.lastExitGen) return null
    const next: Restarts = { lastExitGen: gen, exits: [...r.exits.filter(t => t > now - HOUR_MS), now] }
    this.#d.sql.exec('UPDATE pool_runners SET restarts_json = ? WHERE runner = ?', JSON.stringify(next), runner)
    // An older generation than the one the pool placed on: the turns there run on the newer container.
    if (row.container_gen !== null && row.container_gen > gen) return []
    this.#d.sql.exec("UPDATE pool_runners SET state = 'sleeping', protocol = NULL WHERE runner = ?", runner)
    // A failed start surfaces through monitor() (Container API), so the exit can come while that start's admission is
    // still awaited: that turn is decided by its admission's answer (a placement error moves it on), not fenced here.
    return this.#d.sql
      .exec<{ turn_id: string }>(`SELECT turn_id FROM turns WHERE runner = ? AND state IN ${UNFINISHED} ORDER BY turn_id`, runner)
      .toArray()
      .map(t => t.turn_id)
      .filter(id => this.#placing.get(id)?.runner !== runner)
  }

  // ---------- drain and warm-up ----------

  #flag(key: 'draining_since_ms' | 'draining_until_ms'): number | null {
    const row = this.#d.sql.exec<{ value: number | string | null }>('SELECT value FROM flags WHERE key = ?', key).toArray()[0]
    return row?.value == null ? null : Number(row.value)
  }

  #setFlag(key: 'draining_since_ms' | 'draining_until_ms', value: number) {
    this.#d.sql.exec('INSERT INTO flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }

  #clearDrain() {
    this.#d.sql.exec("DELETE FROM flags WHERE key IN ('draining_since_ms', 'draining_until_ms')")
  }

  #draining(now: number): boolean {
    const until = this.#flag('draining_until_ms')
    return until !== null && until > now
  }

  /** Route 46, in one synchronous step: nothing is admitted after it. Queued turns stay queued (W1's run queue). */
  drain(nowMs: number): DrainState {
    const now = nowMs
    const until = now + DRAIN_MS
    if (!this.#draining(now)) {
      this.#setFlag('draining_since_ms', now)
      // Warm-up must find each runner on a newer container than the one it had when the drain began.
      this.#d.sql.exec('UPDATE pool_runners SET drain_gen = container_gen')
    }
    this.#setFlag('draining_until_ms', until)
    // At the expiry every live run advances again (and a run whose turn ended meanwhile starts its next one).
    this.#advanceLiveRuns(until)
    // The placement queue goes back to W1 (`place` answers `draining`; W1 requeues those turns in their runs).
    if (this.#queueHead() !== null) this.#d.scheduler.schedule({ id: POOL_RETRY_TASK, kind: POOL_RETRY_TASK, dueAtMs: now })
    return this.drainState()
  }

  /** Route 47. A drain past its expiry is cleared here. */
  drainState(): DrainState {
    const now = this.#d.now()
    let until = this.#flag('draining_until_ms')
    if (until !== null && until <= now) {
      this.#clearDrain()
      until = null
    }
    const counts = new Map(
      this.#d.sql.exec<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM turns WHERE state IN ('queued', 'starting', 'live', 'ending') GROUP BY state").toArray().map(r => [r.state, r.n]),
    )
    return {
      live: counts.get('live') ?? 0,
      starting: counts.get('starting') ?? 0,
      ending: counts.get('ending') ?? 0,
      queued: counts.get('queued') ?? 0,
      drainingUntilMs: until,
    }
  }

  /**
   * Route 48: runners `0 .. min(2, N) - 1` up on a container that answered `/protocol` with a shared version and
   * `/health` ok, newer than the container it had when the drain began (a Worker-only deploy rolls no container, so an
   * idle one from before is replaced; one still running turns keeps the drain on). Then the drain clears, the placement
   * queue starts and every live run advances. A drain asked again while the warm-up ran isn't cleared.
   */
  async warmup(): Promise<{ ok: true } | Refusal> {
    const until = this.#flag('draining_until_ms')
    const draining = this.#draining(this.#d.now())
    const names = Array.from({ length: Math.min(WARM_RUNNERS, this.#d.size) }, (_, i) => runnerName(i))
    const results = await Promise.all(
      names.map(async (n): Promise<WarmResult> => {
        const drainGen = draining ? this.#d.sql.exec<{ drain_gen: number | null }>('SELECT drain_gen FROM pool_runners WHERE runner = ?', n).one().drain_gen : null
        try {
          return await this.#d.runner(n).warm(drainGen)
        } catch (e) {
          return { ok: false, why: 'start', detail: e instanceof Error ? e.message : String(e) }
        }
      }),
    )
    let stale = false
    results.forEach((w, i) => {
      if (w.ok) {
        const before = this.#d.sql.exec<{ drain_gen: number | null }>('SELECT drain_gen FROM pool_runners WHERE runner = ?', names[i]).one().drain_gen
        if (draining && before !== null && w.gen <= before) stale = true
        this.#d.sql.exec("UPDATE pool_runners SET state = 'up', refused_until_ms = NULL, protocol = ?, container_gen = ? WHERE runner = ?", w.protocol, w.gen, names[i])
      } else if (w.why === 'protocol') this.#setState(names[i], 'protocol')
    })
    // A container from before the drain still running turns: the drain goes on.
    if (results.some(w => !w.ok && w.why === 'busy')) return { refused: { code: 'unavailable', reason: 'draining' } }
    if (results.some(w => !w.ok)) return { refused: { code: 'unavailable' } }
    // The container from before the drain still runs (the rollout hasn't replaced it): not the new generation yet.
    if (stale) return { refused: { code: 'unavailable', reason: 'draining' } }
    if (this.#flag('draining_until_ms') !== until) return { refused: { code: 'unavailable', reason: 'draining' } }
    const now = this.#d.now()
    this.#clearDrain()
    this.#d.sql.exec('UPDATE pool_runners SET drain_gen = NULL')
    if (this.#queueHead() !== null) this.#d.scheduler.schedule({ id: POOL_RETRY_TASK, kind: POOL_RETRY_TASK, dueAtMs: now })
    this.#advanceLiveRuns(now)
    return { ok: true }
  }

  #advanceLiveRuns(dueAtMs: number) {
    for (const { run_id } of this.#d.sql.exec<{ run_id: string }>("SELECT run_id FROM runs WHERE state = 'live' ORDER BY run_id").toArray()) {
      this.#d.scheduler.schedule({ id: `run-advance:${run_id}`, kind: 'run-advance', dueAtMs, payload: { runId: run_id } })
    }
  }

  // ---------- signals ----------

  health(): PoolHealth {
    const now = this.#d.now()
    const rows = this.#d.sql.exec<{ state: string; restarts_json: string }>(`SELECT state, restarts_json FROM pool_runners WHERE ${RUNNER_IDX} < ?`, this.#d.size).toArray()
    const protocol = rows.filter(r => r.state === 'protocol').length
    const restarting = rows.filter(r => (JSON.parse(r.restarts_json) as Restarts).exits.filter(t => t > now - HOUR_MS).length > RESTARTS_PER_HOUR).length
    const marks = new Map(this.#d.sql.exec<{ key: string; at_ms: number }>('SELECT key, at_ms FROM pool_marks').toArray().map(m => [m.key, m.at_ms]))
    const recent = (k: string) => (marks.get(k) ?? -Infinity) > now - SHORTFALL_WINDOW_MS
    const waiting = this.#d.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM pool_queue WHERE queued_at_ms < ?', now - SHORTFALL_WAIT_MS).one().n
    const shortfall = recent('shortfall') || recent('pool_full') || waiting > 0
    return {
      protocol: protocol === 0 ? { ok: true } : { ok: false, detail: `${protocol} runner(s) with no shared protocol version` },
      restarts: restarting === 0 ? { ok: true } : { ok: false, detail: `${restarting} runner(s) restarted more than ${RESTARTS_PER_HOUR} times in an hour` },
      shortfall: shortfall ? { ok: false, detail: `${waiting} turn(s) waiting over 30 s now; a wait over 30 s or a pool_full in 15 minutes` } : { ok: true },
    }
  }
}

/** The pool on the BrandAgent's parts and the Worker's Runner objects (the compose.ts anchor builds it). */
export function runnerPool(env: Pick<Env, 'RUNNER' | 'RUNNER_POOL'>, parts: Omit<PoolDeps, 'size' | 'runner'>): RunnerPool {
  return new RunnerPool({ ...parts, size: Number(env.RUNNER_POOL), runner: name => env.RUNNER.getByName(name) })
}
