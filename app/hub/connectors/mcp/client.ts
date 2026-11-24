// The hand-written MCP client (P5 W1 section 6, OC-W1-3): MCP 2025-11-25 streamable HTTP, three calls only
// (`initialize`, `notifications/initialized`, `tools/call`). No SDK, no client object holding a token: the bearer is
// built per request from the token the caller opened into a local for that call.
// Docs read 2026-11-21: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (POST JSON-RPC,
// `Accept: application/json, text/event-stream`, `Mcp-Session-Id`, 202 for notifications) and
// https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization (bearer on every request, 403
// `insufficient_scope`).
import type { HubErrorCode } from '../../index/contract'
import type { McpToolResult } from '../../registry/registry'
import { jsonObject, MCP_MAX_BYTES, MCP_TIMEOUT_MS, retryAfterMs, send, type Upstream } from '../../oauth/http'

export const PROTOCOL_VERSION = '2025-11-25'
const SUPPORTED_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26'])

/** A session in object memory, keyed by the record generation it started under. Never stored. */
export type McpSession = { generation: number; id: string | null; protocolVersion: string }

export type McpOutcome =
  | { kind: 'ok'; result: McpToolResult; dropped: number; session: McpSession }
  | { kind: 'unauthorized' }
  | { kind: 'error'; code: HubErrorCode; retryAfterMs?: number }

type Target = { endpoint: string; allowedHosts: readonly string[] }

type Rpc =
  | { kind: 'ok'; body: Record<string, unknown> | null; sessionId: string | null }
  | { kind: 'unauthorized' }
  /** A 404 on a request that carried `Mcp-Session-Id`: the server ended the session (transports, "Session Management"). */
  | { kind: 'session_gone' }
  | { kind: 'error'; code: HubErrorCode; retryAfterMs?: number }

/** One JSON-RPC POST. `expectBody` false for a notification (202 with no body). */
async function rpc(upstream: Upstream, t: Target, token: string, session: McpSession | null, message: Record<string, unknown>, expectBody: boolean): Promise<Rpc> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  }
  if (session?.id) headers['Mcp-Session-Id'] = session.id
  if (session) headers['MCP-Protocol-Version'] = session.protocolVersion
  const sent = await send(upstream, t.endpoint, { method: 'POST', headers, body: JSON.stringify(message) }, {
    allowedHosts: t.allowedHosts,
    timeoutMs: MCP_TIMEOUT_MS,
    maxBytes: MCP_MAX_BYTES,
  })
  if (sent.kind === 'blocked') return { kind: 'error', code: 'internal' }
  if (sent.kind !== 'response') return { kind: 'error', code: 'upstream_unavailable' }
  const { status, headers: h } = sent
  if (status === 401) return { kind: 'unauthorized' }
  if (status === 404 && session?.id) return { kind: 'session_gone' }
  if (status === 403) {
    const challenge = h.get('WWW-Authenticate') ?? ''
    return { kind: 'error', code: /error="?insufficient_scope"?/.test(challenge) ? 'scope_mismatch' : 'upstream_rejected' }
  }
  if (status === 429) return { kind: 'error', code: 'rate_limited', retryAfterMs: retryAfterMs(h) }
  if (status >= 500 || status < 200 || (status >= 300 && status < 400)) return { kind: 'error', code: 'upstream_unavailable' }
  if (status >= 400) return { kind: 'error', code: 'upstream_rejected' }
  if (sent.tooLarge) return { kind: 'error', code: 'result_too_large' }
  const sessionId = h.get('Mcp-Session-Id')
  const validSession = sessionId !== null && /^[\x21-\x7e]{1,256}$/.test(sessionId) ? sessionId : null
  if (!expectBody) return { kind: 'ok', body: null, sessionId: validSession }
  if (sent.text === null) return { kind: 'error', code: 'upstream_unavailable' }
  const type = (h.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase()
  const body = type === 'text/event-stream' ? singleEvent(sent.text) : type === 'application/json' ? jsonObject(sent.text) : null
  if (!body) return { kind: 'error', code: 'upstream_unavailable' }
  return { kind: 'ok', body, sessionId: validSession }
}

/** A text/event-stream body with exactly one `message` event carrying one JSON-RPC object; anything else null. */
export function singleEvent(text: string): Record<string, unknown> | null {
  const events = text.split(/\r?\n\r?\n/).filter(block => block.trim().length > 0)
  const withData = events
    .map(block => {
      const lines = block.split(/\r?\n/)
      const type = lines.find(l => l.startsWith('event:'))?.slice(6).trim() ?? 'message'
      const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''))
      return { type, data }
    })
    .filter(e => e.data.length > 0)
  if (withData.length !== 1 || withData[0]!.type !== 'message') return null
  return jsonObject(withData[0]!.data.join('\n'))
}

let nextId = 1
const rpcId = () => nextId++

/** `initialize` then `notifications/initialized`. Version negotiation: the server's answer must be one we speak. */
async function initialize(upstream: Upstream, t: Target, token: string, generation: number): Promise<{ kind: 'ok'; session: McpSession } | { kind: 'unauthorized' } | { kind: 'error'; code: HubErrorCode; retryAfterMs?: number }> {
  const init = await rpc(upstream, t, token, null, {
    jsonrpc: '2.0',
    id: rpcId(),
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Inhouse', version: '1.0.0' } },
  }, true)
  if (init.kind === 'session_gone') return { kind: 'error', code: 'upstream_unavailable' }
  if (init.kind !== 'ok') return init
  const result = init.body?.result as { protocolVersion?: unknown } | undefined
  if (init.body?.error !== undefined || typeof result !== 'object' || result === null) return { kind: 'error', code: 'upstream_rejected' }
  const version = typeof result.protocolVersion === 'string' && SUPPORTED_VERSIONS.has(result.protocolVersion) ? result.protocolVersion : null
  if (!version) return { kind: 'error', code: 'upstream_unavailable' }
  const session: McpSession = { generation, id: init.sessionId, protocolVersion: version }
  const note = await rpc(upstream, t, token, session, { jsonrpc: '2.0', method: 'notifications/initialized' }, false)
  if (note.kind === 'session_gone') return { kind: 'error', code: 'upstream_unavailable' }
  if (note.kind !== 'ok') return note
  return { kind: 'ok', session }
}

/**
 * `tools/call` with `name` and `args`, initialising first when there's no session for this generation. A JSON-RPC
 * error or `isError: true` is upstream_rejected with no upstream text; text parts only, other types dropped and counted.
 * A 404 on a reused session means the server ended it (an upstream restart): MCP 2025-11-25 says the client MUST start
 * a new one, so initialise once more and re-send once. A 404 on a session made for this call is upstream_unavailable.
 */
export async function callMcpTool(
  upstream: Upstream,
  t: Target,
  token: string,
  generation: number,
  session: McpSession | null,
  name: string,
  args: Record<string, unknown>,
): Promise<McpOutcome> {
  let s = session && session.generation === generation ? session : null
  const reused = s !== null
  if (!s) {
    const init = await initialize(upstream, t, token, generation)
    if (init.kind !== 'ok') return init
    s = init.session
  }
  const call = (sess: McpSession) => rpc(upstream, t, token, sess, { jsonrpc: '2.0', id: rpcId(), method: 'tools/call', params: { name, arguments: args } }, true)
  let res = await call(s)
  if (res.kind === 'session_gone' && reused) {
    const init = await initialize(upstream, t, token, generation)
    if (init.kind !== 'ok') return init
    s = init.session
    res = await call(s)
  }
  if (res.kind === 'session_gone') return { kind: 'error', code: 'upstream_unavailable' }
  if (res.kind !== 'ok') return res
  const body = res.body!
  if (body.error !== undefined) return { kind: 'error', code: 'upstream_rejected' }
  const result = body.result as { isError?: unknown; content?: unknown } | undefined
  if (typeof result !== 'object' || result === null) return { kind: 'error', code: 'upstream_unavailable' }
  if (result.isError === true) return { kind: 'error', code: 'upstream_rejected' }
  if (!Array.isArray(result.content)) return { kind: 'error', code: 'upstream_unavailable' }
  const content: McpToolResult['content'] = []
  let dropped = 0
  for (const part of result.content as unknown[]) {
    const p = part as { type?: unknown; text?: unknown }
    if (typeof p === 'object' && p !== null && p.type === 'text' && typeof p.text === 'string') content.push({ type: 'text', text: p.text })
    else dropped++
  }
  return { kind: 'ok', result: { content }, dropped, session: s }
}
