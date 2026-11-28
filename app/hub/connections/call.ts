// connectionCall (Stage 1 M4-R1, N35): the one way anything reaches a connection's server. Built whole here; later
// packages fill its hooks (hooks.ts) and never edit app/hub/signin/.
//
// The fence: the call starts from one read of the record and remembers its `generation`, `policyRev` and `state`.
// - After every await the record is read again; a remove, a changed generation (a binding or credential change) or
//   `policyRev` (a pause, a trust flip, a confirm, a settings change), a pause or a changed state stops the call.
// - The last check runs inside the upstream every request leaves through (`guarded` below), on every hop: the destination
//   rule, the DNS half of the address check (an await), then the record read again with `beforeCall` (M4-H), then the
//   send, with no await between that check and the send (as N11's permit). So nothing the SDK does in between (its
//   probe, its handshake) can carry a request past a change that landed meanwhile.
// - A request that has left can't be recalled. When the fence breaks after a send, the answer is dropped and the call is
//   refused; a write is then `sent: 'unknown'` ("Needs a check"), never `no`. `sent: 'no'` only when no `tools/call` left.
// The credential comes from `credentialFor` (M4-B's key, M4-O1a's sign-in) and goes only where destinations.ts allows
// its class: the binding's exact `mcp` address. An open connection (`path: 'none'`) sends none and asks no hook.
import type { Tool } from '@modelcontextprotocol/client'
import type { ConnectionState, HubError, HubErrorCode } from '../index/contract'
import { hubError } from '../index/errors'
import type { KeyRingResult } from '../crypto/keyring'
import type { McpToolResult } from '../registry/registry'
import { McpFetchRefused, type McpCredential, type Upstream } from '../oauth/http'
import { sdkCallTool, sdkListTools, type Era, type EraCache, type McpCallOk, type McpFail, type McpFailure, type SdkDeps } from '../connectors/mcp/sdk'
import { destinationRefusal, hostOf, STRIPPED_HEADERS, type CredentialClass, type ResolvePublic } from './destinations'
import type { ConnectionRecord } from './record'
import type { ConnectionHooks } from './hooks'

/** What a caller asks. A write names the pins it was approved under (N46); the server sets them, never a request. */
export type ConnectionCallRequest =
  | { kind: 'list' }
  | { kind: 'read'; tool: string; args: Record<string, unknown> }
  | { kind: 'write'; tool: string; args: Record<string, unknown>; expect: { generation: number; defHash: string; policyRev: number } }

/** What the call started from. Any difference in the record now stops it. */
export type Fence = { generation: number; policyRev: number; state: ConnectionState }

export type CallOutcome =
  | { kind: 'list'; tools: Tool[]; excluded: number; era: Era }
  | { kind: 'read'; result: McpToolResult; dropped: number; era: Era }
  | { kind: 'write'; result: McpToolResult; dropped: number; era: Era }

/** `sent`: whether a `tools/call` may have left (`no` for every list, and for a call stopped before its POST). */
export type CallResult = { ok: true; value: CallOutcome } | { ok: false; error: HubError; sent: 'no' | 'unknown' }

/** What the SignIn object gives a call: its record, synchronously, and the runtime. */
export type CallHost = {
  accountId: string
  /** The record now, or null when there is none or only a tombstone. Synchronous: no await inside. */
  read(): ConnectionRecord | null
  /** Re-reads under the fence and writes the change in one synchronous step; null when the fence broke (nothing written). */
  commit(fence: Fence, change: (r: ConnectionRecord) => ConnectionRecord): ConnectionRecord | null
  now(): number
  upstream(): Promise<Upstream>
  resolvePublic: ResolvePublic
  keyring(): Promise<KeyRingResult>
  eras: EraCache
  hooks: ConnectionHooks
  /** The SDK's per-request deadline and byte cap (tests shorten them). */
  timeoutMs?: number
}

const STATE_CODE: Record<ConnectionState, HubErrorCode> = {
  waiting_signin: 'not_configured',
  waiting_key: 'needs_key',
  needs_review: 'not_configured',
  live: 'internal',
  sign_in_again: 'credentials_rejected',
  needs_key: 'needs_key',
  unavailable: 'upstream_unavailable',
}

/** The fence rule: what stops a call now, or null. Pause first (its own code), then any change of the record. */
export function stopCode(r: ConnectionRecord | null, fence: Fence): HubErrorCode | null {
  if (!r) return 'not_configured'
  if (r.paused) return 'paused'
  if (r.generation !== fence.generation || r.policyRev !== fence.policyRev) return 'definition_changed'
  if (r.state !== fence.state) return STATE_CODE[r.state] === 'internal' ? 'definition_changed' : STATE_CODE[r.state]
  return null
}

const fenceOf = (r: ConnectionRecord): Fence => ({ generation: r.generation, policyRev: r.policyRev, state: r.state })

/** A failure the SDK reported, as a hub code. Nothing from an upstream body or header. */
export function codeOf(reason: McpFailure, path: ConnectionRecord['binding']['path']): HubErrorCode {
  switch (reason) {
    case 'unauthorized':
      return path === 'key' ? 'needs_key' : 'credentials_rejected'
    case 'insufficient_scope':
      return 'scope_mismatch'
    case 'rate_limited':
      return 'rate_limited'
    case 'too_large':
      return 'result_too_large'
    case 'header_mismatch':
      return 'definition_changed'
    case 'version':
      return 'upstream_version_mismatch'
    case 'forbidden':
    case 'rejected':
    case 'tool_error':
      return 'upstream_rejected'
    case 'needs_input':
      return 'needs_input'
    case 'blocked':
      return 'internal'
    case 'unavailable':
    case 'lost':
    case 'malformed':
    case 'over_budget':
      return 'upstream_unavailable'
  }
}

const refused = (code: HubErrorCode, sent: 'no' | 'unknown' = 'no', detail?: string, retryAfterMs?: number): CallResult => ({ ok: false, error: hubError(code, detail, retryAfterMs), sent })

/** The JSON-RPC method of a request body (to count the `tools/call` POSTs that left). */
function rpcOf(body: string): string | null {
  try {
    const m = JSON.parse(body) as { method?: unknown }
    return typeof m === 'object' && m !== null && typeof m.method === 'string' ? m.method : null
  } catch {
    return null
  }
}

/** One call to a connection. See the module header. */
export async function connectionCall(host: CallHost, req: ConnectionCallRequest): Promise<CallResult> {
  const r0 = host.read()
  if (!r0) return refused('not_configured')
  const fence = fenceOf(r0)
  const startRefusal = (r: ConnectionRecord): HubErrorCode | null => {
    if (r.paused) return 'paused'
    if (r.binding.transport !== 'https' || !r.binding.destinations) return 'not_built' // M4-P1's transport
    if (req.kind !== 'list' && r.state !== 'live') return STATE_CODE[r.state] === 'internal' ? 'not_configured' : STATE_CODE[r.state]
    if (req.kind === 'write' && (req.expect.generation !== r.generation || req.expect.policyRev !== r.policyRev)) return 'definition_changed'
    return host.hooks.beforeCall({ record: r, request: req, fence, nowMs: host.now() })
  }
  const first = startRefusal(r0)
  if (first) return refused(first)
  /** After every await: the record again, the fence and the hook. */
  const recheck = (): HubErrorCode | null => {
    const r = host.read()
    return stopCode(r, fence) ?? host.hooks.beforeCall({ record: r!, request: req, fence, nowMs: host.now() })
  }

  // The credential, and the class destinations.ts judges it by.
  let credential: McpCredential | null = null
  let cls: CredentialClass = 'none'
  if (r0.binding.path !== 'none') {
    const c = await host.hooks.credentialFor({ record: r0, request: req, keyring: host.keyring, nowMs: host.now() })
    const moved = recheck()
    if (moved) return refused(moved)
    if (!c.ok) return { ok: false, error: c.error, sent: 'no' }
    credential = c.value.credential
    cls = c.value.cls
  }
  const destinations = r0.binding.destinations!
  const endpoint = destinations.mcp
  const atStart = destinationRefusal(destinations, 'mcp', endpoint, cls)
  if (atStart) return refused('invalid_args', 'no', `destination_${atStart}`)

  const base = await host.upstream()
  const movedAfterUpstream = recheck()
  if (movedAfterUpstream) return refused(movedAfterUpstream)

  let stopped: HubErrorCode | null = null
  let toolCallsLeft = 0
  // Every request the SDK sends comes through here (oauth/http.ts mcpFetch hands it over with `redirect: 'manual'`).
  const guarded: Upstream = async request => {
    const body = await request.clone().text()
    const refusal = destinationRefusal(destinations, 'mcp', request.url, cls)
    if (refusal) {
      stopped ??= 'invalid_args'
      throw new McpFetchRefused('destination')
    }
    if (!(await host.resolvePublic(hostOf(new URL(request.url))))) {
      stopped ??= 'upstream_unavailable'
      throw new McpFetchRefused('address')
    }
    // ---- The last check. Synchronous from here to the send: no await until `base` is called. ----
    const code = recheck()
    if (code) {
      stopped ??= code
      throw new McpFetchRefused('stopped')
    }
    const headers = new Headers(request.headers)
    for (const h of STRIPPED_HEADERS) headers.delete(h)
    if (rpcOf(body) === 'tools/call') toolCallsLeft++
    return base(new Request(request.url, { method: request.method, headers, body: body.length > 0 ? body : null, redirect: 'manual', signal: request.signal }))
  }
  const sdk: SdkDeps = { upstream: guarded, now: host.now, eras: host.eras, ...(host.timeoutMs !== undefined ? { timeoutMs: host.timeoutMs } : {}) }
  const target = { endpoint, generation: r0.generation, credential }
  const sentNow = (): 'no' | 'unknown' => (toolCallsLeft > 0 ? 'unknown' : 'no')
  /** An SDK answer, read through the fence: a stop that landed during the send wins over the answer. */
  const settle = (out: McpFail | { kind: 'ok' }): CallResult | null => {
    if (stopped) return refused(stopped, sentNow())
    const moved = recheck()
    if (moved) return refused(moved, sentNow())
    if (out.kind === 'error') return refused(codeOf(out.reason, r0.binding.path), sentNow(), undefined, out.retryAfterMs)
    return null
  }

  let result: CallResult
  if (req.kind === 'list') {
    const out = await sdkListTools(sdk, target)
    result = settle(out) ?? (out.kind === 'ok' ? { ok: true, value: { kind: 'list', tools: out.tools, excluded: out.excluded, era: out.era } } : refused('internal'))
  } else {
    const tool = r0.tools.find(t => t.name === req.tool)
    if (!tool) return refused('unknown_tool')
    const definition = { name: tool.name, inputSchema: tool.inputSchema as Tool['inputSchema'] }
    const send = async (): Promise<CallResult> => {
      const out: McpCallOk | McpFail = await sdkCallTool(sdk, target, { tool: definition, args: req.args, mode: req.kind, session: null })
      const s = settle(out)
      if (s) return s
      if (out.kind !== 'ok') return refused('internal', sentNow())
      return { ok: true, value: { kind: req.kind, result: out.result, dropped: out.dropped, era: out.era } }
    }
    result = req.kind === 'read' ? await send() : await host.hooks.write({ record: r0, request: req, fence, send })
  }
  return host.hooks.afterCall({ record: r0, request: req, fence, result, commit: change => host.commit(fence, change) })
}
