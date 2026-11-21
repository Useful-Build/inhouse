// The Tools routes (P5 W3): route C's merge rules, route D and E's guards and audit lines. The hub is a fake and every
// expected value is written by hand (the oracle), never derived from the code under test. Ways it can fail, first:
//  1. a tool is listed that the hub didn't return, or one it says isn't configured;
//  2. an abandoned `connecting` row (past the 10-minute TTL) sticks in `beingConnected`;
//  3. a failed account or one that needs a reconnect reads as healthy; `connection` names a tool not in `connected`;
//  4. an Admin or Member reaches the hub on D or E; Shopify is disconnected; an audit line is written for a refused write
//     or goes missing for a made one; `revoked: false` is hidden.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { accessMatrix } from '../access-matrix.ts'
import { checkAccess } from '../auth/matrix.ts'
import type { Principal } from '../auth/index.ts'
import type { HandlerContext } from '../routes.ts'
import { ToolsDataSchema } from '../../shared/contract/tools.ts'
import { CONNECT_STATE_TTL_MS, buildToolsData, toolsHandlers } from './tools.ts'
import type { AccountSummary, ConnectGateway, ConnectorAccountRow, ToolsAuditArgs, ToolsDeps } from './tools.ts'

const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const inst = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const MIN = 60_000

const acct = (accountId: string, over: Partial<AccountSummary['status']> = {}, configured = true): AccountSummary => ({
  accountId, connector: accountId.split(':')[0]!, configured,
  status: {
    accountId, state: 'active', lastError: null, paused: false, kind: accountId.startsWith('slack') ? 'oauth_mcp' : 'client_credentials',
    connectedBy: null, connectedAt: null, revokeFailedAt: null, needsReconnect: false, ...over,
  },
})
const row = (accountId: string, lastState: ConnectorAccountRow['lastState'], lastStateAtMs: number, over: Partial<ConnectorAccountRow> = {}): ConnectorAccountRow =>
  ({ accountId, connector: accountId.split(':')[0]!, lastState, lastStateAtMs, connectedBy: null, connectedAtMs: null, ...over })

describe('route C: the merge', () => {
  it('Shopify active, Slack active and connected by a member: both connected, Slack also a channel, nothing else', () => {
    const data = buildToolsData({
      accounts: [acct('shopify:store', { connectedAt: inst(NOW - 3 * 86_400_000) }), acct('slack:workspace', { connectedAt: inst(NOW - 86_400_000), connectedBy: 'm_inhouse1' })],
      rows: [], nowMs: NOW,
    })
    expect(data.connected).toEqual(['shopify', 'slack'])
    expect(data.beingConnected).toEqual([])
    expect(data.connection).toEqual({})
    expect(data.catalog).toEqual([])
    expect(data.readDone).toBe(2)
    expect(data.channels.map(c => [c.key, c.since.ms])).toEqual([['slack', NOW - 86_400_000]])
    expect(data.details.slack).toMatchObject({ connectedBy: 'm_inhouse1', canDisconnect: true, paused: false, since: inst(NOW - 86_400_000) })
    expect(data.details.shopify).toMatchObject({ paused: false })
    expect(data.details.shopify!.canDisconnect).toBeUndefined()
    expect(ToolsDataSchema.safeParse(data).success).toBe(true)
  })
  it('a tool the hub did not return, or says is not configured, is not listed at all', () => {
    const none = buildToolsData({ accounts: [], rows: [row('slack:workspace', 'connected', NOW)], nowMs: NOW })
    expect(none).toMatchObject({ connected: [], beingConnected: [], catalog: [], details: {}, channels: [], readDone: 0 })
    const off = buildToolsData({ accounts: [acct('slack:workspace', {}, false)], rows: [], nowMs: NOW })
    expect(off.details).toEqual({})
    expect(off.catalog).toEqual([])
  })
  it('a configured account the Inhouse team has not connected is in the catalog, not in connected', () => {
    const d = buildToolsData({ accounts: [acct('slack:workspace', { state: 'empty' })], rows: [], nowMs: NOW })
    expect(d.connected).toEqual([])
    expect(d.catalog.map(c => c.k)).toEqual(['slack'])
    expect(d.channels).toEqual([])
    expect(d.details.slack!.canDisconnect).toBe(false)
  })
  it('a connecting row 2 minutes old is being connected; one 11 minutes old is not; exactly 10 minutes still is', () => {
    const at = (ageMs: number) => buildToolsData({ accounts: [acct('slack:workspace', { state: 'empty' })], rows: [row('slack:workspace', 'connecting', NOW - ageMs)], nowMs: NOW })
    expect(at(2 * MIN).beingConnected).toEqual(['slack'])
    expect(at(2 * MIN).details.slack!.liveBy).toEqual(inst(NOW - 2 * MIN + 10 * MIN))
    expect(at(11 * MIN).beingConnected).toEqual([])
    expect(at(11 * MIN).details.slack!.liveBy).toBeUndefined()
    expect(at(10 * MIN).beingConnected).toEqual(['slack'])
    expect(CONNECT_STATE_TTL_MS).toBe(10 * MIN)
  })
  it('a failed login stays listed as connected and is reported disconnected since its error', () => {
    const d = buildToolsData({ accounts: [acct('shopify:store', { state: 'failed', lastError: { code: 'credentials_rejected', at: inst(NOW - 5 * MIN) } })], rows: [], nowMs: NOW })
    expect(d.connected).toEqual(['shopify'])
    expect(d.connection).toEqual({ shopify: { status: 'disconnected', since: inst(NOW - 5 * MIN) } })
  })
  it('an account whose scopes changed (needsReconnect) reads disconnected and is no channel', () => {
    const d = buildToolsData({ accounts: [acct('slack:workspace', { needsReconnect: true, connectedAt: inst(NOW - 9 * MIN) })], rows: [row('slack:workspace', 'connected', NOW - 7 * MIN)], nowMs: NOW })
    expect(d.connected).toEqual(['slack'])
    expect(d.connection).toEqual({ slack: { status: 'disconnected', since: inst(NOW - 7 * MIN) } })
    expect(d.channels).toEqual([])
  })
  it('paused comes from the hub; a failed revoke is reported; a paused Slack is still a channel', () => {
    const d = buildToolsData({ accounts: [acct('slack:workspace', { paused: true, revokeFailedAt: inst(NOW - MIN) })], rows: [], nowMs: NOW })
    expect(d.details.slack).toMatchObject({ paused: true, revokeFailed: true })
    expect(d.channels.map(c => c.key)).toEqual(['slack'])
  })
  it('property: every listed key names an account the hub returned and configured; connection is a subset of connected', () => {
    const state = fc.constantFrom('empty', 'active', 'failed', 'disconnected' as const)
    const summary = (id: string) => fc.record({ state, paused: fc.boolean(), needsReconnect: fc.boolean(), configured: fc.boolean(), present: fc.boolean() })
      .map(r => (r.present ? [acct(id, { state: r.state, paused: r.paused, needsReconnect: r.needsReconnect, lastError: r.state === 'failed' ? { code: 'x', at: inst(NOW - MIN) } : null }, r.configured)] : []))
    const rowFor = (id: string) => fc.option(fc.record({ s: fc.constantFrom('never', 'connecting', 'connected', 'failed', 'disconnected' as const), age: fc.integer({ min: 0, max: 30 * MIN }) }), { nil: undefined })
      .map(r => (r ? [row(id, r.s, NOW - r.age)] : []))
    fc.assert(fc.property(summary('shopify:store'), summary('slack:workspace'), rowFor('shopify:store'), rowFor('slack:workspace'), (a, b, c, d) => {
      const accounts = [...a, ...b]
      const data = buildToolsData({ accounts, rows: [...c, ...d], nowMs: NOW })
      const returned = new Set(accounts.filter(x => x.configured).map(x => x.accountId.split(':')[0]))
      const keys = [...data.connected, ...data.beingConnected, ...Object.keys(data.connection), ...Object.keys(data.details), ...data.catalog.map(x => x.k), ...data.channels.map(x => x.key)]
      for (const k of keys) expect(returned.has(k)).toBe(true)
      for (const k of Object.keys(data.connection)) expect(data.connected).toContain(k)
      for (const k of data.beingConnected) expect(Object.keys(data.details)).toContain(k)
      expect(ToolsDataSchema.safeParse(data).success).toBe(true)
    }), { numRuns: 300 })
  })
})

// ---- Routes D and E ----

const inhouse: Principal = { kind: 'inhouse', memberId: 'm_inhouse1', subject: 's', grant: null, requestId: 'req-1', expMs: NOW + MIN }
const admin: Principal = { kind: 'person', memberId: 'm_admin1', role: 'admin', subject: 's', requestId: 'req-1', expMs: NOW + MIN }
const member: Principal = { kind: 'person', memberId: 'm_member1', role: 'member', subject: 's', requestId: 'req-1', expMs: NOW + MIN }

function fake(over: { revoked?: boolean; hubFails?: string } = {}) {
  const hubCalls: string[] = []
  const lines: { at: unknown; target: string; line: ToolsAuditArgs }[] = []
  const rowWrites: { accountId: string; connector: string }[] = []
  const fail = (code: string) => ({ ok: false as const, error: { code, message: 'm' } })
  const gateway: ConnectGateway = {
    listAccounts: async () => { hubCalls.push('list'); return over.hubFails ? fail(over.hubFails) : { ok: true, value: [acct('slack:workspace'), acct('shopify:store')] } },
    setPaused: async (_s, id, paused) => { hubCalls.push(`pause:${id}:${paused}`); return over.hubFails ? fail(over.hubFails) : { ok: true, value: { paused } } },
    disconnect: async (_s, id) => { hubCalls.push(`disconnect:${id}`); return over.hubFails ? fail(over.hubFails) : { ok: true, value: { revoked: over.revoked ?? true } } },
  }
  const deps: ToolsDeps = {
    gateway,
    accounts: {
      list: async () => [],
      recordPause: async (at, target, line) => { lines.push({ at, target, line }) },
      recordDisconnect: async (at, accountId, connector, line) => { rowWrites.push({ accountId, connector }); lines.push({ at, target: accountId, line }) },
    },
  }
  return { deps, hubCalls, lines, rowWrites, handlers: toolsHandlers(() => deps) }
}

const ctx = (principal: Principal, method: string, path: string, params: Record<string, string>, body?: unknown): HandlerContext =>
  ({
    request: new Request(`https://x.test${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
    principal, params, requestId: 'req-1', nowMs: NOW, access: { requireObject: () => undefined },
  }) as unknown as HandlerContext

describe('the matrix rows (the lines in the PR body) refuse before the handler', () => {
  const rows = [
    { method: 'GET', pattern: '/api/tools', class: 'technical', allow: ['member', 'admin', 'inhouse'] },
    { method: 'PUT', pattern: '/api/tools/:accountId/paused', class: 'technical', allow: ['inhouse'] },
    { method: 'POST', pattern: '/api/tools/:accountId/disconnect', class: 'technical', allow: ['inhouse'] },
  ] as const
  it('an Admin and a Member are refused on D and E, and may read C; Inhouse passes all three', () => {
    const decide = (p: Principal, i: number) => 'ok' in checkAccess(p, rows[i]!, undefined, NOW)
    expect([0, 1, 2].map(i => decide(admin, i))).toEqual([true, false, false])
    expect([0, 1, 2].map(i => decide(member, i))).toEqual([true, false, false])
    expect([0, 1, 2].map(i => decide(inhouse, i))).toEqual([true, true, true])
  })
  it('the real matrix has no row for these paths yet (the orchestrator adds them)', () => {
    expect(accessMatrix.some(r => r.pattern.startsWith('/api/tools'))).toBe(false)
  })
})

describe('route C handler', () => {
  it('answers the merged list; a query string is refused; a hub failure maps to the API codes', async () => {
    const f = fake()
    const res = await f.handlers.listTools(ctx(member, 'GET', '/api/tools', {}))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { connected: string[] }).connected).toEqual(['shopify', 'slack'])
    expect((await f.handlers.listTools(ctx(member, 'GET', '/api/tools?x=1', {}))).status).toBe(400)
    const down = fake({ hubFails: 'upstream_unavailable' })
    expect((await down.handlers.listTools(ctx(member, 'GET', '/api/tools', {}))).status).toBe(503)
    const bad = fake({ hubFails: 'internal' })
    expect((await bad.handlers.listTools(ctx(member, 'GET', '/api/tools', {}))).status).toBe(500)
  })
})

describe('route D handler', () => {
  const put = (f: ReturnType<typeof fake>, p: Principal, key: string, body: unknown) => f.handlers.setToolPaused(ctx(p, 'PUT', `/api/tools/${key}/paused`, { accountId: key }, body))
  it('Inhouse sets the pause by key or account id: the hub is called with the account id, one audit line, the new state answered', async () => {
    const f = fake()
    const res = await put(f, inhouse, 'slack', { paused: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ paused: true })
    expect(f.hubCalls).toEqual(['pause:slack:workspace:true'])
    expect(f.lines).toEqual([{ at: { actorId: 'm_inhouse1', requestId: 'req-1', nowMs: NOW }, target: 'slack:workspace', line: { action: 'tools.pause', accountId: 'slack:workspace', paused: true } }])
    const again = fake()
    expect((await put(again, inhouse, 'slack:workspace', { paused: false })).status).toBe(200)
    expect(again.hubCalls).toEqual(['pause:slack:workspace:false'])
  })
  it('an Admin or Member that reached the handler is refused with no hub call and no line', async () => {
    for (const p of [admin, member]) {
      const f = fake()
      expect((await put(f, p, 'slack', { paused: true })).status).toBe(403)
      expect(f.hubCalls).toEqual([])
      expect(f.lines).toEqual([])
    }
  })
  it('an unknown key is 404, a bad body is 400, a hub failure writes no line', async () => {
    const f = fake()
    expect((await put(f, inhouse, 'zendesk', { paused: true })).status).toBe(404)
    expect((await put(f, inhouse, 'slack', { paused: 'yes' })).status).toBe(400)
    expect((await put(f, inhouse, 'slack', { paused: true, ifRev: 1 })).status).toBe(400)
    expect(f.hubCalls).toEqual([])
    const bad = fake({ hubFails: 'not_configured' })
    const res = await put(bad, inhouse, 'slack', { paused: true })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe('not_configured')
    expect(bad.lines).toEqual([])
  })
})

describe('route E handler', () => {
  const post = (f: ReturnType<typeof fake>, p: Principal, key: string, body: unknown = {}) => f.handlers.disconnectTool(ctx(p, 'POST', `/api/tools/${key}/disconnect`, { accountId: key }, body))
  it('Inhouse disconnects Slack: the hub, the row write and one audit line; revoked is passed through true or false', async () => {
    for (const revoked of [true, false]) {
      const f = fake({ revoked })
      const res = await post(f, inhouse, 'slack')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ revoked })
      expect(f.hubCalls).toEqual(['disconnect:slack:workspace'])
      expect(f.rowWrites).toEqual([{ accountId: 'slack:workspace', connector: 'slack' }])
      expect(f.lines.map(l => l.line)).toEqual([{ action: 'tools.disconnect', accountId: 'slack:workspace', revoked }])
    }
  })
  it('Shopify is 409 not_disconnectable before any hub call or line', async () => {
    const f = fake()
    const res = await post(f, inhouse, 'shopify')
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe('not_disconnectable')
    expect(f.hubCalls).toEqual([])
    expect(f.lines).toEqual([])
    expect(f.rowWrites).toEqual([])
  })
  it('an Admin or Member is refused, an unknown key is 404, a hub failure changes nothing', async () => {
    for (const p of [admin, member]) {
      const f = fake()
      expect((await post(f, p, 'slack')).status).toBe(403)
      expect(f.hubCalls).toEqual([])
      expect(f.lines).toEqual([])
    }
    const f = fake()
    expect((await post(f, inhouse, 'zendesk')).status).toBe(404)
    expect((await post(f, inhouse, 'slack', { x: 1 })).status).toBe(400)
    const bad = fake({ hubFails: 'internal' })
    expect((await post(bad, inhouse, 'slack')).status).toBe(500)
    expect(bad.lines).toEqual([])
    expect(bad.rowWrites).toEqual([])
  })
})
