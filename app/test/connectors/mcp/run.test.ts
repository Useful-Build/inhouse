// The nightly cases against hand-made hubs (P5 W5 section 1): each case passes on a hub that matches the pins and fails when
// the one thing it checks is wrong (the mutation each case answers "can this fail?" with). The nightly itself needs the house
// deployment; this proves the cases would notice. Runs in the hub's node project once its include lists `../test/connectors/mcp`
// (an orchestrator line, with `../test/connectors/mcp/**/*.ts` in hub/tsconfig.json's include); until then a throwaway config
// with `root: '..'` and `include: ['test/connectors/mcp/**/*.test.ts']` runs it (how the PR body's check was run).
import { describe, expect, it } from 'vitest'
import { slackConnector, slackTools, SLACK_KNOWN_WRITES } from '../../../hub/connectors/mcp/slack/route'
import { discoveryProblems, EXPECTED_SCOPES, readArguments, slackCases } from './cases'
import type { NightlyEnv } from './cases'
import type { Discovery, HubAccount, LiveTool, NightlyHub } from './client'
import { runCases } from './run'

const env: NightlyEnv = { channelId: 'C0TEST0001', noticesChannelId: 'C0TEST0002', rotation: true }
const names = (pick: (t: (typeof slackTools)[number]) => boolean) => slackTools.filter(pick).map(t => ({ name: t.name }))
const shape = (t: (typeof slackTools)[number]) => Object.keys((t.input as unknown as { shape: Record<string, unknown> }).shape)
const goodLive = (): LiveTool[] => [
  ...slackTools.map(t => ({ name: t.upstream, properties: [...shape(t), ...Object.keys(t.fixed ?? {})], readOnly: true })),
  ...SLACK_KNOWN_WRITES.map(name => ({ name, properties: [], readOnly: false })),
]
const goodDiscovery = (): Discovery => ({ prmResource: slackConnector.mcp.resource, ...slackConnector.endpoints!, authorization: slackConnector.endpoints!.authorization, codeChallengeMethods: ['S256'] }) as Discovery
const goodAccount = (): HubAccount => ({ accountId: 'slack:workspace', state: 'active', scopes: [...EXPECTED_SCOPES], needsReconnect: false, paused: false })

/** A hub that answers as the pins say; a test changes one answer. */
function hub(over: Partial<NightlyHub> = {}): NightlyHub {
  const args = readArguments(env.channelId)
  return {
    account: async () => ({ ok: true, value: goodAccount() }),
    listTools: async () => ({ ok: true, value: names(t => t.policy === undefined) }),
    callTool: async (name, a) => {
      if (name === 'slack_search_public') {
        const words = ((a as { keywords: string[] }).keywords).join(' ')
        return { ok: true, value: { data: words === 'supplier' ? 'Supplier Kestrel Mills says the November restock ships late' : 'no matches' } }
      }
      return name in args ? { ok: true, value: { data: { ok: true } } } : { ok: false, code: 'unknown_tool' }
    },
    liveTools: async () => ({ ok: true, value: goodLive() }),
    postNotice: async () => ({ ok: true, value: { ts: '1.000001' } }),
    readBack: async () => ({ ok: true, value: { text: 'Nightly check', attachments: 0, unfurled: false } }),
    discovery: async () => ({ ok: true, value: goodDiscovery() }),
    rotate: async () => ({ ok: true, value: { refreshed: true, oldTokenRefused: true } }),
    ...over,
  }
}

const run = async (h: NightlyHub) => (await runCases(slackCases(h, env), { house: true, print: () => undefined })).failures

describe('the nightly Slack cases', () => {
  it('pass on a hub that matches the pins', async () => {
    expect(await run(hub())).toEqual([])
  })

  const bad: [string, Partial<NightlyHub>, RegExp][] = [
    ['an account that is not active', { account: async () => ({ ok: true, value: { ...goodAccount(), state: 'failed' } }) }, /^1\./],
    ['a sixth scope', { account: async () => ({ ok: true, value: { ...goodAccount(), scopes: [...EXPECTED_SCOPES, 'files:read'] } }) }, /^1\./],
    ['a needed reconnect', { account: async () => ({ ok: true, value: { ...goodAccount(), needsReconnect: true } }) }, /^8\./],
    ['an allowlisted tool gone upstream', { liveTools: async () => ({ ok: true, value: goodLive().slice(1) }) }, /^2\./],
    ['an input property dropped upstream', { liveTools: async () => ({ ok: true, value: goodLive().map((t, i) => (i === 0 ? { ...t, properties: [] } : t)) }) }, /^2\./],
    ['a known write now marked read only', { liveTools: async () => ({ ok: true, value: goodLive().map(t => (t.name === 'slack_send_message' ? { ...t, readOnly: true } : t)) }) }, /^2\./],
    ['an allowlisted tool missing from the hub listing', { listTools: async () => ({ ok: true, value: names(t => t.policy === undefined).slice(1) }) }, /^3\./],
    ['a tool listed that the allowlist does not have', { listTools: async () => ({ ok: true, value: [...names(t => t.policy === undefined), { name: 'slack_send_message' }] }) }, /^3\./],
    ['a read tool that errors', { callTool: async n => (n === 'slack_read_channel' ? { ok: false, code: 'upstream_rejected' } : { ok: true, value: { data: 'x' } }) }, /^3\./],
    ['a read answer over 32 KiB', { callTool: async () => ({ ok: true, value: { data: 'x'.repeat(40_000) } }) }, /^3\./],
    ['a one-word search that only echoes the query', { callTool: async (n, a) => ({ ok: true, value: { data: n === 'slack_search_public' ? `results for ${(a as { keywords: string[] }).keywords.join(' ')}` : 'x' } }) }, /^4\./],
    ['a one-word search that finds nothing', { callTool: async () => ({ ok: true, value: { data: 'nothing' } }) }, /^4\./],
    ['a two-word search that finds the message (the AND is gone)', { callTool: async () => ({ ok: true, value: { data: 'Supplier Kestrel Mills' } }) }, /^4\./],
    ['an attachment on the posted notice', { readBack: async () => ({ ok: true, value: { text: 't', attachments: 1, unfurled: false } }) }, /^5\./],
    ['an unfurl on the posted notice', { readBack: async () => ({ ok: true, value: { text: 't', attachments: 0, unfurled: true } }) }, /^5\./],
    ['an old refresh token still accepted', { rotate: async () => ({ ok: true, value: { refreshed: true, oldTokenRefused: false } }) }, /^6\./],
    ['a moved token endpoint', { discovery: async () => ({ ok: true, value: { ...goodDiscovery(), token: 'https://slack.com/api/other' } }) }, /^7\./],
    ['S256 no longer listed', { discovery: async () => ({ ok: true, value: { ...goodDiscovery(), codeChallengeMethods: ['plain'] } }) }, /^7\./],
  ]
  for (const [name, over, which] of bad) {
    it(`fails on ${name}`, async () => {
      const failures = await run(hub(over))
      expect(failures.some(f => which.test(f)), failures.join(' | ')).toBe(true)
    })
  }

  it('reports a new upstream tool without failing', async () => {
    expect(await run(hub({ liveTools: async () => ({ ok: true, value: [...goodLive(), { name: 'slack_brand_new', properties: [], readOnly: true }] }) }))).toEqual([])
  })
  it('prints SKIP, never ok, for the rotation case when rotation is off', async () => {
    const lines: string[] = []
    await runCases(slackCases(hub(), { ...env, rotation: false }), { house: true, print: l => lines.push(l) })
    expect(lines.some(l => l.startsWith('SKIP 6.'))).toBe(true)
    expect(lines.some(l => l.startsWith('ok   6.'))).toBe(false)
  })
  it('skips the house-only case off the house deployment', async () => {
    const lines: string[] = []
    await runCases(slackCases(hub(), env), { house: false, print: l => lines.push(l) })
    expect(lines.some(l => l.startsWith('SKIP 5.'))).toBe(true)
  })
  it('discoveryProblems names a PRM resource that differs', () => {
    expect(discoveryProblems({ ...goodDiscovery(), prmResource: 'https://mcp.slack.com/mcp' })).toMatch(/resource/)
  })
})
