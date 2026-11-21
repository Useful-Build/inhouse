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
]

export function log(event: LogEvent, fields: LogFields = {}): void {
  const line: Record<string, unknown> = { event }
  for (const key of ALLOWED) {
    const value = fields[key]
    if (typeof value === 'string' || typeof value === 'number') line[key] = value
  }
  console.log(JSON.stringify(line))
}
