// P5 W1 brief "Tests" 1 to 5, 8, 10 to 13, over SignInCore with H0's in-memory store and the fake OAuth MCP server.
// Oracles are written here: literal fixtures, RFC 7636 Appendix B, and a separate model of "issued, consumed, expired".
import { fc, test } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { challengeFor, stateAccount, STATE_TTL_MS } from './protocol'
import { codeOf, connect, evict, MEMBER, NOTES, OTHER_MEMBER, SLACK, SLACK_BASE, SLACK_PRIVATE, world, type World } from './testing/kit'
import { normalize, type SignInRecord } from '../signin/core'
import { MemStore, ringJson } from '../signin/testing/kit'
import { mintTestCode, SLACK_TEST } from '../../test/upstreams/mcp/server'

let lines: string[] = []
beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')))
})
afterEach(() => vi.restoreAllMocks())

const record = (w: World, id = SLACK) => w.store(id).record()!
const search = (w: World, keywords = ['late']) => w.core(SLACK).mcpCall({ accountId: SLACK, upstream: 'slack_search_public', args: { keywords, response_format: 'concise' } })

describe('connect, happy path', () => {
  it('start writes only a pending item (and the sweep alarm); the callback stores a sealed token with the exact scopes', async () => {
    const w = world()
    const started = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    expect(started.ok).toBe(true)
    expect(w.store(SLACK).record()).toBeUndefined()
    expect(w.alarm(SLACK).at).toBe(w.clock.ms + STATE_TTL_MS)
    const url = new URL(started.ok ? started.value.authorizeUrl : '')
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2_user/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: SLACK_TEST.clientId,
      redirect_uri: SLACK_TEST.redirectUri,
      scope: SLACK_BASE.join(' '),
      code_challenge_method: 'S256',
      resource: 'https://mcp.slack.com',
      team: SLACK_TEST.teamId,
    })
    expect(stateAccount(url.searchParams.get('state')!)).toBe(SLACK)
    const { code, state } = await mintTestCode(url.toString())
    expect(await w.core(SLACK).completeConnect({ state, code, memberId: MEMBER })).toEqual({ ok: true, value: { accountId: SLACK } })
    const r = record(w)
    expect(r).toMatchObject({ v: 2, kind: 'oauth_mcp', state: 'active', generation: 1, connectEpoch: 1, connectedBy: MEMBER, workspace: SLACK_TEST.teamId, refresh: null, expiresAtMs: null })
    expect([...r.scopes].sort()).toEqual(SLACK_BASE)
    const token = w.slack.liveTokens()[0]!
    expect(JSON.stringify([...w.store(SLACK).map])).not.toContain(token)
    expect(codeOf(await search(w))).toBe('ok')
  })
})

describe('test 1: a state is used once, by the member who started it', () => {
  type Op = { kind: 'complete'; member: 'right' | 'wrong'; tamper: 'none' | 'prefix' | 'random' } | { kind: 'advance'; ms: number }
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant('complete' as const), member: fc.constantFrom('right' as const, 'wrong' as const), tamper: fc.constantFrom('none' as const, 'prefix' as const, 'random' as const) }),
    fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 12 * 60_000 }) }),
  )
  test.prop([fc.array(op, { maxLength: 8 })], { numRuns: 60 })('at most one completion per state, only for its member, only before expiry', async ops => {
    const w = world()
    const started = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    if (!started.ok) throw new Error('start failed')
    const { code, state } = await mintTestCode(started.value.authorizeUrl, { nowMs: w.clock.ms })
    // The model: issued at t0, consumed by the first completion that reaches it (any member), expired at t0 + TTL.
    const t0 = w.clock.ms
    let consumed = false
    for (const o of ops) {
      if (o.kind === 'advance') {
        w.clock.ms += o.ms
        continue
      }
      const tampered = o.tamper === 'prefix' ? `c2xhY2s6b3RoZXI${state.slice(state.indexOf('.'))}` : o.tamper === 'random' ? `${state.slice(0, -2)}AA` : state
      const r = await w.core(SLACK).completeConnect({ state: tampered, code, memberId: o.member === 'right' ? MEMBER : OTHER_MEMBER })
      const reaches = o.tamper === 'none' && !consumed
      const live = w.clock.ms < t0 + STATE_TTL_MS
      if (reaches) consumed = true
      const expected = reaches && live && o.member === 'right' ? 'ok' : 'state_invalid'
      // The fake's code lives as long as the state, so `ok` here is decided by the state alone.
      expect(codeOf(r)).toBe(expected)
    }
  })

  it('a state started by member X is refused for member Y, and is spent for X too', async () => {
    const w = world()
    const started = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    const { code, state } = await mintTestCode(started.ok ? started.value.authorizeUrl : '')
    expect(codeOf(await w.core(SLACK).completeConnect({ state, code, memberId: OTHER_MEMBER }))).toBe('state_invalid')
    expect(codeOf(await w.core(SLACK).completeConnect({ state, code, memberId: MEMBER }))).toBe('state_invalid')
    expect(w.slack.requests.filter(r => r.path === '/api/oauth.v2.user.access')).toEqual([])
  })

  it("the AS's ?error= consumes the state and records connect_refused; a replayed state then fails", async () => {
    const w = world()
    await connect(w)
    const started = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    const { state, code } = await mintTestCode(started.ok ? started.value.authorizeUrl : '')
    expect(await w.core(SLACK).failConnect({ state, memberId: MEMBER })).toEqual({ ok: true, value: { accountId: SLACK } })
    expect(record(w).lastError?.code).toBe('connect_refused')
    expect(record(w).state).toBe('active')
    expect(codeOf(await w.core(SLACK).completeConnect({ state, code, memberId: MEMBER }))).toBe('state_invalid')
    expect(await w.core(SLACK).failConnect({ state, memberId: MEMBER })).toEqual({ ok: true, value: { accountId: null } })
  })

  it('an expired pending item is swept by the alarm', async () => {
    const w = world()
    await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    expect([...w.store(SLACK).map.keys()].filter(k => k.startsWith('pending:'))).toHaveLength(1)
    w.clock.ms += STATE_TTL_MS
    await w.core(SLACK).alarm()
    expect([...w.store(SLACK).map.keys()].filter(k => k.startsWith('pending:'))).toHaveLength(0)
  })
})

describe('test 2: PKCE', () => {
  it('the challenge of the RFC 7636 Appendix B verifier is its literal', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('the verifier is sealed under its account and field pkce only', async () => {
    const w = world()
    await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    const [, item] = [...w.store(SLACK).map].find(([k]) => k.startsWith('pending:'))! as [string, { data: { pkce: { kid: string } } }]
    const { open } = await import('../crypto/envelope')
    const { parseKeyRing } = await import('../crypto/keyring')
    const ring = await parseKeyRing(w.ring.json)
    if (!ring.ok) throw new Error('ring')
    const env = item.data.pkce as never
    expect((await open(ring.ring, SLACK, 'pkce', env)).ok).toBe(true)
    expect((await open(ring.ring, SLACK, 'token', env)).ok).toBe(false)
    expect((await open(ring.ring, NOTES, 'pkce', env)).ok).toBe(false)
  })

  it('a wrong verifier is refused by the AS and surfaces connect_refused; nothing is stored', async () => {
    const w = world()
    const started = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    const url = new URL(started.ok ? started.value.authorizeUrl : '')
    url.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    const { code, state } = await mintTestCode(url.toString())
    expect(codeOf(await w.core(SLACK).completeConnect({ state, code, memberId: MEMBER }))).toBe('connect_refused')
    expect(w.store(SLACK).record()?.token ?? null).toBeNull()
  })
})

describe('test 3: reconnect and disconnect', () => {
  it('reconnect after disconnect ends active', async () => {
    const w = world()
    await connect(w)
    const first = w.slack.liveTokens()[0]!
    expect(await w.core(SLACK).disconnect(SLACK)).toEqual({ ok: true, value: { generation: 2, revoked: true } })
    expect(w.slack.revoked).toEqual([first])
    expect(record(w)).toMatchObject({ state: 'disconnected', token: null, connectEpoch: 2 })
    const again = await connect(w)
    expect(codeOf(again.completed!)).toBe('ok')
    expect(record(w)).toMatchObject({ state: 'active', generation: 3, connectEpoch: 3 })
    expect(codeOf(await search(w))).toBe('ok')
  })

  test.prop([fc.constantFrom('empty', 'failed', 'disconnected', 'active')], { numRuns: 12 })('a connect with nothing intervening ends active from any state', async from => {
    const w = world()
    if (from !== 'empty') await connect(w)
    if (from === 'disconnected') await w.core(SLACK).disconnect(SLACK)
    if (from === 'failed') {
      for (const t of w.slack.tokens.values()) t.revoked = true
      await search(w)
      expect(record(w).state).toBe('failed')
    }
    expect(codeOf((await connect(w)).completed!)).toBe('ok')
    expect(record(w).state).toBe('active')
    expect(codeOf(await search(w))).toBe('ok')
  })

  it('a disconnect during a connect wins: connect_stale, disconnected, the received token revoked', async () => {
    const w = world()
    const started = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    const { code, state } = await mintTestCode(started.ok ? started.value.authorizeUrl : '')
    await w.core(SLACK).disconnect(SLACK)
    expect(codeOf(await w.core(SLACK).completeConnect({ state, code, memberId: MEMBER }))).toBe('connect_stale')
    expect(record(w)).toMatchObject({ state: 'disconnected', token: null })
    expect(w.slack.revoked).toHaveLength(1)
    expect(w.slack.liveTokens()).toEqual([])
  })

  it('a refresh landing between start and callback of an active rotating account does not make it stale', async () => {
    const w = world({ rotation: true })
    await connect(w)
    const started = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    // Make the refresh due now (inside the 10-minute state life), as if the token were 7 hours old.
    const r = record(w)
    w.store(SLACK).put('record', { ...r, obtainedAtMs: w.clock.ms - 7 * 3600_000, expiresAtMs: w.clock.ms + 5 * 3600_000 })
    await w.core(SLACK).alarm()
    expect(record(w).generation).toBe(2)
    const { code, state } = await mintTestCode(started.ok ? started.value.authorizeUrl : '', { nowMs: w.clock.ms })
    expect(codeOf(await w.core(SLACK).completeConnect({ state, code, memberId: MEMBER }))).toBe('ok')
    expect(record(w)).toMatchObject({ state: 'active', generation: 3, connectEpoch: 2 })
  })

  it('disconnect revokes the token current at its write, even when a refresh rotated it just before', async () => {
    const w = world({ rotation: true })
    await connect(w)
    w.clock.ms += 7 * 3600_000
    await w.core(SLACK).alarm()
    const current = w.slack.liveTokens().at(-1)!
    await w.core(SLACK).disconnect(SLACK)
    expect(w.slack.revoked).toEqual([current])
  })

  it('a revoke that fails says revoked: false and records it', async () => {
    const w = world()
    await connect(w)
    w.slack.revokeFails = true
    expect(await w.core(SLACK).disconnect(SLACK)).toEqual({ ok: true, value: { generation: 2, revoked: false } })
    expect(record(w).revokeFailedAtMs).toBe(w.clock.ms)
    expect(lines.some(l => l.includes('"revoke_failed"'))).toBe(true)
    const s = await w.core(SLACK).accountStatus(SLACK)
    expect(s.ok && s.value.revokeFailedAt?.ms).toBe(w.clock.ms)
  })
})

describe('test 4: atomic rotation and the three refresh classes', () => {
  test.prop([fc.array(fc.constantFrom('call', 'alarm', 'expire', 'stale'), { minLength: 1, maxLength: 8 }), fc.scheduler()], { numRuns: 40 })(
    'for any interleaving of calls, alarms and 401s, at most one refresh is in flight and the stored pair matches',
    async (ops, s) => {
      const w = world({ rotation: true })
      await connect(w)
      let inFlight = 0
      let maxInFlight = 0
      w.slack.deliver = (p, label) => {
        if (label !== 'refresh') return s.schedule(p, label)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        return s.schedule(p, label).finally(() => inFlight--)
      }
      const running = ops.map(o =>
        s.schedule(Promise.resolve(), o).then(async () => {
          if (o === 'call') await search(w)
          else if (o === 'alarm') await w.core(SLACK).alarm()
          else if (o === 'expire') w.clock.ms += 7 * 3600_000
          else w.slack.staleSessions()
        }),
      )
      await s.waitFor(Promise.all(running))
      expect(maxInFlight).toBeLessThanOrEqual(1)
      const r = record(w)
      if (r.state === 'active') {
        const { parseKeyRing } = await import('../crypto/keyring')
        const { open } = await import('../crypto/envelope')
        const ring = await parseKeyRing(w.ring.json)
        if (!ring.ok) throw new Error('ring')
        const access = await open(ring.ring, SLACK, 'token', r.token!)
        const refresh = await open(ring.ring, SLACK, 'refresh', r.refresh!)
        expect(access.ok && refresh.ok && w.slack.refreshOf(access.plaintext)).toBe(refresh.ok && refresh.plaintext)
      }
    },
  )

  const refreshNow = async (w: World) => {
    w.clock.ms += 7 * 3600_000
    await w.core(SLACK).alarm()
  }

  for (const mode of ['unreachable', 'ratelimited'] as const) {
    it(`${mode} is not consumed: backs off, retries with the same refresh token, ends active once the fake recovers`, async () => {
      const w = world({ rotation: true })
      await connect(w)
      w.slack.refreshModes = [mode, mode, mode, mode, mode]
      for (let i = 0; i < 5; i++) await refreshNow(w)
      expect(record(w)).toMatchObject({ state: 'active', failures: 5 })
      expect(new Set(w.slack.refreshSends).size).toBe(1)
      await refreshNow(w)
      expect(record(w)).toMatchObject({ state: 'active', failures: 0, generation: 2 })
      expect(new Set(w.slack.refreshSends).size).toBe(1)
    })
  }

  it('lost answer (unclear) sends the same refresh token at most twice, then failed exactly once', async () => {
    const w = world({ rotation: true })
    await connect(w)
    w.slack.refreshModes = ['lost', 'lost', 'lost']
    await refreshNow(w)
    expect(record(w)).toMatchObject({ state: 'active', refreshUnclear: true })
    await refreshNow(w)
    expect(record(w)).toMatchObject({ state: 'failed', token: null, refresh: null })
    for (let i = 0; i < 3; i++) await refreshNow(w)
    expect(w.slack.refreshSends).toHaveLength(2)
    expect(new Set(w.slack.refreshSends).size).toBe(1)
    expect(lines.filter(l => l.includes('"state":"failed"') && l.includes('"signin_grant"'))).toHaveLength(1)
  })

  it('invalid_refresh_token goes failed at once and asks for a reconnect', async () => {
    const w = world({ rotation: true })
    await connect(w)
    w.slack.refreshModes = ['invalid']
    await refreshNow(w)
    expect(record(w)).toMatchObject({ state: 'failed', token: null, refresh: null, lastError: { code: 'credentials_rejected' } })
    const s = await w.core(SLACK).accountStatus(SLACK)
    expect(s.ok && s.value.needsReconnect).toBe(true)
  })

  it('a crash between the answer and the put behaves as unclear: the spent token then fails, never a loop', async () => {
    const w = world({ rotation: true })
    await connect(w)
    const before = structuredClone(record(w))
    await refreshNow(w)
    // The "crash": the put is lost, the store goes back to the record from before the answer.
    w.store(SLACK).put('record', before)
    evict(w, SLACK)
    await refreshNow(w)
    expect(record(w).state).toBe('failed')
    expect(w.slack.refreshSends).toHaveLength(2)
  })
})

describe('test 4a: the live-token rule (fake same-token switch)', () => {
  it('a reconnect that gets the same token stays active; nothing revoked; the next call succeeds', async () => {
    const w = world()
    await connect(w)
    w.slack.sameToken = true
    expect(codeOf((await connect(w)).completed!)).toBe('ok')
    expect(record(w)).toMatchObject({ state: 'active', generation: 1, connectEpoch: 2 })
    expect(w.slack.revoked).toEqual([])
    expect(codeOf(await search(w))).toBe('ok')
  })

  it('two parallel connects returning the same token: one active, one connect_stale, nothing revoked', async () => {
    const w = world()
    w.slack.sameToken = true
    const a = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    const b = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    const ca = await mintTestCode(a.ok ? a.value.authorizeUrl : '')
    const cb = await mintTestCode(b.ok ? b.value.authorizeUrl : '')
    const ra = await w.core(SLACK).completeConnect({ state: ca.state, code: ca.code, memberId: MEMBER })
    const rb = await w.core(SLACK).completeConnect({ state: cb.state, code: cb.code, memberId: MEMBER })
    expect([codeOf(ra), codeOf(rb)]).toEqual(['ok', 'connect_stale'])
    expect(w.slack.revoked).toEqual([])
    expect(codeOf(await search(w))).toBe('ok')
  })

  it('a same-token reconnect that comes back wider: nothing revoked, scopes updated, needsReconnect, calls scope_mismatch', async () => {
    const w = world()
    await connect(w)
    w.slack.sameToken = true
    const r = await connect(w, SLACK, MEMBER, { scope: [...SLACK_BASE, 'files:read'] })
    expect(codeOf(r.completed!)).toBe('scope_mismatch')
    expect(w.slack.revoked).toEqual([])
    expect([...record(w).scopes].sort()).toEqual([...SLACK_BASE, 'files:read'].sort())
    const s = await w.core(SLACK).accountStatus(SLACK)
    expect(s.ok && s.value.needsReconnect).toBe(true)
    const before = w.slack.requests.length
    expect(codeOf(await search(w))).toBe('scope_mismatch')
    expect(w.slack.requests.length).toBe(before)
  })

  it('a reconnect that gets a different token revokes the old one', async () => {
    const w = world()
    await connect(w)
    const old = w.slack.liveTokens()[0]!
    await connect(w)
    expect(w.slack.revoked).toEqual([old])
    expect(codeOf(await search(w))).toBe('ok')
  })
})

describe('test 5: workspace and exact scopes', () => {
  test.prop([fc.boolean(), fc.subarray([...SLACK_BASE, 'files:read', 'search:read.private', 'im:history']), fc.boolean()], { numRuns: 40 })(
    'stored exactly when team.id matches and the granted set equals the requested set',
    async (rightTeam, granted, exact) => {
      const w = world()
      const scope = exact ? SLACK_BASE : granted
      const r = await connect(w, SLACK, MEMBER, { team: rightTeam ? SLACK_TEST.teamId : SLACK_TEST.otherTeamId, scope })
      const equal = [...scope].sort().join() === SLACK_BASE.join()
      const expected = !rightTeam ? 'workspace_mismatch' : equal ? 'ok' : 'scope_mismatch'
      expect(codeOf(r.completed!)).toBe(expected)
      if (expected === 'ok') expect(record(w).state).toBe('active')
      else {
        expect(w.store(SLACK).record()?.token ?? null).toBeNull()
        expect(w.slack.liveTokens()).toEqual([])
      }
    },
  )

  it('policy flips: on then off hides every tool and answers scope_mismatch with no upstream request; back on restores', async () => {
    const w = world()
    w.env.SLACK_PRIVATE_SEARCH = 'on'
    expect(codeOf((await connect(w)).completed!)).toBe('ok')
    expect([...record(w).scopes].sort()).toEqual(SLACK_PRIVATE)
    w.env.SLACK_PRIVATE_SEARCH = 'off'
    expect(await w.core(SLACK).ready(SLACK)).toEqual({ ok: true, value: { ready: false, code: 'scope_mismatch' } })
    const before = w.slack.requests.length
    expect(codeOf(await search(w))).toBe('scope_mismatch')
    expect(w.slack.requests.length).toBe(before)
    const s = await w.core(SLACK).accountStatus(SLACK)
    expect(s.ok && s.value.needsReconnect).toBe(true)
    w.env.SLACK_PRIVATE_SEARCH = 'on'
    expect(await w.core(SLACK).ready(SLACK)).toEqual({ ok: true, value: { ready: true, policies: ['privateSearch'] } })
  })

  it('the reverse flip (off, then on) also hides the account', async () => {
    const w = world()
    await connect(w)
    w.env.SLACK_PRIVATE_SEARCH = 'on'
    expect(await w.core(SLACK).ready(SLACK)).toEqual({ ok: true, value: { ready: false, code: 'scope_mismatch' } })
  })

  it('a cumulative grant on a reconnect without a revoke fails the exact check', async () => {
    const w = world()
    w.slack.cumulative = true
    w.env.SLACK_PRIVATE_SEARCH = 'on'
    await connect(w)
    w.env.SLACK_PRIVATE_SEARCH = 'off'
    expect(codeOf((await connect(w)).completed!)).toBe('scope_mismatch')
  })
})

describe('test 8: canary', () => {
  it('no token, refresh token, client secret, code or verifier reaches a result, a log line or a status', async () => {
    const w = world({ rotation: true })
    const results: unknown[] = []
    const started = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    results.push(started)
    const { code, state } = await mintTestCode(started.ok ? started.value.authorizeUrl : '')
    results.push(await w.core(SLACK).completeConnect({ state, code, memberId: MEMBER }))
    results.push(await search(w))
    w.slack.staleSessions()
    results.push(await search(w))
    for (const t of w.slack.tokens.values()) t.revoked = true
    results.push(await search(w))
    results.push(await connect(w))
    w.slack.revokeFails = true
    results.push(await w.core(SLACK).disconnect(SLACK))
    results.push(await w.core(SLACK).accountStatus(SLACK))
    const verifierItems = JSON.stringify([...w.store(SLACK).map])
    const all = JSON.stringify(results) + lines.join('\n')
    const secrets = [...w.slack.tokens.keys(), ...w.slack.refreshes.keys(), SLACK_TEST.clientSecret, code]
    for (const s of secrets) expect(all).not.toContain(s)
    for (const s of secrets) expect(verifierItems).not.toContain(s)
  })
})

describe('test 10: one 401', () => {
  it('a non-rotating account answered one 401 re-initialises, re-sends and stays active', async () => {
    const w = world()
    await connect(w)
    expect(codeOf(await search(w))).toBe('ok')
    w.slack.staleSessions()
    expect(codeOf(await search(w))).toBe('ok')
    expect(record(w).state).toBe('active')
  })

  it('two 401s end failed with token and refresh deleted', async () => {
    const w = world()
    await connect(w)
    for (const t of w.slack.tokens.values()) t.revoked = true
    expect(codeOf(await search(w))).toBe('credentials_rejected')
    expect(record(w)).toMatchObject({ state: 'failed', token: null, refresh: null })
  })
})

describe('test 11: key rotation covers every envelope', () => {
  it('rotate, re-seal (client included), retire, then a connect on notes still works', async () => {
    const w = world()
    const keys = new Map<string, string>()
    w.ring.json = ringJson(['k1'], 'k1', keys)
    expect(codeOf((await connect(w, NOTES)).completed!)).toBe('ok')
    expect(w.store(NOTES).record()!.client?.kid).toBe('k1')
    w.ring.json = ringJson(['k1', 'k2'], 'k2', keys)
    expect(await w.core(NOTES).reencrypt(NOTES)).toEqual({ ok: true, value: { kid: 'k2', changed: true } })
    const r = w.store(NOTES).record()!
    expect([r.token?.kid, r.client?.kid]).toEqual(['k2', 'k2'])
    w.ring.json = ringJson(['k2'], 'k2', keys)
    expect(codeOf((await connect(w, NOTES)).completed!)).toBe('ok')
    expect(codeOf(await w.core(NOTES).mcpCall({ accountId: NOTES, upstream: 'notes_search', args: { query: 'fern' } }))).toBe('ok')
  })
})

describe('test 12: alarms', () => {
  it("a non-expiring active account's alarm sweeps expired pending items and writes nothing else", async () => {
    const w = world()
    await connect(w)
    await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    const before = structuredClone(record(w))
    w.clock.ms += STATE_TTL_MS
    await w.core(SLACK).alarm()
    expect(record(w)).toEqual(before)
    expect([...w.store(SLACK).map.keys()]).toEqual(['record'])
  })

  it('a rotating account whose sweep alarm fires before its refresh is due ends with the alarm at the due time', async () => {
    const w = world({ rotation: true })
    await connect(w)
    const due = record(w).obtainedAtMs! + 6 * 3600_000
    await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    expect(w.alarm(SLACK).at).toBe(w.clock.ms + STATE_TTL_MS)
    w.clock.ms += STATE_TTL_MS
    await w.core(SLACK).alarm()
    expect(w.alarm(SLACK).at).toBe(due)
    expect(record(w).generation).toBe(1)
  })
})

describe('test 13: the path by kind', () => {
  it('an oauth_mcp account with no provider configured answers not_configured, and no Shopify grant is attempted', async () => {
    const w = world({ noProvider: true })
    expect(codeOf(await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER }))).toBe('not_configured')
    expect(codeOf(await w.core(SLACK).query({ accountId: SLACK, document: '{ shop { name } }', apiVersion: '2026-10' }))).toBe('not_configured')
    expect(codeOf(await search(w))).toBe('not_configured')
    await w.core(SLACK).alarm()
    expect(w.hostsSeen.filter(h => h.endsWith('myshopify.com'))).toEqual([])
    expect(w.hostsSeen).toEqual([])
  })
})

describe('records', () => {
  it('a stored v1 record reads as v2 with the defaults', () => {
    const v1: SignInRecord = { v: 1, accountId: 'shopify:store', state: 'active', generation: 3, token: null, refresh: null, obtainedAtMs: 1, expiresAtMs: 2, scopes: ['read_orders'], failures: 0, lastError: null }
    expect(normalize(v1)).toEqual({
      ...v1,
      kind: 'client_credentials',
      paused: false,
      connectEpoch: 0,
      connectedBy: null,
      connectedAtMs: null,
      workspace: null,
      client: null,
      endpoints: null,
      revokeFailedAtMs: null,
      refreshUnclear: false,
    })
  })

  it('a connect across an eviction: the pending item and the token persist in storage', async () => {
    const w = world()
    const started = await w.core(SLACK).beginConnect({ accountId: SLACK, memberId: MEMBER })
    evict(w, SLACK)
    const { code, state } = await mintTestCode(started.ok ? started.value.authorizeUrl : '')
    expect(codeOf(await w.core(SLACK).completeConnect({ state, code, memberId: MEMBER }))).toBe('ok')
    evict(w, SLACK)
    expect(codeOf(await search(w))).toBe('ok')
    void MemStore
  })
})
