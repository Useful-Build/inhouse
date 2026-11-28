// The hub's MCP client over the official SDK (Stage 1 M4-C1, N36): @modelcontextprotocol/client 2.4.0, pinned exactly,
// protocol only. The hub's one MCP client: Slack and the notes fixture call it through reviewed-call.ts (M4-C2).
// One operation (a list or a call) is one short-lived Client and transport, closed when it settles.
//
// What it relies on in the SDK (read in the package's own source maps on 2026-11-28; src/client/client.ts,
// streamableHttp.ts, versionNegotiation.ts, probeClassifier.ts, core-internal shared/protocol.ts):
// - `versionNegotiation` defaults to `'legacy'` (no probe, 2025 `initialize` only), so it is set to `{ mode: 'auto' }`:
//   `connect()` probes with `server/discover`, adopts a modern era on a discover result or a -32022 that names a modern
//   version (one corrective re-probe), and falls back to `initialize` on anything else it doesn't recognise. On top of
//   that, our fetch (oauth/http.ts `mcpFetch`) refuses `initialize` once any answer carried a modern error, so a modern
//   error is never followed by the legacy handshake; only a discover result or a -32022 naming a modern version makes the
//   era cache say `modern`.
// - `connect({ prior })` adopts a cached verdict with no round trip (modern) or runs the plain handshake (legacy). The
//   cache (`EraCache`) is in object memory, bound to the endpoint and the credential generation, and expires with the
//   discover result's `ttlMs` (capped at an hour). A list always probes afresh (so a list refreshes it) unless the caller
//   pins the era as legacy (`sdkListTools`'s `era`; the Slack probe, #700).
// - The transport gets no auth provider (so the SDK's `auth()` never runs: no token endpoint, no `console.warn`, no saved
//   or dropped login) and `onInsufficientScope: 'throw'` (the SDK's default is `'reauthorize'`). Our fetch attaches the
//   credential; a 401 or 403 comes back to the caller as it is. Its SSE reconnection is off (`maxRetries: 0`).
// - `callTool` lists and retries on `HeaderMismatch` by itself unless it is given `toolDefinition` (client.ts, "SEP-2243
//   one-refresh-on-miss"), so every call passes the confirmed definition. Only `name` and `inputSchema` go: output-schema
//   validation stays off (the hub reads text parts only), so a definition's `outputSchema` can't fail a call after it ran.
// - `inputRequired: { autoFulfill: false }` with `allowInputRequired: true` per call hands an `input_required` result back
//   instead of answering it; the hub declares no capability (no elicitation, sampling or roots).
// - Lists go through `client.request({ method: 'tools/list' })` page by page, never `listTools()`: that one serves the
//   SDK's response cache and writes `console.debug` / `console.warn` lines, and our refresh must always reach the wire.
//
// Recovery is the hub's, never the SDK's, and each branch has a wire-count test (sdk.test.ts):
// - a read whose answer was lost is sent once more, with a new id; so is a read answered `input_required` with only
//   `requestState`; so is a read on a reused 2025 session the server no longer knows (404), on a new session;
// - a write is exactly one `tools/call` POST, whatever comes back (our fetch also caps it at one). A write on a 2025
//   server starts its own session. `sent: 'no'` only when no `tools/call` POST left the hub.
// No console output, and nothing from an upstream body, header or error message reaches a result.
//
// Bounds: each request has `mcpFetch`'s deadline and byte cap; a whole list also has a total budget (`LIST_BUDGET`:
// every page's bytes and the time since its first request), so 50 pages can't hold 50 times either (#648). Output-schema
// validation can't run: the Client gets a validator that throws (`refusingValidator`), so the workerd shim's default
// (`@cfworker/json-schema`) is never used, and the definition we pass carries no `outputSchema` anyway.
//
// NOT here: a public-address check. `mcpFetch` sends to the exact endpoint it is given and checks scheme, credentials
// in the URL and the path, but not whether the host resolves to a private address; M4-R1's `connections/destinations.ts`
// owns that (N35: the address check, with its DNS-to-connect limit) before an endpoint ever reaches this module.

import { Client, isInputRequiredResult, type ClientOptions, type jsonSchemaValidator, type DiscoverResult, type PriorDiscovery, type StreamableHTTPClientTransportOptions, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client'
import type { McpToolResult } from '../../registry/registry'
import { MCP_MAX_BYTES, MCP_TIMEOUT_MS, mcpFetch, type McpCredential, type McpFetch, type Upstream, type WireEvent } from '../../oauth/http'

export const SDK_CLIENT_INFO = { name: 'Inhouse', version: '1.0.0' } as const
/** A cached era is used for at most this long, whatever the server's `ttlMs` says. */
export const ERA_TTL_MS = 3_600_000
/** The SDK's own request timeout sits past our fetch's deadline, so ours always fires first. */
const SDK_GRACE_MS = 1_000
/** A list longer than this many pages is refused (a cursor that never ends). */
export const MAX_LIST_PAGES = 50
/** A whole list (probe, handshake and every page): at most this many answer bytes, and this long from its first request. */
export const LIST_BUDGET = { bytes: 8 * 1024 * 1024, ms: 60_000 } as const

const LIST_METHODS: ReadonlySet<string> = new Set(['server/discover', 'initialize', 'notifications/initialized', 'tools/list'])
const CALL_METHODS: ReadonlySet<string> = new Set(['server/discover', 'initialize', 'notifications/initialized', 'tools/call'])

export type Era = 'modern' | 'legacy'

/** The era verdicts this object has seen, by endpoint and credential generation. Never stored. */
export class EraCache {
  #entries = new Map<string, { prior: PriorDiscovery; expiresAtMs: number }>()
  static key = (endpoint: string, generation: number) => `${generation}|${endpoint}`
  get(endpoint: string, generation: number, nowMs: number): PriorDiscovery | null {
    const e = this.#entries.get(EraCache.key(endpoint, generation))
    return e && nowMs < e.expiresAtMs ? e.prior : null
  }
  set(endpoint: string, generation: number, prior: PriorDiscovery, expiresAtMs: number): void {
    this.#entries.set(EraCache.key(endpoint, generation), { prior, expiresAtMs })
  }
  drop(endpoint: string, generation: number): void {
    this.#entries.delete(EraCache.key(endpoint, generation))
  }
}

/** Where an operation goes, and with what. `credential` goes only to `endpoint`'s exact URL. */
export type McpTarget = { endpoint: string; generation: number; credential: McpCredential | null }

export type SdkDeps = {
  upstream: Upstream
  now: () => number
  eras: EraCache
  timeoutMs?: number
  maxBytes?: number
  /** A list's total budget (default `LIST_BUDGET`). */
  listBudget?: { bytes: number; ms: number }
}

/** A 2025-era session kept in object memory for reads (writes never reuse one). */
export type LegacySession = { endpoint: string; generation: number; id: string; protocolVersion: string }

export type McpFailure =
  /** Our fetch refused it: not the endpoint, or a request this operation may not send. */
  | 'blocked'
  | 'unauthorized'
  | 'forbidden'
  | 'insufficient_scope'
  | 'rate_limited'
  /** A 5xx, a redirect, a network failure, or an answer that wasn't MCP. */
  | 'unavailable'
  /** The request left and its answer didn't arrive whole (the deadline, a broken body or stream). */
  | 'lost'
  | 'too_large'
  | 'malformed'
  | 'header_mismatch'
  /** -32022: the server doesn't speak the version we used (the era cache is dropped). */
  | 'version'
  /** Any other JSON-RPC error, or a 4xx. */
  | 'rejected'
  /** The tool answered `isError: true`. */
  | 'tool_error'
  /** The server asked for input the hub doesn't give, or (a write) answered `input_required` at all. */
  | 'needs_input'
  /** A list ran past its total byte or time budget (#648). */
  | 'over_budget'

export type McpFail = {
  kind: 'error'
  reason: McpFailure
  /** `no` only when no `tools/call` POST left the hub (always `no` for a list). */
  sent: 'no' | 'unknown'
  retryAfterMs?: number
  wire: WireEvent[]
}

/** `excluded`: tools left out for an invalid `x-mcp-header` declaration. */
export type McpListOk = { kind: 'ok'; tools: Tool[]; excluded: number; era: Era; wire: WireEvent[] }
export type McpCallOk = { kind: 'ok'; result: McpToolResult; dropped: number; era: Era; session: LegacySession | null; wire: WireEvent[] }

/** Output-schema validation is off in the hub: anything that asks for a validator gets a throw, never a check. */
export const refusingValidator: jsonSchemaValidator = {
  getValidator() {
    throw new Error('output-schema validation is off in the hub')
  },
}

/** The Client's options (exported so a test pins each one). */
export function clientOptions(timeoutMs: number): ClientOptions {
  return {
    capabilities: {},
    jsonSchemaValidator: refusingValidator,
    versionNegotiation: { mode: 'auto', probe: { timeoutMs: timeoutMs + SDK_GRACE_MS, maxRetries: 0 } },
    inputRequired: { autoFulfill: false },
  }
}

/** The transport's options (exported so a test pins each one). No `authProvider`, ever. */
export function transportOptions(fetch: McpFetch, session: LegacySession | null): StreamableHTTPClientTransportOptions {
  return {
    fetch,
    onInsufficientScope: 'throw',
    reconnectionOptions: { initialReconnectionDelay: 1_000, maxReconnectionDelay: 30_000, reconnectionDelayGrowFactor: 1.5, maxRetries: 0 },
    ...(session ? { sessionId: session.id, protocolVersion: session.protocolVersion } : {}),
  }
}

type Op = {
  fetch: McpFetch
  record: WireEvent[]
  abort: AbortController
  timeoutMs: number
  /** What a lost answer does now: cancels the waiting request; while connecting, closes the transport too (#652). */
  lost: () => void
}

function operation(deps: SdkDeps, target: McpTarget, allow: ReadonlySet<string>, maxCalls: number, budget?: { bytes: number; ms: number }): Op {
  const record: WireEvent[] = []
  const timeoutMs = deps.timeoutMs ?? MCP_TIMEOUT_MS
  const op: Op = { fetch: null as unknown as McpFetch, record, abort: new AbortController(), timeoutMs, lost: () => {} }
  op.lost = () => op.abort.abort(new DOMException('answer lost', 'AbortError'))
  op.fetch = mcpFetch(deps.upstream, {
    endpoint: target.endpoint,
    credential: target.credential,
    allow,
    maxCalls,
    timeoutMs,
    maxBytes: deps.maxBytes ?? MCP_MAX_BYTES,
    record,
    ...(budget ? { budget } : {}),
    // A stream that ended or broke without its answer: the SDK's request is cancelled now, not at its own timeout.
    onLost: () => op.lost(),
  })
  return op
}

function connection(op: Op, target: McpTarget, session: LegacySession | null): { client: Client; transport: StreamableHTTPClientTransport } {
  return {
    client: new Client({ ...SDK_CLIENT_INFO }, clientOptions(op.timeoutMs)),
    transport: new StreamableHTTPClientTransport(new URL(target.endpoint), transportOptions(op.fetch, session)),
  }
}

const requestOptions = (op: Op) => ({ timeout: op.timeoutMs + SDK_GRACE_MS, signal: op.abort.signal })

/**
 * `client.connect`, failing fast when an answer is lost on the way. The SDK's probe (versionNegotiation.ts ProbeWindow)
 * waits on its own timer and never reads the connect signal, but it settles at once when the transport closes; so while
 * connecting, a lost answer closes the transport (#652).
 */
async function connect(op: Op, conn: { client: Client; transport: StreamableHTTPClientTransport }, prior: PriorDiscovery | null): Promise<void> {
  const cancel = op.lost
  op.lost = () => {
    cancel()
    void conn.transport.close()
  }
  try {
    await conn.client.connect(conn.transport, { ...requestOptions(op), ...(prior ? { prior } : {}) })
  } finally {
    op.lost = cancel
  }
}

/** The 2026-07-28 rule for `x-mcp-header` (streamable-http "Custom Headers from Tool Parameters"), as the SDK reads it. */
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const HEADER_TYPES = new Set(['string', 'integer', 'boolean'])
const UNREACHABLE_KEYWORDS = ['items', 'prefixItems', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'patternProperties', 'dependentSchemas', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', '$defs', 'definitions']
const MAP_KEYWORDS = new Set(['patternProperties', 'dependentSchemas', '$defs', 'definitions'])

/**
 * Whether a tool's `x-mcp-header` declarations are valid: each on a property reached only through `properties`, a
 * non-empty RFC 9110 token, on a string, integer or boolean, unique without regard to case. A client MUST leave out a
 * tool that breaks it (#650). The same walk as the SDK's own `scanXMcpHeaderDeclarations` (core-internal
 * shared/mcpParamHeaders.ts, 2.4.0), which its package doesn't export, so `listTools()` was its only caller.
 */
export function validMcpHeaders(inputSchema: unknown): boolean {
  const seen = new Set<string>()
  const visit = (node: unknown, depth: number, reachable: boolean): boolean => {
    if (node === null || typeof node !== 'object') return true
    if (depth > 64) return false
    const schema = node as Record<string, unknown>
    if ('x-mcp-header' in schema) {
      const name = schema['x-mcp-header']
      if (!reachable || depth === 0 || typeof name !== 'string' || !HEADER_TOKEN.test(name)) return false
      if (typeof schema.type !== 'string' || !HEADER_TYPES.has(schema.type)) return false
      if (seen.has(name.toLowerCase())) return false
      seen.add(name.toLowerCase())
    }
    if (schema.properties !== null && typeof schema.properties === 'object') {
      for (const child of Object.values(schema.properties as Record<string, unknown>)) if (!visit(child, depth + 1, reachable)) return false
    }
    for (const k of UNREACHABLE_KEYWORDS) {
      const sub = schema[k]
      if (sub === undefined) continue
      const branches = Array.isArray(sub) ? sub : sub !== null && typeof sub === 'object' && MAP_KEYWORDS.has(k) ? Object.values(sub as Record<string, unknown>) : [sub]
      for (const b of branches) if (!visit(b, depth + 1, false)) return false
    }
    return true
  }
  return visit(inputSchema, 0, true)
}

/** The era the client settled on, cached for the next operation (a probe's verdict only). */
function remember(deps: SdkDeps, target: McpTarget, client: Client): Era | null {
  const era = client.getProtocolEra()
  if (era === 'modern') {
    const discover = client.getDiscoverResult() as (DiscoverResult & { ttlMs?: unknown }) | undefined
    if (!discover) return null
    const ttl = typeof discover.ttlMs === 'number' && Number.isFinite(discover.ttlMs) ? Math.min(discover.ttlMs, ERA_TTL_MS) : 0
    if (ttl > 0) deps.eras.set(target.endpoint, target.generation, { kind: 'modern', discover }, deps.now() + ttl)
    else deps.eras.drop(target.endpoint, target.generation)
    return 'modern'
  }
  if (era === 'legacy') {
    deps.eras.set(target.endpoint, target.generation, { kind: 'legacy' }, deps.now() + ERA_TTL_MS)
    return 'legacy'
  }
  return null
}

const toolCallSent = (record: WireEvent[]) => record.some(e => e.rpc === 'tools/call' && e.fate === 'sent')

/** Why the last request that left failed, read from the wire record (never from an SDK error's text). */
export function failureOf(event: WireEvent | undefined): { reason: McpFailure; retryAfterMs?: number } {
  if (!event || event.fate !== 'sent') return { reason: 'blocked' }
  switch (event.answer) {
    case 'network':
      return { reason: 'unavailable' }
    case 'lost':
    case 'open':
      return { reason: 'lost' }
    case 'too_large':
      return { reason: 'too_large' }
    case 'malformed':
      return { reason: 'malformed' }
    case undefined:
      return { reason: 'lost' }
    case 'response':
      break
  }
  const status = event.status ?? 0
  if (status === 401) return { reason: 'unauthorized' }
  if (status === 403) return { reason: event.insufficientScope ? 'insufficient_scope' : 'forbidden' }
  if (status === 429) return event.retryAfterMs === undefined ? { reason: 'rate_limited' } : { reason: 'rate_limited', retryAfterMs: event.retryAfterMs }
  if (status >= 500 || (status >= 300 && status < 400) || status < 200) return { reason: 'unavailable' }
  if (event.rpcCode === -32020) return { reason: 'header_mismatch' }
  if (event.rpcCode === -32022) return { reason: 'version' }
  if (event.rpcCode !== undefined || status >= 400) return { reason: 'rejected' }
  // A 2xx the SDK couldn't use (not JSON-RPC, a result that failed its schema).
  return { reason: 'malformed' }
}

const lastSent = (record: WireEvent[], rpc?: string) => [...record].reverse().find(e => e.fate === 'sent' && (rpc === undefined || e.rpc === rpc))

function fail(op: Op, reason: McpFailure, retryAfterMs?: number): McpFail {
  return { kind: 'error', reason, sent: toolCallSent(op.record) ? 'unknown' : 'no', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), wire: op.record }
}

function failFrom(op: Op, deps: SdkDeps, target: McpTarget, rpc?: string): McpFail {
  if (op.record.some(e => e.overBudget)) return fail(op, 'over_budget')
  const f = failureOf(rpc ? (lastSent(op.record, rpc) ?? lastSent(op.record)) : lastSent(op.record))
  if (f.reason === 'version') deps.eras.drop(target.endpoint, target.generation)
  return fail(op, f.reason, f.retryAfterMs)
}

/**
 * Every tool an endpoint lists, page by page, from the wire. Negotiates afresh (a probe, or the 2025 handshake), and
 * caches the era it found; `era: 'legacy'` pins the plain 2025 handshake, so no `server/discover` is sent.
 */
export async function sdkListTools(deps: SdkDeps, target: McpTarget, opts: { era?: 'legacy' } = {}): Promise<McpListOk | McpFail> {
  const op = operation(deps, target, LIST_METHODS, 0, deps.listBudget ?? LIST_BUDGET)
  const { client, transport } = connection(op, target, null)
  try {
    try {
      await connect(op, { client, transport }, opts.era === 'legacy' ? { kind: 'legacy' } : null)
    } catch {
      deps.eras.drop(target.endpoint, target.generation)
      return failFrom(op, deps, target)
    }
    const era = remember(deps, target, client)
    if (!era) return fail(op, 'malformed')
    if (!client.getServerCapabilities()?.tools) return { kind: 'ok', tools: [], excluded: 0, era, wire: op.record }
    const tools: Tool[] = []
    let excluded = 0
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; ; page++) {
      if (page >= MAX_LIST_PAGES) return fail(op, 'malformed')
      let res: { tools: Tool[]; nextCursor?: string }
      try {
        res = await client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } }, requestOptions(op))
      } catch {
        return failFrom(op, deps, target, 'tools/list')
      }
      // A tool whose x-mcp-header declarations break the rule is left out, and counted (#650).
      for (const t of res.tools) {
        if (validMcpHeaders(t.inputSchema)) tools.push(t)
        else excluded++
      }
      if (res.nextCursor === undefined) break
      if (seen.has(res.nextCursor)) return fail(op, 'malformed')
      seen.add(res.nextCursor)
      cursor = res.nextCursor
    }
    return { kind: 'ok', tools, excluded, era, wire: op.record }
  } finally {
    await client.close()
  }
}

export type McpToolCall = {
  /** The confirmed definition (only its `name` and `inputSchema` are used: `Mcp-Name` and `Mcp-Param-*` mirroring). */
  tool: Pick<Tool, 'name' | 'inputSchema'>
  args: Record<string, unknown>
  /** `read` only for a tool the Inhouse team confirmed as a read. */
  mode: 'read' | 'write'
  /** A 2025-era session from an earlier read on this endpoint and generation; ignored for a write. */
  session?: LegacySession | null
}

/** Text parts only; other part types are dropped and counted. Null when `content` isn't a list. */
function textOf(result: Record<string, unknown>): { result: McpToolResult; dropped: number } | null {
  if (!Array.isArray(result.content)) return null
  const content: McpToolResult['content'] = []
  let dropped = 0
  for (const part of result.content as unknown[]) {
    const p = part as { type?: unknown; text?: unknown }
    if (typeof p === 'object' && p !== null && p.type === 'text' && typeof p.text === 'string') content.push({ type: 'text', text: p.text })
    else dropped++
  }
  return { result: { content }, dropped }
}

/**
 * One `tools/call`. The era comes from the cache or from a probe before the call, never from re-sending it. See the
 * module header for the recovery rules.
 */
export async function sdkCallTool(deps: SdkDeps, target: McpTarget, call: McpToolCall): Promise<McpCallOk | McpFail> {
  const read = call.mode === 'read'
  const op = operation(deps, target, CALL_METHODS, read ? 2 : 1)
  const reuse = read && call.session && call.session.endpoint === target.endpoint && call.session.generation === target.generation ? call.session : null
  let recovered = false
  let conn = connection(op, target, reuse)
  let usedSession = reuse
  const definition = { name: call.tool.name, inputSchema: call.tool.inputSchema } as Tool

  const open = async (session: LegacySession | null): Promise<McpFail | Era> => {
    const prior: PriorDiscovery | null = session ? { kind: 'legacy' } : deps.eras.get(target.endpoint, target.generation, deps.now())
    try {
      await connect(op, conn, prior)
    } catch {
      deps.eras.drop(target.endpoint, target.generation)
      return failFrom(op, deps, target)
    }
    if (session) return 'legacy'
    if (prior) return prior.kind
    return remember(deps, target, conn.client) ?? fail(op, 'malformed')
  }

  try {
    let era = await open(reuse)
    if (typeof era !== 'string') return era
    let params: Record<string, unknown> = { name: call.tool.name, arguments: call.args }
    for (;;) {
      let res: Record<string, unknown>
      try {
        res = (await conn.client.callTool(params as { name: string; arguments: Record<string, unknown> }, { ...requestOptions(op), toolDefinition: definition, allowInputRequired: true })) as Record<string, unknown>
      } catch {
        const last = lastSent(op.record, 'tools/call')
        const f = failureOf(last)
        if (read && !recovered && last && f.reason === 'lost') {
          // A lost read is sent once more, on the same connection, with a new id (the SDK numbers each request).
          recovered = true
          if (op.abort.signal.aborted) op.abort = new AbortController()
          continue
        }
        if (read && !recovered && usedSession && last?.status === 404) {
          // The server no longer knows the reused 2025 session (2025-11-25 transports, "Session Management" 4): the
          // call never ran there. Start a new session and send it once more.
          recovered = true
          await conn.client.close()
          conn = connection(op, target, null)
          usedSession = null
          era = await open(null)
          if (typeof era !== 'string') return era
          continue
        }
        // An answer that may mean the cached era is wrong: the next operation probes again (never this call).
        if (f.reason === 'version' || f.reason === 'rejected' || f.reason === 'malformed') deps.eras.drop(target.endpoint, target.generation)
        return fail(op, f.reason, f.retryAfterMs)
      }
      if (isInputRequiredResult(res)) {
        const asks = typeof res.inputRequests === 'object' && res.inputRequests !== null && Object.keys(res.inputRequests).length > 0
        if (read && !recovered && !asks && typeof res.requestState === 'string') {
          // State only (2026-07-28 basic/patterns/mrtr): retried at once, echoing the state, on a new id.
          recovered = true
          params = { name: call.tool.name, arguments: call.args, requestState: res.requestState }
          continue
        }
        return fail(op, 'needs_input')
      }
      if (res.isError === true) return fail(op, 'tool_error')
      const text = textOf(res)
      if (!text) return fail(op, 'malformed')
      const sid = conn.transport.sessionId
      const version = conn.client.getNegotiatedProtocolVersion() ?? usedSession?.protocolVersion
      const session = read && era === 'legacy' && sid !== undefined && version !== undefined ? { endpoint: target.endpoint, generation: target.generation, id: sid, protocolVersion: version } : null
      return { kind: 'ok', result: text.result, dropped: text.dropped, era, session, wire: op.record }
    }
  } finally {
    await conn.client.close()
  }
}
