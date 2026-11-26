// The hub's word on the write accounts, copied into D1 (Stage 1 M2-D, N9; from #433 and #439). Ways it can fail, written
// down first:
//  1. the product keeps its own clock's connection date, so the hub refuses every send as stale (`expect.connectedAtMs`);
//  2. the Shopify scope's shop comes from anywhere but the hub, or a missing handle lets a write through;
//  3. a sync that changes nothing writes anyway (a new rev and an audit line on every request), or one that moves the
//     generation leaves the old generation's grants alive;
//  4. an account the hub doesn't call active, or an answer that can't be read, is treated as open;
//  5. the binding's answer is kept (its disposer never run).
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountSummary, HubResult } from '../../../hub/index/contract.ts'
import { connectorAccountStore } from '../../db/connector-accounts.ts'
import { lastLineId, linesSince } from '../../db/test-support.ts'
import { outboxFacts } from '../../outbox/facts.ts'
import { resolve } from '../../permissions/resolve.ts'
import { POLICY_REV } from '../../permissions/policy.ts'
import { insertGrant, person, resetPermissions } from '../../permissions/test-support.ts'
import { hubAccountFacts, rpcPlain } from './hub-accounts.ts'

const db = env.DB
const SHOP = 'shopify:store'
const SLACK = 'slack:workspace'
const HUB_GEN = 1_700_000_123_456

const status = (o: { state?: 'active' | 'failed' | 'disconnected' | 'empty'; paused?: boolean; connectedAtMs?: number | null } = {}): AccountSummary['status'] => ({
  accountId: 'x', state: o.state ?? 'active', kid: null, expiresAt: null, scopes: [], lastError: null, paused: o.paused ?? false, kind: 'client_credentials',
  connectedBy: null, connectedAt: o.connectedAtMs === null ? null : { iso: new Date(o.connectedAtMs ?? HUB_GEN).toISOString(), ms: o.connectedAtMs ?? HUB_GEN },
  revokeFailedAt: null, needsReconnect: false,
})
const shopify = (o: Parameters<typeof status>[0] & { shop?: string } = {}): AccountSummary =>
  ({ accountId: SHOP, connector: 'shopify', configured: true, status: status(o), ...(o.shop === undefined ? { shop: 'example-write' } : o.shop === '' ? {} : { shop: o.shop }) })
const slack = (o: Parameters<typeof status>[0] = {}): AccountSummary => ({ accountId: SLACK, connector: 'slack', configured: true, status: status({ connectedAtMs: HUB_GEN + 1, ...o }) })

const gateway = (answer: unknown) => {
  const calls: unknown[] = []
  return { calls, connect: { listAccounts: async (scope: unknown) => { calls.push(scope); return answer as HubResult<AccountSummary[]> } } }
}
const read = (answer: unknown, nowMs = 5_000) =>
  hubAccountFacts({ connect: gateway(answer).connect, db, nowMs, requestId: `req-${nowMs}`, log: () => {} })
const row = (id: string) => db.prepare('SELECT * FROM connector_accounts WHERE account_id = ?').bind(id).first<Record<string, unknown>>()

beforeEach(async () => {
  await resetPermissions(db)
  await db.prepare('DELETE FROM connector_accounts').run()
})

describe('the copy into D1 (failures 1, 2, 3)', () => {
  it('copies the hub\'s connection date and the write store\'s handle, with one tools.connect line by the system', async () => {
    const mark = await lastLineId(db)
    expect(await read({ ok: true, value: [shopify(), slack()] })).toEqual([
      { accountId: SHOP, paused: false, label: 'Shopify' }, { accountId: SLACK, paused: false, label: 'Slack' },
    ])
    expect(await row(SHOP)).toMatchObject({ connector: 'shopify', last_state: 'connected', connected_at_ms: HUB_GEN, shop: 'example-write', rev: 1 })
    expect(await row(SLACK)).toMatchObject({ connector: 'slack', last_state: 'connected', connected_at_ms: HUB_GEN + 1, shop: null })
    expect((await linesSince(db, mark)).map(l => [l.action, l.actor_id, JSON.parse(l.args_json)])).toEqual([
      ['tools.connect', 'm_system', { accountId: SHOP, outcome: 'ok' }], ['tools.connect', 'm_system', { accountId: SLACK, outcome: 'ok' }],
    ])
    // resolve reads the copied generation and shop: the scope and the generation are the hub's.
    const facts = await outboxFacts({ db, hubAccounts: async () => [{ accountId: SHOP, paused: false, label: 'Shopify' }] }).resolveFacts(6_000)
    expect(facts.accounts.shopify).toMatchObject({ connectedAtMs: HUB_GEN, shop: 'example-write', connected: true })
    const r = await resolve(facts, { operation: 'shopify.order.tag_add', args: { orderId: 'gid://shopify/Order/1', tags: ['a'] } })
    expect(r).toMatchObject({ accountGen: HUB_GEN, scope: { shop: 'example-write' } })
  })

  it('a second read that changes nothing writes nothing', async () => {
    await read({ ok: true, value: [shopify()] })
    const mark = await lastLineId(db)
    await read({ ok: true, value: [shopify()] }, 9_000)
    expect(await row(SHOP)).toMatchObject({ rev: 1 })
    expect(await linesSince(db, mark)).toEqual([])
  })

  it('a row dated by the product\'s own clock (a Slack connect) takes the hub\'s date; a moved generation revokes the old grants', async () => {
    await connectorAccountStore({ db }).connectEnded(SLACK, 'slack', 'ok', 'connected', { actorId: 'm_system', requestId: 'r1', nowMs: 42 })
    await person(db, 'm_hub_acct', 'member')
    await insertGrant(db, {
      id: 'pg_AAAAAAAAAAAAAAAAAAAAAA', holder: 'member:m_hub_acct', accountId: SLACK, accountGen: 42, operation: 'slack.channel.post', scopeKey: 'channelId=C1',
      perDay: 50, policyRev: POLICY_REV, grantedRole: 'member', ceilingRev: 1, revokedAtMs: null,
    })
    await read({ ok: true, value: [slack()] })
    expect(await row(SLACK)).toMatchObject({ connected_at_ms: HUB_GEN + 1, last_state: 'connected' })
    const g = await db.prepare('SELECT revoked_at_ms, revoke_reason FROM permission_grants WHERE id = ?').bind('pg_AAAAAAAAAAAAAAAAAAAAAA').first()
    expect(g).toMatchObject({ revoke_reason: 'account_reconnected' })
    expect(g?.revoked_at_ms).not.toBeNull()
  })

  it('a Shopify account with no write store configured keeps no handle: resolve refuses the write', async () => {
    await read({ ok: true, value: [shopify({ shop: '' })] })
    expect(await row(SHOP)).toMatchObject({ shop: null, connected_at_ms: HUB_GEN })
    const facts = await outboxFacts({ db, hubAccounts: async () => [{ accountId: SHOP, paused: false, label: 'Shopify' }] }).resolveFacts(6_000)
    expect(await resolve(facts, { operation: 'shopify.order.tag_add', args: { orderId: 'gid://shopify/Order/1', tags: ['a'] } })).toMatchObject({ refuse: { reason: 'account_unavailable' } })
  })
})

describe('fail closed (failures 4, 5)', () => {
  it('an account the hub doesn\'t call active, or paused, is answered paused and not copied', async () => {
    expect(await read({ ok: true, value: [shopify({ state: 'failed' }), slack({ paused: true })] })).toEqual([
      { accountId: SHOP, paused: true, label: 'Shopify' }, { accountId: SLACK, paused: true, label: 'Slack' },
    ])
    expect(await row(SHOP)).toBeNull()
    expect(await read({ ok: true, value: [shopify({ connectedAtMs: null })] })).toEqual([{ accountId: SHOP, paused: true, label: 'Shopify' }])
  })

  it('a hub error, a malformed answer or a throwing binding answers no account at all', async () => {
    expect(await read({ ok: false, error: { code: 'internal', message: 'x' } })).toEqual([])
    expect(await read({ ok: true, value: [{ accountId: SHOP }] })).toEqual([])
    const thrown = await hubAccountFacts({ connect: { listAccounts: async () => { throw new Error('binding') } }, db, nowMs: 1, requestId: 'r', log: () => {} })
    expect(thrown).toEqual([])
    expect(await row(SHOP)).toBeNull()
  })

  it('the binding\'s answer is copied out and its disposer run', () => {
    const dispose = (Symbol as unknown as { dispose?: symbol }).dispose
    if (dispose === undefined) return
    let disposed = 0
    const answer = { ok: true, value: [], [dispose]: () => { disposed++ } }
    expect(rpcPlain(answer)).toEqual({ ok: true, value: [] })
    expect(disposed).toBe(1)
  })
})
