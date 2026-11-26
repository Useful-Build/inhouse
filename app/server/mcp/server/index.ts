// The `inhouse` MCP server (p3-design sections 8.4 and 10, W6): stateless MCP over Streamable HTTP, POST with a JSON
// answer only. Hand-written and small (CHOICE in the design): `initialize` with version negotiation, `ping`,
// `tools/list` and `tools/call`; a notification or a client response is 202 with no body; GET, DELETE and anything else
// is 405 (no SSE stream, no sessions). The egress calls it with the run token's grant, so every call acts as the run's
// person and nobody else. Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports and
// .../basic/lifecycle (version negotiation), .../server/tools (results, `isError`), read 2026-11-20.
import { safeError } from '../../safe-error.ts'
import { z } from 'zod'
import { readCapped } from '../../db/handler-kit.ts'
import { StoreUnavailableError } from '../../db/sql.ts'
import { ALWAYS_LOAD_META_KEY, INHOUSE_TOOLS } from '../registry.ts'
import { TOOL_HANDLERS } from '../tools/index.ts'
import { refusal } from './tool.ts'
import type { ToolScope } from './tool.ts'
import type { ApprovalsWiring } from '../tools/approvals/index.ts'
import type { NotifyDeps } from '../tools/notifications/deps.ts'

/** The protocol versions this server speaks, newest first; an `initialize` asking for another gets the newest. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const

/** The run's ids, from the run token's grant (the egress); never from the request. */
export interface McpScope {
  memberId: string
  chatId: string
  runId: string
  turnId: string
}

export interface McpDeps {
  db: D1Database
  // P5 (p5-w4): passed on to the tools as it is (opaque; built by `notifyDeps(env)`).
  notify?: NotifyDeps
  // Stage 1 M2-D: approval_request's wiring, passed on as it is (egress/actions.ts `approvalsWiring`).
  approvals?: ApprovalsWiring
  /** Epoch ms; the real clock by default (tests pass their own). */
  now?: () => number
}

/** The largest body a call may send. */
const MAX_BODY_BYTES = 256 * 1024

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

type Id = string | number

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const rpcError = (id: Id | null, code: number, message: string, status = 200) => json({ jsonrpc: '2.0', id, error: { code, message } }, status)
const rpcResult = (id: Id, result: unknown) => json({ jsonrpc: '2.0', id, result })

/** `tools/list`: the 20 in the registry's order, each with its input schema, annotations and the always-load mark. */
function toolList() {
  return INHOUSE_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(TOOL_HANDLERS.get(t.name)!.input, { io: 'input' }),
    annotations: t.annotations,
    ...(t.alwaysLoad ? { _meta: { [ALWAYS_LOAD_META_KEY]: true } } : {}),
  }))
}

const isId = (v: unknown): v is Id => typeof v === 'string' || (typeof v === 'number' && Number.isInteger(v))
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The arguments' problems, short, for the agent to fix its call. */
const issues = (e: z.ZodError) => e.issues.slice(0, 5).map(i => `${i.path.length > 0 ? i.path.join('.') : 'arguments'}: ${i.message}`).join('; ')

/** One MCP POST, answered as the run's person. */
export async function handleMcp(request: Request, scope: McpScope, deps: McpDeps): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  // The spec's DNS-rebinding rule: an `Origin` must be valid. Nothing in a container sends one, so any Origin is refused.
  if (request.headers.has('Origin')) return rpcError(null, INVALID_REQUEST, 'Origin not allowed', 403)
  const version = request.headers.get('MCP-Protocol-Version')
  if (version !== null && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) return rpcError(null, INVALID_REQUEST, 'Unsupported MCP-Protocol-Version', 400)

  const bytes = await readCapped(request, MAX_BODY_BYTES)
  if (bytes === null) return rpcError(null, INVALID_REQUEST, 'Body too large', 400)
  let message: unknown
  try {
    message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return rpcError(null, PARSE_ERROR, 'Parse error', 400)
  }
  if (Array.isArray(message)) return rpcError(null, INVALID_REQUEST, 'Batches are not supported: send one message per POST', 400)
  if (!isObject(message) || message.jsonrpc !== '2.0') return rpcError(null, INVALID_REQUEST, 'Invalid Request', 400)

  const hasId = 'id' in message
  if (typeof message.method === 'string') {
    if (!hasId) return new Response(null, { status: 202 })   // a notification
    if (!isId(message.id)) return rpcError(null, INVALID_REQUEST, 'Invalid Request: id must be a string or an integer', 400)
  } else {
    // A client's response to a server request (this server sends none): accepted, nothing to do.
    if (hasId && ('result' in message || 'error' in message)) return new Response(null, { status: 202 })
    return rpcError(null, INVALID_REQUEST, 'Invalid Request', 400)
  }
  const id = message.id as Id
  const params = message.params
  if (params !== undefined && !isObject(params)) return rpcError(id, INVALID_PARAMS, 'params must be an object')

  switch (message.method) {
    case 'initialize': {
      const asked = params?.protocolVersion
      if (typeof asked !== 'string') return rpcError(id, INVALID_PARAMS, 'initialize needs params.protocolVersion')
      const agreed = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0]
      return rpcResult(id, { protocolVersion: agreed, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'inhouse', version: '1.0.0' } })
    }
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: toolList() })
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      const impl = typeof name === 'string' ? TOOL_HANDLERS.get(name) : undefined
      if (!impl) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${typeof name === 'string' ? name : '(no name)'}`)
      const parsed = impl.input.safeParse(args)
      // Input errors are tool execution errors (2025-11-25), so the model can read them and correct its call.
      if (!parsed.success) return rpcResult(id, refusal('invalid_arguments', `The arguments don't fit ${name}: ${issues(parsed.error)}. Fix them and call it again.`))
      const now = deps.now ?? Date.now
      const call: ToolScope = { ...scope, nowMs: now(), requestId: `mcp-${crypto.randomUUID()}` }
      try {
        return rpcResult(id, await impl.call(parsed.data, call, { db: deps.db, ...(deps.notify ? { notify: deps.notify } : {}), ...(deps.approvals ? { approvals: deps.approvals } : {}) }))
      } catch (err) {
        if (err instanceof StoreUnavailableError) {
          console.error({ event: 'mcp_store_unavailable', tool: name, error: safeError(err) })
          return rpcResult(id, refusal('unavailable', 'Saved memory and chat history are unavailable for a moment. Try once more; if it fails again, carry on without them and say so.'))
        }
        console.error({ event: 'mcp_tool_failed', tool: name, error: safeError(err) })
        return rpcError(id, INTERNAL_ERROR, 'Internal error')
      }
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`)
  }
}

/** `handleMcp` bound to its deps: the egress's `McpHandler` (W3 wires `mcpHandler({ db: env.DB })`). */
export const mcpHandler = (deps: McpDeps) => (request: Request, scope: McpScope): Promise<Response> => handleMcp(request, scope, deps)
