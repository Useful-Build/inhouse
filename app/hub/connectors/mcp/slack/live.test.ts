// The live Slack probe (P5 W1 section 7). In CI it runs against the fake Slack (both missing-scope switches) as a
// canary: outcome names only, never a token. The real run is the orchestrator's alone, on the Mac, with the test
// app's 5-scope token handed in through a secret card as a file: SLACK_PROBE_TOKEN_FILE=<card file>.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpUpstream, SLACK_TEST } from '../../../../test/upstreams/mcp/server'
import { probe } from './probe'

afterEach(() => vi.restoreAllMocks())

const BASE = ['search:read.public', 'channels:read', 'channels:history', 'users:read', 'chat:write']

describe('the Slack probe against the fake', () => {
  for (const [mode, expected] of [
    ['hide', { listed: { slack_search_users: false, slack_read_file: false }, searchUsers: 'upstream_rejected' }],
    ['fail', { listed: { slack_search_users: true, slack_read_file: true }, searchUsers: 'scope_mismatch' }],
  ] as const) {
    it(`missing scope ${mode}`, async () => {
      const fake = createMcpUpstream('slack')
      fake.missingScope = mode
      const token = 'xoxp-test-probe'
      fake.tokens.set(token, { clientId: SLACK_TEST.clientId, user: SLACK_TEST.user, team: SLACK_TEST.teamId, scopes: BASE, expiresAtMs: null, revoked: false, refresh: null })
      const printed: string[] = []
      for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a.join(' ')))
      const r = await probe(fake.fetch, token)
      expect(r).toEqual(expected)
      expect(JSON.stringify(r) + printed.join('\n')).not.toContain(token)
    })
  }
})

const tokenFile = process.env.SLACK_PROBE_TOKEN_FILE
describe.skipIf(!tokenFile)('the Slack probe, live (orchestrator only)', () => {
  it('records hidden or listed-and-failing', async () => {
    const token = readFileSync(tokenFile!, 'utf8').trim()
    const r = await probe(req => fetch(req), token)
    // Outcome names only.
    console.info(`probe: ${JSON.stringify(r)}`)
    expect(typeof r.searchUsers).toBe('string')
  })
})
