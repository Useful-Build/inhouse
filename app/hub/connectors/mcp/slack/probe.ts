// The S4 open question (P5 W1 section 7): with the test app's 5-scope token, does Slack hide a tool whose scope is
// missing, or list it and fail? Records whether `slack_search_users` (needs search:read.users) and `slack_read_file`
// (needs files:read) are listed, then calls `slack_search_users` once. Prints outcome names only: never a token, a
// body, a header or upstream text. The connect-side questions (the `resource` parameter, scopes after auth.revoke, the
// same token on re-authorization) need the consent screen and are recorded by hand in the orchestrator's live check.
import type { Upstream } from '../../../oauth/http'
import { reviewedCall } from '../reviewed-call'
import { EraCache, sdkListTools, type McpTarget, type SdkDeps } from '../sdk'
import { slackConnector } from './route'

export type ProbeResult = {
  listed: { slack_search_users: boolean; slack_read_file: boolean }
  /** `ok`, `unauthorized` or a hub error code (`scope_mismatch` = 403 insufficient_scope, `upstream_rejected` = hidden). */
  searchUsers: string
}

export async function probe(upstream: Upstream, token: string): Promise<ProbeResult> {
  const deps: SdkDeps = { upstream, now: () => Date.now(), eras: new EraCache() }
  const target: McpTarget = { endpoint: slackConnector.mcp.endpoint, generation: 0, credential: { header: 'Authorization', value: `Bearer ${token}` } }
  const list = await sdkListTools(deps, target)
  const names = list.kind === 'ok' ? list.tools.map(t => t.name) : []
  const out = await reviewedCall(deps, { endpoint: target.endpoint, token, generation: 0, session: null, name: 'slack_search_users', args: { query: 'test' } })
  return {
    listed: { slack_search_users: names.includes('slack_search_users'), slack_read_file: names.includes('slack_read_file') },
    searchUsers: out.kind === 'ok' ? 'ok' : out.kind === 'unauthorized' ? 'unauthorized' : out.code,
  }
}
