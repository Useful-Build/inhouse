// The Watch soak's evidence (P8a K; master plan, "The Watch soak"). One record per UTC day, six checks. Everything here
// is plain data: `checks.ts` judges a day's evidence, `window.ts` keeps the running count, `collect.ts` reads a
// deployment's D1 (read-only) into the evidence, `run.ts` is the daily driver.

export const CHECK_NAMES = ['morning_check', 'bell_notices', 'memory', 'connector_reads', 'failed_runs', 'guards'] as const
export type CheckName = (typeof CHECK_NAMES)[number]

/**
 * - `clean`: present and as it should be.
 * - `unclean`: present and wrong.
 * - `missing`: the evidence for the day isn't there (no slot, no read, the facet couldn't be read, the check was
 *   skipped for budget, or what was read could not have shown a failure: a leak scan with no planted canary, an
 *   allowed WebFetch with no host recorded). Not clean.
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
  /** Each morning check slot that ended in the day: the items it saved and the `morning_check_found` notices that are its own. */
  morning: { items: number; notices: number }[]
  /** `morning_check_found` notices in the day that belong to no ended slot of the day. */
  strayMorningNotices: number
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
  /** Every routine slot due in the day, any state. Zero on a day the morning check should run is not clean. */
  slots: number
  /** The product's own "failed" (routines/signal.ts): an end with a failure other than not_connected, lost, refused as internal, a system routine missed. */
  failed: number
  /** Failed slots with no ok slot of the same routine after them by the cut-off. */
  unrecovered: number
  /** Claimed past their deadline, or started with no end past the 8-day backstop. */
  stuck: number
}

export interface GuardFacet {
  /**
   * WebFetch calls in the day that were allowed and not refused by the WebFetch hook. `tool_calls` records no host, so
   * their destinations can't be judged: any makes the check missing.
   */
  webfetchAllowed: number
  /** Notice or activity text carrying a canary: the planted ones when `--canary` is given, else any canary-shaped string. */
  leaks: number
  /** `shape`: no canary was planted, so the scan could not have found a leak of house data and the check is missing. */
  canary: 'planted' | 'shape'
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

/** A house release marker (releases.ts): when it went live, the app SHA, whether it changed behaviour, and every phase live after it. */
export interface ReleaseMarker { appSha: string; atMs: number; behaviour: boolean; live: string[] }

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
  /** The phases live on this day (the latest release at or before its start). */
  live: string[]
  /** Consecutive clean days up to and including this one. */
  count: number
  /** The app SHAs of the behaviour releases that started a new window on this day. */
  releases: string[]
  /** True once `count` has reached the gate with every required phase live. */
  passed: boolean
}
