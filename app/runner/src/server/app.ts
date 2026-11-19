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
  RUN_START_MAX_BYTES,
  RunStart,
  encodeRunEvent,
  type ErrorBody,
  type Health,
  type ProtocolInfo,
  acceptsVersion,
} from '../../../shared/protocol/index.ts'
import { z } from 'zod'
import type { RunConfig } from '../protocol/local.ts'
import { sessionEnv } from '../session/env.ts'
import type { SessionUser, SessionUsers } from '../session/seam.ts'
import { RunStream } from './run-stream.ts'
import { hostSession, type SessionHandle, type SpawnSession } from './session-host.ts'

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
  /** The Worker hung up. */
  gone: boolean
  /** The run's NDJSON response, once its headers are out. */
  res: ServerResponse | null
}

export type RootDeps = {
  users: SessionUsers
  spawnSession: SpawnSession
  proxyPort: number
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
  /** The live run's token for a session uid; null when there's none, or more than one (never guess). */
  tokenForUid(uid: number): string | null
  liveCount(): number
  /**
   * Bytes of a live run's events written but not yet taken by the Worker's connection; null for no such run or no
   * stream yet. Bounded by backpressure: past the response's high-water mark the session's stdout isn't read.
   */
  bufferedBytes(runId: string): number | null
  /** The SIGTERM path: refuses new runs (503), stops every run, starting ones included, and resolves once each has ended. */
  stopAll(): Promise<void>
}

/** The token of the one run on `uid`; null for none, or for more than one. */
export function pickToken(runs: Iterable<{ uid: number | null; token: string | null }>, uid: number): string | null {
  const found = [...runs].filter((r) => r.uid === uid)
  return found.length === 1 ? found[0]!.token : null
}

const errorText = (e: unknown) => String(e instanceof Error ? e.message : e)

/** Open connections the API takes at once (the Worker's runs and calls); past it new ones are dropped by Node. */
export const API_MAX_CONNECTIONS = 512

export function createRoot(deps: RootDeps): Root {
  const runs = new Map<string, LiveRun>()
  const chats = new Set<string>()
  const ending = new Set<Promise<void>>()
  let stopping = false

  const tokenForUid = (uid: number): string | null => pickToken(runs.values(), uid)

  const release = async (live: LiveRun, user: SessionUser) => {
    try {
      await deps.users.release(live.chatId, user)
    } catch (e) {
      deps.log({ type: 'session_user_release_failed', runId: live.runId, error: errorText(e) })
    }
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
    if (runs.has(config.runId)) return json(res, 409, { error: 'a run with this id is live' })
    if (chats.has(config.chatId)) return json(res, 409, { error: 'this chat has a live run' })

    // Admitted: from here the run is listed (so stop, interrupt and stopAll reach it) until its user is released.
    const live: LiveRun = {
      runId: config.runId,
      chatId: config.chatId,
      uid: null,
      token: runToken,
      handle: null,
      stopRequested: false,
      interruptRequested: false,
      gone: false,
      res: null,
    }
    runs.set(config.runId, live)
    chats.add(config.chatId)
    const lifecycle = runLifecycle(live, config, req, res).finally(() => {
      runs.delete(config.runId)
      chats.delete(config.chatId)
    })
    ending.add(lifecycle)
    await lifecycle
    ending.delete(lifecycle)
  }

  async function runLifecycle(live: LiveRun, config: RunConfig, req: IncomingMessage, res: ServerResponse) {
    // The Worker hung up: nobody can read the run's events, so stop it, at whatever stage it is, and read what the
    // session still sends without waiting for a drain that will never come (so it can flush and end cleanly).
    const hungUp = () => {
      if (live.gone) return
      live.gone = true
      deps.log({ type: 'worker_hung_up', runId: live.runId })
      live.handle?.resume()
      live.handle?.stop()
    }
    res.on('close', () => {
      if (!res.writableFinished) hungUp()
    })
    // A hang-up between the end of the body and the listener above: its `close` has already gone by.
    if (res.destroyed || req.socket.destroyed) hungUp()

    let user: SessionUser
    try {
      user = await deps.users.allocate(config.chatId)
    } catch (e) {
      deps.log({ type: 'session_user_failed', runId: live.runId, error: errorText(e) })
      return json(res, 500, { error: 'could not set up the session user' })
    }
    if (user.uid === 0 || user.gid === 0) {
      deps.log({ type: 'session_user_refused', runId: live.runId, reason: 'root' })
      await release(live, user)
      return json(res, 500, { error: 'a session never runs as root' })
    }
    // One run per uid: the proxy maps a uid to exactly one token. Not released: the uid belongs to the other run.
    if ([...runs.values()].some((r) => r !== live && r.uid === user.uid)) {
      deps.log({ type: 'session_user_refused', runId: live.runId, reason: 'uid busy', uid: user.uid })
      return json(res, 500, { error: 'the session user still has a live run' })
    }
    live.uid = user.uid
    if (live.gone) {
      deps.log({ type: 'run_abandoned', runId: live.runId, stage: 'allocate' })
      await release(live, user)
      return
    }

    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
    live.res = res
    // Backpressure: when the Worker reads slowly, stop reading the session until the response drains. Once the run has
    // ended (its timeout, say) or the Worker has gone, no drain may ever come: the session is read and the rest dropped.
    const discarding = () => live.gone || stream.ended || res.destroyed || res.writableEnded
    const stream = new RunStream(config.runId, (e) => {
      if (res.destroyed || res.writableEnded) return
      if (!res.write(encodeRunEvent(e)) && !discarding()) live.handle?.pause()
    })
    res.on('drain', () => live.handle?.resume())
    stream.emit({ type: 'started', sessionId: config.sessionId, resume: config.resume })
    const end = async () => {
      live.token = null
      res.end()
      await release(live, user)
    }

    if (live.stopRequested) {
      stream.emit({ type: 'failed', reason: 'stopped', message: 'stopped before the session started' })
      return end()
    }

    let child: ChildProcess | undefined
    let handle: SessionHandle
    try {
      child = deps.spawnSession(user, sessionEnv(user, deps.proxyPort))
      handle = hostSession({ child, stream, config, stopGraceMs: deps.stopGraceMs, log: deps.log })
    } catch (e) {
      // A synchronous spawn failure (EPERM from the uid switch, E2BIG, ...): one terminal event, and nothing left over.
      deps.log({ type: 'session_spawn_failed', runId: live.runId, error: errorText(e) })
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
    if (res.writableNeedDrain && !discarding()) handle.pause()
    if (live.stopRequested || live.gone) handle.stop()
    else if (live.interruptRequested) handle.interrupt()

    const timer = setTimeout(() => {
      stream.emit({ type: 'failed', reason: 'timeout', message: 'the run took too long' })
      handle.resume()
      handle.stop()
    }, deps.runTimeoutMs)
    await handle.done
    clearTimeout(timer)
    // The session and its group are gone: the token goes now; the chat slot frees once release() has settled (finally
    // in startRun), so a new run on this chat can't race this run's release.
    await end()
  }

  const peers = new WeakMap<Socket, Promise<boolean>>()
  const server = http.createServer((req, res) => {
    serve(req, res).catch((e) => {
      deps.log({ type: 'root_request_failed', error: String(e instanceof Error ? e.stack : e) })
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
      else res.destroy()
    })
  })
  server.maxConnections = API_MAX_CONNECTIONS
  server.on('connection', (socket: Socket) => {
    const allowed = Promise.resolve().then(() => deps.apiPeerAllowed(socket)).catch((e) => {
      deps.log({ type: 'api_peer_check_failed', error: errorText(e) })
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
      return json(res, 200, { ok: true, protocol: PROTOCOL_VERSION, live: runs.size, memory: deps.memory() } satisfies Health)
    }

    const header = req.headers[PROTOCOL_HEADER]
    if (!acceptsVersion(typeof header === 'string' ? header : null)) {
      return json(res, 426, { error: 'unsupported protocol version', version: PROTOCOL_VERSION })
    }

    if (method === 'POST' && url.pathname === '/runs') return startRun(req, res)
    const action = /^\/runs\/([A-Za-z0-9_-]{1,64})\/(interrupt|stop)$/.exec(url.pathname)
    if (method === 'POST' && action) {
      const live = runs.get(action[1]!)
      if (!live) return json(res, 404, { error: 'no such live run' })
      // A run still starting records it; it's applied once the session is spawned.
      if (action[2] === 'interrupt') {
        if (live.handle) live.handle.interrupt()
        else live.interruptRequested = true
      } else {
        live.stopRequested = true
        live.handle?.stop()
      }
      return json(res, 202, { ok: true })
    }
    return json(res, 404, { error: 'not found' })
  }

  return {
    server,
    tokenForUid,
    liveCount: () => runs.size,
    bufferedBytes: (runId) => runs.get(runId)?.res?.writableLength ?? null,
    async stopAll() {
      stopping = true
      for (const r of runs.values()) {
        r.stopRequested = true
        r.handle?.stop()
      }
      await Promise.all(ending)
    },
  }
}

function json(res: ServerResponse, status: number, body: ErrorBody | ProtocolInfo | Health | { ok: true }) {
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
