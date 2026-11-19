// The loopback proxy in the root runner. Every credentialed call a session makes (the model, the inhouse MCP server,
// the session store, file saves) comes here on 127.0.0.1. The proxy asks the kernel which OS user is calling, maps that
// uid to its live run, adds the run's token and forwards to the Worker's egress. The token never leaves the root's
// memory except in that one header to the egress.
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import type { Socket } from 'node:net'

export const RUN_TOKEN_HEADER = 'x-inhouse-run-token'
export const PROXY_ROUTES = ['model', 'mcp', 'store', 'files'] as const

/** Headers never forwarded: hop-by-hop ones, the caller's own credentials (the egress adds the real key) and any token. */
const DROP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'authorization',
  'x-api-key',
  RUN_TOKEN_HEADER,
])

export type ProxyDeps = {
  /** The Worker's egress, e.g. `http://egress.internal`. Paths are appended as they came in (`/model/v1/messages`). */
  upstream: URL
  /** The uid on the other end of an accepted connection, or null when unknown. */
  lookupUid: (socket: Socket) => number | null
  /** The live run's token for a uid, or null. */
  tokenForUid: (uid: number) => string | null
  log: (entry: Record<string, unknown>) => void
}

export function createProxy(deps: ProxyDeps): http.Server {
  const uids = new WeakMap<Socket, number | null>()
  const uidOf = (socket: Socket): number | null => {
    if (!uids.has(socket)) {
      let uid: number | null
      try {
        uid = deps.lookupUid(socket)
      } catch (e) {
        deps.log({ type: 'proxy_uid_lookup_failed', error: String(e instanceof Error ? e.message : e) })
        uid = null
      }
      uids.set(socket, uid)
    }
    return uids.get(socket) ?? null
  }

  return http.createServer((req, res) => {
    const path = req.url ?? '/'
    const route = /^\/([a-z]+)\//.exec(path)?.[1]
    if (!route || !(PROXY_ROUTES as readonly string[]).includes(route)) return refuse(res, 404, 'no such route')
    // No dot segments or backslashes, so a path can't climb out of its route once the URL is resolved.
    if (/(^|\/)\.\.?(\/|$|\?)|\\|%2e|%5c/i.test(path)) return refuse(res, 400, 'bad path')

    const uid = uidOf(req.socket)
    if (uid === null) return refuseLogged(deps, res, route, null, 'unknown caller')
    if (uid === 0) return refuseLogged(deps, res, route, uid, 'root never calls through the proxy')
    const token = deps.tokenForUid(uid)
    if (token === null) return refuseLogged(deps, res, route, uid, 'no live run for this user')

    forward(deps.upstream, path, req, res, token, (error) => {
      deps.log({ type: 'proxy_upstream_error', route, uid, error })
    })
  })
}

function refuse(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error }))
}

function refuseLogged(deps: ProxyDeps, res: ServerResponse, route: string, uid: number | null, reason: string) {
  deps.log({ type: 'proxy_refused', route, uid, reason })
  refuse(res, 403, reason)
}

function forward(upstream: URL, path: string, req: IncomingMessage, res: ServerResponse, token: string, onError: (e: string) => void) {
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROP.has(k)) headers[k] = v
  headers[RUN_TOKEN_HEADER] = token
  const target = new URL(upstream.pathname.replace(/\/$/, '') + path, upstream)
  const send = target.protocol === 'https:' ? https.request : http.request
  const up = send(target, { method: req.method, headers }, (upRes) => {
    const out: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && !DROP.has(k)) out[k] = v
    res.writeHead(upRes.statusCode ?? 502, out)
    upRes.pipe(res)
  })
  up.on('error', (e) => {
    onError(e.message)
    if (!res.headersSent) refuse(res, 502, 'upstream failed')
    else res.destroy()
  })
  req.pipe(up)
}
