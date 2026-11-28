// The S4 open question (P5 W1 section 7): with the test app's 5-scope token, does Slack hide a tool whose scope is
// missing, or list it and fail? Records whether `slack_search_users` (needs search:read.users) and `slack_read_file`
// (needs files:read) are listed, then calls `slack_search_users` once. Prints outcome names only: never a token, a
// body, a header or upstream text. The connect-side questions (the `resource` parameter, scopes after auth.revoke, the
// same token on re-authorization) need the consent screen and are recorded by hand in the orchestrator's live check.
//
// `probeDetail` (Part of #697) adds what the hub's pin on Slack's era needs before it can be lifted (#696): one
// standalone `server/discover` POST to Slack's endpoint, reported as its HTTP status and the answer's shape (a result,
// or an in-band error and its code), and why a failed list failed. It uses only the token handed to it: never the core,
// never a stored credential. Shapes, codes and date-shaped version strings only: never a body, a header or upstream text.
import { jsonObject, MCP_MAX_BYTES, MCP_TIMEOUT_MS, send, type Upstream } from '../../../oauth/http'
import { LEGACY_PINNED, reviewedCall } from '../reviewed-call'
import { EraCache, sdkListTools, type McpFailure, type McpTarget, type SdkDeps } from '../sdk'
import { slackConnector } from './route'

export type ProbeResult = {
  listed: { slack_search_users: boolean; slack_read_file: boolean }
  /** `ok`, or why the list failed: so a failed list isn't read as "hidden" (#700). */
  list: 'ok' | McpFailure
  /** `ok`, `unauthorized` or a hub error code (`scope_mismatch` = 403 insufficient_scope, `upstream_rejected` = hidden). */
  searchUsers: string
}

/** How Slack answered one standalone `server/discover`. */
export type DiscoverAnswer = {
  /** The HTTP status, or why there was none. */
  status: number | 'blocked' | 'network' | 'lost'
  body: 'json' | 'sse' | 'empty' | 'other'
  /** `result`: a JSON-RPC result; `error`: an in-band JSON-RPC error (`code`); `unreadable`: neither. */
  answer: 'result' | 'error' | 'unreadable'
  code?: number
  /** A result's `supportedVersions`, date-shaped strings only. */
  versions?: string[]
}

export type ProbeDetail = ProbeResult & { discover: DiscoverAnswer }

const MODERN_VERSION = '2026-07-28'

/** One `server/discover` POST, as the 2026-07-28 spec shapes it, outside the SDK and the core. */
export async function discoverOnce(upstream: Upstream, token: string): Promise<DiscoverAnswer> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'server/discover',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION, 'io.modelcontextprotocol/clientInfo': { name: 'Inhouse', version: '1.0.0' }, 'io.modelcontextprotocol/clientCapabilities': {} } },
  }
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': MODERN_VERSION, 'Mcp-Method': 'server/discover', Authorization: `Bearer ${token}` }
  const sent = await send(upstream, slackConnector.mcp.endpoint, { method: 'POST', headers, body: JSON.stringify(body) }, { allowedHosts: [new URL(slackConnector.mcp.endpoint).host], timeoutMs: MCP_TIMEOUT_MS, maxBytes: MCP_MAX_BYTES })
  if (sent.kind !== 'response') return { status: sent.kind, body: 'empty', answer: 'unreadable' }
  const type = (sent.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase()
  const text = sent.text ?? ''
  const kind: DiscoverAnswer['body'] = text.trim() === '' ? 'empty' : type === 'application/json' ? 'json' : type === 'text/event-stream' ? 'sse' : 'other'
  const data = kind === 'sse' ? text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n') : text
  const msg = kind === 'json' || kind === 'sse' ? jsonObject(data) : null
  const out: DiscoverAnswer = { status: sent.status, body: kind, answer: 'unreadable' }
  if (msg && typeof msg.error === 'object' && msg.error !== null) {
    out.answer = 'error'
    const code = (msg.error as { code?: unknown }).code
    if (typeof code === 'number' && Number.isInteger(code)) out.code = code
  } else if (msg && typeof msg.result === 'object' && msg.result !== null) {
    out.answer = 'result'
    const v = (msg.result as { supportedVersions?: unknown }).supportedVersions
    if (Array.isArray(v)) out.versions = v.filter((x): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x))
  }
  return out
}

export async function probeDetail(upstream: Upstream, token: string): Promise<ProbeDetail> {
  const deps: SdkDeps = { upstream, now: () => Date.now(), eras: new EraCache() }
  const target: McpTarget = { endpoint: slackConnector.mcp.endpoint, generation: 0, credential: { header: 'Authorization', value: `Bearer ${token}` } }
  // The list and the call follow the hub's pin on Slack's era (`LEGACY_PINNED`), so `discoverOnce` is the only
  // `server/discover` sent and the list answers whatever the probe got (#700, #701).
  const era = LEGACY_PINNED.has(slackConnector.id) ? ('legacy' as const) : undefined
  const discover = await discoverOnce(upstream, token)
  const list = await sdkListTools(deps, target, { era })
  const names = list.kind === 'ok' ? list.tools.map(t => t.name) : []
  const out = await reviewedCall(deps, { endpoint: target.endpoint, token, generation: 0, session: null, name: 'slack_search_users', args: { query: 'test' }, era })
  return {
    listed: { slack_search_users: names.includes('slack_search_users'), slack_read_file: names.includes('slack_read_file') },
    searchUsers: out.kind === 'ok' ? 'ok' : out.kind === 'unauthorized' ? 'unauthorized' : out.code,
    list: list.kind === 'ok' ? 'ok' : list.reason,
    discover,
  }
}

/** The S4 answer and the list's outcome (the CI canary's shape). */
export async function probe(upstream: Upstream, token: string): Promise<ProbeResult> {
  const { listed, list, searchUsers } = await probeDetail(upstream, token)
  return { listed, list, searchUsers }
}
