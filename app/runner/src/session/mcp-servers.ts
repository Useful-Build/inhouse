// The session's MCP servers (P4 H1): both go through the root's loopback proxy, which adds the run's token. `inhouse`
// (P3's 20 tools) at the proxy's `/mcp/`; `apps` (the connector hub's read tools, `mcp__apps__<tool>`, OC 5) at its
// `/hub/`. Nothing else: the guards (src/guards/options.ts) refuse any other server, type or URL.
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { INHOUSE_MCP_SERVER } from '../guards/lists.ts'

export const INHOUSE_SERVER = INHOUSE_MCP_SERVER
/** One server for every connector the hub serves, so the runner needs no per-brand connector list. */
export const APPS_SERVER = 'apps'

/** Each server's URL under the proxy (the egress routes `/mcp/` and `/hub/`). */
export function mcpServerUrls(proxyUrl: string): Record<typeof INHOUSE_SERVER | typeof APPS_SERVER, string> {
  const proxy = proxyUrl.replace(/\/$/, '')
  return { [INHOUSE_SERVER]: `${proxy}/mcp/`, [APPS_SERVER]: `${proxy}/hub/` }
}

/** The servers for a session; none without a proxy (a bare test env, as before). */
export function mcpServers(proxyUrl: string | undefined): Options['mcpServers'] | undefined {
  if (!proxyUrl) return undefined
  const urls = mcpServerUrls(proxyUrl)
  return { [INHOUSE_SERVER]: { type: 'http', url: urls[INHOUSE_SERVER] }, [APPS_SERVER]: { type: 'http', url: urls[APPS_SERVER] } }
}
