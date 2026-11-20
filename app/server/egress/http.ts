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

/**
 * An upstream error answer mapped to the Messages API's error shape (8.1): its status, a documented type (its own when
 * it's one, else the status's), and a message: the upstream's own only for `invalid_request_error`, else a fixed one.
 */
export async function mapUpstreamError(res: Response, headers: Headers): Promise<Response> {
  let type = typeForStatus(res.status)
  let message = FIXED_MESSAGE[type]
  try {
    const body = (await res.json()) as { type?: unknown; error?: { type?: unknown; message?: unknown } }
    const t = body?.error?.type
    if (body?.type === 'error' && typeof t === 'string' && (ERROR_TYPES as readonly string[]).includes(t)) type = t as MessagesErrorType
    const m = body?.error?.message
    message = type === 'invalid_request_error' && typeof m === 'string' ? m.replace(/\s+/g, ' ').slice(0, PASSED_MESSAGE_MAX) : FIXED_MESSAGE[type]
  } catch {
    message = FIXED_MESSAGE[type]
  }
  return messagesError(res.status, type, message, headers)
}

/** Request headers the model route forwards upstream (the Messages API's own, 8.1). */
const MODEL_REQUEST_HEADERS = new Set(['anthropic-version', 'anthropic-beta', 'accept'])

export function modelRequestHeaders(incoming: Headers): Headers {
  const out = new Headers()
  for (const [k, v] of incoming) if (MODEL_REQUEST_HEADERS.has(k.toLowerCase())) out.set(k, v)
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

/** Reads a body up to `max` bytes; null when it's bigger (the declared length or the bytes themselves). */
export async function readCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > max) return null
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

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
