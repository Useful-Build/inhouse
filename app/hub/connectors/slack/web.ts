// The three Slack Web API calls the delivery path makes (P5 W4, p5-w4.md section 6): `conversations.info`,
// `conversations.list` and `chat.postMessage`, on `https://slack.com/api/<method>` only. H0's patterns through W1's
// `send`: `redirect: 'manual'`, a 10 s deadline, a 64 KiB body cap, the host checked before the request leaves. The
// bearer is built per request from the token the SignIn core opened into a local. Nothing from a Slack body reaches a
// result except the parsed channel fields and the message `ts`; Slack's error strings map to our closed codes.
// Docs read 2026-11-21:
// - https://docs.slack.dev/reference/methods/chat.postMessage (form-encoded args, `unfurl_links`, `unfurl_media`,
//   errors `not_in_channel`, `channel_not_found`, `restricted_action`, `ratelimited`)
// - https://docs.slack.dev/reference/methods/conversations.info, https://docs.slack.dev/reference/methods/conversations.list
//   (`types=public_channel`, `exclude_archived`, `limit`, `cursor`, `response_metadata.next_cursor`)
// - https://docs.slack.dev/reference/objects/conversation-object (`is_shared`, `is_ext_shared`, `is_org_shared`,
//   `is_pending_ext_shared`, `is_private`, `is_archived`, `is_member`, `is_channel`)
// - https://docs.slack.dev/apis/web-api/rate-limits (HTTP 429 with `Retry-After`)
import type { HubErrorCode } from '../../index/contract'
import { jsonObject, retryAfterMs, send, TOKEN_MAX_BYTES, TOKEN_TIMEOUT_MS, type Upstream } from '../../oauth/http'
import type { SlackChannel } from './contract'

export const SLACK_API = 'https://slack.com/api/'
export const SLACK_API_HOSTS = ['slack.com'] as const
export const LIST_LIMIT = 200

/** A public channel id: never `U…` (a DM by user id), `D…` (a DM) or `G…` (private or multi-person DM). */
export const POSTABLE_CHANNEL = /^C[A-Z0-9]{8,}$/
/** Any channel id the hub reads back. */
const CHANNEL_ID = /^[CG][A-Z0-9]{2,20}$/

export type WebMethod = 'conversations.info' | 'conversations.list' | 'chat.postMessage'

export type WebOutcome =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'unauthorized' }
  | { kind: 'error'; code: HubErrorCode; detail?: string; retryAfterMs?: number }

/** Slack's token errors: the connection needs a reconnect, never a retry. */
const AUTH_ERRORS = new Set(['not_authed', 'invalid_auth', 'account_inactive', 'token_revoked', 'token_expired', 'missing_scope'])

/** One form-encoded POST to `slack.com/api/<method>` with exactly `params`. */
export async function callWeb(upstream: Upstream, token: string, method: WebMethod, params: Record<string, string>): Promise<WebOutcome> {
  const sent = await send(
    upstream,
    `${SLACK_API}${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', Authorization: `Bearer ${token}` },
      body: new URLSearchParams(params).toString(),
    },
    { allowedHosts: SLACK_API_HOSTS, timeoutMs: TOKEN_TIMEOUT_MS, maxBytes: TOKEN_MAX_BYTES },
  )
  if (sent.kind === 'blocked') return { kind: 'error', code: 'internal' }
  if (sent.kind !== 'response') return { kind: 'error', code: 'upstream_unavailable' }
  if (sent.status === 429) return { kind: 'error', code: 'rate_limited', retryAfterMs: retryAfterMs(sent.headers) }
  if (sent.status === 401) return { kind: 'unauthorized' }
  if (sent.status >= 500 || sent.status < 200 || (sent.status >= 300 && sent.status < 400)) return { kind: 'error', code: 'upstream_unavailable' }
  if (sent.status >= 400) return { kind: 'error', code: 'upstream_rejected' }
  if (sent.tooLarge) return { kind: 'error', code: 'result_too_large' }
  const body = jsonObject(sent.text)
  if (!body) return { kind: 'error', code: 'upstream_unavailable' }
  if (body.ok === true) return { kind: 'ok', body }
  const error = typeof body.error === 'string' ? body.error : ''
  if (error === 'ratelimited') return { kind: 'error', code: 'rate_limited', retryAfterMs: retryAfterMs(sent.headers) }
  if (AUTH_ERRORS.has(error)) return error === 'missing_scope' ? { kind: 'error', code: 'scope_mismatch' } : { kind: 'unauthorized' }
  if (error === 'not_in_channel') return { kind: 'error', code: 'connect_refused', detail: 'not_member' }
  if (error === 'is_archived') return { kind: 'error', code: 'connect_refused', detail: 'archived' }
  if (error === 'channel_not_found') return { kind: 'error', code: 'connect_refused', detail: 'not_found' }
  return { kind: 'error', code: 'upstream_rejected' }
}

/** A Slack conversation object as our SlackChannel; null when it isn't one (a malformed answer). */
export function parseChannel(raw: unknown): SlackChannel | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  if (typeof c.id !== 'string' || !CHANNEL_ID.test(c.id)) return null
  if (typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 80) return null
  const flag = (k: string) => c[k] === true
  return {
    id: c.id,
    name: c.name,
    isMember: flag('is_member'),
    shared: flag('is_shared') || flag('is_ext_shared') || flag('is_org_shared') || flag('is_pending_ext_shared'),
    archived: flag('is_archived'),
    // A conversation that isn't a public channel counts as private: `is_private`, a `G` id, or `is_channel` false.
    private: flag('is_private') || c.id.startsWith('G') || c.is_channel === false,
  }
}

/** Why a channel can't take a post, or null when it can (section 6, step 2). */
export function refusalFor(c: SlackChannel): 'shared_channel' | 'archived' | 'not_public' | 'not_member' | null {
  if (c.shared) return 'shared_channel'
  if (c.archived) return 'archived'
  if (c.private || !POSTABLE_CHANNEL.test(c.id)) return 'not_public'
  if (!c.isMember) return 'not_member'
  return null
}
