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
import { hubAccountFacts } from './hub-accounts.ts'

const db = env.DB
const SHOP = 'shopify:store'
const SLACK = 'slack:workspace'
const HUB_GEN = 1_700_000_123_456

const status = (o: { state?: 'active' | 'failed' | 'disconnected' | 'empty'; paused?: boolean; connectedAtMs?: number | null } = {}): AccountSummary['status'] => ({
  accountId: 'x', state: o.state ?? 'active', kid: null, expiresAt: null, scopes: [], lastError: null, paused: o.paused ?? false, kind: 'client_credentials',
  connectedBy: null, connectedAt: o.connectedAtMs === null ? null : { iso: new Date(o.connectedAtMs ?? HUB_GEN).toISOString(), ms: o.connectedAtMs ?? HUB_GEN },
  revokeFailedAt: null, needsReconnect: false,
})
const shopify = (o: Parameters<typeof status>[0] & { shop?: string; currency?: string } = {}): AccountSummary =>
  ({ accountId: SHOP, connector: 'shopify', configured: true, status: status(o), ...(o.shop === undefined ? { shop: 'example-write' } : o.shop === '' ? {} : { shop: o.shop }), ...(o.currency === undefined ? {} : { currency: o.currency }) })
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
    const r = await resolve(facts, { operation: 'shopify.order.tag_add', args: { orderIds: ['gid://shopify/Order/1'], tags: ['a'] } })
    expect(r).toMatchObject({ accountGen: HUB_GEN, scope: { shop: 'example-write' } })
  })

  it('the first request after a connect resolves on the hub\'s copied row, not the row from before it', async () => {
    // No row yet (the client-credentials Shopify account is never recorded by a connect). The facts reader reads the
    // hub (which writes the row) before it reads the rows.
    const facts = outboxFacts({ db, hubAccounts: () => read({ ok: true, value: [shopify()] }) })
    const rf = await facts.resolveFacts(6_000)
    expect(rf.accounts.shopify).toMatchObject({ connectedAtMs: HUB_GEN, shop: 'example-write', connected: true, paused: false })
    expect(await resolve(rf, { operation: 'shopify.order.tag_add', args: { orderIds: ['gid://shopify/Order/1'], tags: ['a'] } })).toMatchObject({ accountGen: HUB_GEN })
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
      perDay: 50, unitsMax: 1, policyRev: POLICY_REV, grantedRole: 'member', ceilingRev: 1, revokedAtMs: null,
    })
    await read({ ok: true, value: [slack()] })
    expect(await row(SLACK)).toMatchObject({ connected_at_ms: HUB_GEN + 1, last_state: 'connected' })
    const g = await db.prepare('SELECT revoked_at_ms, revoke_reason FROM permission_grants WHERE id = ?').bind('pg_AAAAAAAAAAAAAAAAAAAAAA').first()
    expect(g).toMatchObject({ revoke_reason: 'account_reconnected' })
    expect(g?.revoked_at_ms).not.toBeNull()
  })

  it('a product disconnect older than its own connect but not older than the hub\'s date is cleared: the account reads connected', async () => {
    // The product connected at 200 and recorded a disconnect at 150 (its clock); the hub dates the connection 120.
    await db.prepare("INSERT INTO connector_accounts (account_id, connector, last_state, last_state_at_ms, connected_at_ms, disconnected_at_ms) VALUES (?, 'slack', 'connected', 200, 200, 150)").bind(SLACK).run()
    await read({ ok: true, value: [slack({ connectedAtMs: 120 })] })
    expect(await row(SLACK)).toMatchObject({ connected_at_ms: 120, disconnected_at_ms: null })
    const facts = await outboxFacts({ db, hubAccounts: async () => [{ accountId: SLACK, paused: false, label: 'Slack' }] }).resolveFacts(6_000)
    expect(facts.accounts.slack).toMatchObject({ connected: true, connectedAtMs: 120 })
  })

  it('a handle that isn\'t a store handle is no handle: Shopify is refused, the other accounts read as usual', async () => {
    expect(await read({ ok: true, value: [shopify({ shop: 'evil.example/../x' }), slack()] })).toEqual([
      { accountId: SHOP, paused: false, label: 'Shopify' }, { accountId: SLACK, paused: false, label: 'Slack' },
    ])
    expect(await row(SHOP)).toMatchObject({ shop: null })
  })

  it('a Shopify account with no write store configured keeps no handle: resolve refuses the write', async () => {
    await read({ ok: true, value: [shopify({ shop: '' })] })
    expect(await row(SHOP)).toMatchObject({ shop: null, connected_at_ms: HUB_GEN })
    const facts = await outboxFacts({ db, hubAccounts: async () => [{ accountId: SHOP, paused: false, label: 'Shopify' }] }).resolveFacts(6_000)
    expect(await resolve(facts, { operation: 'shopify.order.tag_add', args: { orderIds: ['gid://shopify/Order/1'], tags: ['a'] } })).toMatchObject({ refuse: { reason: 'account_unavailable' } })
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

  it('the binding\'s answer is copied out and its disposer run; an answer that isn\'t data answers no account', async () => {
    const dispose = (Symbol as unknown as { dispose?: symbol }).dispose
    if (dispose === undefined) return
    let disposed = 0
    const answer = { ok: true, value: [shopify()], [dispose]: () => { disposed++ } }
    expect(await read(answer)).toEqual([{ accountId: SHOP, paused: false, label: 'Shopify' }])
    expect(disposed).toBe(1)
    expect(await read({ ok: true, value: [shopify()], stub: () => 1 })).toEqual([])
  })
})

// Stage 1 M3-S2 (N21): the write store's currency, copied as the handle is. Ways it can fail, written first: a refund
// resolves in a currency the hub never named; an odd value from the hub is kept; a passing failure to read it flips refunds
// off (and writes a line) on every request; a store change keeps the old store's currency.
describe('the shop\'s currency (M3-S2)', () => {
  const REFUND = { orderId: 'gid://shopify/Order/1', lines: [{ lineItemId: 'gid://shopify/LineItem/1', quantity: 1 }], amount: { minor: 100, currency: 'USD' }, restock: false, notifyCustomer: false }
  const resolveRefund = async () => {
    const facts = await outboxFacts({ db, hubAccounts: async () => [{ accountId: SHOP, paused: false, label: 'Shopify' }] }).resolveFacts(6_000)
    return { facts, r: await resolve(facts, { operation: 'shopify.refund.create', args: REFUND }) }
  }

  it('copies the hub\'s currency; a refund in it resolves, in another it\'s invalid_args', async () => {
    await read({ ok: true, value: [shopify({ currency: 'USD' })] })
    expect(await row(SHOP)).toMatchObject({ shop: 'example-write', currency: 'USD', rev: 1 })
    const { facts, r } = await resolveRefund()
    expect(facts.accounts.shopify).toMatchObject({ currency: 'USD' })
    expect(r).toMatchObject({ units: 100, scope: { shop: 'example-write' } })
    expect(await resolve(facts, { operation: 'shopify.refund.create', args: { ...REFUND, amount: { minor: 100, currency: 'EUR' } } }))
      .toEqual({ refuse: { verdict: 'refuse', reason: 'invalid_args' } })
  })

  it('no currency, or an odd one, refuses every refund (account_unavailable); the other operations resolve', async () => {
    for (const currency of [undefined, 'usd', 'US$']) {
      await db.prepare('DELETE FROM connector_accounts').run()
      await read({ ok: true, value: [shopify(currency === undefined ? {} : { currency })] })
      expect(await row(SHOP)).toMatchObject({ currency: null })
      const { facts, r } = await resolveRefund()
      expect(r).toEqual({ refuse: { verdict: 'refuse', reason: 'account_unavailable' } })
      expect(await resolve(facts, { operation: 'shopify.order.tag_add', args: { orderIds: ['gid://shopify/Order/1'], tags: ['a'] } })).toMatchObject({ accountGen: HUB_GEN })
    }
  })

  it('a read that names none keeps the stored currency for the same store and generation, writing nothing', async () => {
    await read({ ok: true, value: [shopify({ currency: 'USD' })] })
    const mark = await lastLineId(db)
    await read({ ok: true, value: [shopify()] }, 9_000)
    expect(await row(SHOP)).toMatchObject({ currency: 'USD', rev: 1 })
    expect(await linesSince(db, mark)).toEqual([])
    // The hub names another currency: copied.
    await read({ ok: true, value: [shopify({ currency: 'CAD' })] }, 10_000)
    expect(await row(SHOP)).toMatchObject({ currency: 'CAD', rev: 2 })
  })

  it('another store or a new generation takes the hub\'s word as it is: none until it reads the new store\'s', async () => {
    await read({ ok: true, value: [shopify({ currency: 'USD' })] })
    await read({ ok: true, value: [shopify({ shop: 'other-store' })] }, 9_000)
    expect(await row(SHOP)).toMatchObject({ shop: 'other-store', currency: null })
    await read({ ok: true, value: [shopify({ shop: 'other-store', currency: 'EUR' })] }, 10_000)
    await read({ ok: true, value: [shopify({ shop: 'other-store', connectedAtMs: HUB_GEN + 5 })] }, 11_000)
    expect(await row(SHOP)).toMatchObject({ connected_at_ms: HUB_GEN + 5, currency: null })
  })
})
