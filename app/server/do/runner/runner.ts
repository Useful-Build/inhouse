// The Runner object's logic (p3-design sections 1 and 7), written against a container port so the Workers test pool
// can drive it without a container: index.ts hands it the real `ctx.container`. Every container start registers the
// intercepts (in order: `egress.internal`, HTTPS `*`, then every other HTTP host), starts the container with no
// Internet, sets the inactivity timeout, watches it with `monitor()` (an exit is reported once per generation) and
// negotiates the protocol. A restarted object that finds its container running only re-arms the timeout and the
// monitor (the intercepts belong to the container, and live until it stops).
//
// Docs (read 2026-11-20): Container API, https://developers.cloudflare.com/durable-objects/api/container/ (`start()`
// returns before the container is ready; `setInactivityTimeout()` is unset after a restart, "set it again after start()
// or in the constructor if the container is running"; "The monitor() promise does not survive a Durable Object restart.
// If running is true on startup, call monitor() again"; "Intercepts last until the container stops. Register them again
// for each new container"; hostname intercepts before the catch-all). DO lifecycle,
// https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ (an operation keeps the object
// in memory for at most 15 minutes, so nothing here waits on a long read: the runner pushes, and every push touches).
import {
  ACCEPTED_VERSIONS, ErrorBody, Health, PROTOCOL_HEADER, ProtocolInfo, RunRefusal, RunStatus, negotiateVersion,
  type RunRefusalCode, type RunStart,
} from '../../../shared/protocol/index.ts'
import type { RunnerTurnStatus } from '../brand-agent/ports.ts'

export const RUNNER_PORT = 8080
export const PROXY_PORT = 8081
export const EGRESS_HOST = 'egress.internal'
/** How long the container outlives an inactive object; every push's `touch()` re-arms it. */
export const INACTIVITY_MS = 10 * 60_000
/** `admit`'s own bound: the fetch is aborted, so no admission can land after it (a timeout is `ambiguous`). */
export const ADMIT_TIMEOUT_MS = 15_000
/** `status`, `interrupt`, `stop` and the warm-up's calls. */
export const CALL_TIMEOUT_MS = 10_000
/**
 * How long a new container has to answer `/protocol` (one deadline over the whole start) before it's a placement error.
 * Above a measured cold start (56 s to over 60 s on the sandbox, 2026-11-21, when 60 s here ended the first sends) and
 * under the BrandAgent's `STARTING_DEADLINE_MS` (3 min, brand-agent/core.ts), the starting turn's own deadline.
 */
export const BOOT_TIMEOUT_MS = 150_000
export const BOOT_POLL_MS = 250

/** The only props an intercept gets: never a token, a chat or a member (design 7). */
export interface EgressProps {
  runner: string
  containerGen: number
}

/** What the Runner uses of `ctx.container` (the real one satisfies it; the tests pass a fake). */
export interface ContainerPort<B> {
  readonly running: boolean
  start(options: { enableInternet: boolean; env: Record<string, string> }): void
  setInactivityTimeout(durationMs: number): Promise<void>
  monitor(): Promise<void>
  interceptOutboundHttp(addr: string, binding: B): Promise<void>
  interceptOutboundHttps(addr: string, binding: B): Promise<void>
  interceptAllOutboundHttp(binding: B): Promise<void>
  getTcpPort(port: number): { fetch(input: string, init?: RequestInit): Promise<Response> }
  destroy(): Promise<void>
}

/** The Runner's own durable numbers (its SQLite): the container generation, its negotiated version, the last exit reported. */
export interface RunnerState {
  gen(): number
  setGen(gen: number): void
  /** The version negotiated with generation `gen`: a number, `null` for no shared version, `undefined` when not asked yet. */
  protocol(gen: number): number | null | undefined
  setProtocol(gen: number, version: number | null | undefined): void
  exitReported(): number
  setExitReported(gen: number): void
}

export interface RunnerDeps<B> {
  name: string
  container: ContainerPort<B>
  state: RunnerState
  bindings: { egress(props: EgressProps): B; web(props: EgressProps): B; deny(props: EgressProps): B }
  /** Tells the BrandAgent the container of generation `gen` exited (`containerExited`). */
  exited(runner: string, gen: number): Promise<void>
  /** The versions this Worker speaks (the protocol's own list; a test injects another). */
  accepted?: readonly number[]
  timeout?(ms: number): AbortSignal
  wait?(ms: number): Promise<void>
  log?(entry: Record<string, unknown>): void
}

/**
 * `admit`'s answer. Only a typed answer from the runner is definite; anything it didn't type may follow an admission.
 * - `refused`: the runner's typed refusals (`503 session_pool_exhausted|session_folder_parked`, `409 chat_live|run_live`;
 *   a 409 with no readable body is `chat_live`);
 * - `protocol`: no shared version, or a 426;
 * - `placementError`: the container never answered `/protocol` (it didn't start, stopped, or the boot deadline passed);
 *   `booting`: it's still running (the deadline passed on a slow start), so a later admission joins that start;
 * - `rejected`: a typed 4xx (`ErrorBody`): the runner refused this turn's start (a bad body, too large);
 * - `unavailable`: a typed 5xx (`ErrorBody`: stopping, a session user it couldn't set up): the runner states it didn't
 *   admit (its 202 goes out at admission, so a 5xx from it comes before one);
 * - `ambiguous`: no answer (a network error, the 15 s abort), an untyped 5xx (a proxy's 502 or 504, a bare 500), or any other
 *   answer the runner didn't type (a 2xx other than 202, a 3xx, a 4xx without `ErrorBody`).
 */
export type AdmitResult =
  | { accepted: true; gen: number; protocol: number }
  | { refused: RunRefusalCode; gen: number }
  | { protocol: 'none'; gen: number }
  | { placementError: string; booting: boolean }
  | { rejected: number; gen: number }
  | { unavailable: string; gen: number }
  | { ambiguous: true; gen: number }

export interface StatusResult {
  state: RunnerTurnStatus
  /** The container isn't running: the generation the turn ran on is gone. */
  containerGone: boolean
}

export type WarmResult = { ok: true; gen: number; protocol: number } | { ok: false; why: 'protocol' | 'health' | 'start' | 'busy'; detail: string }

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200)

export class RunnerCore<B> {
  readonly #d: RunnerDeps<B>
  readonly #accepted: readonly number[]
  readonly #timeout: (ms: number) => AbortSignal
  readonly #wait: (ms: number) => Promise<void>
  readonly #log: (entry: Record<string, unknown>) => void
  /** This object instance has a pending `monitor()` (it doesn't survive a restart). */
  #monitoring = false
  #booting: Promise<{ gen: number; protocol: number | null }> | undefined

  constructor(deps: RunnerDeps<B>) {
    this.#d = deps
    this.#accepted = deps.accepted ?? ACCEPTED_VERSIONS
    this.#timeout = deps.timeout ?? (ms => AbortSignal.timeout(ms))
    this.#wait = deps.wait ?? (ms => scheduler.wait(ms))
    this.#log = deps.log ?? (entry => console.log(JSON.stringify({ runner: deps.name, ...entry })))
  }

  /** An egress push arrived: keep the container (and re-arm the monitor after an object restart). Never starts one. */
  async touch(): Promise<void> {
    const c = this.#d.container
    if (!c.running) return
    await c.setInactivityTimeout(INACTIVITY_MS)
    if (!this.#monitoring) this.#watch(this.#d.state.gen())
  }

  async admit(rs: RunStart): Promise<AdmitResult> {
    let up: { gen: number; protocol: number | null }
    try {
      up = await this.#up()
    } catch (e) {
      return { placementError: errorText(e), booting: this.#d.container.running }
    }
    if (up.protocol === null) return { protocol: 'none', gen: up.gen }
    const { gen } = up
    let res: Response
    try {
      res = await this.#port().fetch(`http://runner/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PROTOCOL_HEADER]: String(up.protocol) },
        body: JSON.stringify(rs),
        signal: this.#timeout(ADMIT_TIMEOUT_MS),
      })
    } catch (e) {
      this.#log({ event: 'admit_ambiguous', turnId: rs.runId, error: errorText(e) })
      return { ambiguous: true, gen }
    }
    // The status decides: an answer came, so it's definite. The body is only read to tell the refusals apart.
    if (res.status === 202) {
      await res.body?.cancel()
      return { accepted: true, gen, protocol: up.protocol }
    }
    if (res.status === 426) {
      await res.body?.cancel()
      this.#d.state.setProtocol(gen, null)
      return { protocol: 'none', gen }
    }
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // An unreadable body: untyped.
    }
    const refusal = RunRefusal.safeParse(body)
    if (refusal.success) return { refused: refusal.data.error, gen }
    // The runner's 409s are only "this chat / this run is live here"; a bare one is the chat's (never admitted).
    if (res.status === 409) return { refused: 'chat_live', gen }
    const typed = ErrorBody.safeParse(body).success
    if (typed && res.status >= 400 && res.status < 500) return { rejected: res.status, gen }
    if (typed && res.status >= 500 && res.status < 600) return { unavailable: (body as ErrorBody).error.slice(0, 200), gen }
    this.#log({ event: 'admit_ambiguous', turnId: rs.runId, status: res.status })
    return { ambiguous: true, gen }
  }

  /** The runner's `GET /runs/:id`; `unreachable` only when the call failed. Never starts a container. */
  async status(turnId: string): Promise<StatusResult> {
    if (!this.#d.container.running) return { state: 'unreachable', containerGone: true }
    try {
      const up = await this.#up()
      if (up.protocol === null) return { state: 'unreachable', containerGone: false }
      const res = await this.#port().fetch(`http://runner/runs/${encodeURIComponent(turnId)}`, {
        headers: { [PROTOCOL_HEADER]: String(up.protocol) },
        signal: this.#timeout(CALL_TIMEOUT_MS),
      })
      if (res.status !== 200) {
        await res.body?.cancel()
        return { state: 'unreachable', containerGone: !this.#d.container.running }
      }
      const parsed = RunStatus.parse(await res.json())
      const state: RunnerTurnStatus =
        parsed.state === 'released' ? 'ended' : parsed.state === 'unknown' ? 'unknown' : 'live'
      return { state, containerGone: false }
    } catch (e) {
      this.#log({ event: 'status_failed', turnId, error: errorText(e) })
      return { state: 'unreachable', containerGone: !this.#d.container.running }
    }
  }

  interrupt(turnId: string): Promise<void> {
    return this.#action(turnId, 'interrupt')
  }

  stop(turnId: string): Promise<void> {
    return this.#action(turnId, 'stop')
  }

  /**
   * Warm-up (route 48): the container up, a fresh `/protocol` with a shared version, then `/health` ok on it.
   * `newerThan`: the generation the container had when the drain began. A Worker-only deploy rolls no container, so an
   * equal or older one is replaced here when it runs nothing (`/health` live 0); while it runs turns: `busy`.
   */
  async warm(newerThan: number | null = null): Promise<WarmResult> {
    let up: { gen: number; protocol: number | null }
    try {
      up = await this.#up()
      if (newerThan !== null && up.gen <= newerThan) {
        const live = await this.#live(up.protocol)
        if (live > 0) return { ok: false, why: 'busy', detail: `${live} run(s) on the container from before the drain` }
        await this.#d.container.destroy()
        if (this.#d.container.running) return { ok: false, why: 'start', detail: 'the container from before the drain is still running' }
        await this.#reportExit(up.gen, 'replaced at warm-up')
        up = await this.#up()
      }
      // Asked again on this generation even when it was negotiated earlier: warm-up proves the container as it is now.
      this.#d.state.setProtocol(up.gen, undefined)
      up = { gen: up.gen, protocol: await this.#negotiate(up.gen, true) }
    } catch (e) {
      return { ok: false, why: 'start', detail: errorText(e) }
    }
    if (up.protocol === null) return { ok: false, why: 'protocol', detail: 'no shared protocol version' }
    try {
      const res = await this.#port().fetch('http://runner/health', { signal: this.#timeout(CALL_TIMEOUT_MS) })
      if (res.status !== 200) {
        await res.body?.cancel()
        return { ok: false, why: 'health', detail: `health answered ${res.status}` }
      }
      const health = Health.parse(await res.json())
      if (!health.ok) return { ok: false, why: 'health', detail: 'health not ok' }
      return { ok: true, gen: up.gen, protocol: up.protocol }
    } catch (e) {
      return { ok: false, why: 'health', detail: errorText(e) }
    }
  }

  /** The runner's live runs, from `/health`. */
  async #live(protocol: number | null): Promise<number> {
    if (protocol === null) throw new Error('no shared protocol version with the runner')
    const res = await this.#port().fetch('http://runner/health', { signal: this.#timeout(CALL_TIMEOUT_MS) })
    if (res.status !== 200) {
      await res.body?.cancel()
      throw new Error(`health answered ${res.status}`)
    }
    return Health.parse(await res.json()).live
  }

  async #action(turnId: string, action: 'interrupt' | 'stop'): Promise<void> {
    // No container: nothing runs there to interrupt or stop.
    if (!this.#d.container.running) return
    const up = await this.#up()
    if (up.protocol === null) throw new Error(`${action}: no shared protocol version with the runner`)
    const res = await this.#port().fetch(`http://runner/runs/${encodeURIComponent(turnId)}/${action}`, {
      method: 'POST',
      headers: { [PROTOCOL_HEADER]: String(up.protocol) },
      signal: this.#timeout(CALL_TIMEOUT_MS),
    })
    await res.body?.cancel()
    // 404: the runner doesn't know the run (it ended): nothing left to do.
    if (res.status !== 202 && res.status !== 404) throw new Error(`${action}: the runner answered ${res.status}`)
  }

  #port() {
    return this.#d.container.getTcpPort(RUNNER_PORT)
  }

  /** The container running with a negotiated version; one start at a time. */
  #up(): Promise<{ gen: number; protocol: number | null }> {
    return (this.#booting ??= this.#boot().finally(() => (this.#booting = undefined)))
  }

  async #boot(): Promise<{ gen: number; protocol: number | null }> {
    const c = this.#d.container
    const s = this.#d.state
    if (c.running) {
      const gen = s.gen()
      if (!this.#monitoring) {
        // A restarted object: the container (and its intercepts) carried on; the timeout and the monitor didn't.
        await c.setInactivityTimeout(INACTIVITY_MS)
        this.#watch(gen)
      }
      const known = s.protocol(gen)
      return { gen, protocol: known === undefined ? await this.#negotiate(gen) : known }
    }
    // The last container exited while this object wasn't watching it (evicted, or restarted): report that first.
    if (s.gen() > 0) await this.#reportExit(s.gen(), 'exited while the object was away')
    const gen = s.gen() + 1
    s.setGen(gen)
    const props: EgressProps = { runner: this.#d.name, containerGen: gen }
    await c.interceptOutboundHttp(EGRESS_HOST, this.#d.bindings.egress(props))
    await c.interceptOutboundHttps('*', this.#d.bindings.web(props))
    await c.interceptAllOutboundHttp(this.#d.bindings.deny(props))
    c.start({
      enableInternet: false,
      env: { EGRESS_URL: `http://${EGRESS_HOST}`, PORT: String(RUNNER_PORT), PROXY_PORT: String(PROXY_PORT) },
    })
    await c.setInactivityTimeout(INACTIVITY_MS)
    this.#watch(gen)
    this.#log({ event: 'container_started', gen })
    return { gen, protocol: await this.#negotiate(gen) }
  }

  /**
   * `GET /protocol` until it answers (a new container takes a moment), within one deadline over the whole start;
   * `once`: a single try (warm-up). Stores and returns the shared version.
   */
  async #negotiate(gen: number, once = false): Promise<number | null> {
    const deadline = this.#timeout(BOOT_TIMEOUT_MS)
    let last: unknown = 'no answer'
    for (;;) {
      if (deadline.aborted) throw new Error(`no /protocol answer within ${BOOT_TIMEOUT_MS} ms: ${errorText(last)}`)
      if (!this.#d.container.running) throw new Error('the container stopped before it answered /protocol')
      try {
        const res = await this.#port().fetch('http://runner/protocol', { signal: AbortSignal.any([deadline, this.#timeout(CALL_TIMEOUT_MS)]) })
        if (res.status === 200) {
          const version = negotiateVersion(ProtocolInfo.parse(await res.json()), this.#accepted)
          this.#d.state.setProtocol(gen, version)
          if (version === null) this.#log({ event: 'protocol_mismatch', gen })
          return version
        }
        await res.body?.cancel()
        last = `protocol answered ${res.status}`
      } catch (e) {
        last = e
      }
      if (once) throw new Error(`no /protocol answer: ${errorText(last)}`)
      if (!deadline.aborted) await this.#wait(BOOT_POLL_MS)
    }
  }

  /** Watches the container of generation `gen`; its exit (either way the promise settles) is reported once per generation. */
  #watch(gen: number) {
    this.#monitoring = true
    const exited = (how: unknown) => {
      if (this.#d.state.gen() === gen) this.#monitoring = false
      void this.#reportExit(gen, how)
    }
    this.#d.container.monitor().then(() => exited('exit 0'), exited)
  }

  async #reportExit(gen: number, how: unknown) {
    const s = this.#d.state
    if (s.exitReported() >= gen) return
    s.setExitReported(gen)
    if (s.gen() === gen) s.setProtocol(gen, undefined)
    this.#log({ event: 'container_exited', gen, how: errorText(how) })
    try {
      await this.#d.exited(this.#d.name, gen)
    } catch (e) {
      // The BrandAgent's turn-watch still finds the turns (status: unreachable with the container gone).
      this.#log({ event: 'container_exit_report_failed', gen, error: errorText(e) })
    }
  }
}

/** RunnerState over the object's SQLite (one small key-value table). */
export function sqlRunnerState(sql: SqlStorage): RunnerState {
  sql.exec('CREATE TABLE IF NOT EXISTS runner_state (key TEXT PRIMARY KEY, value INTEGER)')
  const get = (key: string): number | null | undefined => {
    const row = sql.exec<{ value: number | null }>('SELECT value FROM runner_state WHERE key = ?', key).toArray()[0]
    return row === undefined ? undefined : row.value
  }
  const set = (key: string, value: number | null) =>
    sql.exec('INSERT INTO runner_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  const del = (key: string) => sql.exec('DELETE FROM runner_state WHERE key = ?', key)
  return {
    gen: () => get('gen') ?? 0,
    setGen: gen => set('gen', gen),
    protocol: gen => get(`protocol:${gen}`),
    setProtocol: (gen, version) => {
      // Only the current generation's answer is kept.
      sql.exec("DELETE FROM runner_state WHERE key LIKE 'protocol:%' AND key != ?", `protocol:${gen}`)
      if (version === undefined) del(`protocol:${gen}`)
      else set(`protocol:${gen}`, version)
    },
    exitReported: () => get('exit_reported') ?? 0,
    setExitReported: gen => set('exit_reported', gen),
  }
}
