// The loopback proxy in the root runner. Every credentialed call a session makes (the model, the inhouse MCP server,
// the session store, file saves) comes here on 127.0.0.1. The proxy asks the kernel which OS user is calling, maps that
// uid to its live run, adds the run's token and forwards to the Worker's egress. The token never leaves the root's
// memory except in that one header to the egress.
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import type { Socket } from 'node:net'

export const RUN_TOKEN_HEADER = 'x-inhouse-run-token'
export const PROXY_ROUTES = ['model', 'mcp', 'store', 'files'] as const

/**
 * The request headers forwarded, an allowlist: what the Messages API takes (`anthropic-*`), what the MCP streamable
 * HTTP transport needs (`mcp-session-id`, `mcp-protocol-version`, `last-event-id`, `accept`, `content-type`), and the
 * body's framing. Nothing else: no caller credentials (the egress adds the real key) and no token but the proxy's own.
 */
const REQUEST_HEADERS = new Set(['content-type', 'content-length', 'accept', 'user-agent', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'])
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
  /** The live run's token for a uid, or null. */
  tokenForUid: (uid: number) => string | null
  log: (entry: Record<string, unknown>) => void
  /** The largest request body forwarded; a bigger one gets 413. */
  maxBodyBytes?: number
  /** An upstream connection idle this long is cut (504 if nothing was answered yet). */
  upstreamTimeoutMs?: number
}

export const PROXY_MAX_BODY_BYTES = 64 * 1024 * 1024
export const PROXY_UPSTREAM_TIMEOUT_MS = 10 * 60_000

export function createProxy(deps: ProxyDeps): http.Server {
  const uids = new WeakMap<Socket, Promise<number | null>>()
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      deps.log({ type: 'proxy_failed', error: String(e instanceof Error ? e.stack : e) })
      if (!res.headersSent) refuse(res, 500, 'internal error')
      else res.destroy()
    })
  })
  // The uid is looked up as the connection opens, while the caller's socket is certainly still in the tables.
  server.on('connection', (socket: Socket) => {
    uids.set(
      socket,
      Promise.resolve()
        .then(() => deps.lookupUid(socket))
        .catch((e) => {
          deps.log({ type: 'proxy_uid_lookup_failed', error: String(e instanceof Error ? e.message : e) })
          return null
        }),
    )
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = req.url ?? '/'
    const route = /^\/([a-z]+)\//.exec(path)?.[1]
    if (!route || !(PROXY_ROUTES as readonly string[]).includes(route)) return refuse(res, 404, 'no such route')
    // No dot segments or backslashes, so a path can't climb out of its route once the URL is resolved.
    if (/(^|\/)\.\.?(\/|$|\?)|\\|%2e|%5c/i.test(path)) return refuse(res, 400, 'bad path')

    const uid = await (uids.get(req.socket) ?? Promise.resolve(null))
    if (uid === null) return refuseLogged(deps, res, route, null, 'unknown caller')
    if (uid === 0) return refuseLogged(deps, res, route, uid, 'root never calls through the proxy')
    const token = deps.tokenForUid(uid)
    if (token === null) return refuseLogged(deps, res, route, uid, 'no live run for this user')
    forward(deps, path, req, res, token, route, uid)
  }

  return server
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
  const target = new URL(deps.upstream.pathname.replace(/\/$/, '') + path, deps.upstream)
  const send = target.protocol === 'https:' ? https.request : http.request

  let callerGone = false
  let failed = false
  const up = send(target, { method: req.method, headers, timeout: deps.upstreamTimeoutMs ?? PROXY_UPSTREAM_TIMEOUT_MS }, (upRes) => {
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
