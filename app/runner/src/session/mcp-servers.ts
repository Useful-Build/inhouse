// The session's MCP servers (P4 H1): all go through the root's loopback proxy, which adds the run's token. `inhouse`
// (P3's 20 tools) at the proxy's `/mcp/`; `apps` (the connector hub's read tools, `mcp__apps__<tool>`, OC 5) at its
// `/hub/`; and, only when the run config's `actions` is true (Stage 1, N6), `actions` (M2's write tools,
// `mcp__actions__<tool>`) at its `/actions/`. Nothing else: the guards (src/guards/options.ts) refuse any other server,
// type or URL, and refuse `actions` on a run that didn't ask for it.
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { INHOUSE_MCP_SERVER } from '../guards/lists.ts'

export const INHOUSE_SERVER = INHOUSE_MCP_SERVER
/** One server for every connector the hub serves, so the runner needs no per-brand connector list. */
export const APPS_SERVER = 'apps'
/** The write tools' server. It rides the run's `mcp` token (src/proxy/server.ts), so it closes when `mcp` does. */
export const ACTIONS_SERVER = 'actions'

export type McpServerName = typeof INHOUSE_SERVER | typeof APPS_SERVER | typeof ACTIONS_SERVER

/** Each server's URL under the proxy (the egress routes `/mcp/`, `/hub/` and `/actions/`). */
export function mcpServerUrls(proxyUrl: string): Record<McpServerName, string> {
  const proxy = proxyUrl.replace(/\/$/, '')
  return { [INHOUSE_SERVER]: `${proxy}/mcp/`, [APPS_SERVER]: `${proxy}/hub/`, [ACTIONS_SERVER]: `${proxy}/actions/` }
}

/** The servers for a session; none without a proxy (a bare test env, as before). `actions` only when asked for. */
export function mcpServers(proxyUrl: string | undefined, actions = false): Options['mcpServers'] | undefined {
  if (!proxyUrl) return undefined
  const urls = mcpServerUrls(proxyUrl)
  return {
    [INHOUSE_SERVER]: { type: 'http', url: urls[INHOUSE_SERVER] },
    [APPS_SERVER]: { type: 'http', url: urls[APPS_SERVER] },
    ...(actions ? { [ACTIONS_SERVER]: { type: 'http' as const, url: urls[ACTIONS_SERVER] } } : {}),
  }
}
