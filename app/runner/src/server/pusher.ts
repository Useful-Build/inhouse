// Push delivery (protocol v2, P3 R3): the root posts one run's events to the Worker's egress (`POST /events/`, the
// run's token), so nothing holds a long request open. The rules (design section 1):
// - a batch goes when 20 events are queued, on a terminal event or `released`, or 250 ms after the first unsent event
//   (the linger), whichever comes first; with nothing sent for 30 s the run gets a `heartbeat` (before its terminal
//   event), so the Worker sees it alive through a silent tool call (orchestrator's decision, 2026-11-20);
// - one batch in flight per run: the next goes only after this one's ack, and a failed one is sent again unchanged
//   (backoff, without end while the run lives), so a resend can never overtake and look like a seq gap; events that
//   queued while a batch was in flight go in the next batch right after its ack;
// - the buffer (sent and unsent, unacked) is bounded: past `PUSH_BUFFER_MAX_BYTES` the root stops reading the session
//   (`onFull(true)`) until acks bring it back under; nothing is dropped and the run doesn't fail;
// - an ack with `stop: true` (the Worker fenced the run) stops the run, and the pusher goes on pushing everything after
//   it (the Worker keeps the checkpoint, mirror error, terminal event and `released`; skipping the rest would leave a
//   seq gap); a 410 (the run has ended at the Worker) drops the batch and everything after it.
// Once `released` is acked (or the Worker answered 410, or delivery has failed for `giveUpMs` after the run's release)
// the pusher is done.
import { PUSH_BATCH_MAX_EVENTS, PUSH_BUFFER_MAX_BYTES, PushAck, TERMINAL_EVENTS, jsonBytes, type PushBatch, type RunEvent } from '../../../shared/protocol/index.ts'
import { RUN_TOKEN_HEADER } from '../proxy/server.ts'

export const FLUSH_EVENTS = 20
/** How long the first unsent event waits for others before its batch goes. */
export const LINGER_MS = 250
/** Nothing sent for this long: a `heartbeat`. */
export const HEARTBEAT_MS = 30_000
/** One push's own deadline; past it the batch counts as failed and is sent again. */
export const PUSH_TIMEOUT_MS = 30_000
/** After the run's release, how long delivery may keep failing before the pusher gives up (the token is gone by then). */
export const GIVE_UP_AFTER_RELEASE_MS = 10 * 60_000
/** The wait before the n-th resend (from 0): 500 ms doubling, at most 15 s. */
export const backoffMs = (attempt: number) => Math.min(15_000, 500 * 2 ** Math.min(attempt, 10))

export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}
export const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  now: () => Date.now(),
}

export type PushFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>

export type Pusher = {
  /** Takes the run's next event (in seq order, as the stream stamps them). */
  push(event: RunEvent): void
  /** JSON bytes of the events not yet acked (in flight included). */
  bufferedBytes(): number
  /** The last seq pushed in, and the last the Worker acked (null before the first). */
  lastSeq(): number | null
  ackedSeq(): number | null
  /** Resolves once `released` is acked, the Worker answered 410, or delivery gave up. */
  readonly done: Promise<void>
  /** Stops for good (the container is going down). */
  close(): void
}

export function createPusher(opts: {
  runId: string
  token: string
  /** The egress base URL (`EGRESS_URL`). */
  egressUrl: string
  fetch: PushFetch
  timers?: Timers
  log: (entry: Record<string, unknown>) => void
  /** Asks the run's stream for a `heartbeat` event (it comes back through `push`). Not called after a terminal event. */
  heartbeat: () => void
  /** The Worker fenced the run (an ack with `stop: true`), once. */
  onStop: () => void
  /** The Worker answered 410: the run has ended there. */
  onGone: () => void
  /** The buffer went over its cap (true) or back under it (false). */
  onFull: (full: boolean) => void
  maxBytes?: number
  giveUpMs?: number
  /** The linger (`LINGER_MS`; tests may change it). */
  lingerMs?: number
  /** How long the run may go with nothing sent before a `heartbeat` (`HEARTBEAT_MS`). */
  heartbeatMs?: number
}): Pusher {
  const timers = opts.timers ?? realTimers
  const maxBytes = opts.maxBytes ?? PUSH_BUFFER_MAX_BYTES
  const url = `${opts.egressUrl.replace(/\/$/, '')}/events/`
  const pending: { event: RunEvent; bytes: number }[] = []
  let inFlight: { events: RunEvent[]; bytes: number; body: string } | null = null
  let bytes = 0
  let full = false
  /** The linger ran out (or an ack came) while events waited: they go at the next chance. */
  let due = false
  let terminalSeen = false
  let releasedSeen = false
  let releasedAt: number | null = null
  let finished = false
  let stopSent = false
  let last: number | null = null
  let acked: number | null = null
  let attempt = 0
  let linger: unknown = null
  let quiet: unknown = null
  let retry: unknown = null
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))

  const finish = (why: string) => {
    if (finished) return
    finished = true
    timers.clearTimeout(linger)
    timers.clearTimeout(quiet)
    timers.clearTimeout(retry)
    pending.length = 0
    inFlight = null
    bytes = 0
    if (full) {
      full = false
      opts.onFull(false)
    }
    if (why !== 'released') opts.log({ type: 'push_finished', runId: opts.runId, why })
    resolveDone()
  }

  /** The heartbeat clock: restarted at every send; when it runs out with nothing to send, a `heartbeat`. */
  const armQuiet = () => {
    timers.clearTimeout(quiet)
    quiet = timers.setTimeout(onQuiet, opts.heartbeatMs ?? HEARTBEAT_MS)
  }
  const onQuiet = () => {
    if (finished) return
    if (inFlight === null && pending.length === 0 && !terminalSeen) {
      opts.heartbeat()
      due = true
      trySend()
    }
    armQuiet()
  }
  /** The linger starts with the first event that waits unsent; it doesn't restart for later ones. */
  const armLinger = () => {
    if (linger !== null) return
    linger = timers.setTimeout(() => {
      linger = null
      due = true
      trySend()
    }, opts.lingerMs ?? LINGER_MS)
  }

  const shouldSend = () =>
    !finished &&
    inFlight === null &&
    pending.length > 0 &&
    (due || pending.length >= FLUSH_EVENTS || pending.some((p) => TERMINAL_EVENTS.has(p.event.type) || p.event.type === 'released'))

  function trySend() {
    if (!shouldSend()) return
    // At most 200 events, and at most the buffer's cap in event bytes (so the body stays under PUSH_BATCH_MAX_BYTES,
    // the egress's cap): the buffer itself can run past its cap (pausing is after the fact, and a stopping session is
    // read on), so a batch is cut by bytes too. One event always goes.
    let n = 0
    let sum = 0
    while (n < pending.length && n < PUSH_BATCH_MAX_EVENTS && (n === 0 || sum + pending[n]!.bytes <= PUSH_BUFFER_MAX_BYTES)) sum += pending[n++]!.bytes
    const take = pending.splice(0, n)
    const events = take.map((p) => p.event)
    const batch: PushBatch = { turnId: opts.runId, events }
    inFlight = { events, bytes: take.reduce((n, p) => n + p.bytes, 0), body: JSON.stringify(batch) }
    due = false
    timers.clearTimeout(linger)
    linger = null
    armQuiet()
    void send()
  }

  async function send() {
    const batch = inFlight
    if (batch === null || finished) return
    const lastOfBatch = batch.events.at(-1)!.seq
    const abort = new AbortController()
    const deadline = timers.setTimeout(() => abort.abort(), PUSH_TIMEOUT_MS)
    let outcome: { kind: 'acked'; stop: boolean } | { kind: 'gone' } | { kind: 'failed'; why: string }
    try {
      const res = await opts.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RUN_TOKEN_HEADER]: opts.token },
        body: batch.body,
        signal: abort.signal,
      })
      // Any answer but a 200 is read no further: its body is cancelled so the connection is freed.
      if (res.status !== 200) void res.body?.cancel().catch(() => undefined)
      if (res.status === 410) outcome = { kind: 'gone' }
      else if (res.status !== 200) outcome = { kind: 'failed', why: `status ${res.status}` }
      else {
        const ack = PushAck.safeParse(await res.json())
        if (!ack.success) outcome = { kind: 'failed', why: 'an ack that does not parse' }
        else if (ack.data.ackSeq < lastOfBatch) outcome = { kind: 'failed', why: `acked ${ack.data.ackSeq}, sent up to ${lastOfBatch}` }
        else outcome = { kind: 'acked', stop: ack.data.stop }
      }
    } catch (e) {
      outcome = { kind: 'failed', why: String(e instanceof Error ? e.message : e).slice(0, 200) }
    } finally {
      timers.clearTimeout(deadline)
    }
    if (finished || inFlight !== batch) return
    if (outcome.kind === 'gone') {
      opts.log({ type: 'push_gone', runId: opts.runId, seq: lastOfBatch })
      finish('gone')
      opts.onGone()
      return
    }
    if (outcome.kind === 'failed') {
      opts.log({ type: 'push_failed', runId: opts.runId, attempt, why: outcome.why })
      if (releasedAt !== null && timers.now() - releasedAt >= (opts.giveUpMs ?? GIVE_UP_AFTER_RELEASE_MS)) return finish('gave up after the release')
      retry = timers.setTimeout(() => void send(), backoffMs(attempt++))
      return
    }
    attempt = 0
    acked = lastOfBatch
    inFlight = null
    bytes -= batch.bytes
    if (full && bytes <= maxBytes) {
      full = false
      opts.onFull(false)
    }
    if (outcome.stop && !stopSent) {
      stopSent = true
      opts.onStop()
    }
    if (batch.events.some((e) => e.type === 'released')) return finish('released')
    // What queued while this batch was in flight goes now, without another linger.
    if (pending.length > 0) due = true
    trySend()
  }

  return {
    push(event) {
      if (finished || releasedSeen) return
      last = event.seq
      if (TERMINAL_EVENTS.has(event.type)) terminalSeen = true
      if (event.type === 'released') {
        releasedSeen = true
        releasedAt = timers.now()
      }
      const b = jsonBytes(event)
      pending.push({ event, bytes: b })
      bytes += b
      if (!full && bytes > maxBytes) {
        full = true
        opts.onFull(true)
      }
      if (quiet === null) armQuiet()
      trySend()
      if (pending.length > 0 && inFlight === null) armLinger()
    },
    bufferedBytes: () => bytes,
    lastSeq: () => last,
    ackedSeq: () => acked,
    done,
    close: () => finish('closed'),
  }
}
