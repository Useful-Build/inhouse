// Stage 1 M3 (card details, #488) Workers runtime test: `ConnectGateway.cardFacts` through the real runtime's RPC answer
// (the gateway to the write SignIn DO and back) against the fake write store, read as plain data; a run scope and a
// malformed request are refused before anything is read. #574: the deployable hub (INHOUSE_TEST_BUILD off) answers
// `not_configured` at the gateway and at the write SignIn, and asks the store nothing.
import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountStatus, CallerScope, CardFacts, ConnectGateway, HubResult, ReadGateway } from '../index/contract'
import { CardFactsSchema, hubResultSchema } from '../index/schemas'
import { ConnectGateway as ConnectGatewayClass } from './entry'
import { ShopifyWriteSignIn } from '../connectors/shopify/write/signin'
import { SHOPIFY_WRITE_SIGNIN_ACCOUNT } from '../connectors/shopify/write/provider'
import { shopifyWrite } from '../testing/index'

const gw = exports as unknown as { ConnectGateway: Required<ConnectGateway>; ReadGateway: ReadGateway }
const serverScope: CallerScope = { kind: 'server', job: 'card-facts-test', requestId: 'req-cf1' }
const runScope: CallerScope = { kind: 'run', runId: 'run-1', principalId: 'p-1', requestId: 'req-r1' }

beforeEach(async () => {
  await gw.ConnectGateway.testFakes(serverScope, { op: 'reset' })
})

describe('ConnectGateway.cardFacts through Worker exports (workerd)', () => {
  it('reads an order and a variant from the fake write store, and refuses a run scope and a bad request', async () => {
    // Warm the account so `shopify:store` has a connectedAtMs.
    expect((await gw.ReadGateway.callTool(runScope, 'orders_search', { first: 1 })).ok).toBe(true)
    const st = (await env.SIGNIN.get(env.SIGNIN.idFromName('shopify:store')).status('shopify:store')) as HubResult<AccountStatus>
    if (!st.ok || !st.value.connectedAt) throw new Error('expected shopify:store connectedAt')
    const req = {
      accountId: 'shopify:store' as const, expect: { connectedAtMs: st.value.connectedAt.ms, shop: 'example-write' },
      orderIds: ['gid://shopify/Order/9001'], variantIds: ['gid://shopify/ProductVariant/7001'],
    }
    const r = (await gw.ConnectGateway.cardFacts(serverScope, req)) as HubResult<CardFacts>
    expect(hubResultSchema(CardFactsSchema).safeParse(r).success).toBe(true)
    expect(r).toEqual({
      ok: true,
      value: {
        orders: [{ id: 'gid://shopify/Order/9001', found: true, name: '#9001', customer: 'Alex Moore', total: { amount: '642.10', currencyCode: 'USD' } }],
        variants: [{ id: 'gid://shopify/ProductVariant/7001', found: true, product: 'Linen shirt', variant: 'M', sku: 'LIN-M' }],
      },
    })
    expect(await gw.ConnectGateway.cardFacts(runScope, req)).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await gw.ConnectGateway.cardFacts(serverScope, { ...req, orderIds: ['gid://shopify/Customer/1'] })).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
  })

  it('#574: with INHOUSE_TEST_BUILD off (deployable mode), the gateway and the write SignIn answer not_configured and read nothing', async () => {
    const { INHOUSE_TEST_BUILD: _flag, ...off } = env as Env & { INHOUSE_TEST_BUILD?: string }
    const req = {
      accountId: 'shopify:store' as const, expect: { connectedAtMs: 1, shop: 'example-write' },
      orderIds: ['gid://shopify/Order/9001'], variantIds: ['gid://shopify/ProductVariant/7001'],
    }
    const before = shopifyWrite.requests.length
    const gate = new ConnectGatewayClass(createExecutionContext(), off as Env)
    expect(await gate.cardFacts(serverScope, req)).toMatchObject({ ok: false, error: { code: 'not_configured' } })
    const ns = env.SHOPIFY_WRITE_SIGNIN
    const viaSignIn = await runInDurableObject(ns.get(ns.idFromName(SHOPIFY_WRITE_SIGNIN_ACCOUNT)), (_i, state) =>
      new ShopifyWriteSignIn(state, off as Env).cardFacts(req))
    expect(viaSignIn).toMatchObject({ ok: false, error: { code: 'not_configured' } })
    // Nothing reached the fake write store: no token grant, no query.
    expect(shopifyWrite.requests.length).toBe(before)
    expect(shopifyWrite.reads).toEqual([])
  })
})
