// The S4 open question (P5 W1 section 7): with the test app's 5-scope token, does Slack hide a tool whose scope is
// missing, or list it and fail? Records whether `slack_search_users` (needs search:read.users) and `slack_read_file`
// (needs files:read) are listed, then calls `slack_search_users` once. Prints outcome names only: never a token, a
// body, a header or upstream text. The connect-side questions (the `resource` parameter, scopes after auth.revoke, the
// same token on re-authorization) need the consent screen and are recorded by hand in the orchestrator's live check.
import type { Upstream } from '../../../oauth/http'
import { callMcpTool } from '../client'
import { slackConnector } from './route'

export type ProbeResult = {
  listed: { slack_search_users: boolean; slack_read_file: boolean }
  /** `ok`, `unauthorized` or a hub error code (`scope_mismatch` = 403 insufficient_scope, `upstream_rejected` = hidden). */
  searchUsers: string
}

async function listToolNames(upstream: Upstream, token: string): Promise<string[] | null> {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }
  const post = (body: unknown, session: string | null) =>
    upstream(new Request(slackConnector.mcp.endpoint, { method: 'POST', headers: session ? { ...headers, 'Mcp-Session-Id': session } : headers, body: JSON.stringify(body), redirect: 'manual' }))
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Inhouse', version: '1.0.0' } } }, null)
  if (!init.ok) return null
  const session = init.headers.get('Mcp-Session-Id')
  await init.body?.cancel()
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)
  const text = await list.text()
  const json = (list.headers.get('Content-Type') ?? '').includes('event-stream') ? JSON.parse(text.split('\n').find(l => l.startsWith('data:'))!.slice(5)) : JSON.parse(text)
  const tools = (json?.result?.tools ?? []) as { name?: unknown }[]
  return tools.map(t => String(t.name))
}

export async function probe(upstream: Upstream, token: string): Promise<ProbeResult> {
  const names = (await listToolNames(upstream, token)) ?? []
  const target = { endpoint: slackConnector.mcp.endpoint, allowedHosts: slackConnector.mcp.allowedHosts }
  const out = await callMcpTool(upstream, target, token, 0, null, 'slack_search_users', { query: 'test' })
  return {
    listed: { slack_search_users: names.includes('slack_search_users'), slack_read_file: names.includes('slack_read_file') },
    searchUsers: out.kind === 'ok' ? 'ok' : out.kind === 'unauthorized' ? 'unauthorized' : out.code,
  }
}
