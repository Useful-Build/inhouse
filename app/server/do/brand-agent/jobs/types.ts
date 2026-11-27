// The job engine's types (Stage 1 M1-B, N3): the `jobs` row, the ports the engine runs on (`JobDeps`, built in
// compose.ts, faked in test-kit.ts) and the texts port M1-P fills. While `texts` is null no turn is ever promoted.
import type { JobOutcome } from '../../../../shared/contract/jobs.ts'
import type { Effort } from '../../../../shared/contract/common.ts'

/** The server's own continuation texts (N3, N20), M1-P's. `afterCutOff` follows a turn that was cut off (N4). */
export interface JobTexts {
  carryOn(n: number): string
  afterCutOff(n: number): string
}

/** What a continuation runs with: route 29's resolution, read again for every continuation (authority, N3). */
export interface JobTurnSettings {
  model: string
  pickerId: string
  effort: Effort
  sideModel: string
  maxTurns: number
  /** A list, or null for any public host (open mode, M3-F). */
  webFetchDomains: string[] | null
  webSearch: boolean
  /** The helpers' model (N6, M1-P): read again with the rest, so a continuation gets the helpers its root had. */
  subagentModel: string
}

/** A job's one bell notice (N3: bell only, no Slack), keyed by the job so a repeat is one row. */
export interface JobNotice {
  /** The notice's id: one per job. */
  id: string
  jobId: string
  chatId: string
  ownerId: string
  outcome: JobOutcome
  /** `month_cap`: a `budget` end caused by the brand's monthly cap, not the job's own budget. */
  cause: 'month_cap' | null
  atMs: number
}

export interface JobDeps {
  /** Null until M1-P wires the texts: no turn becomes a job. */
  texts: JobTexts | null
  /** The owner is an active member, read from D1 now (not only the removed-member cache). Throws when D1 can't answer. */
  memberActive(memberId: string): Promise<boolean>
  /** Route 29's settings for the root turn's picker id, read now. Throws when D1 can't answer. */
  settings(pickerId: string): Promise<JobTurnSettings | { refused: 'model_off' | 'invalid' }>
  /** Writes the job's bell notice, idempotent by `id`. Throws when D1 can't answer. */
  notify(n: JobNotice): Promise<void>
}

export type JobState = 'running' | 'waiting' | 'ended'

/** `turns.cut_cause`: the server's own interrupt of a live turn (N3). `message`: a person's `now` message (Q4 = B). */
export type CutCause = 'job_cut' | 'job_deadline' | 'message'

/** The `jobs` row (N3). The row is the fence: a turn's outcome alone never starts a continuation. */
export interface JobRow {
  [k: string]: SqlStorageValue
  job_id: string
  chat_id: string
  owner_id: string
  root_turn_id: string
  /** The turn the next step judges (the root, then each continuation). */
  last_turn_id: string
  state: JobState
  outcome: JobOutcome | null
  /** Raised by every end: a continuation submitted under an older gen is refused `conflict`. */
  gen: number
  /** The `n` of the one `job-step:<jobId>:<n>` that may act. */
  pending_n: number
  /** The step whose judgement of the last turn is stored (a retried step never judges twice). */
  judged_n: number
  /** The next continuation's text: `carry` (carryOn) or `cut` (afterCutOff). */
  next_kind: 'carry' | 'cut'
  /** The ledger's `openJob` answered. */
  opened: number
  started_at_ms: number
  deadline_ms: number
  infra_retries: number
  idle_steps: number
  progress_json: string | null
  ended_at_ms: number | null
  cost_micro: number | null
  /** `closeJob` and the notice are done (the `job-end` task). */
  result_sent: number
  /** Why a `budget` end happened: `month_cap` (the brand's monthly cap), else null (the job's own budget). */
  end_cause: string | null
}

/** `jobs.progress_json`: the last label and the helpers running now (task ids, for the count). */
export interface StoredProgress { label: string; running: string[] }
