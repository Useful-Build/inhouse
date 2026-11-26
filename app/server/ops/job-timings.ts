// The job timings a test may shorten (W0-B, N3): the names `timing(name, fallback)` from `@test-controls` reads, and
// the only names route 67's `setTimings` accepts (an unknown name is a 400, never silently ignored). A plain list, so
// the product build may hold it; the overrides themselves live only in the test build's controls.
// M1-B adds each new job timing here, in the same change that reads it.

export const JOB_TIMING_NAMES = [
  /** N3: the server cuts a turn this long after it starts (25 minutes). */
  'JOB_CUT_MS',
  /** N3: a job's hard end, measured from its root turn's start (8 hours). */
  'JOB_DEADLINE_MS',
  /** N3: a continuation refused for a wait (a drain, a full queue, a waiting chat) is tried again this long after (1 minute). */
  'JOB_RETRY_MS',
] as const

export type JobTimingName = (typeof JOB_TIMING_NAMES)[number]
