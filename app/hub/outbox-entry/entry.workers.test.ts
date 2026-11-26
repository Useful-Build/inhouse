// Stage 1 M2-C (N13) Workers runtime tests for WriteGateway through `exports.WriteGateway` on workerd (test config).
// Verifies end-to-end RPC over ShopifyWriteSignIn DO and SignIn DO against the fake upstreams, plus ReadGateway isolation
// and Stage 1 deployable-mode refusal when INHOUSE_TEST_BUILD is off.
import { createExecutionContext, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountStatus, CallerScope, ConnectGateway, HubResult, ReadGateway, ToolInfo, WriteGateway, WriteRequest } from '../index/contract'
import { WriteResultSchema } from '../index/schemas'
import { mintTestCode } from '../../test/upstreams/mcp/server'
import { WriteGateway as WriteGatewayClass } from './entry'

const gw = exports as unknown as {
  ReadGateway: ReadGateway
  ConnectGateway: Required<ConnectGateway>
  WriteGateway: WriteGateway
}

const serverScope: CallerScope = { kind: 'server', job: 'outbox-test', requestId: 'req-w1' }
const runScope: CallerScope = { kind: 'run', runId: 'run-1', principalId: 'p-1', requestId: 'req-r1' }

beforeEach(async () => {
  await gw.ConnectGateway.testFakes(serverScope, { op: 'reset' })
})

describe('WriteGateway through Worker exports (workerd)', () => {
  it('ReadGateway.listTools still returns reads only and callTool refuses writes', async () => {
    const listed = (await gw.ReadGateway.listTools(runScope)) as HubResult<ToolInfo[]>
    if (!listed.ok) throw new Error(listed.error.code)
    const names = listed.value.map(t => t.name)
    expect(names).not.toContain('shopify_order_tag_add')
    expect(names).not.toContain('slack_channel_post')
    expect(await gw.ReadGateway.callTool(runScope, 'shopify_order_tag_add', {})).toMatchObject({
      ok: false,
      error: { code: 'unknown_tool' },
    })
  })

  it('executes shopify.order.tag_add against the fake write store (never the read fixture) and honors fault switches', async () => {
    // Warm the read account so `shopify:store` has a connectedAtMs.
    const read = await gw.ReadGateway.callTool(runScope, 'orders_search', { first: 1 })
    expect(read.ok).toBe(true)
    const statusRes = (await env.SIGNIN.get(env.SIGNIN.idFromName('shopify:store')).status('shopify:store')) as HubResult<AccountStatus>
    if (!statusRes.ok || !statusRes.value.connectedAt) throw new Error('expected shopify:store connectedAt')
    const connectedAtMs = statusRes.value.connectedAt.ms

    const req: WriteRequest = {
      actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA',
      attempt: 1,
      requestId: 'req-shopify-1',
      accountId: 'shopify:store',
      expect: { connectedAtMs, shop: 'example-write' },
      operation: 'shopify.order.tag_add',
      args: { orderId: 'gid://shopify/Order/9001', tags: ['urgent'] },
    }
    const okRes = await gw.WriteGateway.runAction(req)
    expect(WriteResultSchema.safeParse(okRes).success).toBe(true)
    expect(okRes).toEqual({ ok: true, value: { ref: 'order 9001: urgent' } })

    const state1 = (await gw.ConnectGateway.testFakes(serverScope, { op: 'state' })) as HubResult<{
      shopifyWrite: { orders: { id: string; tags: string[] }[]; writes: unknown[] }
    }>
    if (!state1.ok) throw new Error(state1.error.code)
    expect(state1.value.shopifyWrite.writes).toHaveLength(1)
    expect(state1.value.shopifyWrite.orders.find(o => o.id === 'gid://shopify/Order/9001')!.tags).toEqual(['existing', 'urgent'])

    // Fault switch: refuse -> sent: no
    await gw.ConnectGateway.testFakes(serverScope, { op: 'set', shopifyWrite: { faults: { 'shopify.order.tag_add': 'refuse' } } })
    const refRes = await gw.WriteGateway.runAction({ ...req, attempt: 2 })
    expect(refRes).toMatchObject({ ok: false, error: { code: 'upstream_rejected' }, sent: 'no' })

    // Fault switch: timeout -> sent: unknown
    await gw.ConnectGateway.testFakes(serverScope, { op: 'set', shopifyWrite: { faults: { 'shopify.order.tag_add': 'timeout' } } })
    const toRes = await gw.WriteGateway.runAction({ ...req, attempt: 3 })
    expect(toRes).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' }, sent: 'unknown' })

    // Fault switch: broken_body -> sent: unknown
    await gw.ConnectGateway.testFakes(serverScope, { op: 'set', shopifyWrite: { faults: { 'shopify.order.tag_add': 'broken_body' } } })
    const brokenRes = await gw.WriteGateway.runAction({ ...req, attempt: 4 })
    expect(brokenRes).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' }, sent: 'unknown' })
    // The timeout fault hangs until the hub's real 15 s write deadline aborts it.
  }, 30_000)

  it('executes slack.channel.post against FakeSlackWeb through postToSlack', async () => {
    const started = await gw.ConnectGateway.startConnect(serverScope, { accountId: 'slack:workspace', memberId: 'mem_test_0001' })
    if (!started.ok) throw new Error(started.error.code)
    const { code, state } = await mintTestCode(started.value.authorizeUrl)
    const done = await gw.ConnectGateway.completeConnect(serverScope, { state, code, memberId: 'mem_test_0001' })
    expect(done.ok).toBe(true)

    const statusRes = (await env.SIGNIN.get(env.SIGNIN.idFromName('slack:workspace')).status('slack:workspace')) as HubResult<AccountStatus>
    if (!statusRes.ok || !statusRes.value.connectedAt) throw new Error('expected slack connectedAt')

    const res = await gw.WriteGateway.runAction({
      actionId: 'ac_BBBBBBBBBBBBBBBBBBBBBB',
      attempt: 1,
      requestId: 'req-slack-1',
      accountId: 'slack:workspace',
      expect: { connectedAtMs: statusRes.value.connectedAt.ms },
      operation: 'slack.channel.post',
      args: { channelId: 'C0TEST0001', text: 'Tagged order #9001' },
    })
    expect(WriteResultSchema.safeParse(res).success).toBe(true)
    expect(res).toMatchObject({ ok: true, value: { ref: expect.stringMatching(/^#ops-alerts \(\d+\.\d+\)$/) } })
  })

  it('with INHOUSE_TEST_BUILD off (deployable mode), refuses writes with not_configured and sent: no', async () => {
    const { INHOUSE_TEST_BUILD: _flag, ...off } = env as Env & { INHOUSE_TEST_BUILD?: string }
    const gate = new WriteGatewayClass(createExecutionContext(), off as Env)
    const r = await gate.runAction({
      actionId: 'ac_CCCCCCCCCCCCCCCCCCCCCC',
      attempt: 1,
      requestId: 'req-off-1',
      accountId: 'shopify:store',
      expect: { connectedAtMs: 1, shop: 'example-write' },
      operation: 'shopify.order.tag_add',
      args: { orderId: 'gid://shopify/Order/9001', tags: ['a'] },
    })
    expect(r).toMatchObject({ ok: false, error: { code: 'not_configured' }, sent: 'no' })
  })
})
