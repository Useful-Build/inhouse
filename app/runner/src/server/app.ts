// The root runner's HTTP server for the Worker (port 8080) and its table of live runs. It owns every run token, in
// memory only, keyed by run id and the session's uid; the token goes to the loopback proxy and nowhere else (never
// over the local channel, never into a session's env, argv or files). It never imports the Agent SDK.
import type { ChildProcess } from 'node:child_process'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import {
  ACCEPTED_VERSIONS,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  RUN_REFUSAL_STATUS,
  RUN_START_MAX_BYTES,
  RunStart,
  type AuditEntry,
  type AuditPost,
  type ErrorBody,
  type Health,
  type ProtocolInfo,
  type RunAdmission,
  type RunRefusal,
  type RunStatus,
  acceptsVersion,
} from '../../../shared/protocol/index.ts'
import { z } from 'zod'
import { monotonicMs, type RunConfig } from '../protocol/local.ts'
import { RUN_TOKEN_HEADER } from '../proxy/server.ts'
import { sessionEnv } from '../session/env.ts'
import type { SessionUser, SessionUsers } from '../session/seam.ts'
import { createPusher, realTimers, type PushFetch, type Pusher, type Timers } from './pusher.ts'
import { RunStream } from './run-stream.ts'
import { hostSession, type SessionHandle, type SpawnSession } from './session-host.ts'
import { safeError } from '../safe-error.ts'

type CheckpointState = { mainEntries: number; lastUuid: string | null; lastUuidIndex: number | null }

type LiveRun = {
  runId: string
  chatId: string
  /** The session's uid, once allocated. */
  uid: number | null
  /** Dropped as soon as the session has exited; the run stays listed until `release()` has settled. */
  token: string | null
  handle: SessionHandle | null
  /** A stop or interrupt that came before the session was spawned: applied once it is. */
  stopRequested: boolean
  interruptRequested: boolean
  /** The Worker answered 410: the run has ended there, nothing more is pushed. */
  gone: boolean
  /** The push buffer is over its cap: the session isn't read until it drains. */
  full: boolean
  stream: RunStream | null
  pusher: Pusher | null
  /** The session said it was about to call `query()`. */
  queryRan: boolean
  /** The last store result the session reported (a checkpoint's state, or null for a mirror error). */
  checkpoint: CheckpointState | null
  /** The audit entries posted so far (the next one's `n`). */
  audits: number
}

export type RootDeps = {
  users: SessionUsers
  spawnSession: SpawnSession
  proxyPort: number
  /** The Worker's egress base URL: the root posts each run's events (`/events/`) and audit entries (`/audit/`) there. */
  egressUrl: string
  /** The root's own calls to the egress (never through the session proxy). */
  fetch: PushFetch
  timers?: Timers
  /** The push linger (250 ms; tests may change it). */
  pushLingerMs?: number
  /** How long a run may go with nothing pushed before a heartbeat (30 s; tests set it apart from the flush). */
  pushHeartbeatMs?: number
  /** The intercept CA's path for the sessions (the entrypoint's NODE_EXTRA_CA_CERTS), when there is one. */
  extraCaCerts?: string
  /** The push buffer's cap (tests shrink it). */
  pushMaxBytes?: number
  /** After a stop (or a run's end) the session gets this long to exit before its process group is killed. */
  stopGraceMs: number
  /** A run still going after this long ends with `timeout`. */
  runTimeoutMs: number
  memory: () => Health['memory']
  /**
   * Whether a connection to this API may be served. Production refuses a peer that is a local process not owned by
   * root (a session user's Bash), from the kernel's socket tables (src/proxy/proc-net.ts).
   */
  apiPeerAllowed: (socket: Socket) => Promise<boolean>
  log: (entry: Record<string, unknown>) => void
}

export type Root = {
  server: http.Server
  /**
   * The live run's token for a session uid; null when there's none, or more than one (never guess). For the `files`
   * route, null too once the run's terminal event has gone out.
   */
  tokenForUid(uid: number, route?: string): string | null
  liveCount(): number
  /**
   * JSON bytes of a run's events not yet acked by the egress; null for no such run. Bounded by backpressure: past the
   * push buffer's cap the session's channel isn't read.
   */
  bufferedBytes(runId: string): number | null
  /** The SIGTERM path: refuses new runs (503), stops every run, starting ones included, and resolves once each has ended and its `released` went out (or the grace ran out). */
  stopAll(): Promise<void>
}

/** The token of the one run on `uid`; null for none, or for more than one. */
export function pickToken(runs: Iterable<{ uid: number | null; token: string | null }>, uid: number): string | null {
  const found = [...runs].filter((r) => r.uid === uid)
  return found.length === 1 ? found[0]!.token : null
}

/** Open connections the API takes at once (the Worker's calls); past it new ones are dropped by Node. */
export const API_MAX_CONNECTIONS = 512
/** How many released runs `GET /runs/:id` still knows (oldest forgotten first); past that a run reads `unknown`. */
export const RELEASED_KEPT = 1000
/** The audit route's deadline (and never past the entry's own expiry). */
export const AUDIT_POST_TIMEOUT_MS = 10_000

export function createRoot(deps: RootDeps): Root {
  const timers = deps.timers ?? realTimers
  const runs = new Map<string, LiveRun>()
  const chats = new Set<string>()
  const ending = new Set<Promise<void>>()
  /** Released runs, for `GET /runs/:id`, with their pushers (which may still be delivering `released`). */
  const released = new Map<string, Pusher>()
  const pushing = new Set<Pusher>()
  let stopping = false

  const tokenForUid = (uid: number, route?: string): string | null => {
    const token = pickToken(runs.values(), uid)
    // Once the run's terminal event has gone out (its timeout, say), no file is saved for it: one uploaded now would
    // have no `file_saved`. The store stays open, so the session's checkpoint still lands.
    if (token !== null && route === 'files' && [...runs.values()].find((r) => r.uid === uid)!.stream?.ended) return null
    return token
  }

  const release = async (live: LiveRun, user: SessionUser) => {
    try {
      await deps.users.release(live.chatId, user)
    } catch (e) {
      deps.log({ type: 'session_user_release_failed', runId: live.runId, error: safeError(e) })
    }
  }

  const unlist = (live: LiveRun) => {
    runs.delete(live.runId)
    chats.delete(live.chatId)
  }

  async function startRun(req: IncomingMessage, res: ServerResponse) {
    if (stopping) return json(res, 503, { error: 'the runner is stopping' })
    const body = await readJson(req)
    if (stopping) return json(res, 503, { error: 'the runner is stopping' })
    if (!body.ok) return json(res, 400, { error: body.error })
    const parsed = RunStart.safeParse(body.value)
    // Issue messages and paths only: zod doesn't echo input values unless asked, so the token can't come back here.
    if (!parsed.success) return json(res, 400, { error: z.prettifyError(parsed.error).slice(0, 2000) })
    const { runToken, ...config } = parsed.data satisfies { runToken: string } & RunConfig
    if (runs.has(config.runId) || released.has(config.runId)) return refuse(res, 'run_live')
    if (chats.has(config.chatId)) return refuse(res, 'chat_live')

    // Listed from here (so stop, interrupt, status and stopAll reach it) until its user is released.
    const live: LiveRun = {
      runId: config.runId,
      chatId: config.chatId,
      uid: null,
      token: runToken,
      handle: null,
      stopRequested: false,
      interruptRequested: false,
      gone: false,
      full: false,
      stream: null,
      pusher: null,
      queryRan: false,
      checkpoint: null,
      audits: 0,
    }
    runs.set(config.runId, live)
    chats.add(config.chatId)
    // stopAll waits for this run from here: its admission, then its lifecycle.
    let settle!: () => void
    const settled = new Promise<void>((r) => (settle = r))
    ending.add(settled)
    void settled.then(() => ending.delete(settled))
    try {
      await admit(live, config, runToken, res)
    } finally {
      settle()
    }
  }

  async function admit(live: LiveRun, config: RunConfig, runToken: string, res: ServerResponse) {
    let user: SessionUser
    try {
      user = await deps.users.allocate(config.chatId)
    } catch (e) {
      unlist(live)
      deps.log({ type: 'session_user_failed', runId: live.runId, error: safeError(e) })
      // A refusal the Worker can route on (the pool is full, or this chat's folder is parked for good). Anything else is
      // the runner's fault: 500. Either way the run was never admitted.
      const code = (e as { code?: unknown } | null)?.code
      if (code === 'session_pool_exhausted' || code === 'session_folder_parked') return refuse(res, code)
      return json(res, 500, { error: 'could not set up the session user' })
    }
    if (user.uid === 0 || user.gid === 0) {
      deps.log({ type: 'session_user_refused', runId: live.runId, reason: 'root' })
      await release(live, user)
      unlist(live)
      return json(res, 500, { error: 'a session never runs as root' })
    }
    // One run per uid: the proxy maps a uid to exactly one token. Not released: the uid belongs to the other run.
    if ([...runs.values()].some((r) => r !== live && r.uid === user.uid)) {
      deps.log({ type: 'session_user_refused', runId: live.runId, reason: 'uid busy', uid: user.uid })
      unlist(live)
      return json(res, 500, { error: 'the session user still has a live run' })
    }
    live.uid = user.uid

    // Admitted: the answer goes now, and the run's events go to the egress from here on.
    const pusher = createPusher({
      runId: config.runId,
      token: runToken,
      egressUrl: deps.egressUrl,
      fetch: deps.fetch,
      timers,
      lingerMs: deps.pushLingerMs,
      heartbeatMs: deps.pushHeartbeatMs,
      maxBytes: deps.pushMaxBytes,
      log: deps.log,
      heartbeat: () => void stream.emit({ type: 'heartbeat' }),
      onStop: () => {
        deps.log({ type: 'worker_fenced', runId: live.runId })
        stopRun(live)
      },
      onGone: () => {
        live.gone = true
        stopRun(live)
      },
      onFull: (full) => {
        live.full = full
        if (full && !discarding(live)) live.handle?.pause()
        else if (!full) live.handle?.resume()
      },
    })
    const stream = new RunStream(config.runId, (e) => pusher.push(e))
    live.stream = stream
    live.pusher = pusher
    pushing.add(pusher)
    void pusher.done.then(() => pushing.delete(pusher))
    json(res, 202, { accepted: true })

    await runLifecycle(live, config, user)
      .catch((e: unknown) => deps.log({ type: 'run_lifecycle_failed', runId: live.runId, error: safeError(e) }))
      .finally(() => {
        // The session has exited, its store flush is over (its terminal event came after it) and its user is
        // released: the chat is free now, and only then does `released` go out.
        unlist(live)
        released.set(live.runId, pusher)
        while (released.size > RELEASED_KEPT) released.delete(released.keys().next().value!)
        if (!stream.ended) stream.emit({ type: 'failed', reason: 'session_crashed', message: 'the run ended without a terminal event' })
        stream.release({ checkpoint: live.checkpoint === null ? null : { ...live.checkpoint }, queryRan: live.queryRan })
      })
  }

  /** Past a stop, the end of the run, or the Worker's 410: the session is read on, whatever the push buffer holds. */
  const discarding = (live: LiveRun) => live.gone || live.stopRequested || (live.stream?.ended ?? false)

  async function recordAudit(live: LiveRun, entry: AuditEntry, expiresAt: number): Promise<boolean> {
    const token = live.token
    if (token === null || live.gone) return false
    const wait = Math.min(AUDIT_POST_TIMEOUT_MS, expiresAt - monotonicMs())
    if (wait <= 0) return false
    const abort = new AbortController()
    const deadline = timers.setTimeout(() => abort.abort(), wait)
    const post: AuditPost = { turnId: live.runId, n: live.audits++, entry }
    try {
      const res = await deps.fetch(`${deps.egressUrl.replace(/\/$/, '')}/audit/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RUN_TOKEN_HEADER]: token },
        body: JSON.stringify(post),
        signal: abort.signal,
      })
      void res.body?.cancel().catch(() => undefined)
      if (res.status !== 204) deps.log({ type: 'audit_refused', runId: live.runId, n: post.n, status: res.status })
      return res.status === 204
    } catch (e) {
      deps.log({ type: 'audit_failed', runId: live.runId, n: post.n, error: safeError(e) })
      return false
    } finally {
      timers.clearTimeout(deadline)
    }
  }

  async function runLifecycle(live: LiveRun, config: RunConfig, user: SessionUser) {
    const stream = live.stream!
    stream.emit({ type: 'started', sessionId: config.sessionId, resume: config.resume })
    const end = async () => {
      live.token = null
      await release(live, user)
    }

    if (live.stopRequested) {
      stream.emit({ type: 'failed', reason: 'stopped', message: 'stopped before the session started' })
      return end()
    }

    let child: ChildProcess | undefined
    let handle: SessionHandle
    try {
      child = deps.spawnSession(user, sessionEnv(user, deps.proxyPort, deps.extraCaCerts))
      handle = hostSession({
        child,
        stream,
        config,
        stopGraceMs: deps.stopGraceMs,
        log: deps.log,
        recordAudit: (entry, expiresAt) => recordAudit(live, entry, expiresAt),
        onQueryStarted: () => void (live.queryRan = true),
        onStoreResult: (cp) => void (live.checkpoint = cp),
      })
    } catch (e) {
      // A synchronous spawn failure (EPERM from the uid switch, E2BIG, ...): one terminal event, and nothing left over.
      deps.log({ type: 'session_spawn_failed', runId: live.runId, error: safeError(e) })
      if (child?.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
      stream.emit({ type: 'failed', reason: 'session_crashed', message: 'the session process could not start' })
      return end()
    }
    live.handle = handle
    if (live.full && !discarding(live)) handle.pause()
    if (live.stopRequested) handle.stop()
    else if (live.interruptRequested) handle.interrupt()

    const timer = timers.setTimeout(() => {
      stream.emit({ type: 'failed', reason: 'timeout', message: 'the run took too long' })
      handle.resume()
      handle.stop()
    }, deps.runTimeoutMs)
    await handle.done
    timers.clearTimeout(timer)
    // The session and its group are gone: the token goes now; the chat frees once release() has settled.
    await end()
  }

  /** A stop: the session is read on (never paused again) until it ends, so it can flush its last events. */
  function stopRun(live: LiveRun) {
    if (live.stream?.released) return
    live.stopRequested = true
    live.handle?.resume()
    live.handle?.stop()
  }

  const peers = new WeakMap<Socket, Promise<boolean>>()
  const server = http.createServer((req, res) => {
    serve(req, res).catch((e) => {
      deps.log({ type: 'root_request_failed', error: safeError(e) })
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
      else res.destroy()
    })
  })
  server.maxConnections = API_MAX_CONNECTIONS
  server.on('connection', (socket: Socket) => {
    const allowed = Promise.resolve().then(() => deps.apiPeerAllowed(socket)).catch((e) => {
      deps.log({ type: 'api_peer_check_failed', error: safeError(e) })
      return false
    })
    peers.set(socket, allowed)
    void allowed.then((ok) => {
      if (ok) return
      deps.log({ type: 'api_peer_refused', remoteAddress: socket.remoteAddress, remotePort: socket.remotePort })
      socket.destroy()
    })
  })

  async function serve(req: IncomingMessage, res: ServerResponse) {
    // Nothing is served before the peer check has passed, and nothing for a connection it refused.
    const allowed = await (peers.get(req.socket) ?? Promise.resolve(false))
    if (!allowed || req.socket.destroyed) return void req.socket.destroy()
    return route(req, res)
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://runner')
    const method = req.method ?? 'GET'

    // The two discovery routes answer without the protocol header: the Worker asks /protocol before it knows what to send.
    if (method === 'GET' && url.pathname === '/protocol') {
      return json(res, 200, { version: PROTOCOL_VERSION, accepted: [...ACCEPTED_VERSIONS] } satisfies ProtocolInfo)
    }
    if (method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, protocol: PROTOCOL_VERSION, live: runs.size, quarantinedUsers: deps.users.quarantined(), memory: deps.memory() } satisfies Health)
    }

    const header = req.headers[PROTOCOL_HEADER]
    if (!acceptsVersion(typeof header === 'string' ? header : null)) {
      return json(res, 426, { error: 'unsupported protocol version', version: PROTOCOL_VERSION })
    }

    if (method === 'POST' && url.pathname === '/runs') return startRun(req, res)
    const status = /^\/runs\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname)
    if (method === 'GET' && status) return json(res, 200, runStatus(status[1]!))
    const action = /^\/runs\/([A-Za-z0-9_-]{1,64})\/(interrupt|stop)$/.exec(url.pathname)
    if (method === 'POST' && action) {
      const live = runs.get(action[1]!)
      if (!live) return json(res, 404, { error: 'no such live run' })
      // A run still starting records it; it's applied once the session is spawned.
      if (action[2] === 'interrupt') {
        if (live.handle) live.handle.interrupt()
        else live.interruptRequested = true
      } else stopRun(live)
      return json(res, 202, { ok: true })
    }
    return json(res, 404, { error: 'not found' })
  }

  function runStatus(runId: string): RunStatus {
    const live = runs.get(runId)
    if (live) {
      const p = live.pusher
      const seqs = { lastSeq: p?.lastSeq() ?? null, ackedSeq: p?.ackedSeq() ?? null }
      // The terminal event first: a run stopped before its session was spawned has ended without a handle.
      if (live.stream?.ended) return { state: 'ending', ...seqs }
      if (live.stream === null || live.handle === null) return { state: 'admitted', ...seqs }
      return { state: 'running', ...seqs }
    }
    const p = released.get(runId)
    if (p) return { state: 'released', lastSeq: p.lastSeq(), ackedSeq: p.ackedSeq() }
    return { state: 'unknown', lastSeq: null, ackedSeq: null }
  }

  return {
    server,
    tokenForUid,
    liveCount: () => runs.size,
    bufferedBytes: (runId) => (runs.get(runId)?.pusher ?? released.get(runId))?.bufferedBytes() ?? null,
    async stopAll() {
      stopping = true
      for (const r of runs.values()) stopRun(r)
      await Promise.all(ending)
      // Each run's `released` gets the grace to reach the Worker; then the pushers stop.
      await Promise.race([Promise.all([...pushing].map((p) => p.done)), new Promise<void>((r) => timers.setTimeout(r, deps.stopGraceMs))])
      for (const p of pushing) p.close()
    },
  }
}

function refuse(res: ServerResponse, code: RunRefusal['error']) {
  json(res, RUN_REFUSAL_STATUS[code], { error: code } satisfies RunRefusal)
}

function json(res: ServerResponse, status: number, body: ErrorBody | ProtocolInfo | Health | RunAdmission | RunRefusal | RunStatus | { ok: true }) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length
    if (size > RUN_START_MAX_BYTES) return { ok: false, error: 'body too large' }
    chunks.push(c)
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false, error: 'body is not JSON' }
  }
}
