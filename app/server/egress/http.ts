// The egress's own answers and header rules (p3-design 8.1). Nothing here reads a token, a key or a body into a log.

/** The header the root runner's proxy adds (app/runner/src/proxy/server.ts `RUN_TOKEN_HEADER`). Never forwarded. */
export const RUN_TOKEN_HEADER = 'x-inhouse-run-token'

/** The Messages API's error types (https://platform.claude.com/docs/en/api/errors, read 2026-11-20). */
export type MessagesErrorType =
  | 'invalid_request_error' | 'authentication_error' | 'permission_error' | 'not_found_error' | 'request_too_large'
  | 'rate_limit_error' | 'api_error' | 'overloaded_error'

const ERROR_TYPES: readonly MessagesErrorType[] = [
  'invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'request_too_large', 'rate_limit_error',
  'api_error', 'overloaded_error',
]

/** An error in the Messages API's shape: `{ type: 'error', error: { type, message } }`, nothing else. */
export function messagesError(status: number, type: MessagesErrorType, message: string, headers?: Headers): Response {
  const h = new Headers(headers)
  h.set('content-type', 'application/json')
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: h })
}

/** The type a status maps to when the upstream's own type isn't one of the documented ones. */
function typeForStatus(status: number): MessagesErrorType {
  if (status === 400) return 'invalid_request_error'
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  if (status === 529) return 'overloaded_error'
  return 'api_error'
}

/** The fixed message per type: an upstream's own text can carry internal detail (8.1), so only these go back... */
const FIXED_MESSAGE: Record<MessagesErrorType, string> = {
  invalid_request_error: 'The model refused the request.',
  authentication_error: 'The model service refused our credentials.',
  permission_error: 'The model service refused the request.',
  not_found_error: 'The model service has no such resource.',
  request_too_large: 'The request is too large.',
  rate_limit_error: 'The model service is rate limiting; try again shortly.',
  api_error: 'The model service failed.',
  overloaded_error: 'The model service is overloaded; try again shortly.',
}
/** ...except an `invalid_request_error`'s message, which the CLI reads (a prompt too long), capped and single-line. */
const PASSED_MESSAGE_MAX = 500
/** A message that reveals the account's state (credit, billing, keys, limits) gets the fixed text instead. */
const ACCOUNT_STATE = /\b(credits?|balance|billing|payments?|invoices?|plans?|quotas?|spend(ing)?|organi[sz]ations?|workspaces?|accounts?|api[ _-]?keys?|usage limits?)\b/i

/**
 * An upstream error answer mapped to the Messages API's error shape (8.1): its status, a documented type (its own when
 * it's one, else the status's), and a message: the upstream's own only for `invalid_request_error`, else a fixed one.
 * `anthropic`: the body was the API's own `{ type: 'error', error: { type } }` (the model refused it, nothing billed);
 * anything else (a gateway 5xx or 524 after forwarding) may have reached the model.
 */
export async function mapUpstreamError(res: Response, headers: Headers): Promise<{ response: Response; anthropic: boolean }> {
  let type = typeForStatus(res.status)
  let message = FIXED_MESSAGE[type]
  let anthropic = false
  try {
    const body = (await res.json()) as { type?: unknown; error?: { type?: unknown; message?: unknown } }
    const t = body?.error?.type
    if (body?.type === 'error' && typeof t === 'string' && (ERROR_TYPES as readonly string[]).includes(t)) {
      type = t as MessagesErrorType
      anthropic = true
    }
    const m = body?.error?.message
    message = type === 'invalid_request_error' && typeof m === 'string' && !ACCOUNT_STATE.test(m) ? m.replace(/\s+/g, ' ').slice(0, PASSED_MESSAGE_MAX) : FIXED_MESSAGE[type]
  } catch {
    message = FIXED_MESSAGE[type]
  }
  return { response: messagesError(res.status, type, message, headers), anthropic }
}

/** Request headers the model route forwards upstream (the Messages API's own, 8.1); `anthropic-beta` by value below. */
const MODEL_REQUEST_HEADERS = new Set(['anthropic-version', 'accept'])

/**
 * PROVISIONAL (orchestrator, round 2 of #145): this list is read from the CLI's binary, not from traffic. Gate before
 * any product deploy: the Q2 live run narrows it to the betas seen on the wire, each confirmed against Anthropic's docs.
 *
 * The `anthropic-beta` values the gate lets through: a beta can turn on billed behaviour the gate doesn't inspect, so an
 * unknown one is refused (400). Source of every value: the beta table in the pinned CLI (claude-agent-sdk 0.3.328, its
 * native binary's `D("<name>", "<value>")` entries, read 2026-11-20). None has been seen on the wire yet: the Q2 live run
 * records which the CLI really sends through our proxy, and this list is narrowed or widened from that.
 * Allowed: behaviour, display and counting betas, and the features the gate prices or refuses by body field.
 * Left out (refused): fast mode (speed), the MCP connector, files, environments and the cloud runner (ccr), the advisor
 * tool, server-side fallback and fallback credit (another model's price), cache keep-alive and eviction, AFK and auto
 * mode classifiers, dangerous tool use, message threads, the system clear-at, resumption, program use-case ids,
 * results-only search, OAuth, server-side compaction (`compact-*`) and the CLI's internal `x-cc-internal-*` latches.
 */
export const ALLOWED_BETAS: ReadonlySet<string> = new Set([
  'claude-code-20250219', // the CLI identifies itself
  'interleaved-thinking-2025-05-14', // thinking between tool calls
  'context-1m-2025-08-07', // the 1M window (no premium on these models; the 650,000 bound applies)
  'context-management-2025-06-27', // clear_* edits only: compact_* edits are refused by body
  'structured-outputs-2025-12-15',
  'web-search-2025-03-05', // the web_search server tool, priced
  'advanced-tool-use-2025-11-20', // deferred tools; a tool_search server tool is still refused by body
  'tool-search-tool-2025-10-19',
  'effort-2025-11-24', // output_config.effort
  'per-turn-control-2026-07-01',
  'task-budgets-2026-03-13',
  'prompt-caching-scope-2026-01-05',
  'extended-cache-ttl-2025-04-11', // 1-hour cache writes, priced
  'redact-thinking-2026-02-12',
  'thinking-token-count-2026-05-13',
  'thinking-display-updates-2026-08-18',
  'thinking-binding-controls-2026-08-01',
  'token-counting-2024-11-01',
  'timing-2026-09-09',
  'mid-conversation-tool-changes-2026-07-01',
  'inline-tools-2026-09-15',
  'context-hint-2026-04-09',
  'claude-code-side-query-2026-09-29',
])

/** The forwarded headers, or the first `anthropic-beta` value the gate doesn't allow. */
export function modelRequestHeaders(incoming: Headers): Headers | { refusedBeta: string } {
  const out = new Headers()
  for (const [k, v] of incoming) if (MODEL_REQUEST_HEADERS.has(k.toLowerCase())) out.set(k, v)
  const beta = incoming.get('anthropic-beta')
  if (beta !== null) {
    const values = beta.split(',').map(b => b.trim()).filter(b => b !== '')
    const bad = values.find(b => !ALLOWED_BETAS.has(b))
    if (bad !== undefined) return { refusedBeta: bad }
    if (values.length > 0) out.set('anthropic-beta', values.join(','))
  }
  out.set('content-type', 'application/json')
  return out
}

/** Response headers passed back (8.1): content type, request id, rate-limit and retry hints. */
const RESPONSE_HEADERS = new Set(['content-type', 'request-id', 'retry-after', 'retry-after-ms', 'x-should-retry'])
const RESPONSE_PREFIXES = ['anthropic-ratelimit-', 'anthropic-fast-']

export function responseHeaders(upstream: Headers): Headers {
  const out = new Headers()
  for (const [k, v] of upstream) {
    const name = k.toLowerCase()
    if (RESPONSE_HEADERS.has(name) || RESPONSE_PREFIXES.some(p => name.startsWith(p))) out.set(name, v)
  }
  return out
}

/** A plain JSON answer for the non-model routes (`{ error }` on refusals, as the runner's adapters read them). */
export function jsonAnswer(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** The one capped body reader (db/handler-kit.ts), re-exported for the egress routes. */
export { readCapped } from '../db/handler-kit.ts'

export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data))
}
