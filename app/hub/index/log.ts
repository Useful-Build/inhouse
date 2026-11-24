// One JSON line per event, allowlisted fields only. Any other field is a type error and is dropped at runtime, so a
// token, secret, key, document, argument, result or upstream body can't reach a log by a field name we didn't list.

export type LogEvent =
  | 'hub_call'
  | 'signin_grant'
  | 'signin_grant_discarded'
  | 'signin_key_missing'
  | 'signin_reencrypt'
  | 'hub_config_invalid'
  | 'hub_internal'
  // P5 (p5-w1)
  | 'connect_start'
  | 'connect_complete'
  | 'revoke_failed'
  | 'mcp_call'
  // P5 (p5-w2)
  | 'hub_codemode'
  // P5 (p5-w4)
  | 'hub_delivery'

export type LogFields = {
  accountId?: string
  tool?: string
  code?: string
  ms?: number
  runId?: string
  requestId?: string
  kid?: string
  generation?: number
  state?: string
  failures?: number
  // P5 (p5-w1)
  memberId?: string
  upstreamTool?: string
  parts?: number
  // P5 (p5-w2): code mode, never the code, a query, variables or a result
  codeHash?: string
  calls?: number
  bytes?: number
  outcome?: string
  // P5 (p5-w4): the first 12 hex of SHA-256 of a channel id, never the id or the text.
  channelHash?: string
}

const ALLOWED: readonly (keyof LogFields)[] = [
  'accountId',
  'tool',
  'code',
  'ms',
  'runId',
  'requestId',
  'kid',
  'generation',
  'state',
  'failures',
  // P5 (p5-w1)
  'memberId',
  'upstreamTool',
  'parts',
  // P5 (p5-w2)
  'codeHash',
  'calls',
  'bytes',
  'outcome',
  // P5 (p5-w4)
  'channelHash',
]

export function log(event: LogEvent, fields: LogFields = {}): void {
  const line: Record<string, unknown> = { event }
  for (const key of ALLOWED) {
    const value = fields[key]
    if (typeof value === 'string' || typeof value === 'number') line[key] = value
  }
  const text = JSON.stringify(line)
  // The hub's TEST bundle only (wrangler.hub.jsonc defines the switch "false", so esbuild drops this): every line also
  // goes to a bounded per-isolate queue that entrypoint and SignIn DO boundaries flush into the singleton test-fakes DO
  // (hub/testing/fakes.ts, op `logs`).
  if (__INHOUSE_HUB_TEST__) {
    const g = globalThis as { __inhouseHubTestLogs?: { lines: string[]; dropped: number } }
    const buf = (g.__inhouseHubTestLogs ??= { lines: [], dropped: 0 })
    buf.lines.push(text)
    if (buf.lines.length > 5000) {
      buf.lines.shift()
      buf.dropped++
    }
  }
  console.log(text)
}

/**
 * TEST BUILD ONLY: drains lines queued in this isolate since the last flush so the caller can forward them to the
 * singleton test-fakes DO. Always empty outside the test bundle.
 */
export function drainPendingTestLogs(): string[] {
  if (__INHOUSE_HUB_TEST__) {
    const g = globalThis as { __inhouseHubTestLogs?: { lines: string[]; dropped: number } }
    const buf = g.__inhouseHubTestLogs
    if (buf && buf.lines.length > 0) return buf.lines.splice(0, buf.lines.length)
  }
  return []
}
