// The root runner's HTTP server for the Worker (port 8080) and its table of live runs. It owns every run token, in
// memory only, keyed by run id and the session's uid; the token goes to the loopback proxy and nowhere else (never
// over the local channel, never into a session's env, argv or files). It never imports the Agent SDK.
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import {
  ACCEPTED_VERSIONS,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
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
import type { SessionUsers } from '../session/seam.ts'
import { RunStream } from './run-stream.ts'
import { hostSession, type SessionHandle, type SpawnSession } from './session-host.ts'

const MAX_BODY_BYTES = 1024 * 1024

type LiveRun = { runId: string; chatId: string; uid: number | null; token: string; handle: SessionHandle | null }

export type RootDeps = {
  users: SessionUsers
  spawnSession: SpawnSession
  proxyPort: number
  /** After a stop (or a run's end) the session gets this long to exit before it's killed. */
  stopGraceMs: number
  /** A run still going after this long ends with `timeout`. */
  runTimeoutMs: number
  memory: () => Health['memory']
  log: (entry: Record<string, unknown>) => void
}

export type Root = {
  server: http.Server
  /** The live run's token for a session uid; null when there's none, or more than one (never guess). */
  tokenForUid(uid: number): string | null
  liveCount(): number
  /** Stops every live run (the SIGTERM path) and resolves once each has ended. */
  stopAll(): Promise<void>
}

export function createRoot(deps: RootDeps): Root {
  const runs = new Map<string, LiveRun>()
  const chats = new Set<string>()
  const ending = new Set<Promise<void>>()

  const tokenForUid = (uid: number): string | null => {
    const found = [...runs.values()].filter((r) => r.uid === uid)
    return found.length === 1 ? found[0]!.token : null
  }

  async function startRun(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req)
    if (!body.ok) return json(res, 400, { error: body.error })
    const parsed = RunStart.safeParse(body.value)
    // Issue messages and paths only: zod doesn't echo input values unless asked, so the token can't come back here.
    if (!parsed.success) return json(res, 400, { error: z.prettifyError(parsed.error).slice(0, 2000) })
    const { runToken, ...config } = parsed.data satisfies { runToken: string } & RunConfig
    if (runs.has(config.runId)) return json(res, 409, { error: 'a run with this id is live' })
    if (chats.has(config.chatId)) return json(res, 409, { error: 'this chat has a live run' })

    const live: LiveRun = { runId: config.runId, chatId: config.chatId, uid: null, token: runToken, handle: null }
    runs.set(config.runId, live)
    chats.add(config.chatId)
    const forget = () => {
      runs.delete(config.runId)
      chats.delete(config.chatId)
    }

    let user
    try {
      user = await deps.users.allocate(config.chatId)
    } catch (e) {
      forget()
      deps.log({ type: 'session_user_failed', runId: config.runId, error: String(e instanceof Error ? e.message : e) })
      return json(res, 500, { error: 'could not set up the session user' })
    }
    if (user.uid === 0 || user.gid === 0) {
      forget()
      deps.log({ type: 'session_user_refused', runId: config.runId, reason: 'root' })
      return json(res, 500, { error: 'a session never runs as root' })
    }
    live.uid = user.uid

    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
    const stream = new RunStream(config.runId, (e) => res.write(encodeRunEvent(e)))
    stream.emit({ type: 'started', sessionId: config.sessionId, resume: config.resume })

    const child = deps.spawnSession(user, sessionEnv(user, deps.proxyPort))
    const handle = hostSession({ child, stream, config, stopGraceMs: deps.stopGraceMs, log: deps.log })
    live.handle = handle

    const timer = setTimeout(() => {
      stream.emit({ type: 'failed', reason: 'timeout', message: 'the run took too long' })
      handle.stop()
    }, deps.runTimeoutMs)
    // The Worker hung up before the run ended: nobody can read its events, so stop it.
    res.on('close', () => {
      if (!stream.ended) handle.stop()
    })

    const finished = handle.done.then(async () => {
      clearTimeout(timer)
      forget()
      res.end()
      try {
        await deps.users.release(config.chatId, user)
      } catch (e) {
        deps.log({ type: 'session_user_release_failed', runId: config.runId, error: String(e instanceof Error ? e.message : e) })
      }
    })
    ending.add(finished)
    await finished
    ending.delete(finished)
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      deps.log({ type: 'root_request_failed', error: String(e instanceof Error ? e.stack : e) })
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
      else res.destroy()
    })
  })

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
      if (!live?.handle) return json(res, 404, { error: 'no such live run' })
      if (action[2] === 'interrupt') live.handle.interrupt()
      else live.handle.stop()
      return json(res, 202, { ok: true })
    }
    return json(res, 404, { error: 'not found' })
  }

  return {
    server,
    tokenForUid,
    liveCount: () => runs.size,
    async stopAll() {
      for (const r of runs.values()) r.handle?.stop()
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
    if (size > MAX_BODY_BYTES) return { ok: false, error: 'body too large' }
    chunks.push(c)
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false, error: 'body is not JSON' }
  }
}
