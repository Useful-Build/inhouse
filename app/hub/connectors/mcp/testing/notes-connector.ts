// The generic dynamic OAuth MCP connector, test build only (P5 W1 section 10, profile `notes`). Loaded only inside
// H0's guarded test branch (an orchestrator line in signin.ts's loadRegistry); the bundle scan keeps every testing/
// folder out of a deployable bundle. Its upstream is app/test/upstreams/mcp/ (hosts below).
import { z } from 'zod'
import type { McpClientConfig, McpConnectorModule } from '../../../registry/registry'

export const NOTES_ACCOUNT = 'notes:test'
export const NOTES_MCP_HOST = 'notes.example.com'
export const NOTES_AUTH_HOST = 'auth.notes.example.com'

export function notesConfig(env: Readonly<Record<string, unknown>>): McpClientConfig | null {
  const redirectUri = env.CONNECT_REDIRECT_URI
  if (typeof redirectUri !== 'string' || !redirectUri.startsWith('https://')) return null
  return { clientId: null, clientSecret: null, redirectUri, teamId: null, policies: [] }
}

export const notesConnector: McpConnectorModule = {
  kind: 'oauth_mcp',
  id: 'notes',
  accountId: NOTES_ACCOUNT,
  profile: 'generic',
  mcp: { endpoint: `https://${NOTES_MCP_HOST}/mcp`, resource: `https://${NOTES_MCP_HOST}/mcp`, allowedHosts: [NOTES_MCP_HOST, NOTES_AUTH_HOST] },
  client: 'dynamic',
  scopes: { base: ['notes:read'], policy: {} },
  tools: [
    { name: 'notes_search', upstream: 'notes_search', description: 'Searches test notes by words.', input: z.strictObject({ query: z.string().min(1).max(100) }) },
    { name: 'notes_read', upstream: 'notes_read', description: 'Reads one test note by id.', input: z.strictObject({ id: z.string().regex(/^n\d{1,6}$/) }) },
  ],
  knownWrites: ['notes_delete'],
  configure: notesConfig,
}
