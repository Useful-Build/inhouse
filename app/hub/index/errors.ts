// HubError construction: a fixed text per code, plus safe names only (a tool name, scope handles). Never an upstream
// body, header, token, secret, document or argument value.
import type { HubError, HubErrorCode, HubResult } from './contract'

const TEXT: Record<HubErrorCode, string> = {
  invalid_args: 'invalid arguments',
  unknown_tool: 'unknown tool',
  write_refused: 'writes are refused',
  not_configured: 'connector not configured',
  credentials_rejected: 'credentials rejected by the provider',
  scope_mismatch: 'granted scopes do not match the connector',
  key_unavailable: 'token key unavailable',
  upstream_unavailable: 'upstream unavailable',
  upstream_rejected: 'upstream rejected the request',
  upstream_version_mismatch: 'upstream answered with another API version',
  rate_limited: 'rate limited by the upstream',
  result_too_large: 'result too large',
  internal: 'internal error',
  // P5 (p5-w1)
  state_invalid: 'connect state invalid, used or expired',
  workspace_mismatch: 'connected to another workspace',
  connect_stale: 'connect superseded by a newer change',
  connect_refused: 'connect refused by the provider',
  paused: 'connector paused',
  // Stage 1 M4 (M4-A)
  needs_key: 'the connection needs a new key',
  definition_changed: 'the tool changed since it was confirmed',
  needs_input: 'the tool asked for input the hub cannot give',
  leak: "another tool's data can't go to this connection",
  client_fault: 'the login server refused the client',
  not_built: 'not built yet',
  connections_off: 'connections are off in this build',
}

export const isHubErrorCode = (code: unknown): code is HubErrorCode => typeof code === 'string' && Object.hasOwn(TEXT, code)

/** `detail` must be a safe name (tool name, scope handles, error codes); callers never pass upstream text. */
export function hubError(code: HubErrorCode, detail?: string, retryAfterMs?: number): HubError {
  const error: HubError = { code, message: detail ? `${TEXT[code]}: ${detail}` : TEXT[code] }
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs
  return error
}

export const err = <T = never>(code: HubErrorCode, detail?: string, retryAfterMs?: number): HubResult<T> => ({
  ok: false,
  error: hubError(code, detail, retryAfterMs),
})

export const ok = <T>(value: T): HubResult<T> => ({ ok: true, value })
