// The job engine (Stage 1 M1-B, N3 and N4): a person's chat turn that hit a per-turn limit (or the server's 25-minute
// cut) carries on as a chain of turns on the same SDK session, until it's done, out of budget, cancelled, stuck, failed
// or at its 8-hour cap. It lives inside the BrandAgent (core.ts calls it at each seam) and keeps everything in the
// object's SQLite, so a closed tab changes nothing and a reset or a killed container loses nothing:
// - the `jobs` row is the fence: a turn's outcome alone never starts a continuation; `gen` goes up at every end, and a
//   continuation submitted under an older one is refused `conflict` in `admit()`;
// - one `job-step:<jobId>:<n>` task per turn (one shared id would swallow a later end: `ensure` never replaces a
//   pending task); it acts only while the job runs and `n = pending_n`, judges the last turn's stored end once
//   (`judged_n`), then opens the job on the ledger (n = 1), re-reads the owner's membership and the turn settings from
//   D1, and submits the next turn (`job_<jobId>_<n>`, priority `next`, its end task `job-step:<jobId>:<n+1>`);
// - `job-deadline:<jobId>` at the 8-hour cap ends the job `time` and interrupts its live turn;
// - `endJob` is the one synchronous step that ends a job: `gen + 1`, the pending step and the deadline cancelled, one
//   `job.ended`, the job's unfinished turns fenced (or interrupted at the deadline), and `job-end:<jobId>`, the durable
//   retry of `closeJob` on the ledger and the one bell notice.
// Timings come through `timing(name, fallback)` (W0-B), so a test build can shorten them.
import { timing } from '@test-controls'
import type { ChatEvent, SendTurnResult } from '../../../../shared/contract/runs.ts'
import type { Job, JobOutcome } from '../../../../shared/contract/jobs.ts'
import type { Actor, OnEnd, Refusal, SubmitTurn, UsageLedgerPort } from '../ports.ts'
import type { DueTask, Scheduler, TaskResult } from '../scheduler.ts'
import { backoffMs } from '../scheduler.ts'
import { mapTaskMessage } from '../map-events.ts'
import type { TurnRow } from '../core.ts'
import { safeError } from '../../../safe-error.ts'
import { SYSTEM_MEMBER_ID } from '../../../db/ids.ts'
import { MAX_IDLE, MAX_INFRA_RETRIES, PERSON_MESSAGE_ENDS_JOB, idle, judge, promotable } from './rules.ts'
import type { EndCause } from './rules.ts'
import type { CutCause, JobDeps, JobRow, StoredProgress } from './types.ts'
import { jobNoticeId } from './notice.ts'

export const JOB_CUT_DEFAULT_MS = 25 * 60_000
export const JOB_DEADLINE_DEFAULT_MS = 8 * 60 * 60_000
/** A continuation refused for a wait (a drain, a full queue, a chat waiting on a question) is tried again this often. */
export const JOB_RETRY_DEFAULT_MS = 60_000
/** Running helper ids kept per job (the count's bound; more is a runaway the runner's own cap already refuses). */
const MAX_RUNNING_KEPT = 64

export const jobCutMs = (): number => timing('JOB_CUT_MS', JOB_CUT_DEFAULT_MS)
export const jobDeadlineMs = (): number => timing('JOB_DEADLINE_MS', JOB_DEADLINE_DEFAULT_MS)
export const jobRetryMs = (): number => timing('JOB_RETRY_MS', JOB_RETRY_DEFAULT_MS)
export const stepTaskId = (jobId: string, n: number): string => `job-step:${jobId}:${n}`
export const deadlineTaskId = (jobId: string): string => `job-deadline:${jobId}`
export const endTaskId = (jobId: string): string => `job-end:${jobId}`
export const jobTurnKey = (jobId: string, n: number): string => `job_${jobId}_${n}`
export const STEP_KIND = 'job-step'

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** `j_` + 128 random bits (JobIdSchema). */
export const newJobId = (): string => `j_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`

/** What a continuation's submit carries into `admit()`. */
export interface JobSubmit { jobId: string; gen: number; n: number }

/** The engine's parts in the BrandAgent (core.ts implements them). */
export interface JobHost {
  sql: SqlStorage
  scheduler: Scheduler
  now(): number
  usage: UsageLedgerPort
  turn(turnId: string): TurnRow | null
  /** Stores a chat event in the chat's live run (else its newest run). */
  emitChat(chatId: string, event: ChatEvent): void
  /** The fence with `stopped` (core.ts `fence`). */
  stop(t: TurnRow): void
  /** Asks a live turn to interrupt (core.ts `askInterrupt`). */
  askInterrupt(t: TurnRow): void
  /** The chat's live run: its next turn or its end. */
  advanceChat(chatId: string): void
  /** The in-object submit (core.ts `submitTurn`) with the end task and the job's fence. */
  submit(t: SubmitTurn, extra: { onEnd: OnEnd; job: JobSubmit }): Promise<SendTurnResult | Refusal>
  /** Whether the brand is paused now. */
  paused(): boolean
  /** Gives up the chat's question wait, if it waits (core.ts `abandonWait`). */
  abandonWait(chatId: string, failure: string): void
  /** The turn whose question the chat waits on, or null when it doesn't wait. */
  waitingTurn(chatId: string): string | null
  /** Route 27 marked the chat deleted (and no restore since). */
  chatDeleted(chatId: string): boolean
  /** The member is in the object's removed set. */
  memberRemoved(memberId: string): boolean
  /** These turns' cost from the tally, in micro-USD (closed calls at their price, open ones at their worst). */
  turnsMicro(turnIds: string[]): number
}

const refuse = (code: Refusal['refused']['code'], reason?: Refusal['refused']['reason']): Refusal =>
  ({ refused: reason === undefined ? { code } : { code, reason } })
const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const money = (micro: number) => ({ minor: Math.round(micro / 10_000), currency: 'USD' })
const ACTIVE_JOB_TURN = "state IN ('queued', 'starting', 'live') OR (state = 'ending' AND outcome IS NULL AND held_json IS NOT NULL)"

export class JobEngine {
  private deps: JobDeps | null = null
  private readonly h: JobHost
  constructor(host: JobHost) { this.h = host }

  /** index.ts wires the real ports once per object; tests wire fakes. */
  setDeps(d: JobDeps | null): void { this.deps = d }

  // ---------- reads ----------

  job(jobId: string): JobRow | null {
    return this.h.sql.exec<JobRow>('SELECT * FROM jobs WHERE job_id = ?', jobId).toArray()[0] ?? null
  }
  /** The chat's job that hasn't ended, if any (at most one). */
  liveJobOf(chatId: string): JobRow | null {
    return this.h.sql.exec<JobRow>("SELECT * FROM jobs WHERE chat_id = ? AND state != 'ended'", chatId).toArray()[0] ?? null
  }
  /** A running job keeps its chat's run live between its turns (its events stay on one run). */
  keepsRunLive(chatId: string): boolean {
    return this.h.sql.exec("SELECT 1 FROM jobs WHERE chat_id = ? AND state = 'running' LIMIT 1", chatId).toArray().length > 0
  }
  private turnsOf(jobId: string): TurnRow[] {
    return this.h.sql.exec<TurnRow>('SELECT * FROM turns WHERE job_id = ? ORDER BY created_at_ms, ord', jobId).toArray()
  }

  /** The chat's newest job as the contract shows it (`GET /api/chats/:id/job`), or null. */
  chatJob(chatId: string): Job | null {
    const j = this.h.sql.exec<JobRow>('SELECT * FROM jobs WHERE chat_id = ? ORDER BY started_at_ms DESC, rowid DESC LIMIT 1', chatId).toArray()[0]
    return j ? this.view(j) : null
  }
  jobOwner(jobId: string): string | null { return this.job(jobId)?.owner_id ?? null }

  view(j: JobRow): Job {
    const p = j.progress_json === null ? null : JSON.parse(j.progress_json) as StoredProgress
    return {
      jobId: j.job_id, chatId: j.chat_id, rootTurnId: j.root_turn_id, state: j.state, outcome: j.outcome,
      startedAt: instant(j.started_at_ms), deadlineAt: instant(j.deadline_ms),
      endedAt: j.ended_at_ms === null ? null : instant(j.ended_at_ms),
      progress: p === null ? null : { label: p.label, helpers: p.running.length },
      cost: j.cost_micro === null ? null : money(j.cost_micro),
    }
  }

  // ---------- the turn seams (core.ts) ----------

  /**
   * In `storeFinal`'s synchronous step: a person's turn that qualifies becomes a job (N3). `job.started` goes on the
   * turn's run, the first step is ensured now and the deadline task at the cap.
   */
  promoteIfDue(t: TurnRow): void {
    const cs = this.h.sql.exec<{ session: string }>('SELECT session FROM chat_state WHERE chat_id = ?', t.chat_id).toArray()[0]
    const personQueued = this.h.sql.exec("SELECT 1 FROM turns WHERE run_id = ? AND state = 'queued' AND source = 'person' LIMIT 1", t.run_id).toArray().length > 0
    const ok = promotable(t, {
      textsWired: this.deps?.texts != null, session: cs?.session ?? null, personQueued, jobLive: this.liveJobOf(t.chat_id) !== null, paused: this.h.paused(),
      deleted: this.h.chatDeleted(t.chat_id), ownerRemoved: this.h.memberRemoved(t.owner_id),
    })
    if (!ok || t.owner_id === SYSTEM_MEMBER_ID) return
    const now = this.h.now()
    const started = t.started_at_ms ?? t.created_at_ms
    const deadline = started + jobDeadlineMs()
    if (now >= deadline) return
    const jobId = newJobId()
    this.h.sql.exec(
      `INSERT INTO jobs (job_id, chat_id, owner_id, root_turn_id, last_turn_id, state, gen, pending_n, judged_n, next_kind,
        opened, started_at_ms, deadline_ms, infra_retries, idle_steps, result_sent)
        VALUES (?, ?, ?, ?, ?, 'running', 0, 1, 0, 'carry', 0, ?, ?, 0, 0, 0)`,
      jobId, t.chat_id, t.owner_id, t.turn_id, t.turn_id, started, deadline)
    this.h.sql.exec('UPDATE turns SET job_id = ?, job_n = 0 WHERE turn_id = ?', jobId, t.turn_id)
    this.h.emitChat(t.chat_id, { type: 'job.started', jobId, rootTurnId: t.turn_id })
    this.h.scheduler.ensure({ id: stepTaskId(jobId, 1), kind: STEP_KIND, dueAtMs: now })
    this.h.scheduler.ensure({ id: deadlineTaskId(jobId), kind: 'job-deadline', dueAtMs: deadline })
  }

  /** `admit()`'s fence for a continuation, in its synchronous step: the job runs, at this gen and step, before its cap. */
  admitRefusal(j: JobSubmit, chatId: string): Refusal | null {
    const job = this.job(j.jobId)
    if (!job || job.chat_id !== chatId || job.state !== 'running' || job.gen !== j.gen || job.pending_n !== j.n || this.h.now() >= job.deadline_ms) {
      return refuse('conflict')
    }
    return null
  }
  /** The continuation was admitted (same synchronous step): it is the job's turn `n`; the next step is `n + 1`. */
  admitted(j: JobSubmit, turnId: string): void {
    this.h.sql.exec('UPDATE turns SET job_id = ?, job_n = ? WHERE turn_id = ?', j.jobId, j.n, turnId)
    this.h.sql.exec('UPDATE jobs SET pending_n = ?, last_turn_id = ? WHERE job_id = ?', j.n + 1, turnId, j.jobId)
  }

  /** A job turn ended deferred on a question (its end task waits for the resume turn): the job waits. */
  parked(onEnd: OnEnd): void {
    const jobId = this.jobOfStep(onEnd)
    if (jobId !== null) this.h.sql.exec("UPDATE jobs SET state = 'waiting' WHERE job_id = ? AND state = 'running'", jobId)
  }
  /**
   * The question's resume took the job's end task over (in `admit()`'s step): the resume is the job's turn in the parked
   * turn's place (its hold names the job, its cost counts, Cancel and the cap reach it, a crash recovers it), the job's
   * last turn, and the job runs again. An ended job stays ended and its resume is no job turn.
   */
  resumed(onEnd: OnEnd, turnId: string, parkedJobN: number | null): void {
    const jobId = this.jobOfStep(onEnd)
    if (jobId === null) return
    const job = this.job(jobId)
    if (!job || job.state === 'ended') return
    this.h.sql.exec('UPDATE turns SET job_id = ?, job_n = ? WHERE turn_id = ?', jobId, parkedJobN, turnId)
    this.h.sql.exec("UPDATE jobs SET state = 'running', last_turn_id = ? WHERE job_id = ?", turnId, jobId)
  }

  /** A person's own message in the chat (route 29, in `admit()`'s step): Q4 = B leaves the job running. */
  personMessage(chatId: string): void {
    if (PERSON_MESSAGE_ENDS_JOB) this.endWhere('chat_id = ?', [chatId], 'taken_over')
  }
  private jobOfStep(onEnd: OnEnd): string | null {
    if (onEnd.kind !== STEP_KIND) return null
    const m = /^job-step:(j_[A-Za-z0-9_-]{22}):\d+$/.exec(onEnd.id)
    return m ? m[1] : null
  }

  /** Whether the turn's job has ended (false for a turn of no job). */
  endedJob(jobId: string | null): boolean {
    return jobId !== null && this.job(jobId)?.state === 'ended'
  }
  /** The chat waits on a question of this job's own turn. */
  private waitsOn(job: JobRow): boolean {
    const turnId = this.h.waitingTurn(job.chat_id)
    return turnId !== null && this.h.turn(turnId)?.job_id === job.job_id
  }

  /** A job turn may start only while its job runs and before its cap; past the cap the job ends `time` here. */
  mayStart(jobId: string): boolean {
    const job = this.job(jobId)
    if (!job || job.state !== 'running') return false
    if (this.h.now() >= job.deadline_ms) {
      this.endJob(jobId, 'time')
      return false
    }
    return true
  }

  /** When the server cuts this live turn (N3: every person's turn and every job turn, never a routine's), or null. */
  cutAt(t: TurnRow): number | null {
    // Off until jobs are on (M1-P wires the texts): a cut with nothing to carry on would only end the turn early.
    if (this.deps?.texts == null) return null
    if (t.owner_id === SYSTEM_MEMBER_ID || t.fenced === 1 || t.started_at_ms === null || t.state !== 'live') return null
    if (t.cut_cause !== null && t.interrupt_asked === 1) return null
    return t.started_at_ms + jobCutMs()
  }
  /** The server's cut: the cause written in the same step that asks the interrupt (asked again if a send failed). */
  cut(t: TurnRow, cause: CutCause): void {
    this.h.sql.exec('UPDATE turns SET cut_cause = COALESCE(cut_cause, ?) WHERE turn_id = ?', cause, t.turn_id)
    if (t.interrupt_asked === 0) this.h.askInterrupt(this.h.turn(t.turn_id)!)
  }

  /**
   * A person stopped or interrupted a turn (N3): marked in the same step, so a race with the server's cut never carries
   * the job on (and a root turn never becomes one); a turn of a live job cancels the job. `spare`: the turn the
   * person's own action is ending (an interrupt), left to it.
   */
  personStopped(t: TurnRow, spare: boolean): void {
    this.h.sql.exec('UPDATE turns SET person_stop = 1 WHERE turn_id = ?', t.turn_id)
    if (t.job_id !== null) this.endJob(t.job_id, 'cancelled', spare ? t.turn_id : undefined)
  }

  /** `POST /api/jobs/:id/cancel` (the chat's owner only): one synchronous step; an ended job answers as it is. */
  cancel(jobId: string, by: Actor): { job: Job } | Refusal {
    const job = this.job(jobId)
    if (!job || job.owner_id !== by.memberId) return refuse('not_found')
    if (job.state !== 'ended') {
      this.h.sql.exec(`UPDATE turns SET person_stop = 1 WHERE job_id = ? AND (${ACTIVE_JOB_TURN})`, jobId)
      this.endJob(jobId, 'cancelled')
    }
    return { job: this.view(this.job(jobId)!) }
  }

  /** Ends every job that hasn't ended and matches `where` (a pause, a removed owner, deleted chats, a session reset). */
  endWhere(where: string, args: SqlStorageValue[], outcome: JobOutcome): void {
    const ids = this.h.sql.exec<{ job_id: string }>(`SELECT job_id FROM jobs WHERE state != 'ended' AND (${where})`, ...args).toArray()
    for (const r of ids) this.endJob(r.job_id, outcome)
  }

  /** A job turn's SDK task message: the job's progress, stored and shown (N3). */
  progress(t: TurnRow, message: Record<string, unknown>, truncated: boolean): void {
    if (t.job_id === null) return
    const m = mapTaskMessage(message, truncated)
    if (m === null) return
    const job = this.job(t.job_id)
    if (!job || job.state === 'ended') return
    const p: StoredProgress = job.progress_json === null ? { label: '', running: [] } : JSON.parse(job.progress_json) as StoredProgress
    if (m.kind === 'started' && m.helper && !p.running.includes(m.taskId) && p.running.length < MAX_RUNNING_KEPT) p.running.push(m.taskId)
    if (m.kind === 'ended') p.running = p.running.filter(id => id !== m.taskId)
    if (m.kind !== 'progress' || p.running.includes(m.taskId) || p.running.length === 0) p.label = m.label
    this.h.sql.exec('UPDATE jobs SET progress_json = ? WHERE job_id = ?', JSON.stringify(p), job.job_id)
    this.h.emitChat(job.chat_id, { type: 'job.progress', jobId: job.job_id, label: p.label, helpers: p.running.length })
  }

  // ---------- the end ----------

  /**
   * THE one synchronous step that ends a job: the row (gen + 1, the outcome, its cost from the tally), the pending
   * step and the deadline cancelled, one `job.ended`, the job's unfinished turns ended (at the deadline a live one is
   * interrupted with `cut_cause = 'job_deadline'`, else fenced `stopped`; `spare` is left to its own end), a waiting
   * job's question closed (on every end, not only at the deadline), `job-end` for the ledger and the notice, then the
   * chat's run. Once per job.
   */
  endJob(jobId: string, outcome: JobOutcome, spare?: string, cause?: EndCause): boolean {
    const job = this.job(jobId)
    if (!job || job.state === 'ended') return false
    const now = this.h.now()
    const turns = this.turnsOf(jobId)
    const cost = this.h.turnsMicro(turns.map(t => t.turn_id))
    const changed = this.h.sql.exec(
      "UPDATE jobs SET state = 'ended', outcome = ?, gen = gen + 1, ended_at_ms = ?, cost_micro = ?, end_cause = ? WHERE job_id = ? AND state != 'ended'",
      outcome, now, cost, cause ?? null, jobId).rowsWritten
    if (changed === 0) return false
    this.h.scheduler.cancel(stepTaskId(jobId, job.pending_n))
    this.h.scheduler.cancel(deadlineTaskId(jobId))
    this.h.emitChat(job.chat_id, { type: 'job.ended', jobId, outcome, durationMs: Math.max(0, now - job.started_at_ms), cost: money(cost) })
    for (const t0 of turns) {
      if (t0.turn_id === spare) continue
      const t = this.h.turn(t0.turn_id)
      if (!t || t.fenced === 1) continue
      const held = t.state === 'ending' && t.outcome === null && t.held_json !== null
      if (!(t.state === 'queued' || t.state === 'starting' || t.state === 'live' || held)) continue
      if (outcome === 'time' && t.state === 'live') this.cut(t, 'job_deadline')
      else this.h.stop(t)
    }
    // The job's question closes with it, whatever ended it and whatever the job's state said (its deferred turn may sit
    // between its checkpoint and `released`): a later answer can't resume an ended job, and the chat takes messages again.
    if (this.waitsOn(job)) this.h.abandonWait(job.chat_id, `job_${outcome}`)
    this.h.scheduler.ensure({ id: endTaskId(jobId), kind: 'job-end', dueAtMs: now })
    this.h.advanceChat(job.chat_id)
    return true
  }

  // ---------- the tasks ----------

  /** `job-step:<jobId>:<n>`: judge the last turn's end (once), then the next continuation (N3's handler order). */
  async step(task: DueTask, attempts: number): Promise<TaskResult> {
    const m = /^job-step:(j_[A-Za-z0-9_-]{22}):(\d+)$/.exec(task.id)
    if (!m) throw new Error(`job-step: bad task id ${task.id}`)
    const jobId = m[1]
    const n = Number(m[2])
    let job = this.job(jobId)
    // A waiting job's end task fired with no wait left: the wait was given up outside the engine (a delete, a reset,
    // damage, a refused resume), so the job can't go on.
    if (job && job.state === 'waiting' && job.pending_n === n && !this.waitsOn(job)) {
      this.endJob(jobId, 'cancelled')
      return { done: true }
    }
    if (!job || job.state !== 'running' || job.pending_n !== n) return { done: true }
    const deps = this.deps
    if (deps === null) return { retryAtMs: this.h.now() + backoffMs(attempts), error: 'no job ports' }
    if (deps.texts === null) {
      this.endJob(jobId, 'failed')
      return { done: true }
    }
    if (job.judged_n < n) {
      const judged = this.judgeLast(job, n)
      if (judged === 'ended') return { done: true }
      // The turn this step follows isn't final yet (a reordered task): looked at again shortly, never dropped.
      if (judged === 'wait') return { retryAtMs: this.h.now() + jobRetryMs(), error: 'turn_not_final' }
    }
    job = this.job(jobId)!
    if (this.h.now() >= job.deadline_ms) {
      this.endJob(jobId, 'time')
      return { done: true }
    }
    const gen = job.gen
    const stale = () => { const j = this.job(jobId); return !j || j.state !== 'running' || j.gen !== gen || j.pending_n !== n }
    // 1. The ledger's job (all-in: it seeds from the root turn). Idempotent by job id.
    if (job.opened === 0) {
      try {
        await this.h.usage.openJob({ jobId, rootTurnId: job.root_turn_id, nowMs: this.h.now() })
      } catch (err) {
        console.error({ event: 'job_open_failed', jobId, error: safeError(err) })
        return { retryAtMs: this.h.now() + backoffMs(attempts), error: 'open_job' }
      }
      if (stale()) return { done: true }
      this.h.sql.exec('UPDATE jobs SET opened = 1 WHERE job_id = ?', jobId)
    }
    // 2. Authority again: the owner in D1 now, and the turn settings (the model may be off, the web switches changed).
    const root = this.h.turn(job.root_turn_id)
    if (!root) throw new Error(`job-step: the root turn of ${jobId} is gone`)
    let active: boolean
    let settings: Awaited<ReturnType<JobDeps['settings']>>
    try {
      active = await deps.memberActive(job.owner_id)
      settings = active ? await deps.settings(root.picker_id) : { refused: 'invalid' }
    } catch (err) {
      console.error({ event: 'job_authority_read_failed', jobId, error: safeError(err) })
      return { retryAtMs: this.h.now() + backoffMs(attempts), error: 'authority_read' }
    }
    if (stale()) return { done: true }
    if (!active) {
      this.endJob(jobId, 'cancelled')
      return { done: true }
    }
    if ('refused' in settings) {
      this.endJob(jobId, 'failed')
      return { done: true }
    }
    // 3. The continuation.
    const fresh = this.job(jobId)!
    const text = fresh.next_kind === 'cut' ? deps.texts.afterCutOff(n) : deps.texts.carryOn(n)
    const turn: SubmitTurn = {
      chatId: job.chat_id, by: { kind: 'person', memberId: job.owner_id },
      model: settings.model, pickerId: settings.pickerId, effort: settings.effort, sideModel: settings.sideModel,
      maxTurns: settings.maxTurns, webFetchDomains: settings.webFetchDomains, webSearch: settings.webSearch,
      subagentModel: settings.subagentModel,
      input: { clientTurnKey: jobTurnKey(jobId, n), text, priority: 'next', model: settings.pickerId, attachments: [] },
    }
    const answer = await this.h.submit(turn, { onEnd: { kind: STEP_KIND, id: stepTaskId(jobId, n + 1) }, job: { jobId, gen, n } })
    if (!('refused' in answer)) return { done: true }
    return this.refused(jobId, gen, n, answer)
  }

  /** N3's refused continuation. A wait is tried again (a fresh schedule, never counted toward quarantine), bounded by the cap. */
  private refused(jobId: string, gen: number, n: number, r: Refusal): TaskResult {
    const job = this.job(jobId)
    if (!job || job.state !== 'running' || job.gen !== gen) return { done: true }
    const { code, reason } = r.refused
    const wait = (code === 'unavailable' && reason === 'draining') || (code === 'rate_limited' && reason === 'queue_full')
      || (code === 'conflict' && reason === 'waiting_answer')
    if (wait) {
      const at = Math.min(this.h.now() + jobRetryMs(), job.deadline_ms)
      this.h.scheduler.schedule({ id: stepTaskId(jobId, n), kind: STEP_KIND, dueAtMs: at })
      return { done: true }
    }
    if (code === 'conflict' && reason === undefined) return { done: true }
    const outcome: JobOutcome = (code === 'forbidden' && (reason === 'paused' || reason === 'removed')) || code === 'not_found' ? 'cancelled' : 'failed'
    this.endJob(jobId, outcome)
    return { done: true }
  }

  /**
   * The last turn's stored end, judged once per step (`judged_n`), in one synchronous step: `go`, `ended` (it ended the
   * job) or `wait` (that turn isn't final yet). A turn that deferred and was resumed is judged by its resume (the resume
   * inherits the end task).
   */
  private judgeLast(job: JobRow, n: number): 'go' | 'ended' | 'wait' {
    if (n === 1) {
      this.h.sql.exec("UPDATE jobs SET judged_n = 1, next_kind = 'carry' WHERE job_id = ?", job.job_id)
      return 'go'
    }
    let t = this.h.turn(job.last_turn_id)
    for (let i = 0; t && i < 50; i++) {
      const resume = this.h.sql.exec<TurnRow>('SELECT * FROM turns WHERE chat_id = ? AND client_key = ?', t.chat_id, `resume_q_${t.turn_id.slice(2)}`).toArray()[0]
      if (!resume) break
      t = resume
    }
    if (!t) throw new Error(`job-step: the last turn of ${job.job_id} is gone`)
    if (t.state !== 'ended' && t.state !== 'cancelled') return 'wait'
    if (this.h.now() >= job.deadline_ms) {
      this.endJob(job.job_id, 'time')
      return 'ended'
    }
    const v = judge(t)
    if (v === 'done' || typeof v === 'object') {
      if (v === 'done') this.endJob(job.job_id, 'done')
      else this.endJob(job.job_id, v.end, undefined, v.cause)
      return 'ended'
    }
    if (v === 'carry') {
      const quiet = idle(t)
      const idleSteps = quiet === null ? job.idle_steps : quiet ? job.idle_steps + 1 : 0
      if (idleSteps >= MAX_IDLE) {
        this.endJob(job.job_id, 'stuck')
        return 'ended'
      }
      this.h.sql.exec("UPDATE jobs SET judged_n = ?, next_kind = 'carry', idle_steps = ?, infra_retries = 0 WHERE job_id = ?", n, idleSteps, job.job_id)
      return 'go'
    }
    if (v === 'retry') {
      if (job.infra_retries + 1 > MAX_INFRA_RETRIES) {
        this.endJob(job.job_id, 'failed')
        return 'ended'
      }
      this.h.sql.exec("UPDATE jobs SET judged_n = ?, next_kind = 'cut', infra_retries = infra_retries + 1 WHERE job_id = ?", n, job.job_id)
      return 'go'
    }
    // `again`: the turn never ran; the same text once more.
    this.h.sql.exec('UPDATE jobs SET judged_n = ? WHERE job_id = ?', n, job.job_id)
    return 'go'
  }

  /** `job-deadline:<jobId>`: the 8-hour cap, a fence on a live or waiting job (N3). */
  deadline(task: DueTask): TaskResult {
    const jobId = task.id.slice('job-deadline:'.length)
    const job = this.job(jobId)
    if (!job || job.state === 'ended') return { done: true }
    if (this.h.now() < job.deadline_ms) {
      this.h.scheduler.schedule({ id: task.id, kind: 'job-deadline', dueAtMs: job.deadline_ms })
      return { done: true }
    }
    this.endJob(jobId, 'time')
    return { done: true }
  }

  /** `job-end:<jobId>`: `closeJob` on the ledger, then the one bell notice; retried until both answered. */
  async end(task: DueTask, attempts: number): Promise<TaskResult> {
    const jobId = task.id.slice('job-end:'.length)
    const job = this.job(jobId)
    if (!job || job.state !== 'ended' || job.result_sent === 1) return { done: true }
    if (this.deps === null) return { retryAtMs: this.h.now() + backoffMs(attempts), error: 'no job ports' }
    try {
      await this.h.usage.closeJob(jobId)
      await this.deps.notify({ id: jobNoticeId(jobId), jobId, chatId: job.chat_id, ownerId: job.owner_id, outcome: job.outcome!, cause: job.end_cause === 'month_cap' ? 'month_cap' : null, atMs: job.ended_at_ms! })
    } catch (err) {
      console.error({ event: 'job_end_failed', jobId, error: safeError(err) })
      return { retryAtMs: this.h.now() + backoffMs(attempts), error: 'job_end' }
    }
    this.h.sql.exec('UPDATE jobs SET result_sent = 1 WHERE job_id = ?', jobId)
    return { done: true }
  }

  /** After a reset: every live job has its deadline task and every ended one not yet told its `job-end` (ensure). */
  seeds(): void {
    const now = this.h.now()
    for (const j of this.h.sql.exec<{ job_id: string; deadline_ms: number }>("SELECT job_id, deadline_ms FROM jobs WHERE state != 'ended'").toArray()) {
      this.h.scheduler.ensure({ id: deadlineTaskId(j.job_id), kind: 'job-deadline', dueAtMs: j.deadline_ms })
    }
    for (const j of this.h.sql.exec<{ job_id: string }>("SELECT job_id FROM jobs WHERE state = 'ended' AND result_sent = 0").toArray()) {
      this.h.scheduler.ensure({ id: endTaskId(j.job_id), kind: 'job-end', dueAtMs: now })
    }
  }
}
