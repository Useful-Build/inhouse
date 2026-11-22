// The nightly Slack checks (P5 W5 section 1), run only by the nightly (a trusted workflow on `main`'s code against the house
// deployment) and the orchestrator's live check through a secret card. Never in CI: no tool token is in CI.
//
// Slack has no separate test mode. The official route is a dedicated workspace and an internal app in it (P0's test workspace),
// which is what this runs against: https://docs.slack.dev/ai/slack-mcp-server/ (the hosted MCP server, user-token flow),
// https://docs.slack.dev/reference/methods/conversations.history (the read-back) and
// https://docs.slack.dev/reference/methods/auth.revoke. The case list below is the brief's eight items.
//
// Every case returns null when it holds, else a short reason with no workspace data in it (the runner prints it). Real ids
// come from the environment, never from the repo.
import { slackConnector, SLACK_KNOWN_WRITES, slackTools } from '../../../hub/connectors/mcp/slack/route'
import type { Discovery, NightlyHub } from './client'

/** The five least scopes, written out (acceptance 7): never read back from the connector, which is the code under test. */
export const EXPECTED_SCOPES = ['channels:history', 'channels:read', 'chat:write', 'search:read.public', 'users:read'] as const
export const SLACK_ACCOUNT = 'slack:workspace'
/** The seeded message the supplier-delay case finds (the fixed text of W1 section 8). One distinctive word is in it. */
export const SUPPLIER_WORD = 'supplier'
export const SUPPLIER_PHRASE = 'supplier delay'
export const RESULT_CAP_BYTES = 32 * 1024

export type NightlyCase = {
  name: string
  run: () => Promise<string | null>
  /** Needs the house deployment's Act stage and the notices channel. */
  houseOnly?: boolean
  /** Why the case doesn't apply in this run (printed as SKIP, never counted as ok). */
  skip?: string
}
export type NightlyEnv = { channelId: string; noticesChannelId: string; rotation: boolean }

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length
const sorted = (a: readonly string[]) => [...a].sort()
const same = (a: readonly string[], b: readonly string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))

/** The read tools and a fixed, harmless argument each, against the seeded public channel. A tool without a row here fails loud (a new allowlisted tool needs its argument). */
export function readArguments(channelId: string): Record<string, unknown> {
  return {
    slack_search_public: { keywords: [SUPPLIER_WORD], limit: 5 },
    slack_search_channels: { keywords: ['general'], limit: 5 },
    slack_read_channel: { channel_id: channelId },
    slack_list_user_channels: { limit: 10 },
    slack_list_channel_members: { channel_id: channelId, limit: 10 },
    slack_read_user_profile: {},
  }
}

/** Names of the allowlisted tools the nightly calls once: the reads that need no private-search policy and no thread id. */
const needsThread = new Set(['slack_read_thread'])
const policyGated = (name: string) => slackTools.find(t => t.name === name)?.policy !== undefined

export function slackCases(hub: NightlyHub, env: NightlyEnv): NightlyCase[] {
  const account = async () => hub.account(SLACK_ACCOUNT)
  return [
    {
      name: '1. the account is active and its scopes equal the five exactly',
      run: async () => {
        const a = await account()
        if (!a.ok) return `status: ${a.code}`
        if (a.value.state !== 'active') return `state is ${a.value.state}`
        return same(a.value.scopes, EXPECTED_SCOPES) ? null : `scopes: ${a.value.scopes.length} granted, not the expected five`
      },
    },
    {
      name: '2. drift: the live tools/list still holds every allowlisted tool, every known write is still a write, new tools are reported',
      run: async () => {
        const live = await hub.liveTools(SLACK_ACCOUNT)
        if (!live.ok) return `liveTools: ${live.code}`
        const byName = new Map(live.value.map(t => [t.name, t]))
        const problems: string[] = []
        for (const t of slackTools) {
          const u = byName.get(t.upstream)
          if (!u) { problems.push(`${t.upstream} is gone upstream`); continue }
          const relied = [...Object.keys((t.input as unknown as { shape?: Record<string, unknown> }).shape ?? {}), ...Object.keys(t.fixed ?? {})]
          const missing = relied.filter(p => !u.properties.includes(p))
          if (missing.length > 0) problems.push(`${t.upstream} lost input properties: ${missing.join(', ')}`)
          if (u.readOnly === false) problems.push(`${t.upstream} is no longer read only`)
        }
        for (const w of SLACK_KNOWN_WRITES) {
          const u = byName.get(w)
          if (u && u.readOnly === true) problems.push(`${w} is now marked read only upstream: a person reviews it`)
        }
        // A new upstream tool is reported, never a failure: it is hidden by design until a reviewed PR lists it.
        const known = new Set<string>([...slackTools.map(t => t.upstream), ...SLACK_KNOWN_WRITES])
        const fresh = live.value.filter(t => !known.has(t.name)).map(t => t.name).sort()
        if (fresh.length > 0) console.log(`nightly: new upstream Slack tools for a person to review (hidden, not a failure): ${fresh.join(', ')}`)
        return problems.length === 0 ? null : problems.join('; ')
      },
    },
    {
      name: '3. each allowlisted read tool answers once with a fixed argument, under 32 KiB',
      run: async () => {
        const args = readArguments(env.channelId)
        const listed = await hub.listTools()
        if (!listed.ok) return `listTools: ${listed.code}`
        const offered = listed.value.map(t => t.name).filter(n => n.startsWith('slack_'))
        const problems: string[] = []
        // The listing and the allowlist agree: every allowlisted tool the config offers is listed, and nothing else is.
        const expected = slackTools.filter(t => !policyGated(t.name)).map(t => t.name)
        const missing = expected.filter(n => !offered.includes(n))
        const extra = offered.filter(n => !slackTools.some(t => t.name === n))
        if (missing.length > 0) problems.push(`listed tools missing from the hub's listing: ${missing.join(', ')}`)
        if (extra.length > 0) problems.push(`listed tools the allowlist doesn't have: ${extra.join(', ')}`)
        const skipped = offered.filter(n => needsThread.has(n) || policyGated(n))
        if (skipped.length > 0) console.log(`nightly: case 3 does not call (needs a thread id or the private-search policy): ${skipped.join(', ')}`)
        for (const name of offered) {
          if (needsThread.has(name) || policyGated(name)) continue
          if (!(name in args)) { problems.push(`${name} has no fixed argument in readArguments`); continue }
          const r = await hub.callTool(name, args[name])
          if (!r.ok) { problems.push(`${name}: ${r.code}`); continue }
          if (bytes(r.value.data) > RESULT_CAP_BYTES) problems.push(`${name}: answer over 32 KiB`)
        }
        return problems.length === 0 ? null : problems.join('; ')
      },
    },
    {
      name: '4. the supplier-delay search, tool alone: "supplier" finds the seeded message, "supplier delay" does not (the AND)',
      run: async () => {
        const one = await hub.callTool('slack_search_public', { keywords: [SUPPLIER_WORD] })
        if (!one.ok) return `search for the one word: ${one.code}`
        const both = await hub.callTool('slack_search_public', { keywords: SUPPLIER_PHRASE.split(' ') })
        if (!both.ok) return `search for the phrase: ${both.code}`
        // The seeded message's own words ("Kestrel"), not the query's: an answer that merely echoes "supplier" proves nothing.
        if (!JSON.stringify(one.value.data).toLowerCase().includes('kestrel')) return 'the one-word search did not find the seeded message'
        return JSON.stringify(both.value.data).toLowerCase().includes('kestrel') ? 'the two-word search found the message: the AND is gone' : null
      },
    },
    {
      name: '5. a notice posts through the server and the read-back shows no attachment or unfurl',
      houseOnly: true,
      run: async () => {
        const text = `Nightly check ${new Date().toISOString().slice(0, 10)}`
        const posted = await hub.postNotice(env.noticesChannelId, 'Nightly check', text)
        if (!posted.ok) return `post: ${posted.code}`
        const back = await hub.readBack(env.noticesChannelId, posted.value.ts)
        if (!back.ok) return `read-back: ${back.code}`
        if (back.value.attachments > 0) return 'the message carries an attachment'
        return back.value.unfurled ? 'the message was unfurled' : null
      },
    },
    {
      name: '6. with rotation on, an alarm-driven refresh succeeds and the old refresh token is refused afterwards',
      ...(env.rotation ? {} : { skip: 'rotation is off (NIGHTLY_ROTATION is not 1)' }),
      run: async () => {
        const r = await hub.rotate(SLACK_ACCOUNT)
        if (!r.ok) return `rotate: ${r.code}`
        if (!r.value.refreshed) return 'the refresh did not succeed'
        return r.value.oldTokenRefused ? null : 'the old refresh token was still accepted after a refresh'
      },
    },
    {
      name: '7. discovery pin: the live PRM and AS metadata still name the endpoints W1 pinned, resource equals mcp.resource, S256 listed',
      run: async () => {
        const d = await hub.discovery(SLACK_ACCOUNT)
        if (!d.ok) return `discovery: ${d.code}`
        return discoveryProblems(d.value)
      },
    },
    {
      name: '8. scopes exact: the granted scopes equal the requested set for the house config, no reconnect needed',
      run: async () => {
        const a = await account()
        if (!a.ok) return `status: ${a.code}`
        if (a.value.needsReconnect) return 'the account needs a reconnect'
        return same(a.value.scopes, EXPECTED_SCOPES) ? null : 'the granted scopes differ from the requested five'
      },
    },
  ]
}

/** The pin check on its own, so a hand-made Discovery can show it fails. Null when it holds. */
export function discoveryProblems(d: Discovery): string | null {
  const out: string[] = []
  if (d.prmResource !== slackConnector.mcp.resource) out.push('PRM resource differs from the connector\'s mcp.resource')
  if (d.authorization !== slackConnector.endpoints?.authorization) out.push('the authorization endpoint moved')
  if (d.token !== slackConnector.endpoints?.token) out.push('the token endpoint moved')
  if (d.revoke !== slackConnector.endpoints?.revoke) out.push('the revoke endpoint moved')
  if (!d.codeChallengeMethods.includes('S256')) out.push('S256 is not listed')
  return out.length === 0 ? null : out.join('; ')
}
