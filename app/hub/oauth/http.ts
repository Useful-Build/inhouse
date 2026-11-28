// Upstream requests for the OAuth and MCP paths (P5 W1, brief sections 4 and 5). H0's patterns: `redirect: 'manual'`,
// a deadline whose timer is cleared when the call settles (never AbortSignal.timeout), a byte cap on every body, and
// every URL's host checked against the connector's allowed hosts (exact, https only) before the request leaves.
// Nothing here throws on an upstream answer; nothing from a body or header reaches a result except what callers parse.
import type { Upstream } from '../signin/providers/shopify'

export type { Upstream }

/** Token endpoint: 10 s, 64 KiB. MCP calls: 20 s, 4 MiB. Discovery and registration share the token bounds. */
export const TOKEN_TIMEOUT_MS = 10_000
export const TOKEN_MAX_BYTES = 64 * 1024
export const MCP_TIMEOUT_MS = 20_000
export const MCP_MAX_BYTES = 4 * 1024 * 1024

/** An https URL whose host is exactly one of `allowed`, with no credentials in it. Null otherwise. */
export function allowedUrl(raw: string, allowed: readonly string[]): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
  return allowed.includes(url.host) ? url : null
}

export type Sent =
  /** The URL failed the host check: nothing was sent. */
  | { kind: 'blocked' }
  /** The request threw before any answer (DNS, connect): it most likely never reached the upstream. */
  | { kind: 'network' }
  /** Our deadline fired, or the body stream broke: the request went out and the answer was lost. */
  | { kind: 'lost' }
  | { kind: 'response'; status: number; headers: Headers; text: string | null; tooLarge: boolean }

/** Sends one request under a deadline and reads the body with a cap. `text` is null when it isn't valid UTF-8. */
export async function send(
  upstream: Upstream,
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  bounds: { allowedHosts: readonly string[]; timeoutMs: number; maxBytes: number },
): Promise<Sent> {
  const checked = allowedUrl(url, bounds.allowedHosts)
  if (!checked) return { kind: 'blocked' }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('upstream deadline', 'TimeoutError'))
  }, bounds.timeoutMs)
  try {
    let res: Response
    try {
      res = await upstream(
        new Request(checked.toString(), { method: init.method, headers: init.headers, body: init.body, redirect: 'manual', signal: controller.signal }),
      )
    } catch {
      return timedOut ? { kind: 'lost' } : { kind: 'network' }
    }
    const read = await readCapped(res, bounds.maxBytes)
    if (read.kind === 'failed') return { kind: 'lost' }
    return { kind: 'response', status: res.status, headers: res.headers, text: read.kind === 'ok' ? read.text : null, tooLarge: read.kind === 'too_large' }
  } finally {
    clearTimeout(timer)
  }
}

type Capped = { kind: 'ok'; text: string; bytes: number } | { kind: 'too_large' } | { kind: 'bad_utf8' } | { kind: 'failed' }

async function readCapped(res: Response, limit: number): Promise<Capped> {
  if (!res.body) return { kind: 'ok', text: '', bytes: 0 }
  const declared = Number(res.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > limit) {
    await res.body.cancel().catch(() => {})
    return { kind: 'too_large' }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        return { kind: 'too_large' }
      }
      chunks.push(value)
    }
  } catch {
    return { kind: 'failed' }
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  try {
    return { kind: 'ok', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all), bytes: total }
  } catch {
    return { kind: 'bad_utf8' }
  }
}

/** A JSON object, or null for anything else (never throws). */
export function jsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** `Retry-After` in seconds as milliseconds; absent or odd values give `fallbackMs`. */
export function retryAfterMs(headers: Headers, fallbackMs = 1000): number {
  const raw = headers.get('Retry-After')
  const s = raw === null ? NaN : Number(raw)
  return Number.isFinite(s) && s >= 0 && s <= 86_400 ? Math.ceil(s * 1000) : fallbackMs
}

/** Equal strings, compared without an early exit on the first difference. Both stay in the caller's locals. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

// ---------- The MCP SDK's fetch (Stage 1 M4-C1, N36) ----------
// The official client (@modelcontextprotocol/client 2.4.0, connectors/mcp/sdk.ts) sends through this and nothing else.
// What the SDK's transport does with its `fetch` (StreamableHTTPClientTransport; the package's source map,
// src/client/streamableHttp.ts, read 2026-11-28): every request goes to the one endpoint URL it was built with; POST for
// each JSON-RPC message, GET to open a standing stream after a 2025-era `notifications/initialized`, DELETE only from
// `terminateSession()`. Its default redirect policy wraps this fetch in `fetchWithinOrigin` (core-internal
// shared/transport.ts), which follows a same-origin 3xx that carries a `Location`: so a redirect answer is handed back
// with its `Location` removed, and none is ever followed. Each rule below is ours, applied before anything leaves:
// - the URL must be exactly the endpoint (scheme, host, port, path, query), https, no credentials in it;
// - GET is answered here with 405 (no standing stream) and DELETE likewise (a session is never ended upstream): the SDK
//   treats 405 as "no stream offered" on both (`_startOrAuthSse`, `terminateSession`);
// - a POST's JSON-RPC method must be on the caller's list, and `tools/call` has a per-operation cap (a write's is 1);
//   anything else is answered here (202 for a notification) or refused, and never sent;
// - `initialize` (the 2025 handshake) leaves only as the first request of an operation (a cached legacy verdict) or
//   right after a probe the spec lets a client read as "legacy server": a 400, 404, 405, 406, 415 or 422, or an in-band
//   JSON-RPC error (over JSON or an event stream), neither one of the 2026-07-28 errors (-32020, -32021, -32022: any of
//   them, whatever its id, its data or the answer's content type, marks the server modern). So a modern error,
//   a redirect, an outage or a lost answer is never followed by the legacy handshake (the SDK's own classifier,
//   src/client/probeClassifier.ts, falls back on every one of those but an outage). One more case lets it leave: a 404
//   to a request that carried a session id (2025-11-25 transports, "Session Management" 4: start a new session);
// - our credential is the only one attached (the SDK has no auth provider; any `Authorization` it set is dropped);
// - `redirect: 'manual'`, a deadline per request (its timer cleared when the answer settles), the SDK's abort signal,
//   and a byte cap on every body;
// - an event stream is read event by event and closed at the answer whose id matches the request, so a server that
//   leaves the stream open doesn't run a finished call into the deadline.
// Nothing here logs. The record (`WireEvent`) holds statuses, JSON-RPC error codes and flags, never a body or a header.

/** A credential header for the MCP endpoint only: an API key's header, or `Authorization: Bearer <token>`. */
export type McpCredential = { header: string; value: string }

/** Header names a credential may never take (the transport's own, and the request's framing). */
const RESERVED_CREDENTIAL_HEADERS = new Set([
  'content-type', 'content-length', 'accept', 'host', 'cookie', 'connection', 'transfer-encoding', 'last-event-id',
  'mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
])

/** A credential the adapter will attach: a token-character header name that isn't reserved, a value with no CR, LF or NUL. */
export function validCredential(c: McpCredential): boolean {
  const name = c.header.toLowerCase()
  return /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/.test(name) && !RESERVED_CREDENTIAL_HEADERS.has(name) && !name.startsWith('mcp-param-') && c.value.length > 0 && !/[\r\n\0]/.test(c.value)
}

/** One request the SDK asked for, and what became of it. */
export type WireEvent = {
  method: string
  /** The JSON-RPC method, for a POST whose body is one message. */
  rpc: string | null
  id: string | number | null
  /** `local`: answered here; `refused`: thrown here, nothing sent; `blocked`: not the endpoint; `sent`: it may have left. */
  fate: 'local' | 'refused' | 'blocked' | 'sent'
  /** For a sent request. `network`: threw before any answer; `lost`: the deadline or a broken body; `open`: still streaming. */
  answer?: 'response' | 'network' | 'lost' | 'too_large' | 'malformed' | 'open'
  status?: number
  /** The JSON-RPC error code of the answer to this request's id, or of a null-id error (never its message or data). */
  rpcCode?: number
  /** A -32022 that names a 2026-07-28 or later version among those it supports. */
  modernVersions?: boolean
  insufficientScope?: boolean
  retryAfterMs?: number
  /** The operation's whole budget ran out here: refused before it left, or its answer cut short (#648). */
  overBudget?: true
}

export type McpFetchOptions = {
  endpoint: string
  credential: McpCredential | null
  /** The JSON-RPC methods a POST may carry for this operation. */
  allow: ReadonlySet<string>
  /** At most this many `tools/call` POSTs may leave for this operation. */
  maxCalls: number
  timeoutMs?: number
  maxBytes?: number
  /** Every request is appended here, in order. */
  record: WireEvent[]
  /** Called when an event stream ends or breaks without its answer (the SDK would otherwise wait for its own timeout). */
  onLost?: () => void
  /**
   * A cap on the whole operation, over all its requests (#648): answer bytes read and time since its first request. A
   * request that would start past it is refused here; one in flight gets only what is left (deadline and byte cap).
   */
  budget?: { bytes: number; ms: number }
}

export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>

/** The 2026-07-28 error family (basic/index "Error Codes"): any of them means a modern server (#647). */
const MODERN_ERROR_CODES = new Set([-32020, -32021, -32022])
const FIRST_MODERN_VERSION = '2026-07-28'
/** The statuses a 2025 server answers a request it doesn't know with, which license the legacy fallback after a probe. */
const LEGACY_PROBE_STATUSES = new Set([400, 404, 405, 406, 415, 422])
/** Answer headers the SDK may read; everything else (Location, Set-Cookie, ...) stays here. */
const PASSED_HEADERS = ['content-type', 'mcp-session-id', 'www-authenticate', 'retry-after']

/** What the adapter throws when it sent nothing, or the answer didn't arrive whole. Carries no upstream text. */
export class McpFetchRefused extends Error {
  override name = 'McpFetchRefused'
}

/** The `fetch` the SDK's transport gets: see the section comment above. One per operation (its record and caps). */
export function mcpFetch(upstream: Upstream, o: McpFetchOptions): McpFetch {
  const timeoutMs = o.timeoutMs ?? MCP_TIMEOUT_MS
  const maxBytes = o.maxBytes ?? MCP_MAX_BYTES
  const endpoint = new URL(o.endpoint)
  if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' || endpoint.hash !== '') {
    throw new TypeError('the MCP endpoint must be an https URL with no credentials or fragment')
  }
  if (o.credential && !validCredential(o.credential)) throw new TypeError('the credential header is not allowed')
  let calls = 0
  let modernSeen = false
  let spentBytes = 0
  let startedAt: number | null = null
  /** Whether the legacy handshake may follow: true before anything was sent, then only after a probe read as legacy. */
  let handshakeOk = true

  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    let target: URL | null
    try {
      target = new URL(url)
    } catch {
      target = null
    }
    if (!target || target.href !== endpoint.href) {
      o.record.push({ method, rpc: null, id: null, fate: 'blocked' })
      throw new McpFetchRefused('not the endpoint')
    }
    if (method !== 'POST') {
      o.record.push({ method, rpc: null, id: null, fate: 'local', status: 405 })
      return new Response(null, { status: 405, headers: { Allow: 'POST' } })
    }
    const body = typeof init?.body === 'string' ? init.body : null
    const msg = jsonObject(body)
    const rpc = msg && typeof msg.method === 'string' ? msg.method : null
    const id = msg && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null
    const event: WireEvent = { method, rpc, id, fate: 'refused' }
    o.record.push(event)
    if (rpc === null || !o.allow.has(rpc) || (rpc === 'initialize' && (modernSeen || !handshakeOk)) || (rpc === 'tools/call' && calls >= o.maxCalls)) {
      // A notification nobody needs to hear is acknowledged here; a request is refused. Neither leaves.
      if (rpc !== null && rpc.startsWith('notifications/') && id === null) {
        event.fate = 'local'
        event.status = 202
        return new Response(null, { status: 202 })
      }
      throw new McpFetchRefused('not sent')
    }
    startedAt ??= Date.now()
    const leftMs = o.budget ? o.budget.ms - (Date.now() - startedAt) : Infinity
    const leftBytes = o.budget ? o.budget.bytes - spentBytes : Infinity
    if (leftMs <= 0 || leftBytes <= 0) {
      event.overBudget = true
      throw new McpFetchRefused('over the operation budget')
    }
    if (rpc === 'tools/call') calls++
    handshakeOk = false
    const deadlineMs = Math.min(timeoutMs, leftMs)
    const capBytes = Math.min(maxBytes, leftBytes)

    const headers = new Headers(init?.headers)
    headers.delete('authorization')
    if (o.credential) headers.set(o.credential.header, o.credential.value)
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (deadlineMs < timeoutMs) event.overBudget = true
      controller.abort(new DOMException('upstream deadline', 'TimeoutError'))
    }, deadlineMs)
    const outer = init?.signal ?? null
    const onOuter = () => controller.abort(outer?.reason)
    if (outer?.aborted) onOuter()
    outer?.addEventListener('abort', onOuter, { once: true })
    const done = () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuter)
    }

    event.fate = 'sent'
    let res: Response
    try {
      // Raced against our own abort, so the deadline holds even over an upstream that doesn't watch the signal.
      const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new McpFetchRefused('aborted')), { once: true }))
      res = await Promise.race([upstream(new Request(endpoint.href, { method: 'POST', headers, body, redirect: 'manual', signal: controller.signal })), aborted])
    } catch {
      done()
      event.answer = timedOut ? 'lost' : 'network'
      throw new McpFetchRefused('no answer')
    }
    event.status = res.status
    if (res.status === 403 && /error="?insufficient_scope"?/.test(res.headers.get('WWW-Authenticate') ?? '')) event.insufficientScope = true
    if (res.status === 429) event.retryAfterMs = retryAfterMs(res.headers)
    const passed = new Headers()
    for (const h of PASSED_HEADERS) {
      const v = res.headers.get(h)
      if (v !== null) passed.set(h, v)
    }
    const session = passed.get('mcp-session-id')
    // Visible ASCII only (2025-11-25 transports, "Session Management" 1), up to 4 KiB: a signed id (a JWT) fits (#651).
    if (session !== null && !/^[\x21-\x7e]{1,4096}$/.test(session)) passed.delete('mcp-session-id')
    const sessionSent = headers.has('mcp-session-id')
    /**
     * Reads one JSON-RPC message of the answer: an error for this request's id, or with a null id (a server that couldn't
     * read the id still answers this request), records its code. Any -32020, -32021 or -32022 marks the server modern,
     * whatever its id, its `data` or the answer's content type (#647). Returns whether the message answers this request.
     */
    const note = (m: Record<string, unknown>): boolean => {
      const mine = m.id === id && id !== null
      const error = typeof m.error === 'object' && m.error !== null ? (m.error as { code?: unknown; data?: unknown }) : null
      if (error && typeof error.code === 'number' && (mine || m.id === null || m.id === undefined)) {
        event.rpcCode = error.code
        const supported = typeof error.data === 'object' && error.data !== null ? (error.data as { supported?: unknown }).supported : undefined
        if (error.code === -32022 && Array.isArray(supported) && supported.some(v => typeof v === 'string' && v >= FIRST_MODERN_VERSION)) event.modernVersions = true
        if (MODERN_ERROR_CODES.has(error.code)) modernSeen = true
        return true
      }
      return mine && ('result' in m || 'error' in m)
    }
    /** Once the answer is known (JSON read whole, or the matching stream event): may the legacy handshake follow? */
    const decide = () => {
      if (modernSeen) return
      if (res.status === 404 && sessionSent) handshakeOk = true
      // A probe read as "a 2025 server" (2026-07-28 streamable-http "Backward Compatibility"): one of the statuses a
      // 2025 server refuses an unknown request with, or an in-band JSON-RPC error over JSON or an event stream (#646).
      // Never a 401, 403, 408 or 429 (the SDK's classifier reads 408 and 429 as legacy: an outage isn't a verdict).
      if (rpc === 'server/discover') handshakeOk = LEGACY_PROBE_STATUSES.has(res.status) || (res.status === 200 && event.rpcCode !== undefined)
    }

    if (res.status >= 300 && res.status < 400) {
      // Never followed: handed back with no Location, so the SDK's same-origin follower has nowhere to go.
      await res.body?.cancel()
      done()
      event.answer = 'response'
      return new Response(null, { status: res.status, headers: passed })
    }
    const type = (res.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (type === 'text/event-stream' && res.status === 200 && res.body && id !== null) {
      event.answer = 'open'
      const spend = (n: number) => {
        spentBytes += n
        if (event.answer === 'too_large' && capBytes < maxBytes) event.overBudget = true
      }
      return new Response(matchedStream(res.body, id, capBytes, event, done, note, decide, o.onLost, spend), { status: 200, headers: passed })
    }
    const read = await readCapped(res, capBytes)
    done()
    if (read.kind !== 'ok') {
      event.answer = read.kind === 'failed' ? 'lost' : read.kind === 'too_large' ? 'too_large' : 'malformed'
      if (read.kind === 'too_large' && capBytes < maxBytes) event.overBudget = true
      throw new McpFetchRefused('no whole answer')
    }
    spentBytes += read.bytes
    event.answer = 'response'
    // Whatever the content type says: a JSON body, or the events of a stream that wasn't a 200 (#647).
    const messages = type === 'text/event-stream' ? sseMessages(read.text) : [jsonObject(read.text)]
    let answered = false
    for (const m of messages) if (m && note(m)) answered = true
    decide()
    // An in-band error the SDK can't match to its request (a null id): end its wait now, not at its own timeout.
    if (answered && res.status === 200 && event.rpcCode !== undefined && !messages.some(m => m?.id === id)) o.onLost?.()
    return new Response(read.text.length > 0 ? read.text : null, { status: res.status, headers: passed })
  }
}

/** The JSON object each `data:` of a whole event-stream text holds (null for one that isn't an object). */
function sseMessages(text: string): (Record<string, unknown> | null)[] {
  return text
    .split(/\r?\n\r?\n/)
    .map(block => block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n'))
    .filter(data => data.length > 0)
    .map(data => jsonObject(data))
}

/**
 * An event stream passed on event by event, closed right after the event that answers `id` (the upstream stream is
 * cancelled then). The deadline (`done` clears it) and the byte cap hold over the whole read. Only whole events pass.
 */
function matchedStream(
  upstream: ReadableStream<Uint8Array>,
  id: string | number,
  maxBytes: number,
  event: WireEvent,
  done: () => void,
  note: (m: Record<string, unknown>) => boolean,
  decide: () => void,
  onLost: (() => void) | undefined,
  spend: (bytes: number) => void,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  const encoder = new TextEncoder()
  let buffer = ''
  let total = 0
  let finished = false
  const finish = async (c: ReadableStreamDefaultController<Uint8Array>, answer: NonNullable<WireEvent['answer']>, failed: boolean) => {
    if (finished) return
    finished = true
    event.answer = answer
    done()
    spend(total)
    if (failed) c.error(new McpFetchRefused('no whole answer'))
    else c.close()
    if (answer !== 'response') onLost?.()
    // The upstream stream may already be broken (a lost answer): cancelling it then has nothing left to do.
    await reader.cancel().catch(() => undefined)
  }
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch {
          return finish(c, 'lost', true)
        }
        // Ended without the answer: the SDK sees the stream end (its reconnection is off, and a GET is answered here).
        if (chunk.done) return finish(c, 'lost', false)
        total += chunk.value.byteLength
        if (total > maxBytes) return finish(c, 'too_large', true)
        try {
          buffer += decoder.decode(chunk.value, { stream: true })
        } catch {
          return finish(c, 'malformed', true)
        }
        const blocks = buffer.split(/\r?\n\r?\n/)
        buffer = blocks.pop()!
        let out = ''
        let answered = false
        let unmatched = false
        for (const block of blocks) {
          out += `${block}\n\n`
          const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n')
          const m = data.length > 0 ? jsonObject(data) : null
          if (m && note(m)) {
            answered = true
            unmatched = m.id !== id
            break
          }
        }
        if (answered) {
          // Decided before the SDK reads the answer, so its next request (a 2025 handshake or not) meets the verdict.
          decide()
          if (out.length > 0) c.enqueue(encoder.encode(out))
          await finish(c, 'response', false)
          // A null-id error the SDK can't match: end its wait now.
          if (unmatched) onLost?.()
          return
        }
        if (out.length > 0) c.enqueue(encoder.encode(out))
        if (out.length > 0) return
      }
    },
    async cancel() {
      if (finished) return
      finished = true
      event.answer = 'lost'
      done()
      await reader.cancel()
    },
  })
}
