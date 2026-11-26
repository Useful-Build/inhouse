// Stage 1 M2-C (N13) Node tests for WriteGateway, Shopify write (ShopifyWriteCore), and Slack outbox posting.
// Proves:
// 1. Unknown operations and malformed requests are refused with `sent: 'no'`.
// 2. ReadGateway (`listReadyTools` / `callReadyTool`) lists reads only and refuses writes.
// 3. With no Shopify write credentials, the answer is `not_configured` (`sent: 'no'`), never falling back to the read token.
// 4. Paused account and changed `connectedAtMs` are refused with `sent: 'no'`, including when the change lands during an awaited step.
// 5. Each Shopify write fault switch (`succeed`, `refuse`, `timeout`, `broken_body`) maps to ok, definite refusal (`sent: 'no'`), or unknown (`sent: 'unknown'`).
// 6. Slack outbox posts reuse `postToSlack` (bounds, single escape, channel re-check, fixed params) and return safe refs only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountStatus, CallerScope, HubResult, WriteRequest } from '../index/contract'
import { WriteResultSchema } from '../index/schemas'
import { ok } from '../index/errors'
import { parseKeyRing } from '../crypto/keyring'
import { connectors } from '../connectors/index'
import { buildRegistry, callReadyTool, listReadyTools } from '../registry/registry'
import { MemStore, ringJson, START_MS } from '../signin/testing/kit'
import { ShopifyWriteCore } from '../connectors/shopify/write/core'
import {
  parseShopifyWriteConfig,
  SHOPIFY_WRITE_ACCOUNT,
} from '../connectors/shopify/write/provider'
import { postSlackOutboxAction, type SlackOutboxStub } from '../connectors/slack/outbox'
import { connectSlack, deliveryWorld, SLACK } from '../connectors/slack/testing/kit'
import {
  createShopifyWriteUpstream,
  SHOPIFY_WRITE_SHOP,
  SHOPIFY_WRITE_TEST_CLIENT_ID,
  SHOPIFY_WRITE_TEST_CLIENT_SECRET,
} from '../../test/upstreams/shopify/write/server'
import { runWriteAction, type WriteGatewayDeps } from './gateway'

const CONNECTED_AT_MS = START_MS

const makeAccountStatus = (overrides: Partial<AccountStatus> = {}): AccountStatus => ({
  accountId: SHOPIFY_WRITE_ACCOUNT,
  state: 'active',
  kid: 'k1',
  expiresAt: { iso: new Date(START_MS + 3600_000).toISOString(), ms: START_MS + 3600_000 },
  scopes: ['read_orders'],
  lastError: null,
  paused: false,
  kind: 'client_credentials',
  connectedBy: null,
  connectedAt: { iso: new Date(CONNECTED_AT_MS).toISOString(), ms: CONNECTED_AT_MS },
  revokeFailedAt: null,
  needsReconnect: false,
  ...overrides,
})

const baseShopifyReq = (overrides: Partial<WriteRequest> = {}): WriteRequest => ({
  actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA',
  attempt: 1,
  requestId: 'req-write-1',
  accountId: SHOPIFY_WRITE_ACCOUNT,
  expect: { connectedAtMs: CONNECTED_AT_MS },
  operation: 'shopify.order.tag_add',
  args: { orderId: 'gid://shopify/Order/9001', tags: ['priority', 'rush'] },
  ...overrides,
})

const baseSlackReq = (overrides: Partial<WriteRequest> = {}): WriteRequest => ({
  actionId: 'ac_BBBBBBBBBBBBBBBBBBBBBB',
  attempt: 1,
  requestId: 'req-write-2',
  accountId: SLACK,
  expect: { connectedAtMs: 0 },
  operation: 'slack.channel.post',
  args: { channelId: 'C0TEST0001', text: 'Order #9001 tagged priority' },
  ...overrides,
})

let logs: string[] = []
beforeEach(() => {
  logs = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)))
})
afterEach(() => vi.restoreAllMocks())

function shopifyWorld(opts: {
  configured?: boolean
  status?: () => Promise<HubResult<AccountStatus>>
  upstreamWrap?: (inner: (req: Request) => Promise<Response>) => (req: Request) => Promise<Response>
} = {}) {
  const store = new MemStore()
  const fake = createShopifyWriteUpstream()
  let now = START_MS
  const ring = parseKeyRing(ringJson(['k1'], 'k1'))
  const config = opts.configured === false
    ? null
    : { shop: SHOPIFY_WRITE_SHOP, clientId: SHOPIFY_WRITE_TEST_CLIENT_ID, clientSecret: SHOPIFY_WRITE_TEST_CLIENT_SECRET }
  const upstreamFn = opts.upstreamWrap ? opts.upstreamWrap(fake.fetch) : fake.fetch
  const core = new ShopifyWriteCore({
    store,
    now: () => now,
    upstream: async () => upstreamFn,
    keyring: async () => ring,
    config: () => config,
    accountStatus: opts.status ?? (async () => ok(makeAccountStatus())),
  })
  const deps: WriteGatewayDeps = {
    shopifyOrderTagAdd: input => core.orderTagAdd(input),
    slackChannelPost: async () => ({ ok: false, error: { code: 'not_configured', message: 'connector not configured' }, sent: 'no' }),
    now: () => now,
  }
  return { store, fake, core, deps, setNow: (ms: number) => { now = ms } }
}

describe('WriteGateway schema & operation checks', () => {
  it('refuses unknown operations with unknown_tool and sent: no', async () => {
    const w = shopifyWorld()
    for (const op of ['shopify.order.refund', 'shopify.order.cancel', 'slack.dm.send', 'orders_update']) {
      const r = await runWriteAction(w.deps, { ...baseShopifyReq(), operation: op as never })
      expect(WriteResultSchema.safeParse(r).success).toBe(true)
      expect(r).toMatchObject({ ok: false, error: { code: 'unknown_tool' }, sent: 'no' })
    }
    expect(w.fake.requests).toEqual([])
  })

  it('refuses malformed requests with invalid_args and sent: no', async () => {
    const w = shopifyWorld()
    const bads: unknown[] = [
      null,
      'shopify.order.tag_add',
      {},
      { ...baseShopifyReq(), attempt: 0 },
      { ...baseShopifyReq(), attempt: 1.5 },
      { ...baseShopifyReq(), actionId: '' },
      { ...baseShopifyReq(), accountId: 'Bad Account' },
      { ...baseShopifyReq(), expect: { connectedAtMs: -1 } },
      { ...baseShopifyReq(), extraField: true },
      { ...baseShopifyReq(), args: { orderId: '1234', tags: ['a'] } },
      { ...baseShopifyReq(), args: { orderId: 'gid://shopify/Order/9001', tags: [] } },
      { ...baseShopifyReq(), args: { orderId: 'gid://shopify/Order/9001', tags: ['1', '2', '3', '4', '5', '6'] } },
      { ...baseShopifyReq(), args: { orderId: 'gid://shopify/Order/9001', tags: ['bad,tag'] } },
      { ...baseShopifyReq(), args: { orderId: 'gid://shopify/Order/9001', tags: ['ok'], extra: 1 } },
      { ...baseShopifyReq(), accountId: SLACK },
    ]
    for (const bad of bads) {
      const r = await runWriteAction(w.deps, bad as WriteRequest)
      expect(WriteResultSchema.safeParse(r).success, JSON.stringify(bad)).toBe(true)
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: 'invalid_args' }, sent: 'no' })
    }
    expect(w.fake.requests).toEqual([])
  })
})

describe('ReadGateway isolation', () => {
  it('ReadGateway.listTools returns reads only and callTool refuses write operations', async () => {
    const registry = buildRegistry(connectors)
    const scope: CallerScope = { kind: 'run', runId: 'r1', principalId: 'p1', requestId: 'req-1' }
    let shopifyCalls = 0
    let mcpCalls = 0
    const deps = {
      registry,
      isConfigured: () => true,
      isReady: async () => ({ ready: true as const, policies: [] }),
      shopifyFor: () => ({
        graphql: async () => {
          shopifyCalls++
          return ok({ data: {} })
        },
      }),
      mcpFor: () => ({
        call: async () => {
          mcpCalls++
          return ok({ content: [] })
        },
      }),
      nowMs: () => START_MS,
    }
    const listed = await listReadyTools(deps)
    const names = listed.map(t => t.name)
    expect(names).not.toContain('shopify_order_tag_add')
    expect(names).not.toContain('shopify.order.tag_add')
    expect(names).not.toContain('slack_channel_post')
    expect(names).not.toContain('slack.channel.post')

    for (const writeName of ['shopify_order_tag_add', 'shopify.order.tag_add', 'slack_channel_post', 'slack.channel.post']) {
      const r = await callReadyTool(deps, scope, writeName, {})
      expect(r).toMatchObject({ ok: false, error: { code: 'unknown_tool' } })
    }
    expect(shopifyCalls + mcpCalls).toBe(0)
  })
})

describe('Shopify write credentials & isolation', () => {
  it('parseShopifyWriteConfig ignores read app credentials and returns null when write creds are absent', () => {
    expect(
      parseShopifyWriteConfig({
        // Read app vars present, write app vars absent.
        SHOPIFY_SHOP: 'example-fixture',
        SHOPIFY_CLIENT_ID: 'test-client',
        SHOPIFY_CLIENT_SECRET: 'test-secret',
      } as Record<string, string>),
    ).toBeNull()
    expect(
      parseShopifyWriteConfig({
        SHOPIFY_WRITE_SHOP: '',
        SHOPIFY_WRITE_CLIENT_ID: '',
        SHOPIFY_WRITE_CLIENT_SECRET: '',
      }),
    ).toBeNull()
    expect(
      parseShopifyWriteConfig({
        SHOPIFY_WRITE_SHOP: SHOPIFY_WRITE_SHOP,
        SHOPIFY_WRITE_CLIENT_ID: SHOPIFY_WRITE_TEST_CLIENT_ID,
        SHOPIFY_WRITE_CLIENT_SECRET: SHOPIFY_WRITE_TEST_CLIENT_SECRET,
      }),
    ).toEqual({
      shop: SHOPIFY_WRITE_SHOP,
      clientId: SHOPIFY_WRITE_TEST_CLIENT_ID,
      clientSecret: SHOPIFY_WRITE_TEST_CLIENT_SECRET,
    })
  })

  it('with no write credentials, answers not_configured with sent: no and makes zero upstream calls', async () => {
    const w = shopifyWorld({ configured: false })
    const r = await runWriteAction(w.deps, baseShopifyReq())
    expect(r).toMatchObject({ ok: false, error: { code: 'not_configured' }, sent: 'no' })
    expect(w.fake.requests).toEqual([])
  })

  it('refuses when write app token lacks write_orders scope (sent: no, zero mutations)', async () => {
    const w = shopifyWorld()
    w.fake.scope = ['read_orders']
    const r = await runWriteAction(w.deps, baseShopifyReq())
    expect(r).toMatchObject({ ok: false, error: { code: 'scope_mismatch' }, sent: 'no' })
    expect(w.fake.writes).toEqual([])
  })
})

describe('Shopify write account checks (before and during awaited steps)', () => {
  it('refuses a paused account with sent: no and zero upstream calls', async () => {
    const w = shopifyWorld({ status: async () => ok(makeAccountStatus({ paused: true })) })
    const r = await runWriteAction(w.deps, baseShopifyReq())
    expect(r).toMatchObject({ ok: false, error: { code: 'paused' }, sent: 'no' })
    expect(w.fake.requests).toEqual([])
  })

  it('refuses a changed connectedAtMs with sent: no and zero upstream calls', async () => {
    const w = shopifyWorld({
      status: async () => ok(makeAccountStatus({ connectedAt: { iso: new Date(CONNECTED_AT_MS + 1000).toISOString(), ms: CONNECTED_AT_MS + 1000 } })),
    })
    const r = await runWriteAction(w.deps, baseShopifyReq())
    expect(r).toMatchObject({ ok: false, error: { code: 'connect_stale' }, sent: 'no' })
    expect(w.fake.requests).toEqual([])
  })

  it('refuses with sent: no if account becomes paused during the token grant await (zero write mutations)', async () => {
    let paused = false
    const w = shopifyWorld({
      status: async () => ok(makeAccountStatus({ paused })),
      upstreamWrap: inner => async req => {
        const res = await inner(req)
        if (new URL(req.url).pathname === '/admin/oauth/access_token') paused = true
        return res
      },
    })
    const r = await runWriteAction(w.deps, baseShopifyReq())
    expect(r).toMatchObject({ ok: false, error: { code: 'paused' }, sent: 'no' })
    expect(w.fake.writes).toEqual([])
    expect(w.fake.orders.get('gid://shopify/Order/9001')!.tags).toEqual(['existing'])
  })

  it('refuses with sent: no if connectedAtMs changes during the token grant await (zero write mutations)', async () => {
    let connectedAtMs = CONNECTED_AT_MS
    const w = shopifyWorld({
      status: async () => ok(makeAccountStatus({ connectedAt: { iso: new Date(connectedAtMs).toISOString(), ms: connectedAtMs } })),
      upstreamWrap: inner => async req => {
        const res = await inner(req)
        if (new URL(req.url).pathname === '/admin/oauth/access_token') connectedAtMs = CONNECTED_AT_MS + 5000
        return res
      },
    })
    const r = await runWriteAction(w.deps, baseShopifyReq())
    expect(r).toMatchObject({ ok: false, error: { code: 'connect_stale' }, sent: 'no' })
    expect(w.fake.writes).toEqual([])
  })
})

describe('Shopify write fault switches', () => {
  it('succeed: adds tags, returns safe ref only, logs no args or tokens', async () => {
    const w = shopifyWorld()
    const r = await runWriteAction(w.deps, baseShopifyReq())
    expect(WriteResultSchema.safeParse(r).success).toBe(true)
    expect(r).toEqual({ ok: true, value: { ref: 'order 9001: priority, rush' } })
    expect(w.fake.orders.get('gid://shopify/Order/9001')!.tags).toEqual(['existing', 'priority', 'rush'])
    expect(w.fake.writes).toHaveLength(1)
    expect(logs.join('\n')).not.toMatch(/shpat_|priority|rush|9001/)
  })

  it('refuse: returns upstream_rejected with sent: no and leaves order unchanged', async () => {
    const w = shopifyWorld()
    w.fake.faults['shopify.order.tag_add'] = 'refuse'
    const r = await runWriteAction(w.deps, baseShopifyReq())
    expect(WriteResultSchema.safeParse(r).success).toBe(true)
    expect(r).toMatchObject({ ok: false, error: { code: 'upstream_rejected' }, sent: 'no' })
    expect(w.fake.orders.get('gid://shopify/Order/9001')!.tags).toEqual(['existing'])
    expect(w.fake.writes).toHaveLength(1)
  })

  it('timeout: returns upstream_unavailable with sent: unknown and does not retry', async () => {
    const w = shopifyWorld()
    w.fake.faults['shopify.order.tag_add'] = 'timeout'
    const r = await runWriteAction(w.deps, baseShopifyReq())
    expect(WriteResultSchema.safeParse(r).success).toBe(true)
    expect(r).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' }, sent: 'unknown' })
    expect(w.fake.writes).toHaveLength(1)
  })

  it('broken_body: returns upstream_unavailable with sent: unknown', async () => {
    const w = shopifyWorld()
    w.fake.faults['shopify.order.tag_add'] = 'broken_body'
    const r = await runWriteAction(w.deps, baseShopifyReq())
    expect(WriteResultSchema.safeParse(r).success).toBe(true)
    expect(r).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' }, sent: 'unknown' })
    expect(w.fake.writes).toHaveLength(1)
  })

  it('unknown order id: returns upstream_rejected with sent: no', async () => {
    const w = shopifyWorld()
    const r = await runWriteAction(
      w.deps,
      baseShopifyReq({ args: { orderId: 'gid://shopify/Order/999999', tags: ['test'] } }),
    )
    expect(r).toMatchObject({ ok: false, error: { code: 'upstream_rejected' }, sent: 'no' })
  })
})

describe('Slack outbox operation (slack.channel.post)', () => {
  async function slackOutboxWorld() {
    const w = deliveryWorld()
    await connectSlack(w)
    const status = await w.core.accountStatus(SLACK)
    if (!status.ok || !status.value.connectedAt) throw new Error('expected connected Slack account')
    const connectedAtMs = status.value.connectedAt.ms
    const stub: SlackOutboxStub = {
      status: id => w.core.accountStatus(id),
      slackChannelInfo: (id, ch) => w.core.slackChannelInfo(id, ch),
      slackPost: (id, req) => w.core.slackPost(id, req),
    }
    const deps: WriteGatewayDeps = {
      shopifyOrderTagAdd: async () => ({ ok: false, error: { code: 'not_configured', message: 'connector not configured' }, sent: 'no' }),
      slackChannelPost: input => postSlackOutboxAction(stub, input),
    }
    return { w, stub, deps, connectedAtMs }
  }

  it('posts through postToSlack (escaping once, stripping links, fixed params) and returns safe ref', async () => {
    const { w, deps, connectedAtMs } = await slackOutboxWorld()
    const r = await runWriteAction(
      deps,
      baseSlackReq({
        expect: { connectedAtMs },
        args: { channelId: 'C0TEST0001', text: 'R&D check https://evil.example.com @here <@U1>' },
      }),
    )
    expect(WriteResultSchema.safeParse(r).success).toBe(true)
    expect(r).toMatchObject({ ok: true, value: { ref: expect.stringMatching(/^#ops-alerts \(\d+\.\d+\)$/) } })
    expect(w.web.violations).toEqual([])
    expect(w.web.posts).toHaveLength(1)
    expect(w.web.posts[0]!.text).toBe('*Inhouse*\nR&amp;D check [link removed] here &lt;@U1&gt;')
    expect(w.web.posts[0]!.unfurl_links).toBe('false')
    expect(w.web.posts[0]!.unfurl_media).toBe('false')
  })

  it('refuses paused account and changed connectedAtMs with sent: no (before and during awaited channel check)', async () => {
    const { w, stub, deps, connectedAtMs } = await slackOutboxWorld()
    // Wrong connectedAtMs
    const stale = await runWriteAction(deps, baseSlackReq({ expect: { connectedAtMs: connectedAtMs + 1 } }))
    expect(stale).toMatchObject({ ok: false, error: { code: 'connect_stale' }, sent: 'no' })
    expect(w.web.posts).toEqual([])

    // Paused before call
    await w.core.setPaused(SLACK, true)
    const pausedRes = await runWriteAction(deps, baseSlackReq({ expect: { connectedAtMs } }))
    expect(pausedRes).toMatchObject({ ok: false, error: { code: 'paused' }, sent: 'no' })
    expect(w.web.posts).toEqual([])
    await w.core.setPaused(SLACK, false)

    // Paused DURING the awaited slackChannelInfo call
    const raceStub: SlackOutboxStub = {
      status: id => stub.status(id),
      slackChannelInfo: async (id, ch) => {
        const res = await stub.slackChannelInfo(id, ch)
        await w.core.setPaused(SLACK, true)
        return res
      },
      slackPost: (id, req) => stub.slackPost(id, req),
    }
    const raceRes = await postSlackOutboxAction(raceStub, {
      accountId: SLACK,
      expect: { connectedAtMs },
      args: { channelId: 'C0TEST0001', text: 'Should not send' },
    })
    expect(raceRes).toMatchObject({ ok: false, error: { code: 'paused' }, sent: 'no' })
    expect(w.web.posts).toEqual([])
  })

  it('refuses shared, archived, private, non-member, and unknown channels with sent: no', async () => {
    const { w, deps, connectedAtMs } = await slackOutboxWorld()
    for (const [channelId, code] of [
      ['C0TEST0003', 'connect_refused'],
      ['C0TEST0004', 'connect_refused'],
      ['C0TEST0005', 'connect_refused'],
      ['C0TEST0006', 'connect_refused'],
      ['C0TEST9999', 'connect_refused'],
      ['D0TEST0001', 'invalid_args'],
    ] as const) {
      const r = await runWriteAction(deps, baseSlackReq({ expect: { connectedAtMs }, args: { channelId, text: 'hi' } }))
      expect(r, channelId).toMatchObject({ ok: false, error: { code }, sent: 'no' })
    }
    expect(w.web.posts).toEqual([])
  })

  it('maps definite Slack post refusal to sent: no and lost answer (throwNextPost) to sent: unknown', async () => {
    const { w, deps, connectedAtMs } = await slackOutboxWorld()
    w.web.failNextPost = 'restricted_action'
    const refused = await runWriteAction(deps, baseSlackReq({ expect: { connectedAtMs } }))
    expect(refused).toMatchObject({ ok: false, error: { code: 'upstream_rejected' }, sent: 'no' })

    w.web.throwNextPost = true
    const lost = await runWriteAction(deps, baseSlackReq({ expect: { connectedAtMs } }))
    expect(lost).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' }, sent: 'unknown' })
    expect(w.web.posts).toHaveLength(1)
  })
})
