// The egress's `hub` route (P4 H1): the runner's read path to the connector hub. A second MCP server, `apps`, over
// Streamable HTTP (POST with a JSON answer only), answered from the hub's `ReadGateway` service binding. The egress's
// dispatch checks the run token against the grant's `mcp` route first (so `/hub/` closes exactly when `mcp` does) and
// hands this handler the grant; the hub sees only the run's ids from that grant, never anything from the request body.
// Every hub tool is listed read only and without `_meta`, so none is loaded upfront: the model finds them through
// tool search. Specs read 2026-11-21: https://modelcontextprotocol.io/specification/2025-11-25/server/tools (`tools/list`,
// `tools/call`, `isError`, protocol vs tool execution errors), .../basic/transports (POST, 202 for a notification,
// `MCP-Protocol-Version`, `Origin`); https://code.claude.com/docs/en/agent-sdk/tool-search (tool search is on by
// default; a tool not marked `alwaysLoad` is deferred).
import { z } from 'zod'
import type { CallerScope, HubErrorCode, ReadGateway, ToolInfo } from '../../hub/index/contract.ts'
import type { RunGrant } from '../do/brand-agent/tokens.ts'
import { MCP_PROTOCOL_VERSIONS } from '../mcp/server/index.ts'
import { readCapped } from './http.ts'

/** The two read methods; the product Worker never binds the hub's `ServerGateway` (P4 OC 4). */
export type ReadGatewayLike = Pick<ReadGateway, 'listTools' | 'callTool'>

/** The JSON-RPC methods a log line may name; anything else is logged as `other` (never the caller's text). */
const LOGGED_METHODS = ['initialize', 'ping', 'tools/list', 'tools/call', 'notification'] as const
export type HubLogMethod = (typeof LOGGED_METHODS)[number] | 'other' | 'none'

/** What a log line's `code` may be: `ok`, a hub error code, or this route's own refusals. */
export type HubLogCode = 'ok' | HubErrorCode | 'binding_failed' | 'not_listed' | 'unknown_hub_code' | 'bad_request' | 'bad_params' | 'unknown_method' | 'method_not_allowed' | 'not_found' | 'too_large'

/** One line per call, these fields only: never the token, its hash, arguments, results, documents or hub messages. */
export type HubEgressLog = {
  event: 'egress_hub'
  method: HubLogMethod
  /** A hub tool's name only when a hub list from this isolate named it, else `unknown`. */
  tool?: string
  code: HubLogCode
  ms: number
  turnId: string
}
const LOG_FIELDS: readonly (keyof HubEgressLog)[] = ['event', 'method', 'tool', 'code', 'ms', 'turnId']

export interface HubRouteDeps {
  hub: ReadGatewayLike
  now(): number
  requestId(): string
  log(e: HubEgressLog): void
}

/** The real deps for the egress (the dispatch passes `env.HUB`). */
export function hubRouteDeps(hub: ReadGatewayLike, log: (e: Record<string, unknown>) => void): HubRouteDeps {
  return { hub, now: () => Date.now(), requestId: () => crypto.randomUUID(), log }
}

/**
 * What the model reads when a call names a tool the hub's read list doesn't (N14): only reading tools run here. Writes go
 * through the `actions` server and a person's OK (server/egress/actions.ts), never through `apps`.
 */
export const NOT_LISTED_TEXT = "not_listed: this tool isn't available to run right now, so it didn't run and nothing outside Inhouse was changed. Only reading tools run here, and only while their app is connected: if the person expected it to work, ask them to check its app in Tools (it may be paused or need a reconnect)."
/** The model's text when the hub's read list couldn't be read (fail closed). */
const LIST_FAILED_TEXT = 'internal: the tool list could not be read, so the call did not run'

export const HUB_PATH = '/hub/'
export const HUB_MAX_BODY_BYTES = 64 * 1024
export const HUB_SERVER_INFO = { name: 'apps', version: '1.0.0' } as const

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

type Id = string | number

// The zod mirror of the hub's answers (contract.ts types; the hub's own schemas.ts isn't imported, so the product
// Worker takes no hub dependency). Anything that doesn't parse is a binding failure. Plain objects that strip unknown
// keys, and any string as an error code: a hub deployed ahead of the product Worker (a new field, a new code) keeps
// working; an unknown code is answered as `internal`.
const HUB_ERROR_CODES: readonly HubErrorCode[] = [
  'invalid_args', 'unknown_tool', 'write_refused', 'not_configured', 'credentials_rejected', 'scope_mismatch', 'key_unavailable',
  'upstream_unavailable', 'upstream_rejected', 'upstream_version_mismatch', 'rate_limited', 'result_too_large', 'internal',
  'state_invalid', 'workspace_mismatch', 'connect_stale', 'connect_refused', 'paused',
]
const isHubCode = (c: string): c is HubErrorCode => (HUB_ERROR_CODES as readonly string[]).includes(c)
const HubErrorMirror = z.object({ code: z.string(), message: z.string(), retryAfterMs: z.number().optional() })
const resultMirror = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value }), z.object({ ok: z.literal(false), error: HubErrorMirror })])
const ToolInfoMirror = z.object({ name: z.string(), connector: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()) })
const listMirror = resultMirror(z.array(ToolInfoMirror))
const callMirror = resultMirror(z.object({ data: z.unknown() }))

/** The most of the hub's message the model reads (defence in depth: the hub's is already a fixed text). */
export const HUB_MESSAGE_MAX_CHARS = 500
const CUT_MARKER = ' [cut]'

/** Tool names a hub list from this isolate has named: the only tool names a log line carries. */
const knownTools = new Set<string>()
/** Tests only: forget the names, so no test depends on another's list. */
export function resetKnownToolsForTests(): void {
  knownTools.clear()
}

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } })
const rpcError = (id: Id | null, code: number, message: string, status = 200) => json({ jsonrpc: '2.0', id, error: { code, message } }, status)
const rpcResult = (id: Id, result: unknown) => json({ jsonrpc: '2.0', id, result })
const accepted = () => new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } })

const isId = (v: unknown): v is Id => typeof v === 'string' || (typeof v === 'number' && Number.isInteger(v))
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A `tools/list` entry: read only, and no `_meta` at all (never `anthropic/alwaysLoad`). */
export function listedTool(t: ToolInfo) {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true } }
}

/** A hub error as the model reads it (a tool execution error); the message capped at HUB_MESSAGE_MAX_CHARS. */
export function errorText(e: { code: HubErrorCode; message: string; retryAfterMs?: number }): string {
  const retry = e.code === 'rate_limited' && e.retryAfterMs !== undefined ? ` (retry after ${Math.ceil(e.retryAfterMs / 1000)} s)` : ''
  const message = e.message.length > HUB_MESSAGE_MAX_CHARS ? `${e.message.slice(0, HUB_MESSAGE_MAX_CHARS)}${CUT_MARKER}` : e.message
  return `${e.code}: ${message}${retry}`
}
const INTERNAL_TEXT = 'internal: internal error'

/** One MCP POST to `/hub/`, answered from the hub as the grant's run. */
export async function handleHub(request: Request, grant: RunGrant, deps: HubRouteDeps): Promise<Response> {
  const started = deps.now()
  let method: HubLogMethod = 'none'
  let tool: string | undefined
  const done = (code: HubLogCode, response: Response): Response => {
    const line: HubEgressLog = { event: 'egress_hub', method, ...(tool !== undefined ? { tool } : {}), code, ms: Math.max(0, deps.now() - started), turnId: grant.turnId }
    // The runtime allowlist behind the type: a field nobody listed never reaches the log.
    const out: Record<string, unknown> = {}
    for (const k of LOG_FIELDS) if (typeof line[k] === 'string' || typeof line[k] === 'number') out[k] = line[k]
    deps.log(out as unknown as HubEgressLog)
    return response
  }

  if (new URL(request.url).pathname !== HUB_PATH) return done('not_found', json({ error: 'not_found' }, 404))
  if (request.method !== 'POST') return done('method_not_allowed', json({ error: 'method' }, 405, { Allow: 'POST' }))
  // The transport's DNS-rebinding rule: nothing in a container sends an `Origin`, so any Origin is refused.
  if (request.headers.has('Origin')) return done('bad_request', rpcError(null, INVALID_REQUEST, 'Origin not allowed', 403))
  const version = request.headers.get('MCP-Protocol-Version')
  if (version !== null && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) return done('bad_request', rpcError(null, INVALID_REQUEST, 'Unsupported MCP-Protocol-Version', 400))
  const type = request.headers.get('Content-Type')?.split(';', 1)[0]!.trim().toLowerCase()
  if (type !== 'application/json') return done('bad_request', rpcError(null, INVALID_REQUEST, 'Content-Type must be application/json', 415))

  const bytes = await readCapped(request, HUB_MAX_BODY_BYTES)
  if (bytes === null) return done('too_large', rpcError(null, INVALID_REQUEST, 'Body too large', 413))
  let message: unknown
  try {
    message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return done('bad_request', rpcError(null, PARSE_ERROR, 'Parse error', 400))
  }
  if (Array.isArray(message)) return done('bad_request', rpcError(null, INVALID_REQUEST, 'Batches are not supported: send one message per POST', 400))
  if (!isObject(message) || message.jsonrpc !== '2.0') return done('bad_request', rpcError(null, INVALID_REQUEST, 'Invalid Request', 400))

  if (typeof message.method !== 'string') {
    // A client's response to a server request (this server sends none): accepted, nothing to do.
    if ('id' in message && ('result' in message || 'error' in message)) return done('ok', accepted())
    return done('bad_request', rpcError(null, INVALID_REQUEST, 'Invalid Request', 400))
  }
  if (!('id' in message)) {
    method = 'notification'
    return done('ok', accepted())
  }
  method = (LOGGED_METHODS as readonly string[]).includes(message.method) ? (message.method as HubLogMethod) : 'other'
  if (!isId(message.id)) return done('bad_request', rpcError(null, INVALID_REQUEST, 'Invalid Request: id must be a string or an integer', 400))
  const id = message.id
  const params = message.params
  if (params !== undefined && !isObject(params)) return done('bad_params', rpcError(id, INVALID_PARAMS, 'params must be an object'))

  // The run's ids from the grant, a fresh request id per call; never a chat id, a token or anything from the body.
  const scope = (): CallerScope => ({ kind: 'run', runId: grant.runId, principalId: grant.memberId, requestId: deps.requestId() })

  switch (message.method) {
    case 'initialize': {
      const asked = params?.protocolVersion
      if (typeof asked !== 'string') return done('bad_params', rpcError(id, INVALID_PARAMS, 'initialize needs params.protocolVersion'))
      const agreed = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0]
      return done('ok', rpcResult(id, { protocolVersion: agreed, capabilities: { tools: {} }, serverInfo: HUB_SERVER_INFO }))
    }
    case 'ping':
      return done('ok', rpcResult(id, {}))
    case 'tools/list': {
      // No pagination: the hub's list is short, and a `cursor` is ignored.
      let answer: unknown
      try {
        answer = await deps.hub.listTools(scope())
      } catch {
        return done('binding_failed', rpcError(id, INTERNAL_ERROR, 'hub: internal', 503))
      }
      const parsed = listMirror.safeParse(answer)
      if (!parsed.success) return done('binding_failed', rpcError(id, INTERNAL_ERROR, 'hub: internal'))
      if (!parsed.data.ok) {
        const code = parsed.data.error.code
        if (!isHubCode(code)) return done('unknown_hub_code', rpcError(id, INTERNAL_ERROR, 'hub: internal'))
        return done(code, rpcError(id, INTERNAL_ERROR, `hub: ${code}`))
      }
      for (const t of parsed.data.value) knownTools.add(t.name)
      return done('ok', rpcResult(id, { tools: parsed.data.value.map(listedTool) }))
    }
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments
      if (typeof name !== 'string' || (args !== undefined && !isObject(args))) {
        return done('bad_params', rpcError(id, INVALID_PARAMS, 'tools/call needs params.name (a string) and params.arguments (an object, if given)'))
      }
      tool = knownTools.has(name) ? name : 'unknown'
      // The read-list check (N14), on every call: a tool runs only when the hub's read list, read now, names it. The
      // hub's ReadGateway refuses a write itself; this check doesn't rest on that, so a hub that grows a write tool still
      // runs none here. Writes reach the hub only through the outbox's dispatcher.
      let listed: unknown
      try {
        listed = await deps.hub.listTools(scope())
      } catch {
        return done('binding_failed', rpcResult(id, { content: [{ type: 'text', text: LIST_FAILED_TEXT }], isError: true }))
      }
      const reads = listMirror.safeParse(listed)
      if (!reads.success || !reads.data.ok) return done('binding_failed', rpcResult(id, { content: [{ type: 'text', text: LIST_FAILED_TEXT }], isError: true }))
      if (!reads.data.value.some(t => t.name === name)) {
        return done('not_listed', rpcResult(id, { content: [{ type: 'text', text: NOT_LISTED_TEXT }], isError: true }))
      }
      let answer: unknown
      try {
        answer = await deps.hub.callTool(scope(), name, args ?? {})
      } catch {
        return done('binding_failed', rpcResult(id, { content: [{ type: 'text', text: INTERNAL_TEXT }], isError: true }))
      }
      const parsed = callMirror.safeParse(answer)
      if (!parsed.success) return done('binding_failed', rpcResult(id, { content: [{ type: 'text', text: INTERNAL_TEXT }], isError: true }))
      if (!parsed.data.ok) {
        const error = parsed.data.error
        if (!isHubCode(error.code)) return done('unknown_hub_code', rpcResult(id, { content: [{ type: 'text', text: INTERNAL_TEXT }], isError: true }))
        return done(error.code, rpcResult(id, { content: [{ type: 'text', text: errorText({ ...error, code: error.code }) }], isError: true }))
      }
      // A value JSON can't carry (a BigInt, a cycle) is a binding failure, never an uncaught 500.
      let text: string
      try {
        text = JSON.stringify(parsed.data.value.data) ?? 'null'
      } catch {
        return done('binding_failed', rpcResult(id, { content: [{ type: 'text', text: INTERNAL_TEXT }], isError: true }))
      }
      return done('ok', rpcResult(id, { content: [{ type: 'text', text }] }))
    }
    default:
      return done('unknown_method', rpcError(id, METHOD_NOT_FOUND, 'Method not found'))
  }
}
