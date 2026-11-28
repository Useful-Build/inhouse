// One reviewed upstream read for the sign-in core (Stage 1 M4-C2): a `tools/call` through the SDK wrapper (sdk.ts, N36),
// answered in the hub's codes. It replaces the hand-written client (P5 W1 section 6) that Slack and the notes fixture
// used, so the hub has one MCP client. The codes are the old client's, one for one, so every caller and test reads
// the same answers:
// - a 401 is `unauthorized` (the core refreshes or re-initialises, then re-sends once, as before);
// - a 403 `insufficient_scope` is scope_mismatch, any other 403 or 4xx, a JSON-RPC error or `isError: true` is
//   upstream_rejected (never with upstream text); a 429 is rate_limited with its Retry-After;
// - a 5xx, a redirect, a network failure, a lost answer or one that isn't MCP is upstream_unavailable, and so is a 404
//   to a request that carried a 2025 session (the server ended it: sdk.ts starts a new one once for a reused session);
// - an answer over the byte cap is result_too_large; a request our fetch refused to send is internal.
// Only reviewed reads come here (the connector's `tools` entries; a known write is refused before this), so the call
// is `mode: 'read'`: a 2025 session is reused across calls and a lost answer is sent once more (N36 "Reads").
// The definition passed is the bare name with an open object schema: the reviewed entry's zod input already checked
// the arguments, and M4-H brings the confirmed upstream definition.
// Slack's era is pinned as legacy (`LEGACY_PINNED`): its reads run the plain 2025 handshake and never probe with
// `server/discover`, so its wire is exactly the old client's (initialize, the notification, the call). Unpinned, a
// probe answered with a 401 would read as a rejected token and delete Slack's credentials, and a 403, 5xx or non-MCP
// answer would fail every read (Fable, #692 round 1; #696 tracks the probe's 401 for unpinned servers). The notes
// fixture stays unpinned, so the probe path stays covered.
import type { HubErrorCode } from '../../index/contract'
import type { McpToolResult } from '../../registry/registry'
import type { WireEvent } from '../../oauth/http'
import { ERA_TTL_MS, sdkCallTool, type LegacySession, type McpFail, type SdkDeps } from './sdk'

/** Connectors (by id) whose server is known to speak only the 2025 protocol: their era is pinned, never probed. */
export const LEGACY_PINNED: ReadonlySet<string> = new Set(['slack'])

export type ReviewedOutcome =
  | { kind: 'ok'; result: McpToolResult; dropped: number; session: LegacySession | null }
  | { kind: 'unauthorized' }
  | { kind: 'error'; code: HubErrorCode; retryAfterMs?: number }

export type ReviewedCall = {
  endpoint: string
  /** The bearer, attached by our fetch to the endpoint's exact URL only. */
  token: string
  generation: number
  /** A 2025 session from an earlier read on this endpoint and generation. */
  session: LegacySession | null
  name: string
  args: Record<string, unknown>
  /** `legacy`: the endpoint's era is pinned, so the call runs the 2025 handshake and never sends `server/discover`. */
  era?: 'legacy'
}

const OPEN_OBJECT = { type: 'object' } as const

/** Whether the request that failed carried a 2025 session id: anything after a handshake, or on a reused session. */
function sessionRequest(wire: WireEvent[], event: WireEvent, reused: boolean): boolean {
  if (event.rpc === 'initialize' || event.rpc === 'server/discover') return false
  return reused || wire.some(e => e.rpc === 'initialize' && e.fate === 'sent' && e.status !== undefined && e.status >= 200 && e.status < 300)
}

/** The hub's code for a wrapper failure (see the module header). */
export function reviewedFailure(f: McpFail, reused: boolean): Exclude<ReviewedOutcome, { kind: 'ok' }> {
  switch (f.reason) {
    case 'unauthorized':
      return { kind: 'unauthorized' }
    case 'blocked':
      return { kind: 'error', code: 'internal' }
    case 'insufficient_scope':
      return { kind: 'error', code: 'scope_mismatch' }
    case 'rate_limited':
      return { kind: 'error', code: 'rate_limited', ...(f.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {}) }
    case 'too_large':
      return { kind: 'error', code: 'result_too_large' }
    case 'unavailable':
    case 'lost':
    case 'malformed':
    case 'over_budget':
      return { kind: 'error', code: 'upstream_unavailable' }
    case 'rejected': {
      const last = [...f.wire].reverse().find(e => e.fate === 'sent')
      if (last?.status === 404 && sessionRequest(f.wire, last, reused)) return { kind: 'error', code: 'upstream_unavailable' }
      return { kind: 'error', code: 'upstream_rejected' }
    }
    case 'forbidden':
    case 'header_mismatch':
    case 'version':
    case 'tool_error':
    case 'needs_input':
      return { kind: 'error', code: 'upstream_rejected' }
  }
}

/** One reviewed read. Never throws on an upstream answer; nothing from a body, header or SDK error reaches the result. */
export async function reviewedCall(deps: SdkDeps, c: ReviewedCall): Promise<ReviewedOutcome> {
  if (c.era === 'legacy') deps.eras.set(c.endpoint, c.generation, { kind: 'legacy' }, deps.now() + ERA_TTL_MS)
  const reused = c.session !== null && c.session.endpoint === c.endpoint && c.session.generation === c.generation
  const out = await sdkCallTool(
    deps,
    { endpoint: c.endpoint, generation: c.generation, credential: { header: 'Authorization', value: `Bearer ${c.token}` } },
    { tool: { name: c.name, inputSchema: OPEN_OBJECT }, args: c.args, mode: 'read', session: c.session },
  )
  if (out.kind === 'error') return reviewedFailure(out, reused)
  return { kind: 'ok', result: out.result, dropped: out.dropped, session: out.session }
}
