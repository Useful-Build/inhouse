// Raw request vectors (Stage 1 M4-F, N36, N52): the same bytes go to our fixture and, in M4-C1's differential test, to
// the official @modelcontextprotocol/server 2.4.0, and the normalised answers must match. Each names the spec rule it
// stands for. Bundled into the hub's TEST build only (the seam imports index.ts, not this file, but it stays npm-free).
//
// `target` is the endpoint path on the fixture's host (modern: `/open/mcp`; legacy: `/mcp`). A header value of
// `{session}` is replaced by a fresh session id from an `initialize` before the vector is sent (legacy only).

import { MODERN_VERSION, LEGACY_VERSION, META, encodeHeaderValue } from './wire'

export type Normalised = {
  status: number
  /** `json`, `sse`, `none` (no body) or `other`. */
  body: 'json' | 'sse' | 'none' | 'other'
  /** The JSON-RPC error code, when the answer is one. */
  code?: number
  /** `error.data.supported` / `requested`, when present. */
  supported?: string[]
  requested?: string
  /** The sorted keys of `result`, minus `_meta`. */
  resultKeys?: string[]
  /** Whether the answer carries an `Mcp-Session-Id`. */
  session: boolean
  /** `result.protocolVersion` (a legacy `initialize`). */
  protocolVersion?: string
}

export type RawVector = {
  id: string
  /** The spec rule, as page and section. */
  rule: string
  era: 'modern' | 'legacy'
  target: string
  request: { method: 'POST' | 'GET' | 'DELETE'; headers: Record<string, string>; body?: unknown }
  /** Every field given must equal the normalised answer's. */
  expect: Partial<Normalised>
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
const meta = (caps: Record<string, unknown> = {}) => ({ [META.protocolVersion]: MODERN_VERSION, [META.clientInfo]: { name: 'vector-client', version: '1.0.0' }, [META.clientCapabilities]: caps })
const modernHeaders = (method: string, extra: Record<string, string> = {}) => ({ ...JSON_HEADERS, 'MCP-Protocol-Version': MODERN_VERSION, 'Mcp-Method': method, ...extra })
const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method, params })

const SH = 'streamable-http (2026-07-28)'
const VER = 'versioning (2026-07-28)'

export const MODERN_VECTORS: readonly RawVector[] = [
  { id: 'discover', rule: 'server/discover: MUST implement; supportedVersions, capabilities, ttlMs, cacheScope', era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('server/discover'), body: rpc(1, 'server/discover', { _meta: meta() }) }, expect: { status: 200, body: 'json', session: false } },
  { id: 'list', rule: 'server/tools "Listing Tools": tools, nextCursor, ttlMs, cacheScope, resultType', era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('tools/list'), body: rpc(2, 'tools/list', { _meta: meta() }) }, expect: { status: 200, body: 'json', resultKeys: ['cacheScope', 'nextCursor', 'resultType', 'tools', 'ttlMs'] } },
  { id: 'call', rule: 'server/tools "Calling Tools"; Mcp-Name mirrors params.name', era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('tools/call', { 'Mcp-Name': 'notes_search' }), body: rpc(3, 'tools/call', { name: 'notes_search', arguments: { query: 'fern' }, _meta: meta() }) }, expect: { status: 200, body: 'json', resultKeys: ['content', 'isError', 'resultType'] } },
  { id: 'legacy-initialize', rule: `${VER} compatibility matrix (Legacy client, Modern server: 400) and "SHOULD name the protocol versions it supports in any error it returns to an initialize request"`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: JSON_HEADERS, body: rpc(4, 'initialize', { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'legacy', version: '1' } }) }, expect: { status: 400, code: -32022, supported: [MODERN_VERSION], requested: LEGACY_VERSION, session: false } },
  { id: 'legacy-initialize-modern-header', rule: `${SH} "Server Validation": headers must match the body (an initialize under a 2026 header)`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: { ...JSON_HEADERS, 'MCP-Protocol-Version': MODERN_VERSION }, body: rpc(5, 'initialize', { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'legacy', version: '1' } }) }, expect: { status: 400, code: -32020 } },
  { id: 'legacy-request-no-envelope', rule: `${SH} "Protocol Version Header": a version the server doesn't implement is 400 UnsupportedProtocolVersion`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: { ...JSON_HEADERS, 'MCP-Protocol-Version': LEGACY_VERSION }, body: rpc(6, 'tools/list') }, expect: { status: 400, code: -32022, supported: [MODERN_VERSION], requested: LEGACY_VERSION } },
  { id: 'missing-version-header', rule: `${SH} "Server Validation": a required standard header (MCP-Protocol-Version) missing is 400 HeaderMismatch`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: { ...JSON_HEADERS, 'Mcp-Method': 'server/discover' }, body: rpc(7, 'server/discover', { _meta: meta() }) }, expect: { status: 400, code: -32020 } },
  { id: 'missing-method-header', rule: `${SH} "Standard Request Headers": Mcp-Method required on all requests`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: { ...JSON_HEADERS, 'MCP-Protocol-Version': MODERN_VERSION }, body: rpc(8, 'server/discover', { _meta: meta() }) }, expect: { status: 400, code: -32020 } },
  { id: 'method-header-mismatch', rule: `${SH} "Server Validation": a header value that doesn't match the body is 400 HeaderMismatch`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('tools/list'), body: rpc(9, 'server/discover', { _meta: meta() }) }, expect: { status: 400, code: -32020 } },
  { id: 'version-header-mismatch', rule: `${SH} "Protocol Version Header": the header MUST match _meta's protocolVersion, else 400 HeaderMismatch`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('server/discover', { 'MCP-Protocol-Version': '2026-12-01' }), body: rpc(10, 'server/discover', { _meta: meta() }) }, expect: { status: 400, code: -32020 } },
  { id: 'unsupported-version', rule: `${VER} "Protocol Version Negotiation": UnsupportedProtocolVersionError lists the supported versions`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('server/discover', { 'MCP-Protocol-Version': '2099-01-01' }), body: rpc(11, 'server/discover', { _meta: { ...meta(), [META.protocolVersion]: '2099-01-01' } }) }, expect: { status: 400, code: -32022, supported: [MODERN_VERSION], requested: '2099-01-01' } },
  { id: 'missing-capabilities', rule: 'basic/index "_meta": a request missing a required field is 400 with -32602', era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('server/discover'), body: rpc(12, 'server/discover', { _meta: { [META.protocolVersion]: MODERN_VERSION } }) }, expect: { status: 400, code: -32602 } },
  { id: 'modern-header-no-envelope', rule: 'basic/index "_meta": protocolVersion and clientCapabilities are required on every request', era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('tools/list'), body: rpc(13, 'tools/list') }, expect: { status: 400, code: -32602 } },
  { id: 'call-missing-name-header', rule: `${SH} "Standard Request Headers": Mcp-Name required for tools/call`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('tools/call'), body: rpc(14, 'tools/call', { name: 'notes_search', arguments: { query: 'fern' }, _meta: meta() }) }, expect: { status: 400, code: -32020 } },
  { id: 'call-name-mismatch', rule: `${SH} "Server Validation": Mcp-Name must match params.name`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('tools/call', { 'Mcp-Name': 'notes_read' }), body: rpc(15, 'tools/call', { name: 'notes_search', arguments: { query: 'fern' }, _meta: meta() }) }, expect: { status: 400, code: -32020 } },
  { id: 'call-name-base64', rule: `${SH} "Value Encoding": servers MUST decode a Base64 sentinel before comparing`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('tools/call', { 'Mcp-Name': `=?base64?${btoa('notes_search')}?=` }), body: rpc(16, 'tools/call', { name: 'notes_search', arguments: { query: 'fern' }, _meta: meta() }) }, expect: { status: 200, body: 'json' } },
  { id: 'call-missing-param-header', rule: `${SH} "Server Behavior for Custom Headers": a value in the body with no Mcp-Param header is rejected (-32020)`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('tools/call', { 'Mcp-Name': 'region_lookup' }), body: rpc(17, 'tools/call', { name: 'region_lookup', arguments: { region: 'eu-west' }, _meta: meta() }) }, expect: { status: 400, code: -32020 } },
  { id: 'call-param-header-mismatch', rule: `${SH} "Server Behavior for Custom Headers": header must match the body (-32020)`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('tools/call', { 'Mcp-Name': 'region_lookup', 'Mcp-Param-Region': 'us-east' }), body: rpc(18, 'tools/call', { name: 'region_lookup', arguments: { region: 'eu-west' }, _meta: meta() }) }, expect: { status: 400, code: -32020 } },
  { id: 'call-param-header-base64', rule: `${SH} "Value Encoding": non-ASCII goes as =?base64?...?= and is decoded`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('tools/call', { 'Mcp-Name': 'region_lookup', 'Mcp-Param-Region': encodeHeaderValue('Zürich') }), body: rpc(19, 'tools/call', { name: 'region_lookup', arguments: { region: 'Zürich' }, _meta: meta() }) }, expect: { status: 200, body: 'json' } },
  { id: 'unknown-method', rule: `${SH} "Protocol Version Header": an unimplemented method is 404 with -32601`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('prompts/list'), body: rpc(20, 'prompts/list', { _meta: meta() }) }, expect: { status: 404, code: -32601 } },
  { id: 'get', rule: `${SH} "Earlier Streamable HTTP Revisions": GET to the endpoint is 405`, era: 'modern', target: '/open/mcp', request: { method: 'GET', headers: { Accept: 'text/event-stream' } }, expect: { status: 405 } },
  { id: 'delete', rule: `${SH} "Earlier Streamable HTTP Revisions": DELETE to the endpoint is 405`, era: 'modern', target: '/open/mcp', request: { method: 'DELETE', headers: { 'Mcp-Session-Id': 'stale-1' } }, expect: { status: 405 } },
  { id: 'session-ignored', rule: `${SH} "Earlier Streamable HTTP Revisions": ignore an Mcp-Session-Id, never mint or echo one`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('server/discover', { 'Mcp-Session-Id': 'stale-1' }), body: rpc(21, 'server/discover', { _meta: meta() }) }, expect: { status: 200, session: false } },
  { id: 'notification', rule: `${SH} "Sending Messages" 5: an accepted notification is 202 with no body`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: JSON_HEADERS, body: { jsonrpc: '2.0', method: 'notifications/initialized' } }, expect: { status: 202, body: 'none' } },
  { id: 'batch', rule: `${SH} "Sending Messages" 4: the body is a single JSON-RPC request or notification`, era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('tools/list'), body: [rpc(22, 'tools/list', { _meta: meta() })] }, expect: { status: 400, code: -32600 } },
  { id: 'not-json', rule: 'JSON-RPC 2.0: a body that is not JSON is a parse error', era: 'modern', target: '/open/mcp', request: { method: 'POST', headers: modernHeaders('tools/list'), body: '{"jsonrpc":' }, expect: { status: 400, code: -32700 } },
]

export const LEGACY_VECTORS: readonly RawVector[] = [
  { id: 'initialize', rule: 'lifecycle (2025-11-25) "Version Negotiation"; transports "Session Management" 1', era: 'legacy', target: '/mcp', request: { method: 'POST', headers: JSON_HEADERS, body: rpc(1, 'initialize', { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'legacy', version: '1' } }) }, expect: { status: 200, body: 'json', session: true, protocolVersion: LEGACY_VERSION } },
  { id: 'initialize-unknown-version', rule: 'lifecycle (2025-11-25) "Version Negotiation": otherwise answer another version it supports', era: 'legacy', target: '/mcp', request: { method: 'POST', headers: JSON_HEADERS, body: rpc(2, 'initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } }) }, expect: { status: 200, session: true, protocolVersion: LEGACY_VERSION } },
  { id: 'list-on-session', rule: 'transports (2025-11-25) "Session Management" 2: later requests carry the session id', era: 'legacy', target: '/mcp', request: { method: 'POST', headers: { ...JSON_HEADERS, 'MCP-Protocol-Version': LEGACY_VERSION, 'Mcp-Session-Id': '{session}' }, body: rpc(3, 'tools/list') }, expect: { status: 200, body: 'json', resultKeys: ['nextCursor', 'tools'] } },
  { id: 'list-no-session', rule: 'transports (2025-11-25) "Session Management" 2: a request without the session id is 400', era: 'legacy', target: '/mcp', request: { method: 'POST', headers: { ...JSON_HEADERS, 'MCP-Protocol-Version': LEGACY_VERSION }, body: rpc(4, 'tools/list') }, expect: { status: 400, code: -32000 } },
  { id: 'list-unknown-session', rule: 'transports (2025-11-25) "Session Management" 3: an ended or unknown session is 404', era: 'legacy', target: '/mcp', request: { method: 'POST', headers: { ...JSON_HEADERS, 'MCP-Protocol-Version': LEGACY_VERSION, 'Mcp-Session-Id': 'no-such-session' }, body: rpc(5, 'tools/list') }, expect: { status: 404, code: -32001 } },
  { id: 'unsupported-version-header', rule: 'transports (2025-11-25) "Protocol Version Header": an unsupported version is 400', era: 'legacy', target: '/mcp', request: { method: 'POST', headers: { ...JSON_HEADERS, 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Session-Id': '{session}' }, body: rpc(6, 'tools/list') }, expect: { status: 400, code: -32000 } },
  { id: 'modern-probe', rule: `${SH} "Backward Compatibility": a legacy server's 400 carries no recognised modern error, so the client falls back to initialize`, era: 'legacy', target: '/mcp', request: { method: 'POST', headers: modernHeaders('server/discover'), body: rpc(7, 'server/discover', { _meta: meta() }) }, expect: { status: 400, code: -32000 } },
  { id: 'get', rule: 'transports (2025-11-25) "Listening for Messages from the Server" 3: 405 when no SSE stream is offered', era: 'legacy', target: '/mcp', request: { method: 'GET', headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': '{session}' } }, expect: { status: 405 } },
  { id: 'delete', rule: 'transports (2025-11-25) "Session Management" 5: DELETE ends the session', era: 'legacy', target: '/mcp', request: { method: 'DELETE', headers: { 'Mcp-Session-Id': '{session}', 'MCP-Protocol-Version': LEGACY_VERSION } }, expect: { status: 200 } },
]

/** The request a vector describes, against a base URL (`https://<host>`), with `{session}` filled in. */
export function vectorRequest(v: RawVector, baseUrl: string, session?: string): Request {
  const headers = Object.fromEntries(Object.entries(v.request.headers).map(([k, val]) => [k, val === '{session}' ? (session ?? '') : val]))
  const body = v.request.body === undefined ? undefined : typeof v.request.body === 'string' ? v.request.body : JSON.stringify(v.request.body)
  return new Request(`${baseUrl}${v.target}`, { method: v.request.method, headers, ...(body !== undefined ? { body } : {}) })
}

/** The fields the differential test compares, read from an answer. */
export async function normalise(res: Response): Promise<Normalised> {
  const ct = res.headers.get('Content-Type') ?? ''
  const text = await res.text()
  const out: Normalised = {
    status: res.status,
    body: text.length === 0 ? 'none' : ct.includes('application/json') ? 'json' : ct.includes('text/event-stream') ? 'sse' : 'other',
    session: res.headers.get('Mcp-Session-Id') !== null,
  }
  let msg: unknown = null
  if (out.body === 'json') msg = JSON.parse(text)
  else if (out.body === 'sse') {
    const data = text.split('\n').filter(l => l.startsWith('data: ') && l.length > 6).map(l => l.slice(6))
    msg = data.length > 0 ? JSON.parse(data[data.length - 1]!) : null
  }
  if (typeof msg === 'object' && msg !== null) {
    const m = msg as { error?: { code?: number; data?: { supported?: string[]; requested?: string } }; result?: Record<string, unknown> }
    if (m.error) {
      out.code = m.error.code
      if (m.error.data?.supported) out.supported = m.error.data.supported
      if (m.error.data?.requested) out.requested = m.error.data.requested
    }
    if (m.result) {
      out.resultKeys = Object.keys(m.result).filter(k => k !== '_meta').sort()
      if (typeof m.result.protocolVersion === 'string') out.protocolVersion = m.result.protocolVersion
    }
  }
  return out
}
