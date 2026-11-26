// The job engine's rules (M1-B, N3, N4) as pure functions over stored rows: which turn becomes a job, what a job turn's
// end means for its job, which crashed job turn keeps its session (spike variant A), and what a person's message does
// to a running job (Wasim's Q4 = B: the agent answers, the job carries on). No storage here: engine.ts applies them.
import type { JobOutcome } from '../../../../shared/contract/jobs.ts'
import type { CutCause } from './types.ts'

/** The turn's end as stored, what the rules read. */
export interface TurnEnd {
  outcome: string | null
  failure: string | null
  cancel_why: string | null
  cut_cause: string | null
  person_stop: number
  abandoned: string | null
  steps_n: number
  parts_n: number
}

/**
 * A job turn's end, for its job (N3's table):
 * - `done`: the job ends `done`;
 * - `carry`: it carries on (a per-turn limit, or the server's cut), counted by the no-progress guard;
 * - `retry`: an infrastructure end, retried from the last checkpoint (N4), at most 3 in a row;
 * - `again`: the turn never ran for a passing reason (`budget_busy`, `pool_full`): tried again, not counted;
 * - `{ end }`: the job ends with that outcome.
 */
export type Verdict = 'done' | 'carry' | 'retry' | 'again' | { end: JobOutcome; cause?: EndCause }

/** Why a job ended `budget`: the brand's monthly cap, not the job's own budget (the notice says which to raise). */
export type EndCause = 'month_cap'

const CARRY = new Set(['max_turns', 'turn_budget'])
const RETRY = new Set(['session_crashed', 'protocol', 'store', 'unknown'])
const BUDGET = new Set(['cap_reached', 'job_budget'])
const AGAIN = new Set(['budget_busy', 'pool_full'])
/** The server's interrupts that carry the job on (a deadline cut ended the job before it asked). */
const CARRYING_CUTS = new Set<string>(['job_cut', 'message'] satisfies CutCause[])

const budgetEnd = (code: string): Verdict => (code === 'cap_reached' ? { end: 'budget', cause: 'month_cap' } : { end: 'budget' })

export function judge(t: TurnEnd): Verdict {
  // A person's stop or interrupt cancels the job, whatever the turn's own end (it may race the server's cut).
  if (t.person_stop === 1) return { end: 'cancelled' }
  // A deferred turn whose wait was given up: its result is never delivered.
  if (t.abandoned !== null) return { end: 'cancelled' }
  // A turn cancelled before it ran is stored with no outcome, only its `cancel_why` (core.ts `storeFinal`).
  switch (t.outcome ?? 'cancelled') {
    case 'done': return 'done'
    case 'interrupted':
      if (t.cut_cause === 'job_deadline') return { end: 'time' }
      return t.cut_cause !== null && CARRYING_CUTS.has(t.cut_cause) ? 'carry' : { end: 'cancelled' }
    case 'stopped': return { end: 'cancelled' }
    case 'failed': {
      const f = t.failure ?? 'unknown'
      if (CARRY.has(f)) return 'carry'
      // The runner's 30-minute hard stop or the 45-minute backstop after a cut: retried. Inactivity (no cut): failed.
      if (f === 'timeout') return t.cut_cause !== null ? 'retry' : { end: 'failed' }
      if (RETRY.has(f)) return 'retry'
      if (BUDGET.has(f)) return budgetEnd(f)
      if (AGAIN.has(f)) return 'again'
      return { end: 'failed' }
    }
    case 'cancelled': {
      const why = t.cancel_why
      if (why !== null && BUDGET.has(why)) return budgetEnd(why)
      if (why === 'pool_full') return 'again'
      if (why === 'session_unusable') return { end: 'failed' }
      return { end: 'cancelled' }
    }
    default: return { end: 'failed' }
  }
}

/**
 * A continuation that made no new step and no new part (the no-progress guard). A turn cut by a person's `now` message
 * (Q4 = B) never counts: two quick messages mustn't end a job `stuck`; `null` leaves the count as it is.
 */
export const idle = (t: Pick<TurnEnd, 'steps_n' | 'parts_n' | 'cut_cause'>): boolean | null =>
  t.cut_cause === 'message' ? null : t.steps_n === 0 && t.parts_n === 0
/** Two idle continuations in a row end the job `stuck`. */
export const MAX_IDLE = 2
/** Infrastructure retries in a row before the job ends `failed` (N3). */
export const MAX_INFRA_RETRIES = 3

/** What `promotable` reads besides the turn. */
export interface PromoteFacts {
  /** The texts port is wired (M1-P). */
  textsWired: boolean
  /** The chat's session after this turn's end. */
  session: string | null
  /** A person's turn is queued in the same run. */
  personQueued: boolean
  /** The chat has a job that hasn't ended. */
  jobLive: boolean
  /** The brand is paused now: Pause ends every job, so none starts while it holds. */
  paused: boolean
  /** Route 27 marked the chat deleted. */
  deleted: boolean
  /** The turn's owner is in the object's removed set. */
  ownerRemoved: boolean
}

/**
 * Whether a turn becomes a job (N3), read inside `storeFinal`'s synchronous step: a person's own turn (route 29; a
 * job's own turns are already in one, routine turns never become jobs in M1) that ended on a per-turn limit or the
 * server's cut, not stopped by its person, not fenced by a pause, a removal or a delete (on an `ending` turn, or one
 * fenced already, the fence keeps the outcome and writes `cancel_why`, core.ts `fence`), the brand not paused, the chat
 * not deleted, its owner not removed, its session resumable after it, no person's turn queued behind it, and no other job
 * alive in the chat.
 */
export function promotable(t: TurnEnd & { source: string | null; job_id: string | null }, f: PromoteFacts): boolean {
  if (!f.textsWired || f.paused || f.deleted || f.ownerRemoved || t.source !== 'person' || t.job_id !== null || t.person_stop === 1 || t.cancel_why !== null) return false
  const limit = t.outcome === 'failed' && (t.failure === 'max_turns' || t.failure === 'turn_budget')
  const cut = t.outcome === 'interrupted' && t.cut_cause === 'job_cut'
  return (limit || cut) && f.session === 'resumable' && !f.personQueued && !f.jobLive
}

/** What the recover rule reads (N4, spike variant A). */
export interface RecoverFacts {
  /** The checkpoint the turn's start resumed from (`RunStart.expect`), or null for a fresh session. */
  expect: { mainEntries: number } | null
  /** The chat's stored session now, before this turn's end changes it. */
  session: string | null
  sessionId: string | null
  checkpointMainEntries: number | null
  /** The turn's own run token is fully closed (closed in the same step, before the rule reads it). */
  tokensClosed: boolean
}

/**
 * N4 with the spike's variant A: a job turn that crashed after its query ran and before any checkpoint keeps the
 * chat `resumable` at the checkpoint it started from, on either crash path (fenced with the grace over, or ended
 * unfenced through `terminal()`: `endTurn` runs only once the attempt is over on both). Everything else is `damaged`
 * as before: a turn with a mirror error (the tail may have a gap), a non-job turn, a turn that started a fresh session,
 * a failure outside the retry class.
 */
export function recoverable(
  t: { job_id: string | null; session_id: string | null; query_ran: number; saw_checkpoint: number; mirror_error: number; outcome: string | null; failure: string | null; cut_cause: string | null },
  f: RecoverFacts,
): boolean {
  if (t.job_id === null || t.query_ran !== 1 || t.saw_checkpoint !== 0 || t.mirror_error !== 0 || !f.tokensClosed) return false
  if (f.expect === null || f.expect.mainEntries < 1) return false
  if (f.session !== 'resumable' || f.sessionId === null || f.sessionId !== t.session_id) return false
  if (f.checkpointMainEntries !== f.expect.mainEntries) return false
  // An end with no outcome yet is stored `failed protocol` by `endTurn` (a release without a terminal event).
  if (t.outcome !== null && t.outcome !== 'failed') return false
  const failure = t.outcome === null ? 'protocol' : (t.failure ?? 'unknown')
  return RETRY.has(failure) || (failure === 'timeout' && t.cut_cause !== null)
}

/**
 * Wasim's Q4 = B (2026-11-26): a person's message in a job's chat never ends the job. The agent answers it in its own
 * turn, then the job carries on; only Cancel stops it. M1-I would change this one line.
 */
export const PERSON_MESSAGE_ENDS_JOB = false
