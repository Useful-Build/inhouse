// The Watch soak's evidence (P8a K; master plan, "The Watch soak"). One record per UTC day, six checks. Everything here
// is plain data: `checks.ts` judges a day's evidence, `window.ts` keeps the running count, `collect.ts` reads a
// deployment's D1 (read-only) into the evidence, `run.ts` is the daily driver.

export const CHECK_NAMES = ['morning_check', 'bell_notices', 'memory', 'connector_reads', 'failed_runs', 'guards'] as const
export type CheckName = (typeof CHECK_NAMES)[number]

/**
 * - `clean`: present and as it should be.
 * - `unclean`: present and wrong.
 * - `missing`: the evidence for the day isn't there (no slot, no read, the facet couldn't be read, or the check was
 *   skipped for budget). Not clean.
 * - `pending`: the check can't be judged yet because a later phase's table doesn't exist (the P6a memory approval).
 *   Not clean.
 */
export type CheckStatus = 'clean' | 'unclean' | 'missing' | 'pending'

export interface CheckResult { status: CheckStatus; detail: string }
export type Checks = Record<CheckName, CheckResult>

/** The morning check's slots whose due time falls in the UTC day. */
export interface MorningFacet {
  slots: { state: string; kind: string; reason: string | null; failure: string | null; outcome: string | null }[]
}

/** The bell, against the day's failed routine slots. `expectedIds` are the notice ids a failed end must have written. */
export interface BellFacet {
  expectedIds: string[]
  /** Every `routine_failed` notice in the day. */
  failedNoticeIds: string[]
  /** `morning_check_found` notices in the day, against the morning check's ended slots (at most one each). */
  morningNotices: number
  morningEnded: number
}

export interface MemoryFacet {
  /** Chat-sourced person facts saved while their owner's "Learn from my chats" was off. */
  learnOffSaves: number
  /** Team facts saved active with no approval. `null` until P6a's approval shape exists (then the check is pending). */
  teamFactsUnapproved: number | null
}

export interface ConnectorFacet {
  /** Allowed connector read calls (`mcp__apps__*`) in the day. */
  readCalls: number
  /** Morning slots that ended `not_connected` or `incomplete`. */
  failedReads: number
}

export interface RunsFacet {
  /** Slots still claimed or started past their deadline. */
  stuck: number
}

export interface GuardFacet {
  /** Allowed WebFetch calls while the team's host list was empty (empty means no host at Watch). */
  webfetchBypass: number
  /** Notice or activity text carrying a canary-shaped string. */
  leaks: number
}

/** A facet is `null` when it couldn't be read: that's `missing`, never clean. */
export interface DayEvidence {
  day: string
  morning: MorningFacet | null
  bell: BellFacet | null
  memory: MemoryFacet | null
  connectors: ConnectorFacet | null
  runs: RunsFacet | null
  guards: GuardFacet | null
}

/** A house release marker: when it went live, whether it changed behaviour, and the phases live after it. */
export interface ReleaseMarker { tag: string; atMs: number; behaviour: boolean; live: string[] }

/** The phases that must all be live for a day to count (decision 3). */
export const REQUIRED_PHASES = ['P4', 'P5', 'P6a', 'P8a'] as const

export type DayVerdict = 'clean' | 'not_clean'
/** Why a day doesn't count, in the order the window checks them. */
export type DayReason = 'phases_not_live' | 'release' | 'bypass' | 'notice' | 'check'

export interface DayRecord {
  day: string
  checks: Checks
  verdict: DayVerdict
  /** Empty on a clean day. */
  reasons: DayReason[]
  /** Consecutive clean days up to and including this one. */
  count: number
  /** The release tags that started a new window on this day. */
  releases: string[]
  /** True once `count` has reached the gate with every required phase live. */
  passed: boolean
}
