// The legacy fixture MCP server (Stage 1 M4-F, N52): MCP 2025-11-25 only (it also accepts 2025-06-18 and 2025-03-26),
// on `legacy.mcp-fixtures.example.com`. Bundled into the hub's TEST build only: relative imports and runtime globals,
// no npm package. Deterministic (session ids from a counter).
//
// The rules it stands for (MCP 2025-11-25, read 2026-11-28; the official 2.4.0 server's 2025-era transport was read for
// the exact refusal codes):
// - basic/lifecycle "Initialization" and "Version Negotiation": `initialize` first; the server answers the requested
//   version when it supports it, else its own latest; then `notifications/initialized` (202).
// - basic/transports "Session Management": a session id on the `InitializeResult` (`MCP-Session-Id`), required on
//   every later request (400 without it), 404 for an unknown or ended one, ended by DELETE.
// - basic/transports "Protocol Version Header": an unsupported `MCP-Protocol-Version` is 400.
// - basic/transports "Listening for Messages from the Server": a GET gets 405 (no standalone stream here).
// - Seen from a 2026-07-28 client (2026-07-28 streamable-http "Backward Compatibility"): a modern request (no session,
//   a 2026 version header) gets 400 with a body that is not a recognised modern error (-32000), so a dual-era client
//   falls back to `initialize`.
//
// Endpoints: `/mcp` (open, JSON answers), `/sse/mcp` (open, every answer an SSE stream with event ids, closed after the
// answer), `/as/<profile>/mcp` (signed in at the login fixture, as.ts).

import { type FixtureLoginServer, PROFILE_IDS } from './as'
import { authRefusal, type Endpoint, type FixtureTool, notesTools, prmAnswer, prmUrlOf } from './modern'
import { CODES, HOSTS, isJsonType, isObject, json, LEGACY_VERSION, LEGACY_VERSIONS, readJson, rpcError, sseEvent } from './wire'

export const LEGACY_SERVER_INFO = { name: 'fixture-legacy', version: '1.0.0' } as const

type LegacyEndpoint = Endpoint & { sse?: boolean }
const LEGACY_LIST: LegacyEndpoint[] = [
  { path: '/mcp', auth: { kind: 'none' } },
  { path: '/sse/mcp', auth: { kind: 'none' }, sse: true },
  ...PROFILE_IDS.map((p): LegacyEndpoint => ({ path: `/as/${p}/mcp`, auth: { kind: 'signin', profile: p } })),
]
export const LEGACY_ENDPOINTS: Record<string, LegacyEndpoint> = Object.fromEntries(LEGACY_LIST.map(e => [e.path, e]))

export class LegacyMcpServer {
  readonly as: FixtureLoginServer
  readonly host = HOSTS.legacy
  sessions = new Map<string, { endpoint: string; version: string; initialized: boolean }>()
  calls: { endpoint: string; tool: string; args: Record<string, unknown>; session: string }[] = []
  writes: { endpoint: string; tool: string; args: Record<string, unknown> }[] = []
  #n = 0
  #tools: FixtureTool[]

  constructor(as: FixtureLoginServer) {
    this.as = as
    this.#tools = notesTools(this.writes)
  }

  reset(): void {
    this.sessions.clear()
    this.calls = []
    this.writes.length = 0
  }

  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const prm = /^\/\.well-known\/oauth-protected-resource(\/.*)$/.exec(url.pathname)
    if (req.method === 'GET' && prm) return prmAnswer(this.host, LEGACY_ENDPOINTS[prm[1]!])
    const ep = LEGACY_ENDPOINTS[url.pathname]
    if (!ep) return json({ error: 'not_found' }, 404)
    const denied = authRefusal(req, ep, this.host, this.as)
    if (denied) return denied
    if (req.method === 'GET') return rpcError(405, null, CODES.legacyServer, 'Method not allowed.', undefined, { Allow: 'POST, DELETE' })
    if (req.method === 'DELETE') {
      const bad = this.#session(req)
      if (bad) return bad
      this.sessions.delete(req.headers.get('Mcp-Session-Id')!)
      return new Response(null, { status: 200 })
    }
    if (req.method !== 'POST') return rpcError(405, null, CODES.legacyServer, 'Method not allowed.', undefined, { Allow: 'POST, DELETE' })
    const accept = req.headers.get('Accept') ?? ''
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return rpcError(406, null, CODES.legacyServer, 'Not Acceptable: Client must accept both application/json and text/event-stream')
    if (!isJsonType(req.headers.get('Content-Type'))) return rpcError(415, null, CODES.legacyServer, 'Unsupported Media Type: Content-Type must be application/json')
    const read = await readJson(req)
    if (!read.ok) return rpcError(400, null, CODES.parse, 'Parse error: Invalid JSON')
    const msg = read.value
    if (!isObject(msg) || msg.jsonrpc !== '2.0') return rpcError(400, null, CODES.parse, 'Parse error: Invalid JSON-RPC message')
    const params = isObject(msg.params) ? msg.params : {}
    if (msg.method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      const version = (LEGACY_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_VERSION
      const session = `legacy-session-${String(++this.#n).padStart(4, '0')}`
      this.sessions.set(session, { endpoint: ep.path, version, initialized: false })
      return this.#answer(ep, msg.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: true } },
        serverInfo: LEGACY_SERVER_INFO,
        instructions: 'UPSTREAM TEXT: fixture server instructions.',
      }, { 'Mcp-Session-Id': session })
    }
    const bad = this.#session(req)
    if (bad) return bad
    const session = req.headers.get('Mcp-Session-Id')!
    if (!('id' in msg)) {
      if (msg.method === 'notifications/initialized') this.sessions.get(session)!.initialized = true
      return new Response(null, { status: 202 })
    }
    switch (msg.method) {
      case 'tools/list': {
        // 2025-11-25 pages too; the cursor is opaque.
        const offset = typeof params.cursor === 'string' && /^page-\d+$/.test(params.cursor) ? Number(params.cursor.slice(5)) : 0
        const page = this.#tools.slice(offset, offset + 2).map(t => t.def)
        return this.#answer(ep, msg.id, { tools: page, ...(offset + 2 < this.#tools.length ? { nextCursor: `page-${offset + 2}` } : {}) })
      }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        const args = isObject(params.arguments) ? params.arguments : {}
        const tool = this.#tools.find(t => t.def.name === name)
        if (!tool) return this.#answer(ep, msg.id, undefined, {}, { code: CODES.invalidParams, message: `Unknown tool: ${name}` })
        // A signed-in endpoint checks the tool's scope (2025-11-25 authorization "Scope Challenge Handling", RFC 6750
        // section 3.1): a token without it gets 403 insufficient_scope and the call never runs (#631).
        if (ep.auth.kind === 'signin' && tool.scope !== undefined) {
          const bearer = /^Bearer (.+)$/.exec(req.headers.get('Authorization') ?? '')?.[1]
          const scopes = bearer === undefined ? [] : (this.as.introspect(bearer)?.scopes ?? [])
          if (!scopes.includes(tool.scope)) {
            return new Response(null, { status: 403, headers: { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${tool.scope}", resource_metadata="${prmUrlOf(this.host, ep.path)}"` } })
          }
        }
        this.calls.push({ endpoint: ep.path, tool: name, args: structuredClone(args), session })
        const out = await tool.run(args, { endpoint: ep.path, declaredCapabilities: {}, params })
        if (out.kind !== 'result') return this.#answer(ep, msg.id, undefined, {}, { code: CODES.internal, message: 'unexpected outcome' })
        return this.#answer(ep, msg.id, { content: [{ type: 'text', text: JSON.stringify(out.value) }], isError: false })
      }
      case 'ping':
        return this.#answer(ep, msg.id, {})
      default:
        // A 2025 server answers an unknown method in band.
        return this.#answer(ep, msg.id, undefined, {}, { code: CODES.methodNotFound, message: 'Method not found' })
    }
  }

  /** Null when the request names a live session with a supported version header; else the official refusal. */
  #session(req: Request): Response | null {
    const sid = req.headers.get('Mcp-Session-Id')
    if (sid === null) return rpcError(400, null, CODES.legacyServer, 'Bad Request: Mcp-Session-Id header is required')
    if (!this.sessions.has(sid)) return rpcError(404, null, CODES.legacySessionNotFound, 'Session not found')
    const v = req.headers.get('MCP-Protocol-Version')
    if (v !== null && !(LEGACY_VERSIONS as readonly string[]).includes(v)) {
      return rpcError(400, null, CODES.legacyServer, `Bad Request: Unsupported protocol version: ${v} (supported versions: ${LEGACY_VERSIONS.join(', ')})`)
    }
    return null
  }

  #answer(ep: LegacyEndpoint, id: unknown, result?: Record<string, unknown>, headers: Record<string, string> = {}, error?: { code: number; message: string }): Response {
    const body = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }
    if (!ep.sse) return json(body, 200, headers)
    // 2025-11-25 "Sending Messages" 6: an event id with empty data first, then the answer, then the stream ends.
    const text = `id: ev-0\ndata: \n\n${sseEvent(body, 'ev-1')}`
    return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream', ...headers } })
  }
}

/** A 2025-11-25 `initialize` as a legacy client sends it (no version header on the handshake). */
export function legacyInitialize(url: string, id: number | string = 1, version: string = LEGACY_VERSION): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'fixture-legacy-client', version: '1.0.0' } } }),
  })
}

/** A later 2025-11-25 request on a session. */
export function legacyRequest(url: string, session: string | null, body: Record<string, unknown>, version: string = LEGACY_VERSION): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': version,
      ...(session !== null ? { 'Mcp-Session-Id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...body }),
  })
}
