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
import type { AccountSummary, HubError } from '../../hub/index/contract.ts'
import type { ConnectorAccountRow, ToolsAuditArgs, ToolsDeps, ToolsGateway } from './tools.ts'

const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const inst = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const MIN = 60_000

const acct = (accountId: string, over: Partial<AccountSummary['status']> = {}, configured = true): AccountSummary => ({
  accountId, connector: accountId.split(':')[0]!, configured,
  status: {
    accountId, state: 'active', kid: null, expiresAt: null, scopes: [], lastError: null, paused: false, kind: accountId.startsWith('slack') ? 'oauth_mcp' : 'client_credentials',
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
    expect(data.details.slack).toMatchObject({ accountId: 'slack:workspace', connectedBy: 'm_inhouse1', canDisconnect: true, paused: false, since: inst(NOW - 86_400_000) })
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
    expect(d.catalog).toEqual([{ k: 'slack', name: 'Slack', desc: 'Team conversations in the channels your agent can see', need: 0, accountId: 'slack:workspace' }])
    expect(d.channels).toEqual([])
    // A catalog tool has no details (the UI's rule: details are for tools connected or being connected).
    expect(d.details).toEqual({})
  })
  it('a connecting row 2 minutes old is being connected; one 11 minutes old is not; exactly 10 minutes still is', () => {
    const at = (ageMs: number) => buildToolsData({ accounts: [acct('slack:workspace', { state: 'empty' })], rows: [row('slack:workspace', 'connecting', NOW - ageMs)], nowMs: NOW })
    expect(at(2 * MIN).beingConnected).toEqual(['slack'])
    expect(at(2 * MIN).catalog).toEqual([])
    expect(at(11 * MIN).catalog.map(c => c.k)).toEqual(['slack'])
    expect(Object.keys(at(11 * MIN).details)).toEqual(['slack'])
    expect(at(2 * MIN).details.slack!.liveBy).toEqual(inst(NOW - 2 * MIN + 10 * MIN))
    expect(at(11 * MIN).beingConnected).toEqual([])
    expect(at(10 * MIN).beingConnected).toEqual(['slack'])
    expect(CONNECT_STATE_TTL_MS).toBe(10 * MIN)
  })
  it('a failed login stays listed as connected and is reported disconnected since its error', () => {
    const d = buildToolsData({ accounts: [acct('shopify:store', { state: 'failed', connectedAt: inst(NOW - 60 * MIN), lastError: { code: 'credentials_rejected', at: inst(NOW - 5 * MIN) } })], rows: [], nowMs: NOW })
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
    const d = buildToolsData({ accounts: [acct('slack:workspace', { paused: true, revokeFailedAt: inst(NOW - MIN), connectedAt: inst(NOW - 2 * MIN) })], rows: [], nowMs: NOW })
    expect(d.details.slack).toMatchObject({ paused: true, revokeFailed: true })
    expect(d.channels.map(c => c.key)).toEqual(['slack'])
  })
  it('a failed tool with a fresh connecting row is in connected (failed) AND in beingConnected: a reconnect is in progress', () => {
    const d = buildToolsData({
      accounts: [acct('slack:workspace', { state: 'failed', connectedAt: inst(NOW - 60 * MIN), lastError: { code: 'credentials_rejected', at: inst(NOW - 30 * MIN) } })],
      rows: [row('slack:workspace', 'connecting', NOW - MIN)], nowMs: NOW,
    })
    expect(d.connected).toEqual(['slack'])
    expect(d.beingConnected).toEqual(['slack'])
    expect(d.connection).toEqual({ slack: { status: 'disconnected', since: inst(NOW - 30 * MIN) } })
    const r = buildToolsData({ accounts: [acct('slack:workspace', { needsReconnect: true, connectedAt: inst(NOW - 60 * MIN) })], rows: [row('slack:workspace', 'connecting', NOW - MIN)], nowMs: NOW })
    expect([r.connected, r.beingConnected, Object.keys(r.connection)]).toEqual([['slack'], ['slack'], ['slack']])
  })
  it('no time is invented: since falls back to the row, then the hub connect time, never the clock; a channel needs a time', () => {
    const failed = (rows: ConnectorAccountRow[], over: Partial<AccountSummary['status']> = {}) =>
      buildToolsData({ accounts: [acct('shopify:store', { state: 'failed', ...over })], rows, nowMs: NOW }).connection.shopify?.since
    expect(failed([row('shopify:store', 'failed', NOW - 20 * MIN)], { connectedAt: inst(NOW - 60 * MIN) })).toEqual(inst(NOW - 20 * MIN))
    expect(failed([row('shopify:store', 'failed', NOW - 20 * MIN, { connectedAtMs: NOW - 60 * MIN })])).toEqual(inst(NOW - 20 * MIN))
    expect(failed([], { connectedAt: inst(NOW - 40 * MIN) })).toEqual(inst(NOW - 40 * MIN))
    // With no connect time anywhere it was never connected (a failed first grant): not connected, so no epoch "since".
    // (Before the P5 Tools crash fix this read connected, disconnected since the epoch, and had no details.since.)
    expect(failed([])).toBeUndefined()
    const slack = (rows: ConnectorAccountRow[], over: Partial<AccountSummary['status']> = {}) =>
      buildToolsData({ accounts: [acct('slack:workspace', over)], rows, nowMs: NOW }).channels.map(c => c.since)
    expect(slack([row('slack:workspace', 'connected', NOW - 3 * MIN)])).toEqual([inst(NOW - 3 * MIN)])
    expect(slack([], { connectedAt: inst(NOW - 8 * MIN) })).toEqual([inst(NOW - 8 * MIN)])
    expect(slack([])).toEqual([])
  })
  it('a disconnected tool (hub state, row) keeps its details, with the failed revoke, and is a catalog entry to connect again', () => {
    const d = buildToolsData({
      accounts: [acct('slack:workspace', { state: 'disconnected', revokeFailedAt: inst(NOW - MIN) })],
      rows: [row('slack:workspace', 'disconnected', NOW - MIN)], nowMs: NOW,
    })
    expect(d.connected).toEqual([])
    expect(d.channels).toEqual([])
    expect(d.catalog.map(c => [c.k, c.accountId])).toEqual([['slack', 'slack:workspace']])
    expect(d.details.slack).toMatchObject({ accountId: 'slack:workspace', revokeFailed: true, canDisconnect: false })
    expect(d.details.slack!.since).toBeUndefined()
  })
  it('the hub alone: a disconnected or failed account with NO row still shows (state from the hub, no time invented)', () => {
    const off = buildToolsData({ accounts: [acct('slack:workspace', { state: 'disconnected', revokeFailedAt: inst(NOW - MIN) })], rows: [], nowMs: NOW })
    expect(off.connected).toEqual([])
    expect(off.details.slack).toMatchObject({ accountId: 'slack:workspace', revokeFailed: true })
    expect(off.catalog.map(c => c.k)).toEqual(['slack'])
    // A failed account with no connect time from the hub or a row was never connected (the P5 Tools crash fix: connected
    // implies since). Its details stay, so its page opens, and it reads as a catalog entry, not as a connected tool.
    const lost = buildToolsData({ accounts: [acct('slack:workspace', { state: 'failed' })], rows: [], nowMs: NOW })
    expect(lost.connected).toEqual([])
    expect(lost.connection).toEqual({})
    expect(Object.keys(lost.details)).toEqual(['slack'])
    expect(lost.catalog.map(c => c.k)).toEqual(['slack'])
    const was = buildToolsData({ accounts: [acct('slack:workspace', { state: 'failed', connectedAt: inst(NOW - 60 * MIN) })], rows: [], nowMs: NOW })
    expect(was.connected).toEqual(['slack'])
    expect(was.connection).toEqual({ slack: { status: 'disconnected', since: inst(NOW - 60 * MIN) } })
  })
  it('a first connect that failed or was declined leaves a row but no hub state: the details stay, so its page opens', () => {
    for (const lastState of ['never', 'failed', 'disconnected'] as const) {
      const d = buildToolsData({ accounts: [acct('slack:workspace', { state: 'empty' })], rows: [row('slack:workspace', lastState, NOW - MIN)], nowMs: NOW })
      expect(Object.keys(d.details), lastState).toEqual(['slack'])
      expect(d.catalog.map(c => c.k), lastState).toEqual(['slack'])
      expect(d.connected).toEqual([])
    }
  })
  it('readDone counts only tools the agent can read now: active, not paused, no reconnect needed', () => {
    const at = { connectedAt: inst(NOW - 60 * MIN) }
    const n = (over: Partial<AccountSummary['status']>) => buildToolsData({ accounts: [acct('slack:workspace', { ...at, ...over }), acct('shopify:store', at)], rows: [], nowMs: NOW }).readDone
    expect(n({})).toBe(2)
    expect(n({ paused: true })).toBe(1)
    expect(n({ needsReconnect: true })).toBe(1)
    expect(n({ state: 'failed' })).toBe(1)
    expect(n({ state: 'empty' })).toBe(1)
  })
  it('two hub rows for one account id give one entry; an account id the catalog does not know is never listed', () => {
    const d = buildToolsData({ accounts: [acct('slack:workspace', { connectedAt: inst(NOW - MIN) }), acct('slack:workspace', { connectedAt: inst(NOW - MIN) }), acct('zendesk:main')], rows: [], nowMs: NOW })
    expect(d.connected).toEqual(['slack'])
    expect(Object.keys(d.details)).toEqual(['slack'])
    expect(d.channels).toHaveLength(1)
  })
  it('property: every listed key names an account the hub returned and configured; connection is a subset of connected', () => {
    const state = fc.constantFrom('empty', 'active', 'failed', 'disconnected' as const)
    const summary = (id: string) => fc.record({ state, paused: fc.boolean(), needsReconnect: fc.boolean(), configured: fc.boolean(), present: fc.boolean() })
      .map(r => (r.present ? [acct(id, { state: r.state, paused: r.paused, needsReconnect: r.needsReconnect, lastError: r.state === 'failed' ? { code: 'credentials_rejected' as const, at: inst(NOW - MIN) } : null }, r.configured)] : []))
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
  // The Tools screen crash (P5, ship recording 45046093071): Shopify active with no connect time and no row was listed as
  // connected with no `since`, and the client's sinceLine threw for the whole screen. Ways it can fail: a connected tool
  // with no `since`; a `since` that is the clock (moves between reads).
  it('an active client-credentials account with no row: since is the hub connect time, the same on every read', () => {
    const read = (nowMs: number) => buildToolsData({ accounts: [acct('shopify:store', { connectedAt: inst(NOW - 2 * 86_400_000) })], rows: [], nowMs })
    expect(read(NOW).connected).toEqual(['shopify'])
    expect(read(NOW).details.shopify!.since).toEqual(inst(NOW - 2 * 86_400_000))
    expect(read(NOW + 3 * 3_600_000).details.shopify!.since).toEqual(read(NOW).details.shopify!.since)
  })
  it('property: connected implies since (the contract the client reads); a tool with no honest date is not listed as connected', () => {
    const state = fc.constantFrom('empty', 'active', 'failed', 'disconnected' as const)
    const summary = (id: string) => fc.record({ state, needsReconnect: fc.boolean(), at: fc.option(fc.integer({ min: 0, max: 30 * MIN }), { nil: null }) })
      .map(r => [acct(id, { state: r.state, needsReconnect: r.needsReconnect, connectedAt: r.at === null ? null : inst(NOW - r.at) })])
    const rowFor = (id: string) => fc.option(fc.record({ s: fc.constantFrom('never', 'connecting', 'connected', 'failed', 'disconnected' as const), age: fc.integer({ min: 0, max: 30 * MIN }), at: fc.option(fc.integer({ min: 0, max: 30 * MIN }), { nil: null }) }), { nil: undefined })
      .map(r => (r ? [row(id, r.s, NOW - r.age, { connectedAtMs: r.at === null ? null : NOW - r.at })] : []))
    fc.assert(fc.property(summary('shopify:store'), summary('slack:workspace'), rowFor('shopify:store'), rowFor('slack:workspace'), (a, b, c, d) => {
      const data = buildToolsData({ accounts: [...a, ...b], rows: [...c, ...d], nowMs: NOW })
      for (const k of data.connected) expect(data.details[k]?.since, k).toBeDefined()
    }), { numRuns: 300 })
    const none = buildToolsData({ accounts: [acct('shopify:store')], rows: [], nowMs: NOW })
    expect(none.connected).toEqual([])
    expect(none.catalog.map(c => c.k)).toEqual(['shopify'])
  })
  // #321 review M1: a first grant that failed (never held a token) must not read as a plain "Not connected": the details
  // carry when its login failed, so the page says so. Ways it can fail: the failure time is dropped; a connected tool
  // also carries it; a time is invented when the hub gave none.
  it('a failed account never connected: not in connected, its details carry loginFailedAt from the hub error, else nothing', () => {
    const shop = buildToolsData({ accounts: [acct('shopify:store', { state: 'failed', lastError: { code: 'credentials_rejected', at: inst(NOW - 5 * MIN) } })], rows: [], nowMs: NOW })
    expect(shop.connected).toEqual([])
    expect(shop.details.shopify!.loginFailedAt).toEqual(inst(NOW - 5 * MIN))
    const slack = buildToolsData({ accounts: [acct('slack:workspace', { state: 'failed', lastError: { code: 'credentials_rejected', at: inst(NOW - 9 * MIN) } })], rows: [], nowMs: NOW })
    expect(slack.details.slack!.loginFailedAt).toEqual(inst(NOW - 9 * MIN))
    expect(buildToolsData({ accounts: [acct('slack:workspace', { state: 'failed' })], rows: [], nowMs: NOW }).details.slack!.loginFailedAt).toBeUndefined()
    const was = buildToolsData({ accounts: [acct('shopify:store', { state: 'failed', connectedAt: inst(NOW - 60 * MIN), lastError: { code: 'credentials_rejected', at: inst(NOW - 5 * MIN) } })], rows: [], nowMs: NOW })
    expect(was.details.shopify!.loginFailedAt).toBeUndefined()
    expect(ToolsDataSchema.safeParse(shop).success).toBe(true)
  })
  // #321 review round 2: the row-time fallback comes only from a `connected` row, so a failure time never shows as a
  // connected date.
  it('a failed hub account with a failed row and no connect time is not connected; the row failure time is never its since', () => {
    for (const lastState of ['failed', 'never', 'disconnected', 'connecting'] as const) {
      const d = buildToolsData({ accounts: [acct('slack:workspace', { state: 'failed', lastError: { code: 'credentials_rejected', at: inst(NOW - 4 * MIN) } })], rows: [row('slack:workspace', lastState, NOW - 20 * MIN)], nowMs: NOW })
      expect(d.connected, lastState).toEqual([])
      expect(d.details.slack!.since, lastState).toBeUndefined()
      expect(d.details.slack!.loginFailedAt, lastState).toEqual(inst(NOW - 4 * MIN))
    }
    const active = buildToolsData({ accounts: [acct('slack:workspace')], rows: [row('slack:workspace', 'failed', NOW - 20 * MIN)], nowMs: NOW })
    expect(active.connected).toEqual([])
    expect(active.channels).toEqual([])
  })
  // #321 review L2: isConnected takes the same row fallback as the Slack channel does.
  it('an active account with no connect time but a row time is connected since the row time', () => {
    const d = buildToolsData({ accounts: [acct('slack:workspace')], rows: [row('slack:workspace', 'connected', NOW - 3 * MIN)], nowMs: NOW })
    expect(d.connected).toEqual(['slack'])
    expect(d.details.slack!.since).toEqual(inst(NOW - 3 * MIN))
  })
})


// ---- Routes D and E ----

const inhouse: Principal = { kind: 'inhouse', memberId: 'm_inhouse1', subject: 's', grant: null, requestId: 'req-1', expMs: NOW + MIN }
const admin: Principal = { kind: 'person', memberId: 'm_admin1', role: 'admin', subject: 's', requestId: 'req-1', expMs: NOW + MIN }
const member: Principal = { kind: 'person', memberId: 'm_member1', role: 'member', subject: 's', requestId: 'req-1', expMs: NOW + MIN }

interface FakeOpts {
  revoked?: boolean
  /** The hub's error on every call. */
  hubFails?: HubError
  slack?: Partial<AccountSummary['status']>
  rows?: ConnectorAccountRow[]
  /** The write operations enabled for the brand (`permission_ceiling`). None by default (N2). */
  enabled?: string[]
  /** The first row write throws (a failed D1 batch). */
  rowWriteFailsOnce?: boolean
}

function fake(o: FakeOpts = {}) {
  const hubCalls: string[] = []
  const lines: { at: unknown; target: string; line: ToolsAuditArgs }[] = []
  const rowWrites: { accountId: string; connector: string }[] = []
  let failNext = o.rowWriteFailsOnce ?? false
  const fail = () => ({ ok: false as const, error: o.hubFails! })
  const gateway: ToolsGateway = {
    listAccounts: async () => (o.hubFails ? fail() : { ok: true, value: [acct('slack:workspace', { connectedAt: inst(NOW - 60 * MIN), ...o.slack }), acct('shopify:store', { connectedAt: inst(NOW - 60 * MIN) })] }),
    setPaused: async (_s, id, paused) => { hubCalls.push(`pause:${id}:${paused}`); return o.hubFails ? fail() : { ok: true, value: { paused } } },
    disconnect: async (_s, id) => { hubCalls.push(`disconnect:${id}`); return o.hubFails ? fail() : { ok: true, value: { revoked: o.revoked ?? true } } },
  }
  const deps: ToolsDeps = {
    gateway,
    accounts: {
      list: async () => o.rows ?? [],
      enabledOperations: async () => o.enabled ?? [],
      recordPause: async (at, target, line) => { lines.push({ at, target, line }) },
      recordDisconnect: async (at, accountId, connector, line) => {
        if (failNext) { failNext = false; throw new Error('D1 batch failed') }
        rowWrites.push({ accountId, connector })
        lines.push({ at, target: accountId, line })
      },
    },
  }
  return { hubCalls, lines, rowWrites, deps, handlers: toolsHandlers(() => deps) }
}

const ctx = (principal: Principal, method: string, path: string, params: Record<string, string>, body?: unknown): HandlerContext =>
  ({
    request: new Request(`https://x.test${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
    principal, params, requestId: 'req-1', nowMs: NOW, access: { requireObject: () => undefined },
  }) as unknown as HandlerContext

const errBody = async (res: Response) => ((await res.json()) as { error: { code: string; reason?: string } }).error

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
  it('the real matrix carries exactly these three rows', () => {
    const real = accessMatrix.filter(r => r.pattern.startsWith('/api/tools')).map(r => ({ method: r.method, pattern: r.pattern, class: r.class, allow: r.allow }))
    expect(real).toEqual(rows.map(r => ({ method: r.method, pattern: r.pattern, class: r.class, allow: [...r.allow] })))
  })
})

// #337 round 4 (L1): in test and eval builds route C's list reads through the test shop (`listView`), but pause and
// disconnect act on the hub's own accounts, so their "before" read must be the binding's, not the view's, or the audit
// line's no-change check compares against another account's state.
describe('route C reads the list view; D and E read the binding they act on', () => {
  it('a view that differs from the binding: C shows the view, D decides its audit line from the binding', async () => {
    const f = fake()
    const viewCalls: string[] = []
    const deps: ToolsDeps = {
      gateway: { ...f.deps.gateway },
      listView: { listAccounts: async () => { viewCalls.push('view'); return { ok: true, value: [acct('shopify:store', { connectedAt: inst(NOW - 60 * MIN), paused: true })] } } },
      accounts: f.deps.accounts,
    }
    const h = toolsHandlers(() => deps)
    const listed = (await (await h.listTools(ctx(member, 'GET', '/api/tools', {}))).json()) as { connected: string[] }
    expect(listed.connected).toEqual(['shopify'])
    expect(viewCalls).toEqual(['view'])
    // The binding says Shopify isn't paused (the view says it is): pausing it is a change, so it writes its line.
    const res = await h.setToolPaused(ctx(inhouse, 'PUT', '/api/tools/shopify:store/paused', { accountId: 'shopify:store' }, { paused: true }))
    expect(res.status).toBe(200)
    expect(f.lines.map(l => l.line)).toEqual([{ action: 'tools.pause', accountId: 'shopify:store', paused: true }])
    await h.disconnectTool(ctx(inhouse, 'POST', '/api/tools/slack:workspace/disconnect', { accountId: 'slack:workspace' }, {}))
    expect(viewCalls, 'D and E never read the view').toEqual(['view'])
  })
})

describe('route C handler', () => {
  it('answers the merged list and ignores a query string; a hub failure maps to the API codes', async () => {
    const f = fake()
    for (const path of ['/api/tools', '/api/tools?x=1']) {
      const res = await f.handlers.listTools(ctx(member, 'GET', path, {}))
      expect(res.status).toBe(200)
      expect(((await res.json()) as { connected: string[] }).connected).toEqual(['shopify', 'slack'])
    }
    const down = fake({ hubFails: { code: 'upstream_unavailable', message: 'm' } })
    expect((await down.handlers.listTools(ctx(member, 'GET', '/api/tools', {}))).status).toBe(503)
    const bad = fake({ hubFails: { code: 'internal', message: 'm' } })
    expect((await bad.handlers.listTools(ctx(member, 'GET', '/api/tools', {}))).status).toBe(500)
  })
  // Stage 1 M2-I: the product's tool page offers drafting only for a tool the agent may act on.
  it('a tool acts only while one of its write operations is enabled; none is the default (N2)', async () => {
    const acts = async (enabled?: string[]) => {
      const body = (await (await fake({ enabled }).handlers.listTools(ctx(member, 'GET', '/api/tools', {}))).json()) as { details: Record<string, { acts?: boolean }> }
      return { shopify: body.details.shopify?.acts, slack: body.details.slack?.acts }
    }
    expect(await acts()).toEqual({ shopify: undefined, slack: undefined })
    expect(await acts(['shopify.order.tag_add'])).toEqual({ shopify: true, slack: undefined })
    expect(await acts(['shopify.order.tag_add', 'slack.channel.post'])).toEqual({ shopify: true, slack: true })
    expect(ToolsDataSchema.safeParse(buildToolsData({ accounts: [acct('shopify:store', { connectedAt: inst(NOW - MIN) })], rows: [], nowMs: NOW, enabled: ['shopify.order.tag_add'] })).success).toBe(true)
  })
  it('the hub rate limit is a 429 rate_limited carrying Retry-After in whole seconds', async () => {
    const f = fake({ hubFails: { code: 'rate_limited', message: 'm', retryAfterMs: 2500 } })
    const res = await f.handlers.listTools(ctx(member, 'GET', '/api/tools', {}))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('3')
    expect((await errBody(res)).code).toBe('rate_limited')
    const none = fake({ hubFails: { code: 'rate_limited', message: 'm' } })
    const r2 = await none.handlers.listTools(ctx(member, 'GET', '/api/tools', {}))
    expect([r2.status, r2.headers.get('Retry-After')]).toEqual([429, null])
  })
})

describe('route D handler', () => {
  const put = (f: ReturnType<typeof fake>, p: Principal, id: string, body: unknown) => f.handlers.setToolPaused(ctx(p, 'PUT', `/api/tools/${id}/paused`, { accountId: id }, body))
  it('Inhouse pauses by account id: the hub is called with it, one audit line, the new state answered', async () => {
    const f = fake()
    const res = await put(f, inhouse, 'slack:workspace', { paused: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ paused: true })
    expect(f.hubCalls).toEqual(['pause:slack:workspace:true'])
    expect(f.lines).toEqual([{ at: { actorId: 'm_inhouse1', requestId: 'req-1', nowMs: NOW }, target: 'slack:workspace', line: { action: 'tools.pause', accountId: 'slack:workspace', paused: true } }])
  })
  it('a repeat that changes nothing writes no line (pause when paused, resume when running), but still answers the state', async () => {
    const paused = fake({ slack: { paused: true } })
    const again = await put(paused, inhouse, 'slack:workspace', { paused: true })
    expect([again.status, await again.json()]).toEqual([200, { paused: true }])
    expect(paused.lines).toEqual([])
    const running = fake()
    expect((await put(running, inhouse, 'slack:workspace', { paused: false })).status).toBe(200)
    expect(running.lines).toEqual([])
    const resume = fake({ slack: { paused: true } })
    await put(resume, inhouse, 'slack:workspace', { paused: false })
    expect(resume.lines.map(l => l.line)).toEqual([{ action: 'tools.pause', accountId: 'slack:workspace', paused: false }])
  })
  it('an Admin or Member that reached the handler is refused with no hub call and no line', async () => {
    for (const p of [admin, member]) {
      const f = fake()
      expect((await put(f, p, 'slack:workspace', { paused: true })).status).toBe(403)
      expect(f.hubCalls).toEqual([])
      expect(f.lines).toEqual([])
    }
  })
  it('a connector key or unknown id is 404, a bad body is 400, a hub failure writes no line', async () => {
    const f = fake()
    expect((await put(f, inhouse, 'slack', { paused: true })).status).toBe(404)
    expect((await put(f, inhouse, 'zendesk:main', { paused: true })).status).toBe(404)
    expect((await put(f, inhouse, 'slack:workspace', { paused: 'yes' })).status).toBe(400)
    expect((await put(f, inhouse, 'slack:workspace', { paused: true, ifRev: 1 })).status).toBe(400)
    expect(f.hubCalls).toEqual([])
    const bad = fake({ hubFails: { code: 'not_configured', message: 'm' } })
    const res = await put(bad, inhouse, 'slack:workspace', { paused: true })
    expect([res.status, (await errBody(res)).reason]).toEqual([409, 'not_configured'])
    expect(bad.lines).toEqual([])
  })
})

describe('route E handler', () => {
  const post = (f: ReturnType<typeof fake>, p: Principal, id: string, body: unknown = {}) => f.handlers.disconnectTool(ctx(p, 'POST', `/api/tools/${id}/disconnect`, { accountId: id }, body))
  it('Inhouse disconnects Slack: the hub, the row write and one audit line; revoked is passed through true or false', async () => {
    for (const revoked of [true, false]) {
      const f = fake({ revoked })
      const res = await post(f, inhouse, 'slack:workspace')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ revoked })
      expect(f.hubCalls).toEqual(['disconnect:slack:workspace'])
      expect(f.rowWrites).toEqual([{ accountId: 'slack:workspace', connector: 'slack' }])
      expect(f.lines.map(l => l.line)).toEqual([{ action: 'tools.disconnect', accountId: 'slack:workspace', revoked }])
    }
  })
  it('a failed login can be disconnected too', async () => {
    const f = fake({ slack: { state: 'failed' } })
    expect((await post(f, inhouse, 'slack:workspace')).status).toBe(200)
  })
  it('Shopify is 409 not_disconnectable before any hub call or line', async () => {
    const f = fake()
    const res = await post(f, inhouse, 'shopify:store')
    expect([res.status, (await errBody(res)).reason]).toEqual([409, 'not_disconnectable'])
    expect(f.hubCalls).toEqual([])
    expect(f.lines).toEqual([])
    expect(f.rowWrites).toEqual([])
  })
  it('an account that is not connected is 409 not_connected: empty, or disconnected with the row already saying so; no hub call, no line', async () => {
    const cases: FakeOpts[] = [
      { slack: { state: 'empty' } },
      { slack: { state: 'disconnected' }, rows: [row('slack:workspace', 'disconnected', NOW - MIN)] },
      { slack: { state: 'disconnected' } },
      { slack: { state: 'disconnected' }, rows: [row('slack:workspace', 'never', NOW - MIN)] },
    ]
    for (const o of cases) {
      const f = fake(o)
      const res = await post(f, inhouse, 'slack:workspace')
      expect([res.status, (await errBody(res)).reason]).toEqual([409, 'not_connected'])
      expect(f.hubCalls).toEqual([])
      expect(f.lines).toEqual([])
      expect(f.rowWrites).toEqual([])
    }
  })
  it('a retry after a failed row write calls the hub again and finishes: the hub is disconnected, the row still says connected', async () => {
    const f = fake({ rowWriteFailsOnce: true })
    await expect(post(f, inhouse, 'slack:workspace')).rejects.toThrow('D1 batch failed')
    expect(f.hubCalls).toEqual(['disconnect:slack:workspace'])
    expect(f.lines).toEqual([])
    // What the hub and D1 hold now: the hub disconnected, the row not yet.
    const retry = fake({ slack: { state: 'disconnected' }, rows: [row('slack:workspace', 'connected', NOW - 5 * MIN)] })
    const res = await post(retry, inhouse, 'slack:workspace')
    expect([res.status, await res.json()]).toEqual([200, { revoked: true }])
    expect(retry.hubCalls).toEqual(['disconnect:slack:workspace'])
    expect(retry.rowWrites).toEqual([{ accountId: 'slack:workspace', connector: 'slack' }])
    expect(retry.lines).toHaveLength(1)
  })
  it('a connecting row (a reconnect in flight) is 409 not_connected: no hub call, no line; a failed row still retries', async () => {
    const mid = fake({ slack: { state: 'disconnected' }, rows: [row('slack:workspace', 'connecting', NOW - MIN)] })
    const res = await post(mid, inhouse, 'slack:workspace')
    expect([res.status, (await errBody(res)).reason]).toEqual([409, 'not_connected'])
    expect([mid.hubCalls, mid.lines, mid.rowWrites]).toEqual([[], [], []])
    const failed = fake({ slack: { state: 'disconnected' }, rows: [row('slack:workspace', 'failed', NOW - MIN)] })
    expect((await post(failed, inhouse, 'slack:workspace')).status).toBe(200)
    expect(failed.hubCalls).toEqual(['disconnect:slack:workspace'])
  })
  it('a retry after a failed first revoke records revoked: false, in the line and the answer, though the second hub call says true', async () => {
    const f = fake({ revoked: true, slack: { state: 'disconnected', revokeFailedAt: inst(NOW - 5 * MIN) }, rows: [row('slack:workspace', 'connected', NOW - 6 * MIN)] })
    const res = await post(f, inhouse, 'slack:workspace')
    expect([res.status, await res.json()]).toEqual([200, { revoked: false }])
    expect(f.lines.map(l => l.line)).toEqual([{ action: 'tools.disconnect', accountId: 'slack:workspace', revoked: false }])
    // A first-time disconnect of an account with an old failed revoke flag still reports the hub's answer.
    const first = fake({ revoked: true, slack: { revokeFailedAt: inst(NOW - 5 * MIN) } })
    expect(await (await post(first, inhouse, 'slack:workspace')).json()).toEqual({ revoked: true })
  })
  it('an Admin or Member is refused, a key or unknown id is 404, a hub failure changes nothing', async () => {
    for (const p of [admin, member]) {
      const f = fake()
      expect((await post(f, p, 'slack:workspace')).status).toBe(403)
      expect(f.hubCalls).toEqual([])
      expect(f.lines).toEqual([])
    }
    const f = fake()
    expect((await post(f, inhouse, 'zendesk:main')).status).toBe(404)
    expect((await post(f, inhouse, 'slack')).status).toBe(404)
    expect((await post(f, inhouse, 'slack:workspace', { x: 1 })).status).toBe(400)
    const bad = fake({ hubFails: { code: 'internal', message: 'm' } })
    expect((await post(bad, inhouse, 'slack:workspace')).status).toBe(500)
    expect(bad.lines).toEqual([])
    expect(bad.rowWrites).toEqual([])
  })
})
