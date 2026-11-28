// The live Slack probe (P5 W1 section 7). In CI it runs against the fake Slack (both missing-scope switches) as a
// canary: outcome names only, never a token. The real run is the orchestrator's alone, on the Mac, with the test
// app's 5-scope token handed in through a secret card as a file: SLACK_PROBE_TOKEN_FILE=<card file>.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpUpstream, SLACK_TEST } from '../../../../test/upstreams/mcp/server'
import { probe, probeDetail } from './probe'

afterEach(() => vi.restoreAllMocks())

const BASE = ['search:read.public', 'channels:read', 'channels:history', 'users:read', 'chat:write']

describe('the Slack probe against the fake', () => {
  for (const [mode, expected] of [
    ['hide', { listed: { slack_search_users: false, slack_read_file: false }, list: 'ok', searchUsers: 'upstream_rejected' }],
    ['fail', { listed: { slack_search_users: true, slack_read_file: true }, list: 'ok', searchUsers: 'scope_mismatch' }],
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

describe('the probe detail against the fake (Part of #697)', () => {
  const fakeWith = (token: string, revoked = false) => {
    const fake = createMcpUpstream('slack')
    fake.tokens.set(token, { clientId: SLACK_TEST.clientId, user: SLACK_TEST.user, team: SLACK_TEST.teamId, scopes: BASE, expiresAtMs: null, revoked, refresh: null })
    return fake
  }

  it('reports server/discover answered in band (-32601), the list ok, and no token anywhere', async () => {
    const token = 'xoxp-test-detail'
    const r = await probeDetail(fakeWith(token).fetch, token)
    expect(r.discover).toEqual({ status: 200, body: 'json', answer: 'error', code: -32601 })
    expect(r.list).toBe('ok')
    expect(JSON.stringify(r)).not.toContain(token)
  })

  it('reports a discover answered 401 by its status, and why a failed list failed', async () => {
    const token = 'xoxp-test-revoked'
    const r = await probeDetail(fakeWith(token, true).fetch, token)
    expect(r.discover).toEqual({ status: 401, body: 'empty', answer: 'unreadable' })
    expect(r.list).toBe('unauthorized')
    expect(r.listed).toEqual({ slack_search_users: false, slack_read_file: false })
  })

  it('reports a modern result with its date-shaped versions only, never its text', async () => {
    const token = 'xoxp-test-modern'
    const fake = fakeWith(token)
    const up = async (req: Request) => {
      const msg = req.method === 'POST' ? ((await req.clone().json().catch(() => null)) as { id?: unknown; method?: unknown } | null) : null
      if (msg?.method !== 'server/discover') return fake.fetch(req)
      const body = { jsonrpc: '2.0', id: msg.id, result: { supportedVersions: ['2026-07-28', 'UPSTREAM TEXT'], serverInfo: { name: 'UPSTREAM TEXT' } } }
      return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    const r = await probeDetail(up, token)
    expect(r.discover).toEqual({ status: 200, body: 'sse', answer: 'result', versions: ['2026-07-28'] })
    expect(r.list).toBe('ok')
    expect(JSON.stringify(r)).not.toContain('UPSTREAM')
  })

  /** The fake (missing scopes listed, then failing), with `refuse` answering some methods 401, every method recorded. */
  const recording = (token: string, refuse: (method: string) => boolean) => {
    const fake = fakeWith(token)
    fake.missingScope = 'fail'
    const seen: string[] = []
    const up = async (req: Request) => {
      const body = req.method === 'POST' ? ((await req.clone().json().catch(() => null)) as { method?: string } | null) : null
      if (body?.method) seen.push(body.method)
      return body?.method && refuse(body.method) ? new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }) : fake.fetch(req)
    }
    return { up, seen }
  }

  it('a server/discover answered 401 alone is reported, and the pinned list and call still run (#700)', async () => {
    const token = 'xoxp-test-discover-401'
    const { up, seen } = recording(token, m => m === 'server/discover')
    const r = await probeDetail(up, token)
    expect(r.discover).toEqual({ status: 401, body: 'empty', answer: 'unreadable' })
    expect(r.list).toBe('ok')
    expect(r.listed).toEqual({ slack_search_users: true, slack_read_file: true })
    expect(r.searchUsers).toBe('scope_mismatch')
    expect(seen.filter(m => m === 'server/discover')).toHaveLength(1)
  })

  it("the probe's call is pinned even when the list failed and cached nothing (#701)", async () => {
    const token = 'xoxp-test-list-fails'
    let inits = 0
    const { up, seen } = recording(token, m => m === 'server/discover' || (m === 'initialize' && inits++ === 0))
    const r = await probeDetail(up, token)
    expect(r.list).toBe('unauthorized')
    expect(r.searchUsers).toBe('scope_mismatch')
    // The only server/discover is discoverOnce's: the list's handshake and the call's never probe.
    expect(seen).toEqual(['server/discover', 'initialize', 'initialize', 'notifications/initialized', 'tools/call'])
  })
})

const tokenFile = process.env.SLACK_PROBE_TOKEN_FILE
describe.skipIf(!tokenFile)('the Slack probe, live (orchestrator only)', () => {
  it('records hidden or listed-and-failing, how Slack answers server/discover, and why a list failed (Part of #697)', async () => {
    const token = readFileSync(tokenFile!, 'utf8').trim()
    // One run: the detail carries the S4 answer too.
    const r = await probeDetail(req => fetch(req), token)
    expect(typeof r.searchUsers).toBe('string')
    // Outcome names, shapes, codes and versions only; the token is checked absent before anything prints.
    const line = JSON.stringify(r)
    expect(line).not.toContain(token)
    console.info(`probe detail: ${line}`)
  })
})
