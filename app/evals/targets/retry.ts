// Door reads that retry a transient error (#691): one network blip, 5xx, 429 or timeout must not end a 6-hour run.
// Rules:
//   - only reads retry (a D1 SELECT, an R2 list or get); a write that may have landed never does;
//   - only an error that is clearly transient retries (the caller's `transient` names it, or says no); an auth refusal,
//     a bad config, a cap or an answer that isn't JSON stops at once, as before;
//   - a bounded number of tries with backoff (DOOR_RETRY_DELAYS_MS), each retry reported through `onRetry` (the run's
//     report notes it); the reason is a fixed label, never the error's text (it can hold an account id or a host).

/** The waits before each retry: 3 retries, 4 tries in all, about 20 s of waiting at most. */
export const DOOR_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 15_000]

/** A transient failure seen inside a try: retried while tries are left, else its `final` error is thrown. */
export class TransientDoorError extends Error {
  override name = 'TransientDoorError'
  readonly reason: string
  readonly final: Error
  constructor(reason: string, final: Error) {
    super(final.message)
    this.reason = reason
    this.final = final
  }
}

export interface RetryOptions {
  /** Each retry, as one line for the report. Default: written to stderr, so a retry is never silent. */
  onRetry?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  delaysMs?: readonly number[]
}

/**
 * Runs `work` (told whether this is its last try) and retries it while it throws a TransientDoorError and tries are left.
 * Any other error, or a transient one on the last try (its `final` error), is thrown as it is.
 */
export async function withRetries<T>(what: string, work: (last: boolean) => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const delays = o.delaysMs ?? DOOR_RETRY_DELAYS_MS
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const onRetry = o.onRetry ?? ((line: string) => process.stderr.write(`${line}\n`))
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= delays.length
    try {
      return await work(last)
    } catch (e) {
      if (!(e instanceof TransientDoorError)) throw e
      if (last) throw e.final
      onRetry(`A door read was retried: ${what} (${e.reason}), try ${attempt + 2} of ${delays.length + 1}.`)
      await sleep(delays[attempt]!)
    }
  }
}
