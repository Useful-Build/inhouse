// The #248 review fold (B2, 2026-11-21): a 404 on a reused MCP session, the live-token guard under interleaving, the
// generation check on the same-token failed-check write, refresh backoff, re-sealing a disconnected account's client,
// the issuer check, the policy check in mcpCall, the DM scope rule and the sweep re-arm. Oracles are literals.
import { fc, test } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKOFF_MS } from '../signin/core'
import { ringJson } from '../signin/testing/kit'
import { requestedScopes } from '../registry/registry'
import { slackConnector } from '../connectors/mcp/slack/route'
import { notesConnector } from '../connectors/mcp/testing/notes-connector'
import { discover } from './protocol'
import { codeOf, connect, MEMBER, NOTES, SLACK, SLACK_BASE, world, type World } from './testing/kit'
import { createMcpUpstream, mintTestCode } from '../../test/upstreams/mcp/server'

beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => {}))
afterEach(() => vi.restoreAllMocks())

const record = (w: World, id = SLACK) => w.store(id).record()!
const search = (w: World) => w.core(SLACK).mcpCall({ accountId: SLACK, upstream: 'slack_search_public', args: { keywords: ['late'] } })

/** Every AES-GCM decrypt and encrypt and every digest resolve when fast-check's scheduler says (the comparison's await). */
function scheduleDecrypts(s: fc.Scheduler) {
  for (const m of ['decrypt', 'encrypt', 'digest'] as const) {
    const orig = (crypto.subtle[m] as (...a: unknown[]) => Promise<unknown>).bind(crypto.subtle)
    vi.spyOn(crypto.subtle, m).mockImplementation(((...a: unknown[]) => s.schedule(orig(...a), m)) as never)
  }
}
const unscheduleCrypto = () => {
  for (const m of ['decrypt', 'encrypt', 'digest'] as const) vi.mocked(crypto.subtle[m]).mockRestore()
}

describe('item 1: a 404 on a reused session starts a new one', () => {
  it('after an upstream restart (sessions gone), the next call re-initialises once and succeeds', async () => {
    const w = world()
    await connect(w)
    expect(codeOf(await search(w))).toBe('ok')
    w.slack.sessions.clear()
    const before = w.slack.requests.length
    expect(codeOf(await search(w))).toBe('ok')
    expect(w.slack.requests.slice(before).map(r => r.rpc)).toEqual(['tools/call', 'initialize', 'notifications/initialized', 'tools/call'])
    expect(codeOf(await search(w))).toBe('ok')
    expect(record(w).state).toBe('active')
  })

  it('a 404 on a session made for this call is upstream_unavailable, and the next call starts afresh', async () => {
    const w = world()
    await connect(w)
    const real = w.slack.fetch
    let calls = 0
    w.slack.fetch = async req => {
      const res = await real(req.clone())
      return new URL(req.url).pathname === '/mcp' && req.headers.get('Mcp-Session-Id') && ++calls <= 3 ? new Response(null, { status: 404 }) : res
    }
    expect(codeOf(await search(w))).toBe('upstream_unavailable')
    w.slack.fetch = real
    expect(codeOf(await search(w))).toBe('ok')
  })
})

describe('item 2: the inner live-token guard under interleaving', () => {
  test.prop([fc.scheduler()], { numRuns: 80 })(
    "two same-token connects: a connect gone stale never revokes the token the other one just stored",
    async s => {
      const w = world()
      await connect(w)
      w.slack.sameToken = true
      const a = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
      const b = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
      const ca = await mintTestCode(a.ok ? a.value.authorizeUrl : '', { user: 'U0TEST0009' })
      const cb = await mintTestCode(b.ok ? b.value.authorizeUrl : '', { user: 'U0TEST0009' })
      scheduleDecrypts(s)
      const done = Promise.all([
        w.core(SLACK).completeConnect({ state: ca.state, code: ca.code, memberId: MEMBER }),
        w.core(SLACK).completeConnect({ state: cb.state, code: cb.code, memberId: MEMBER }),
      ])
      await s.waitFor(done)
      unscheduleCrypto()
      const t = w.slack.liveTokens('U0TEST0009')
      expect(t).toHaveLength(1)
      expect(w.slack.revoked).not.toContain(t[0])
      expect(record(w).state).toBe('active')
      expect(codeOf(await search(w))).toBe('ok')
    },
  )
})

describe('item 3: the same-token failed-check write checks the generation', () => {
  test.prop([fc.scheduler()], { numRuns: 100 })('a reconnect with another token landing during the comparison wins; the account stays ready', async s => {
    const w = world()
    await connect(w)
    w.slack.sameToken = true
    const a = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    const b = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    const ca = await mintTestCode(a.ok ? a.value.authorizeUrl : '', { scope: [...SLACK_BASE, 'files:read'] })
    const cb = await mintTestCode(b.ok ? b.value.authorizeUrl : '', { user: 'U0TEST0002' })
    scheduleDecrypts(s)
    const done = Promise.all([
      w.core(SLACK).completeConnect({ state: ca.state, code: ca.code, memberId: MEMBER }),
      w.core(SLACK).completeConnect({ state: cb.state, code: cb.code, memberId: MEMBER }),
    ])
    await s.waitFor(done)
    unscheduleCrypto()
    expect(await w.core(SLACK).ready(SLACK)).toEqual({ ok: true, value: { ready: true, policies: [] } })
    expect([...record(w).scopes].sort()).toEqual(SLACK_BASE)
  })
})

describe('item 4: refresh backoff', () => {
  const expire = (w: World) => {
    const r = record(w)
    w.clock.ms = r.expiresAtMs! + 1
  }

  it('two quick calls after a not-consumed answer send one refresh; after the backoff the next call refreshes', async () => {
    const w = world({ rotation: true })
    await connect(w)
    expire(w)
    w.slack.refreshModes = ['unreachable']
    expect(codeOf(await search(w))).toBe('upstream_unavailable')
    expect(codeOf(await search(w))).toBe('upstream_unavailable')
    expect(w.slack.refreshSends).toHaveLength(1)
    w.clock.ms += BACKOFF_MS[0]
    expect(codeOf(await search(w))).toBe('ok')
    expect(w.slack.refreshSends).toHaveLength(2)
  })

  it('Retry-After later than the backoff is honoured by calls and by the alarm', async () => {
    const w = world({ rotation: true })
    await connect(w)
    expire(w)
    w.slack.refreshModes = ['ratelimited']
    w.slack.retryAfterS = 600
    const t0 = w.clock.ms
    expect(codeOf(await search(w))).toBe('rate_limited')
    w.clock.ms = t0 + 120_000
    expect(codeOf(await search(w))).toBe('rate_limited')
    await w.core(SLACK).alarm()
    expect(w.slack.refreshSends).toHaveLength(1)
    expect(w.alarm(SLACK).at).toBe(t0 + 600_000)
    w.clock.ms = t0 + 600_000
    await w.core(SLACK).alarm()
    expect(w.slack.refreshSends).toHaveLength(2)
    expect(record(w)).toMatchObject({ state: 'active', failures: 0, retryAtMs: null })
  })
})

describe('item 5: key rotation reaches a disconnected account', () => {
  it("re-seals a disconnected dynamic account's client and reports any envelope left on an old kid", async () => {
    const w = world()
    const keys = new Map<string, string>()
    w.ring.json = ringJson(['k1'], 'k1', keys)
    await connect(w, NOTES)
    await w.core(NOTES).disconnect(NOTES)
    w.ring.json = ringJson(['k1', 'k2'], 'k2', keys)
    expect(await w.core(NOTES).reencrypt(NOTES)).toEqual({ ok: true, value: { kid: 'k2', changed: true } })
    expect(w.store(NOTES).record()!.client?.kid).toBe('k2')
    w.ring.json = ringJson(['k2'], 'k2', keys)
    expect(codeOf((await connect(w, NOTES)).completed!)).toBe('ok')
  })
})

describe('item 6: the AS metadata issuer', () => {
  it('refuses metadata whose issuer differs from the one it was fetched for (RFC 8414 section 3.3)', async () => {
    const fake = createMcpUpstream('notes')
    fake.asIssuer = 'https://evil.example'
    expect(await discover(fake.fetch, notesConnector)).toEqual({ ok: false, code: 'connect_refused' })
    fake.asIssuer = 'https://auth.notes.example.com/'
    expect(await discover(fake.fetch, notesConnector)).toEqual({ ok: false, code: 'connect_refused' })
  })
})

describe('item 8', () => {
  it('(a) mcpCall refuses a tool whose policy is off, before any request', async () => {
    const w = world()
    await connect(w)
    const before = w.slack.requests.length
    const r = await w.core(SLACK).mcpCall({ accountId: SLACK, upstream: 'slack_search_public_and_private', args: { keywords: ['x'] } })
    expect(codeOf(r)).toBe('unknown_tool')
    expect(w.slack.requests.length).toBe(before)
  })

  it('(b) never DMs: no requested scope under any policy reads DMs or group DMs, and a DM channel id is refused', () => {
    for (const policies of [[], ['privateSearch']]) {
      const scopes = requestedScopes(slackConnector, { clientId: 'c', clientSecret: 's', redirectUri: 'https://x/api/connect/callback', teamId: 'T0TEST0001', policies })
      expect(scopes.filter(s => /^(im|mpim):|search:read\.(im|mpim)$/.test(s))).toEqual([])
    }
    const read = slackConnector.tools.find(t => t.name === 'slack_read_channel')!
    expect(read.input.safeParse({ channel_id: 'D0TEST0001' }).success).toBe(false)
  })

  it('(d) an alarm on an account with no record re-arms itself while one-time items remain', async () => {
    const w = world()
    const core = w.core('shopify:store')
    await core.putPending('a', 1, 60_000)
    await core.putPending('b', 2, 120_000)
    w.clock.ms += 60_000
    await core.alarm()
    expect(w.alarm('shopify:store').at).toBe(w.clock.ms + 60_000)
  })
})

describe('re-check lows (B2)', () => {
  it("a 401 on a still-valid token while refreshes are rate limited sends no refresh", async () => {
    const w = world({ rotation: true })
    await connect(w)
    const r = record(w)
    // The proactive refresh at half-life is rate limited; the token itself is still good for 6 hours.
    w.clock.ms = r.obtainedAtMs! + (r.expiresAtMs! - r.obtainedAtMs!) / 2
    w.slack.refreshModes = ['ratelimited']
    await w.core(SLACK).alarm()
    expect(record(w)).toMatchObject({ state: 'active', failures: 1 })
    expect(w.slack.refreshSends).toHaveLength(1)
    for (const t of w.slack.tokens.values()) t.revoked = true
    expect(codeOf(await search(w))).toBe('rate_limited')
    expect(w.slack.refreshSends).toHaveLength(1)
    expect(record(w).state).toBe('active')
  })

  it('an error on a reused session drops it: the next call initialises first', async () => {
    const w = world()
    await connect(w)
    expect(codeOf(await search(w))).toBe('ok')
    const real = w.slack.fetch
    let failed = false
    w.slack.fetch = async req => {
      const body = await req.clone().text()
      if (!failed && body.includes('"tools/call"')) {
        failed = true
        return new Response(null, { status: 500 })
      }
      return real(req)
    }
    expect(codeOf(await search(w))).toBe('upstream_unavailable')
    w.slack.fetch = real
    const before = w.slack.requests.length
    expect(codeOf(await search(w))).toBe('ok')
    expect(w.slack.requests[before]!.rpc).toBe('initialize')
  })
})
