// Shared wire helpers for M4's fixture MCP servers and login server (Stage 1 M4-F, N52). Bundled into the hub's TEST
// build only (through ./index.ts and app/hub/testing/index.ts): relative imports and runtime globals, no npm package.
// Deterministic: no clock of its own and no randomness (ids come from counters).

/** Every fixture host lives under this invented domain (never a real service). */
export const FIXTURE_DOMAIN = 'mcp-fixtures.example.com'

export const HOSTS = {
  modern: `modern.${FIXTURE_DOMAIN}`,
  legacy: `legacy.${FIXTURE_DOMAIN}`,
  helpdesk: `helpdesk.${FIXTURE_DOMAIN}`,
  login: `login.${FIXTURE_DOMAIN}`,
  blocked: `blocked.${FIXTURE_DOMAIN}`,
  redirect: `redirect.${FIXTURE_DOMAIN}`,
  rest: `rest.${FIXTURE_DOMAIN}`,
  /** A private address a hostile metadata document names (detect.ts). Registered only as a trap that logs. */
  privateTrap: '10.0.0.7',
} as const

/** Fixed start time (the injected clock's default). */
export const FIXTURE_EPOCH_MS = Date.UTC(2026, 10, 28, 9, 0, 0)

export const MODERN_VERSION = '2026-07-28'
export const LEGACY_VERSION = '2025-11-25'
/** The legacy fake's supported revisions (2025-11-25 and the two earlier Streamable HTTP ones). */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const

export const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const

/** 2026-07-28 basic/index "Error Codes" plus the JSON-RPC 2.0 codes. */
export const CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Legacy sub-range (-32000 to -32019): what the 2025-era official transport answers its own refusals with. */
  legacyServer: -32000,
  legacySessionNotFound: -32001,
  headerMismatch: -32020,
  missingClientCapability: -32021,
  unsupportedVersion: -32022,
} as const

/** One line of the shared request log: what reached a fixture, never a credential's value. */
export type WireEntry = {
  seq: number
  host: string
  path: string
  method: string
  /** Which credential kind the request carried (`none` when it carried none). */
  credential: 'none' | 'bearer' | 'basic' | 'key' | 'other'
  /** JSON-RPC method, when the body was one. */
  rpc?: string
  /** `tools/call`'s tool name. */
  tool?: string
  /** `tools/call`'s arguments, as the fixture received them (the eval's "what reached a destination"). */
  args?: Record<string, unknown>
  status?: number
  /** A redirect's target, when the fixture answered one. */
  location?: string
}

export class WireLog {
  entries: WireEntry[] = []
  #seq = 0
  add(e: Omit<WireEntry, 'seq'>): WireEntry {
    const entry = { seq: ++this.#seq, ...e }
    this.entries.push(entry)
    return entry
  }
  clear(): void {
    this.entries = []
  }
  /** Entries for one host (and path prefix). */
  for(host: string, pathPrefix = ''): WireEntry[] {
    return this.entries.filter(e => e.host === host && e.path.startsWith(pathPrefix))
  }
}

export function credentialOf(req: Request): WireEntry['credential'] {
  const auth = req.headers.get('Authorization')
  if (auth !== null) {
    if (/^Bearer /i.test(auth)) return 'bearer'
    if (/^Basic /i.test(auth)) return 'basic'
    return 'other'
  }
  if (req.headers.get('X-Api-Key') !== null) return 'key'
  return 'none'
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

/** A JSON-RPC error answer (the official server's shape: `{ jsonrpc, error, id }`). */
export function rpcError(status: number, id: unknown, code: number, message: string, data?: unknown, headers: Record<string, string> = {}): Response {
  return json({ jsonrpc: '2.0', error: { code, message, ...(data !== undefined ? { data } : {}) }, id: id ?? null }, status, headers)
}

export function rpcResult(id: unknown, result: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return json({ jsonrpc: '2.0', id, result }, 200, headers)
}

/** One SSE event line block. */
export const sseEvent = (data: unknown, id?: string): string => `${id !== undefined ? `id: ${id}\n` : ''}event: message\ndata: ${JSON.stringify(data)}\n\n`

const enc = new TextEncoder()

export function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function utf8ToB64(text: string): string {
  let bin = ''
  for (const b of enc.encode(text)) bin += String.fromCharCode(b)
  return btoa(bin)
}

export async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))))
}

/** TEST-ONLY HMAC key for the fixtures' integrity-protected `requestState` (MRTR server requirement 4). */
const STATE_KEY = 'inhouse-fixture-state-key-not-a-secret-51c3'

export async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(STATE_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload))))
}

/**
 * Decodes a header value per 2026-07-28 Streamable HTTP "Value Encoding": `=?base64?...?=` is Base64 of UTF-8 (markers
 * lowercase, exact); anything else is the plain value. `undefined` for a malformed sentinel or a value with characters
 * outside visible ASCII, space and tab.
 */
export function decodeHeaderValue(raw: string): string | undefined {
  const v = raw.replace(/^[ \t]+|[ \t]+$/g, '')
  if (v.startsWith('=?base64?') && v.endsWith('?=') && v.length >= 11) {
    const inner = v.slice(9, -2)
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(inner) || inner.length % 4 !== 0) return undefined
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(inner), c => c.charCodeAt(0)))
    } catch {
      return undefined
    }
  }
  if (!/^[\t\x20-\x7e]*$/.test(v)) return undefined
  return v
}

/**
 * Encodes a value for an `Mcp-Name` or `Mcp-Param-*` header the way a conforming client must (the same section):
 * plain when it's visible ASCII with no leading or trailing whitespace and doesn't look like the sentinel, else Base64.
 */
export function encodeHeaderValue(value: string): string {
  const plain = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value) || value === ''
  const looksLikeSentinel = value.startsWith('=?base64?') && value.endsWith('?=')
  return plain && !looksLikeSentinel ? value : `=?base64?${utf8ToB64(value)}?=`
}

export type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads a request body as JSON: `{ ok: false }` when it isn't JSON. */
export async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await req.text()
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

/** Whether a Content-Type names JSON (`application/json`, with or without parameters). */
export const isJsonType = (ct: string | null): boolean => ct !== null && /^application\/json\s*(;|$)/i.test(ct.trim())
