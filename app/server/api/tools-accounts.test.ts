// Routes C to E with the real adapter (`tools-accounts.ts`) over W1's connector store, on the real migrations, and a fake
// hub. Ways it can fail, written down first (tools.test.ts covers the merge and the guards with a fake store):
//  1. a row's fields reach the page wrongly (the list maps a column to the wrong field);
//  2. a disconnect changes the row without its line, or the line without the row (one batch: a broken audit insert
//     rolls the row back too), or leaves the old `rev`;
//  3. a pause writes a row change, or writes a line that names the wrong account, actor or arguments;
//  4. a retry after a failed write double-writes.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountSummary } from '../../hub/index/contract.ts'
import { openStores } from '../db/stores.ts'
import type { Stores } from '../db/stores.ts'
import { brokenAudit, ctx, lastLineId, linesSince, person, personPrincipal, reqId } from '../db/test-support.ts'
import type { Principal } from '../auth/principal.ts'
import type { HandlerContext } from '../routes.ts'
import { toolsHandlers } from './tools.ts'
import type { ToolsGateway } from './tools.ts'
import { toolsAccounts } from './tools-accounts.ts'

const db = env.DB
const stores = openStores(env)
const T = 1_800_000_000_000
const SLACK = 'slack:workspace'
let u = 0
const uniq = () => `${++u}-${Math.random().toString(36).slice(2, 7)}`

function hub(slack: Partial<AccountSummary['status']> = {}) {
  const calls: string[] = []
  const status: AccountSummary['status'] = {
    accountId: SLACK, state: 'active', kid: null, expiresAt: null, scopes: [], lastError: null, paused: false, kind: 'oauth_mcp',
    connectedBy: null, connectedAt: null, revokeFailedAt: null, needsReconnect: false, ...slack,
  }
  const gateway: ToolsGateway = {
    listAccounts: async () => ({ ok: true, value: [{ accountId: SLACK, connector: 'slack', configured: true, status }] }),
    setPaused: async (_s, id, paused) => { calls.push(`pause:${id}:${paused}`); return { ok: true, value: { paused } } },
    disconnect: async (_s, id) => { calls.push(`disconnect:${id}`); return { ok: true, value: { revoked: true } } },
  }
  return { gateway, calls }
}

const handlers = (gateway: ToolsGateway, s: Stores) => toolsHandlers(() => ({ gateway, accounts: toolsAccounts(s.connectors) }))
const call = (s: Stores, p: Principal, method: string, path: string, params: Record<string, string>, body?: unknown) =>
  ({ ...ctx(s, p, { method, path, params, body, nowMs: T }).c }) as unknown as HandlerContext

async function inhouse(): Promise<Principal> {
  const id = await stores.members.resolveInhouse({ subject: `ih-${uniq()}`, email: `ih-${uniq()}@example.test`, requestId: reqId(), nowMs: T })
  return { kind: 'inhouse', memberId: id.memberId, subject: id.subject, grant: null, requestId: reqId(), expMs: 4_102_444_800_000 }
}
const row = () => db.prepare('SELECT * FROM connector_accounts WHERE account_id = ?').bind(SLACK).first<Record<string, unknown>>()

beforeEach(async () => { await db.prepare('DELETE FROM connector_accounts').run() })

describe('the adapter on the real store', () => {
  it('list maps the row to the page fields', async () => {
    const p = await inhouse()
    const mid = (p as { memberId: string }).memberId
    await stores.connectors.connectEnded(SLACK, 'slack', 'ok', 'connected', { actorId: mid, requestId: reqId(), nowMs: T })
    expect(await toolsAccounts(stores.connectors).list()).toEqual([
      { accountId: SLACK, connector: 'slack', lastState: 'connected', lastStateAtMs: T, connectedBy: mid, connectedAtMs: T },
    ])
  })

  it('route C lists a connecting row as being connected, from the real table', async () => {
    const p = await inhouse()
    const mid = (p as { memberId: string }).memberId
    await stores.connectors.connectStarted(SLACK, 'slack', { actorId: mid, requestId: reqId(), nowMs: T - 60_000 })
    const h = hub({ state: 'empty' })
    const res = await handlers(h.gateway, stores).listTools(call(stores, await inhouse(), 'GET', '/api/tools', {}))
    const data = (await res.json()) as { beingConnected: string[]; catalog: { k: string }[] }
    expect([res.status, data.beingConnected, data.catalog.map(c => c.k)]).toEqual([200, ['slack'], ['slack']])
  })
})

describe('route D writes its line and nothing else', () => {
  it('a pause that changes the state writes one tools.pause line on the connector and no row', async () => {
    const p = await inhouse()
    const mid = (p as { memberId: string }).memberId
    const h = hub()
    const before = await lastLineId(db)
    const res = await handlers(h.gateway, stores).setToolPaused(call(stores, p, 'PUT', `/api/tools/${SLACK}/paused`, { accountId: SLACK }, { paused: true }))
    expect([res.status, await res.json()]).toEqual([200, { paused: true }])
    const lines = await linesSince(db, before)
    expect(lines.map(l => [l.action, l.target_kind, l.target_id, l.actor_id, JSON.parse(l.args_json)])).toEqual([
      ['tools.pause', 'connector', SLACK, mid, { accountId: SLACK, paused: true }],
    ])
    expect(await row()).toBeNull()
  })

  it('a repeat (the hub already paused) writes no line', async () => {
    const p = await inhouse()
    const before = await lastLineId(db)
    const res = await handlers(hub({ paused: true }).gateway, stores).setToolPaused(call(stores, p, 'PUT', `/api/tools/${SLACK}/paused`, { accountId: SLACK }, { paused: true }))
    expect(res.status).toBe(200)
    expect(await linesSince(db, before)).toEqual([])
  })
})

describe('route E: the row change and its line are one batch', () => {
  it('disconnect upserts the row (disconnected, who, when, rev + 1) and writes one tools.disconnect line', async () => {
    const p = await inhouse()
    const mid = (p as { memberId: string }).memberId
    await stores.connectors.connectEnded(SLACK, 'slack', 'ok', 'connected', { actorId: mid, requestId: reqId(), nowMs: T - 1000 })
    const before = await lastLineId(db)
    const h = hub()
    const res = await handlers(h.gateway, stores).disconnectTool(call(stores, p, 'POST', `/api/tools/${SLACK}/disconnect`, { accountId: SLACK }, {}))
    expect([res.status, await res.json()]).toEqual([200, { revoked: true }])
    expect(h.calls).toEqual([`disconnect:${SLACK}`])
    expect(await stores.connectors.get(SLACK)).toMatchObject({ lastState: 'disconnected', disconnectedBy: mid, disconnectedAtMs: T, connectedBy: mid, rev: 2 })
    expect((await linesSince(db, before)).map(l => [l.action, l.target_kind, l.target_id, JSON.parse(l.args_json)])).toEqual([
      ['tools.disconnect', 'connector', SLACK, { accountId: SLACK, revoked: true }],
    ])
  })

  it('a broken audit insert rolls the row back, and the retry then writes the row and one line once', async () => {
    const p = await inhouse()
    const mid = (p as { memberId: string }).memberId
    await stores.connectors.connectEnded(SLACK, 'slack', 'ok', 'connected', { actorId: mid, requestId: reqId(), nowMs: T - 1000 })
    const before = await lastLineId(db)
    const broken = openStores(env, brokenAudit)
    const h = hub()
    await expect(handlers(h.gateway, broken).disconnectTool(call(broken, p, 'POST', `/api/tools/${SLACK}/disconnect`, { accountId: SLACK }, {}))).rejects.toThrow()
    expect(await stores.connectors.get(SLACK)).toMatchObject({ lastState: 'connected', rev: 1 })
    expect(await linesSince(db, before)).toEqual([])
    // The hub is now disconnected, the row still says connected: the retry calls the hub again and finishes.
    const retry = hub({ state: 'disconnected' })
    const res = await handlers(retry.gateway, stores).disconnectTool(call(stores, p, 'POST', `/api/tools/${SLACK}/disconnect`, { accountId: SLACK }, {}))
    expect(res.status).toBe(200)
    expect(retry.calls).toEqual([`disconnect:${SLACK}`])
    expect(await stores.connectors.get(SLACK)).toMatchObject({ lastState: 'disconnected', rev: 2 })
    expect(await linesSince(db, before)).toHaveLength(1)
  })

  it('an Admin and a Member never reach the hub on D or E', async () => {
    for (const role of ['admin', 'member'] as const) {
      const p = personPrincipal(await person(stores, { email: `t-${uniq()}@example.test`, subject: `st-${uniq()}`, role }), role)
      const h = hub()
      const t = handlers(h.gateway, stores)
      expect((await t.setToolPaused(call(stores, p, 'PUT', `/api/tools/${SLACK}/paused`, { accountId: SLACK }, { paused: true }))).status).toBe(403)
      expect((await t.disconnectTool(call(stores, p, 'POST', `/api/tools/${SLACK}/disconnect`, { accountId: SLACK }, {}))).status).toBe(403)
      expect(h.calls).toEqual([])
    }
  })
})
