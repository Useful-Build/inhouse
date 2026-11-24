// The loopback proxy in the root runner. Every credentialed call a session makes (the model, the inhouse MCP server,
// the hub's `apps` MCP server, the session store, file saves) comes here on 127.0.0.1. The proxy asks the kernel which OS user is calling, maps that
// uid to its live run, adds the run's token and forwards to the Worker's egress. The token never leaves the root's
// memory except in that one header to the egress.
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import type { Socket } from 'node:net'

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
  /** Delays before retrying a failed idempotent MCP startup handshake on `/mcp/` or `/hub/` (default `MCP_HANDSHAKE_RETRY_DELAYS_MS`). */
  mcpRetryDelaysMs?: readonly number[]
}

export const PROXY_MAX_BODY_BYTES = 64 * 1024 * 1024
/** Open connections the proxy takes at once, across every session; past it new ones are dropped by Node. */
export const PROXY_MAX_CONNECTIONS = 1024
/** Open connections one session user may hold, so one session can't take every slot above; past it they're closed. */
export const PROXY_MAX_CONNECTIONS_PER_UID = 256
export const PROXY_UPSTREAM_TIMEOUT_MS = 10 * 60_000
/**
 * Strictly idempotent, read-only MCP startup/handshake methods that may be retried on a transient upstream error.
 * This defends against confirmed startup behavior in the pinned Claude Code CLI 2.1.328 binary:
 * with `MCP_CONNECTION_NONBLOCKING=0`, `F()` resolves the startup wait on a `failed` result,
 * and the `zBn` retry ([500, 1500, 4000] ms) runs unawaited. `tools/call` is never retried here.
 */
const RETRYABLE_MCP_METHODS = new Set(['initialize', 'notifications/initialized', 'tools/list', 'ping'])
const RETRYABLE_UPSTREAM_STATUSES = new Set([500, 502, 503, 504])
export const MCP_HANDSHAKE_MAX_BODY_BYTES = 16 * 1024
export const MCP_HANDSHAKE_MAX_RESPONSE_BYTES = 1024 * 1024
export const MCP_HANDSHAKE_RETRY_DELAYS_MS: readonly number[] = [150, 400]

export function createProxy(deps: ProxyDeps): http.Server {
  const uids = new WeakMap<Socket, Promise<number | null>>()
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      deps.log({ type: 'proxy_failed', error: String(e instanceof Error ? e.stack : e) })
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
          deps.log({ type: 'proxy_uid_lookup_failed', error: String(e instanceof Error ? e.message : e) })
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

function isRetryableMcpHandshake(body: Buffer): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const msg = parsed as { jsonrpc?: unknown; method?: unknown }
  return msg.jsonrpc === '2.0' && typeof msg.method === 'string' && RETRYABLE_MCP_METHODS.has(msg.method)
}

function forward(deps: ProxyDeps, path: string, req: IncomingMessage, res: ServerResponse, token: string, route: string, uid: number) {
  const maxBody = deps.maxBodyBytes ?? PROXY_MAX_BODY_BYTES
  const tooLarge = () => {
    deps.log({ type: 'proxy_refused', route, uid, reason: 'body too large' })
    if (!res.headersSent) refuse(res, 413, 'body too large')
    else res.destroy()
  }
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > maxBody) return tooLarge()

  const retryCap = Math.min(maxBody, MCP_HANDSHAKE_MAX_BODY_BYTES)
  const mayRetryHandshake =
    (route === 'mcp' || route === 'hub') &&
    req.method === 'POST' &&
    (declared === undefined || Number(declared) <= retryCap)
  if (mayRetryHandshake) {
    bufferOrStreamMcp(deps, path, req, res, token, route, uid, maxBody, retryCap, tooLarge)
    return
  }
  forwardStream(deps, path, req, res, token, route, uid, maxBody, tooLarge)
}

function buildForwardHeaders(req: IncomingMessage, token: string): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && forwardsRequestHeader(k)) headers[k] = v
  headers[RUN_TOKEN_HEADER] = token
  return headers
}

function responseHeaders(upRes: IncomingMessage): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && !RESPONSE_DROP.has(k)) out[k] = v
  return out
}

function bufferOrStreamMcp(
  deps: ProxyDeps,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  route: string,
  uid: number,
  maxBody: number,
  retryCap: number,
  tooLarge: () => void,
) {
  const chunks: Buffer[] = []
  let size = 0
  let callerGone = false
  let switched = false

  const onClose = () => {
    if (res.writableFinished) return
    callerGone = true
  }
  res.on('close', onClose)

  const onData = (chunk: Buffer) => {
    if (callerGone || switched) return
    size += chunk.length
    if (size > maxBody) {
      switched = true
      cleanup()
      tooLarge()
      return
    }
    chunks.push(chunk)
    if (size > retryCap) {
      switched = true
      cleanup()
      forwardStream(deps, path, req, res, token, route, uid, maxBody, tooLarge, chunks, size)
    }
  }
  const onEnd = () => {
    if (callerGone || switched) return
    cleanup()
    const body = Buffer.concat(chunks, size)
    const delays = isRetryableMcpHandshake(body) ? (deps.mcpRetryDelaysMs ?? MCP_HANDSHAKE_RETRY_DELAYS_MS) : []
    forwardBuffered(deps, path, req, res, token, route, uid, body, delays)
  }
  const onError = () => {
    callerGone = true
    cleanup()
  }
  const cleanup = () => {
    req.off('data', onData)
    req.off('end', onEnd)
    req.off('error', onError)
    res.off('close', onClose)
  }
  req.on('data', onData)
  req.on('end', onEnd)
  req.on('error', onError)
}

function forwardBuffered(
  deps: ProxyDeps,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  initialToken: string,
  route: string,
  uid: number,
  body: Buffer,
  retryDelaysMs: readonly number[],
) {
  const logError = (error: string) => deps.log({ type: 'proxy_upstream_error', route, uid, error })
  const target = targetFor(deps.upstream, path, route)!
  const send = target.protocol === 'https:' ? https.request : http.request
  const timeout = deps.upstreamTimeoutMs ?? PROXY_UPSTREAM_TIMEOUT_MS
  const tokenRoute = tokenRouteFor(route)

  let callerGone = false
  let activeUp: http.ClientRequest | null = null
  let retryTimer: NodeJS.Timeout | undefined

  res.on('close', () => {
    if (res.writableFinished) return
    callerGone = true
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    activeUp?.destroy()
  })

  const attempt = (index: number) => {
    if (callerGone) return
    const headers = buildForwardHeaders(req, initialToken)
    headers['content-length'] = String(body.length)
    let settled = false
    const canRetry = index < retryDelaysMs.length

    const retryOrFail = (error: string, status: number) => {
      if (settled || callerGone) return
      settled = true
      logError(error)
      if (!canRetry || res.headersSent) {
        if (!res.headersSent) refuse(res, status, 'upstream failed')
        else res.destroy()
        return
      }
      scheduleRetry(index + 1, status)
    }

    const scheduleRetry = (nextIndex: number, status: number) => {
      const delay = retryDelaysMs[nextIndex - 1] ?? 0
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        if (callerGone) return
        const freshToken = deps.tokenForUid(uid, tokenRoute)
        if (freshToken === null) {
          refuseLogged(deps, res, route, uid, 'no live run for this user (or its stream has ended)')
          return
        }
        if (freshToken !== initialToken) {
          refuse(res, status, 'upstream failed')
          return
        }
        attempt(nextIndex)
      }, delay)
    }

    // `agent: false`: fresh connection per request avoids stale idle keep-alive socket 502s against `egress.internal`.
    const up = send(target, { method: req.method, headers, agent: false, timeout }, (upRes) => {
      const status = upRes.statusCode ?? 502
      if (canRetry && RETRYABLE_UPSTREAM_STATUSES.has(status)) {
        retryOrFail(`upstream status ${status}`, status)
        up.destroy()
        return
      }
      if (!canRetry) {
        settled = true
        res.writeHead(status, responseHeaders(upRes))
        upRes.pipe(res)
        upRes.on('close', () => {
          if (upRes.complete || callerGone) return
          logError('the upstream ended mid-body')
          res.destroy()
        })
        return
      }
      // Buffer small handshake responses so a mid-body cut from `egress.internal` retries cleanly too.
      const resChunks: Buffer[] = []
      let resBytes = 0
      let streaming = false
      upRes.on('data', (chunk: Buffer) => {
        if (settled || callerGone) return
        if (streaming) {
          if (!res.write(chunk)) {
            upRes.pause()
            res.once('drain', () => upRes.resume())
          }
          return
        }
        resBytes += chunk.length
        resChunks.push(chunk)
        if (resBytes > MCP_HANDSHAKE_MAX_RESPONSE_BYTES) {
          streaming = true
          res.writeHead(status, responseHeaders(upRes))
          for (const c of resChunks) res.write(c)
          resChunks.length = 0
        }
      })
      upRes.on('end', () => {
        if (settled || callerGone) return
        settled = true
        if (streaming) {
          res.end()
          return
        }
        res.writeHead(status, responseHeaders(upRes))
        res.end(Buffer.concat(resChunks, resBytes))
      })
      upRes.on('close', () => {
        if (settled || callerGone || upRes.complete) return
        if (streaming) {
          settled = true
          logError('the upstream ended mid-body')
          res.destroy()
          return
        }
        retryOrFail('the upstream ended mid-body', 502)
      })
    })
    activeUp = up
    up.on('timeout', () => up.destroy(new Error('upstream timeout')))
    up.on('error', (e) => retryOrFail(e.message, e.message === 'upstream timeout' ? 504 : 502))
    up.end(body)
  }

  attempt(0)
}

function forwardStream(
  deps: ProxyDeps,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  route: string,
  uid: number,
  maxBody: number,
  tooLarge: () => void,
  prefix: readonly Buffer[] = [],
  initialSize = 0,
) {
  const logError = (error: string) => deps.log({ type: 'proxy_upstream_error', route, uid, error })
  const headers = buildForwardHeaders(req, token)
  const target = targetFor(deps.upstream, path, route)!
  const send = target.protocol === 'https:' ? https.request : http.request

  let callerGone = false
  let failed = false
  // `agent: false`: Node's globalAgent pools keep-alive sockets (`keepAlive: true`), and `forwardStream()` streams `req`
  // directly into `up`, so it cannot retry if the upstream closes an idle socket just as we reuse it (which surfaces
  // as an immediate ECONNRESET -> 502 and breaks MCP startup or a tool call). The upstream is the container's local
  // `http://egress.internal` intercept, so a fresh connection per request avoids stale-socket 502s cleanly.
  const up = send(target, { method: req.method, headers, agent: false, timeout: deps.upstreamTimeoutMs ?? PROXY_UPSTREAM_TIMEOUT_MS }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, responseHeaders(upRes))
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
    logError(e.message)
    if (!res.headersSent) refuse(res, e.message === 'upstream timeout' ? 504 : 502, 'upstream failed')
    else res.destroy()
  })
  // The caller went away (or its connection broke): the upstream request is dropped with it.
  res.on('close', () => {
    if (res.writableFinished) return
    callerGone = true
    up.destroy()
  })

  const write = (chunk: Buffer) => {
    if (!up.write(chunk) && !req.isPaused()) {
      req.pause()
      up.once('drain', () => req.resume())
    }
  }

  let size = initialSize
  req.on('data', (chunk: Buffer) => {
    if (failed) return
    size += chunk.length
    if (size > maxBody) {
      failed = true
      up.destroy()
      tooLarge()
      return
    }
    write(chunk)
  })
  req.on('end', () => {
    if (!failed) up.end()
  })
  // Attach the data listener before writing the prefix so it cannot resume a backpressured request.
  for (const chunk of prefix) write(chunk)
}
