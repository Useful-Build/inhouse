// The loopback proxy in the root runner. Every credentialed call a session makes (the model, the inhouse MCP server,
// the hub's `apps` MCP server, the session store, file saves) comes here on 127.0.0.1. The proxy asks the kernel which OS user is calling, maps that
// uid to its live run, adds the run's token and forwards to the Worker's egress. The token never leaves the root's
// memory except in that one header to the egress.
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import type { Socket } from 'node:net'
import { safeError } from '../safe-error.ts'

export const RUN_TOKEN_HEADER = 'x-inhouse-run-token'
export const PROXY_ROUTES = ['model', 'mcp', 'store', 'files', 'hub'] as const
/** The token route each proxy route asks for: `hub` (P4 H1's `apps` server) rides the run's `mcp` token, so it closes when `mcp` does. */
export const tokenRouteFor = (route: string): string => (route === 'hub' ? 'mcp' : route)

/**
 * The request headers forwarded, an allowlist: what the Messages API takes (`anthropic-*`), what the MCP streamable
 * HTTP transport needs (`mcp-session-id`, `mcp-protocol-version`, `last-event-id`, `accept`, `content-type`), the
 * body's framing, and a saved file's hash (`x-inhouse-sha256`, src/files/files.ts). Nothing else: no caller
 * credentials (the egress adds the real key) and no token but the proxy's own.
 */
const REQUEST_HEADERS = new Set(['content-type', 'content-length', 'accept', 'user-agent', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'x-inhouse-sha256'])
const forwardsRequestHeader = (name: string) => REQUEST_HEADERS.has(name) || name.startsWith('anthropic-')

/**
 * Response headers never passed back: hop-by-hop ones and the token header. A denylist here, unlike the request side,
 * on purpose: the request allowlist guards what reaches the egress with a token on it, but a response goes back only to
 * the session that asked, and it carries nothing that session can't already see. The SDK and the MCP transport read
 * headers we'd otherwise have to track by name (rate limits, request ids, `mcp-session-id`, retry hints), and dropping
 * one would break the caller rather than protect anything. The token header is dropped in case the egress ever echoes
 * it.
 */
const RESPONSE_DROP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', RUN_TOKEN_HEADER])

export type ProxyDeps = {
  /** The Worker's egress, e.g. `http://egress.internal`. Paths are appended as they came in (`/model/v1/messages`). */
  upstream: URL
  /** The uid on the other end of an accepted connection, or null when unknown. Called once, when the connection opens. */
  lookupUid: (socket: Socket) => Promise<number | null>
  /** The live run's token for a uid and route, or null (the root closes `files` once a run's stream has ended). */
  tokenForUid: (uid: number, route: string) => string | null
  log: (entry: Record<string, unknown>) => void
  /** The largest request body forwarded; a bigger one gets 413. */
  maxBodyBytes?: number
  /** An upstream connection idle this long is cut (504 if nothing was answered yet). */
  upstreamTimeoutMs?: number
  /** Open connections across every session (default `PROXY_MAX_CONNECTIONS`). */
  maxConnections?: number
  /** Open connections one uid may hold (default `PROXY_MAX_CONNECTIONS_PER_UID`). */
  maxConnectionsPerUid?: number
}

export const PROXY_MAX_BODY_BYTES = 64 * 1024 * 1024
/** Open connections the proxy takes at once, across every session; past it new ones are dropped by Node. */
export const PROXY_MAX_CONNECTIONS = 1024
/** Open connections one session user may hold, so one session can't take every slot above; past it they're closed. */
export const PROXY_MAX_CONNECTIONS_PER_UID = 256
export const PROXY_UPSTREAM_TIMEOUT_MS = 10 * 60_000

export function createProxy(deps: ProxyDeps): http.Server {
  const uids = new WeakMap<Socket, Promise<number | null>>()
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      deps.log({ type: 'proxy_failed', error: safeError(e) })
      if (!res.headersSent) refuse(res, 500, 'internal error')
      else res.destroy()
    })
  })
  server.maxConnections = deps.maxConnections ?? PROXY_MAX_CONNECTIONS
  const maxPerUid = deps.maxConnectionsPerUid ?? PROXY_MAX_CONNECTIONS_PER_UID
  const openPerUid = new Map<number, number>()
  // The uid is looked up as the connection opens, while the caller's socket is certainly still in the tables.
  server.on('connection', (socket: Socket) => {
    uids.set(
      socket,
      Promise.resolve()
        .then(() => deps.lookupUid(socket))
        .catch((e) => {
          deps.log({ type: 'proxy_uid_lookup_failed', error: safeError(e) })
          return null
        })
        .then((uid) => {
          // Counted only while open: a socket already closed has fired its `close`, so it isn't counted at all.
          if (uid === null || socket.destroyed) return uid
          const open = (openPerUid.get(uid) ?? 0) + 1
          if (open > maxPerUid) {
            deps.log({ type: 'proxy_refused', uid, reason: 'too many connections for this user' })
            socket.destroy()
            return null
          }
          openPerUid.set(uid, open)
          socket.once('close', () => {
            const left = openPerUid.get(uid)! - 1
            if (left === 0) openPerUid.delete(uid)
            else openPerUid.set(uid, left)
          })
          return uid
        }),
    )
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = req.url ?? '/'
    const route = /^\/([a-z]+)\//.exec(path)?.[1]
    if (!route || !(PROXY_ROUTES as readonly string[]).includes(route)) return refuse(res, 404, 'no such route')
    if (badProxyPath(path)) return refuse(res, 400, 'bad path')
    // And whatever the checks above miss, the URL as resolved must still sit under the upstream base and this route.
    if (targetFor(deps.upstream, path, route) === null) return refuse(res, 400, 'bad path')

    const uid = await (uids.get(req.socket) ?? Promise.resolve(null))
    if (uid === null) return refuseLogged(deps, res, route, null, 'unknown caller')
    if (uid === 0) return refuseLogged(deps, res, route, uid, 'root never calls through the proxy')
    const token = deps.tokenForUid(uid, tokenRouteFor(route))
    if (token === null) return refuseLogged(deps, res, route, uid, 'no live run for this user (or its stream has ended)')
    forward(deps, path, req, res, token, route, uid)
  }

  return server
}

/**
 * Whether the proxy refuses a path as it stands. No dot segments, backslashes or fragments (`#`, raw or encoded) in the
 * path, so it can't climb out of its route once the URL is resolved: `/model/..#x` would resolve to `/`. The query is
 * free to carry encoded `#` and `.` (`?q=%23x`); a raw `#` is refused anywhere, since it would end the URL there. The
 * session's files adapter (src/files/) asks this before it sends a name, so a refusal there is a clear notice.
 */
export function badProxyPath(path: string): boolean {
  const pathOnly = path.split('?', 1)[0]!
  return path.includes('#') || /(^|\/)\.\.?(\/|$)|\\|%2e|%5c|%23/i.test(pathOnly)
}

/**
 * The upstream URL for a caller's path, or null when, once resolved, it isn't under the upstream base's own path and
 * then `/<route>/`, or it carries a fragment.
 */
export function targetFor(upstream: URL, path: string, route: string): URL | null {
  const base = upstream.pathname.replace(/\/$/, '')
  let target: URL
  try {
    target = new URL(base + path, upstream)
  } catch {
    return null
  }
  if (target.origin !== upstream.origin || target.hash !== '' || !target.pathname.startsWith(`${base}/${route}/`)) return null
  return target
}

function refuse(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({ error }))
}

function refuseLogged(deps: ProxyDeps, res: ServerResponse, route: string, uid: number | null, reason: string) {
  deps.log({ type: 'proxy_refused', route, uid, reason })
  refuse(res, 403, reason)
}

function forward(deps: ProxyDeps, path: string, req: IncomingMessage, res: ServerResponse, token: string, route: string, uid: number) {
  const maxBody = deps.maxBodyBytes ?? PROXY_MAX_BODY_BYTES
  const logError = (error: string) => deps.log({ type: 'proxy_upstream_error', route, uid, error })
  const tooLarge = () => {
    deps.log({ type: 'proxy_refused', route, uid, reason: 'body too large' })
    if (!res.headersSent) refuse(res, 413, 'body too large')
    else res.destroy()
  }
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > maxBody) return tooLarge()

  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && forwardsRequestHeader(k)) headers[k] = v
  headers[RUN_TOKEN_HEADER] = token
  const target = targetFor(deps.upstream, path, route)!
  const send = target.protocol === 'https:' ? https.request : http.request

  let callerGone = false
  let failed = false
  // `agent: false`: Node's globalAgent pools keep-alive sockets (`keepAlive: true`), and `forward()` streams `req`
  // directly into `up`, so it cannot retry if the upstream closes an idle socket just as we reuse it (which surfaces
  // as an immediate ECONNRESET -> 502 and breaks MCP startup or a tool call). The upstream is the container's local
  // `http://egress.internal` intercept, so a fresh connection per request avoids stale-socket 502s cleanly.
  const up = send(target, { method: req.method, headers, agent: false, timeout: deps.upstreamTimeoutMs ?? PROXY_UPSTREAM_TIMEOUT_MS }, (upRes) => {
    const out: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && !RESPONSE_DROP.has(k)) out[k] = v
    res.writeHead(upRes.statusCode ?? 502, out)
    upRes.pipe(res)
    // The upstream cut the body short: the caller must not take a partial body for a whole one.
    upRes.on('close', () => {
      if (upRes.complete || callerGone) return
      logError('the upstream ended mid-body')
      res.destroy()
    })
  })
  up.on('timeout', () => up.destroy(new Error('upstream timeout')))
  up.on('error', (e) => {
    if (callerGone || failed) return
    failed = true
    // A Node request error names the target URL, whose path can be an output's file name: the log gets our own
    // timeout's fixed text, or the error's name and code.
    logError(e.message === 'upstream timeout' ? 'upstream timeout' : safeError(e))
    if (!res.headersSent) refuse(res, e.message === 'upstream timeout' ? 504 : 502, 'upstream failed')
    else res.destroy()
  })
  // The caller went away (or its connection broke): the upstream request is dropped with it.
  res.on('close', () => {
    if (res.writableFinished) return
    callerGone = true
    up.destroy()
  })

  let size = 0
  req.on('data', (chunk: Buffer) => {
    if (failed) return
    size += chunk.length
    if (size > maxBody) {
      failed = true
      up.destroy()
      tooLarge()
      return
    }
    if (!up.write(chunk)) {
      req.pause()
      up.once('drain', () => req.resume())
    }
  })
  req.on('end', () => {
    if (!failed) up.end()
  })
}
