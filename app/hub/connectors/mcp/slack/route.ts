// The Slack connector (P5 W1): Slack's hosted MCP server, one internal Slack app per brand, pre-registered (Slack has
// no Dynamic Client Registration), read tools only. Default deny: the hub lists exactly the entries below, with our
// descriptions and narrowed inputs; any other upstream tool is hidden and uncallable until a reviewed PR lists it.
// Docs read 2026-11-21:
// - https://docs.slack.dev/ai/slack-mcp-server/ (endpoint https://mcp.slack.com/mcp, streamable HTTP, no DCR,
//   confidential OAuth, user token flow v2_user/authorize then oauth.v2.user.access, scope groups per tool)
// - https://mcp.slack.com/.well-known/oauth-protected-resource (`resource` https://mcp.slack.com) and
//   .well-known/oauth-authorization-server (client_secret_post, S256) as the brief records them (2026-11-20)
// - https://docs.slack.dev/reference/methods/auth.revoke
// Tool and argument names follow S4's `tools/list`; the orchestrator's live check confirms them before freezing, and
// the nightly (W5) fails on drift.
import { z } from 'zod'
import type { McpClientConfig, McpConnectorModule, McpToolEntry } from '../../../registry/registry'

const CHANNEL_ID = z.string().regex(/^[CG][A-Z0-9]{2,20}$/)
const USER_ID = z.string().regex(/^[UW][A-Z0-9]{2,20}$/)
const TS = z.string().regex(/^\d{1,12}\.\d{1,8}$/)
const CURSOR = z.string().min(1).max(500)
/** Slack's search date bounds: YYYY-MM-DD. */
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const KEYWORDS = z.array(z.string().min(1).max(100)).min(1).max(5)

const searchInput = z.strictObject({
  keywords: KEYWORDS.describe('Distinctive words; every word must appear in a message (ANDed, exact).'),
  limit: z.number().int().min(1).max(20).optional(),
  after: DATE.optional(),
  before: DATE.optional(),
  sort: z.enum(['score', 'timestamp']).optional(),
  sort_dir: z.enum(['asc', 'desc']).optional(),
  cursor: CURSOR.optional(),
})

const SEARCH_HINT =
  'Keywords are ANDed and matched exactly, so a message must contain every word given. Search one distinctive word ' +
  'at a time, and try the likely wordings (for a delay: "late", "delay", "ships", "slipped") before concluding that ' +
  'nothing exists.'

export const slackTools: readonly McpToolEntry[] = [
  {
    name: 'slack_search_public',
    upstream: 'slack_search_public',
    description: `Searches messages in the workspace's public Slack channels. ${SEARCH_HINT}`,
    input: searchInput,
    fixed: { response_format: 'concise' },
  },
  {
    name: 'slack_search_channels',
    upstream: 'slack_search_channels',
    description: 'Finds public Slack channels by name or topic words. Returns channel ids for slack_read_channel.',
    input: z.strictObject({ keywords: KEYWORDS, limit: z.number().int().min(1).max(20).optional(), cursor: CURSOR.optional() }),
    fixed: { channel_types: 'public_channel', include_archived: false },
  },
  {
    name: 'slack_read_channel',
    upstream: 'slack_read_channel',
    description: 'Reads the latest messages of one public Slack channel (25 per page). Narrow with oldest or latest (message timestamps).',
    input: z.strictObject({ channel_id: CHANNEL_ID, cursor: CURSOR.optional(), oldest: TS.optional(), latest: TS.optional() }),
    fixed: { response_format: 'concise', limit: 25 },
  },
  {
    name: 'slack_read_thread',
    upstream: 'slack_read_thread',
    description: 'Reads the replies of one Slack thread (25 per page), given its channel id and the parent message timestamp.',
    input: z.strictObject({ channel_id: CHANNEL_ID, message_ts: TS, cursor: CURSOR.optional() }),
    fixed: { response_format: 'concise', limit: 25 },
  },
  {
    name: 'slack_list_user_channels',
    upstream: 'slack_list_user_channels',
    description: 'Lists the public Slack channels the connected person belongs to, without archived ones.',
    input: z.strictObject({ limit: z.number().int().min(1).max(100).optional(), cursor: CURSOR.optional() }),
    fixed: { types: 'public_channel', exclude_archived: true },
  },
  {
    name: 'slack_list_channel_members',
    upstream: 'slack_list_channel_members',
    description: 'Lists the members of one public Slack channel by user id.',
    input: z.strictObject({ channel_id: CHANNEL_ID, limit: z.number().int().min(1).max(100).optional(), cursor: CURSOR.optional() }),
  },
  {
    name: 'slack_read_user_profile',
    upstream: 'slack_read_user_profile',
    description: "Reads one Slack user's profile (name, title, time zone) by user id; without an id, the connected person's.",
    input: z.strictObject({ user_id: USER_ID.optional() }),
  },
  {
    name: 'slack_search_public_and_private',
    upstream: 'slack_search_public_and_private',
    description: `Searches messages in public Slack channels and the private channels the connected person is in (never direct messages). ${SEARCH_HINT}`,
    input: searchInput,
    fixed: { response_format: 'concise', channel_types: 'public_channel,private_channel' },
    policy: 'privateSearch',
  },
]

/** The 13 writes S4's `tools/list` showed. `callTool` on one answers write_refused; none can ever be listed. */
export const SLACK_KNOWN_WRITES = [
  'slack_send_message',
  'slack_schedule_message',
  'slack_send_message_draft',
  'slack_add_reaction',
  'slack_create_conversation',
  'slack_create_canvas',
  'slack_update_canvas',
  'slack_create_list',
  'slack_update_list',
  'slack_add_list_record',
  'slack_update_list_record',
  'slack_get_file_upload_url',
  'slack_complete_file_upload',
] as const

const TEAM_ID = /^T[A-Z0-9]{2,20}$/

/**
 * Hub vars `SLACK_CLIENT_ID`, `SLACK_TEAM_ID`, `SLACK_PRIVATE_SEARCH` (`off` default), `CONNECT_REDIRECT_URI` and the
 * optional secret `SLACK_CLIENT_SECRET` (OC-W1-9). Any missing or malformed value: not configured.
 */
export function slackConfig(env: Readonly<Record<string, unknown>>): McpClientConfig | null {
  const str = (k: string) => (typeof env[k] === 'string' && (env[k] as string).length > 0 ? (env[k] as string) : null)
  const clientId = str('SLACK_CLIENT_ID')
  const clientSecret = str('SLACK_CLIENT_SECRET')
  const teamId = str('SLACK_TEAM_ID')
  const redirectUri = str('CONNECT_REDIRECT_URI')
  const privateSearch = str('SLACK_PRIVATE_SEARCH') ?? 'off'
  if (!clientId || !clientSecret || !teamId || !TEAM_ID.test(teamId) || !redirectUri) return null
  if (!redirectUri.startsWith('https://') || !redirectUri.endsWith('/api/connect/callback')) return null
  if (privateSearch !== 'on' && privateSearch !== 'off') return null
  return { clientId, clientSecret, redirectUri, teamId, policies: privateSearch === 'on' ? ['privateSearch'] : [] }
}

export const slackConnector: McpConnectorModule = {
  kind: 'oauth_mcp',
  id: 'slack',
  accountId: 'slack:workspace',
  profile: 'slack',
  mcp: {
    endpoint: 'https://mcp.slack.com/mcp',
    // PRM's value: no `/mcp` path, unlike the endpoint.
    resource: 'https://mcp.slack.com',
    // Set from the live probe (brief section 7); on until it shows Slack refuses the parameter.
    sendResource: true,
    allowedHosts: ['mcp.slack.com', 'slack.com'],
  },
  client: 'preregistered',
  endpoints: {
    authorization: 'https://slack.com/oauth/v2_user/authorize',
    token: 'https://slack.com/api/oauth.v2.user.access',
    revoke: 'https://slack.com/api/auth.revoke',
  },
  scopes: {
    // The five least scopes. DMs (`im:*`, `mpim:*`) are never read.
    base: ['search:read.public', 'channels:read', 'channels:history', 'users:read', 'chat:write'],
    policy: { privateSearch: ['search:read.private', 'groups:history'] },
  },
  tools: slackTools,
  knownWrites: SLACK_KNOWN_WRITES,
  configure: slackConfig,
}
