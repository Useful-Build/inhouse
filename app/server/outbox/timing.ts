// The outbox's fixed times (N11). Read them through `timing()`, never as literals, so a test sees the same numbers the
// code uses.

const TIMING = Object.freeze({
  /** Undo works this long after an approval; the send may start once it's over (`send_at_ms`). */
  holdMs: 10_000,
  /** An approved row still unclaimed this long after `send_at_ms` lost its task: the sweep schedules it again. */
  lostTaskMs: 30_000,
  /** The longest the dispatcher waits for the hub's answer. Past it the result is unclear: "Needs a check". */
  hubTimeoutMs: 15_000,
  /** A row still `sending` this long after its claim is unclear: the sweep moves it to "Needs a check". */
  staleSendingMs: 60_000,
  /** An unanswered card expires after this long. */
  expiresMs: 7 * 86_400_000,
  /**
   * An approval not claimed this long after it was given lapses back to waiting (the orchestrator's cap), whether its
   * send task is late, in backoff or quarantined: an OK is for now, not for whenever.
   */
  approvalMaxAgeMs: 10 * 60_000,
  /** The sweep runs this often. */
  sweepEveryMs: 60_000,
})

export type OutboxTiming = typeof TIMING

export const timing = (): OutboxTiming => TIMING
