// The product Worker's API responses: every one carries the security headers and `Cache-Control: no-store`, and an
// error's body is `{ "error": { code, reason?, current? } }` (p2-design section 4).
import headersFile from '../public/_headers?raw'
import { parseHeaders, respond } from '../shared/security-headers.ts'
import type { AgentErrorCode } from '../shared/contract/index.ts'

/** The `/*` block of public/_headers, parsed once per isolate. */
export const SECURITY_HEADERS = parseHeaders(headersFile)

/**
 * The API's error codes: the contract's, plus the ones P2 adds to it (p2-design section 4). Once W3's schema change
 * puts them in `AgentErrorCodeSchema`, this is just `AgentErrorCode`.
 */
export type ApiErrorCode = AgentErrorCode | 'unauthorized' | 'invalid' | 'rate_limited' | 'cap_reached'

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, invalid: 400, rate_limited: 429,
  // P3 chooses cap_reached's status; until then it is the same as rate_limited.
  cap_reached: 429, unavailable: 503, unknown: 500, offline: 503,
}

/** An error answer. `reason` and `current` only where section 4 lists them; never a detail of why auth failed. */
export function apiError(code: ApiErrorCode, extra: { reason?: string; current?: unknown; headers?: HeadersInit } = {}): Response {
  const error: { code: ApiErrorCode; reason?: string; current?: unknown } = { code }
  if (extra.reason !== undefined) error.reason = extra.reason
  if (extra.current !== undefined) error.current = extra.current
  const headers = new Headers(extra.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return respond(SECURITY_HEADERS, STATUS[code], { headers, body: JSON.stringify({ error }) })
}

/** A JSON answer. */
export function apiJson(value: unknown, status = 200): Response {
  return respond(SECURITY_HEADERS, status, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(value) })
}
