// The two operations (N9) as `resolve` uses them. Ways it can fail: an argument outside the hub's strict shape gets
// through (a sixth tag, a comma in a tag, an order that isn't an order id, an extra key); a Slack post keeps a link or
// a control character, or is cut instead of refused; an unlisted channel resolves; the table's tool names drift.
import { describe, expect, it } from 'vitest'
import { TEXT_MAX } from '../../../shared/notify/bound.ts'
import { auditInputSha256 } from '../../../shared/protocol/index.ts'
import { resolve } from '../../permissions/resolve.ts'
import type { ResolveFacts } from '../../permissions/types.ts'
import { OPERATIONS, operationForTool } from './index.ts'
import { TagAddArgsSchema } from './shopify-order-tag-add.ts'
import { PostArgsSchema } from './slack-channel-post.ts'

const facts: ResolveFacts = {
  nowMs: 1,
  accounts: {
    shopify: { accountId: 'shopify:store', connectedAtMs: 10, connected: true, paused: false, label: 'Shopify (Store A)', shop: 'store-a' },
    slack: { accountId: 'slack:workspace', connectedAtMs: 20, connected: true, paused: false, label: 'Slack', shop: null },
  },
  listedChannels: [{ id: 'C0123ABCD', name: 'Ops' }],
}

describe('shopify.order.tag_add', () => {
  const ok = (a: unknown) => TagAddArgsSchema.safeParse(a).success
  it('takes one order and 1 to 5 distinct clean tags, nothing else', async () => {
    expect(ok({ orderId: 'gid://shopify/Order/42', tags: ['vip', 'gift'] })).toBe(true)
    expect(ok({ orderId: 'gid://shopify/Order/42', tags: [] })).toBe(false)
    expect(ok({ orderId: 'gid://shopify/Order/42', tags: ['a', 'b', 'c', 'd', 'e', 'f'] })).toBe(false)
    expect(ok({ orderId: 'gid://shopify/Order/42', tags: ['vip', 'VIP'] })).toBe(false)
    expect(ok({ orderId: 'gid://shopify/Order/42', tags: ['a,b'] })).toBe(false)
    expect(ok({ orderId: 'gid://shopify/Order/42', tags: [' vip'] })).toBe(false)
    expect(ok({ orderId: 'gid://shopify/Order/42', tags: ['v\u202eip'] })).toBe(false)
    expect(ok({ orderId: 'gid://shopify/Order/42', tags: ['x'.repeat(41)] })).toBe(false)
    expect(ok({ orderId: 'gid://shopify/Customer/42', tags: ['vip'] })).toBe(false)
    expect(ok({ orderId: '42', tags: ['vip'] })).toBe(false)
    expect(ok({ orderId: 'gid://shopify/Order/42', tags: ['vip'], shop: 'other' })).toBe(false)
  })
  it('resolves to the connected shop, one record, and its card in server words', async () => {
    const r = await resolve(facts, { operation: 'shopify.order.tag_add', args: { orderId: 'gid://shopify/Order/42', tags: ['vip'] } })
    expect(r).toMatchObject({ accountId: 'shopify:store', accountGen: 10, scope: { shop: 'store-a' }, scopeKey: 'shop=store-a', records: 1, units: 1 })
    expect(OPERATIONS['shopify.order.tag_add'].card({ orderId: 'gid://shopify/Order/42', tags: ['vip', 'gift'] }, facts)).toEqual({ title: 'Add 2 tags to order 42', lines: ['Tag: vip', 'Tag: gift'] })
  })
  it('refuses an account that is gone, paused or has no shop', async () => {
    for (const shopify of [null, { ...facts.accounts.shopify!, paused: true }, { ...facts.accounts.shopify!, connected: false }, { ...facts.accounts.shopify!, shop: null }, { ...facts.accounts.shopify!, connectedAtMs: null }]) {
      expect(await resolve({ ...facts, accounts: { ...facts.accounts, shopify } }, { operation: 'shopify.order.tag_add', args: { orderId: 'gid://shopify/Order/42', tags: ['vip'] } }))
        .toEqual({ refuse: { verdict: 'refuse', reason: 'account_unavailable' } })
    }
  })
})

describe('slack.channel.post', () => {
  it('cleans the text as notification_send does: links removed, control characters stripped; parsing again changes nothing', async () => {
    const once = PostArgsSchema.parse({ channel: '#ops', text: 'See https://evil.example now\u200b' })
    expect(once.text).toBe('See [link removed] now')
    expect(PostArgsSchema.parse(once)).toEqual(once)
  })
  it('refuses an empty or too long text, never cuts it', async () => {
    expect(PostArgsSchema.safeParse({ channel: 'ops', text: '\u200b' }).success).toBe(false)
    expect(PostArgsSchema.safeParse({ channel: 'ops', text: 'x'.repeat(TEXT_MAX + 1) }).success).toBe(false)
    expect(PostArgsSchema.safeParse({ channel: 'ops', text: 'x'.repeat(TEXT_MAX) }).success).toBe(true)
  })
  it('maps a listed channel by name or id to its id, and refuses an unlisted one', async () => {
    for (const channel of ['#ops', 'OPS', 'C0123ABCD']) {
      expect(await resolve(facts, { operation: 'slack.channel.post', args: { channel, text: 'hi' } })).toMatchObject({ scope: { channelId: 'C0123ABCD' }, scopeKey: 'channelId=C0123ABCD', accountGen: 20 })
    }
    expect(await resolve(facts, { operation: 'slack.channel.post', args: { channel: '#general', text: 'hi' } })).toEqual({ refuse: { verdict: 'refuse', reason: 'not_listed' } })
    expect(OPERATIONS['slack.channel.post'].card({ channel: 'ops', text: 'hi' }, facts)).toEqual({ title: 'Post to #Ops in Slack', lines: ['hi'] })
  })
  // M2-N: notification_send's headline rides along as `title`. Ways it can fail: a title keeps a link or a line break, is
  // cut instead of refused, changes an untitled post's arguments or hash, or doesn't reach the card.
  it('takes an optional one-line title, cleaned and refused over 120 characters; without one the arguments are as before', async () => {
    const titled = PostArgsSchema.parse({ channel: '#ops', title: 'Low\nstock https://evil.example', text: 'a\nb' })
    expect(titled).toEqual({ channel: '#ops', title: 'Low stock [link removed]', text: 'a\nb' })
    expect(PostArgsSchema.parse(titled)).toEqual(titled)
    expect(PostArgsSchema.safeParse({ channel: 'ops', title: 'x'.repeat(121), text: 'hi' }).success).toBe(false)
    expect(PostArgsSchema.safeParse({ channel: 'ops', title: '\u200b', text: 'hi' }).success).toBe(false)
    expect(PostArgsSchema.parse({ channel: '#ops', text: 'hi' })).toEqual({ channel: '#ops', text: 'hi' })
    expect(OPERATIONS['slack.channel.post'].card(titled, facts)).toEqual({ title: 'Post to #Ops in Slack', lines: ['Low stock [link removed]', 'a\nb'] })
    const plain = await resolve(facts, { operation: 'slack.channel.post', args: { channel: '#ops', text: 'hi' } })
    const withTitle = await resolve(facts, { operation: 'slack.channel.post', args: { channel: '#ops', text: 'hi', title: 'T' } })
    expect((plain as { payloadHash: string }).payloadHash).toBe(await auditInputSha256({ scope: { channelId: 'C0123ABCD' }, operation: 'slack.channel.post', args: { channel: '#ops', text: 'hi' }, accountGen: 20, accountId: 'slack:workspace' }))
    expect((withTitle as { payloadHash: string }).payloadHash).not.toBe((plain as { payloadHash: string }).payloadHash)
  })
})

describe('the table', () => {
  it('names each operation by its tool, and nothing else', async () => {
    expect(operationForTool('shopify_order_tag_add')).toBe('shopify.order.tag_add')
    expect(operationForTool('slack_channel_post')).toBe('slack.channel.post')
    expect(operationForTool('notification_send')).toBeNull()
    for (const e of Object.values(OPERATIONS)) expect(e).toMatchObject({ idempotent: false, defaultPerDay: 50, memberMay: true, effects: { money: false, customer: false, destructive: false, access: false } })
  })
  it('gives the same payload hash for the same action and another for any change', async () => {
    const a = await resolve(facts, { operation: 'slack.channel.post', args: { channel: '#ops', text: 'hi' } })
    const b = await resolve(facts, { operation: 'slack.channel.post', args: { channel: 'OPS', text: 'hi' } })
    const c = await resolve(facts, { operation: 'slack.channel.post', args: { channel: '#ops', text: 'hi!' } })
    const d = await resolve({ ...facts, accounts: { ...facts.accounts, slack: { ...facts.accounts.slack!, connectedAtMs: 21 } } }, { operation: 'slack.channel.post', args: { channel: '#ops', text: 'hi' } })
    const hash = (x: unknown) => (x as { payloadHash: string }).payloadHash
    expect(hash(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set([hash(a), hash(c), hash(d)]).size).toBe(3)
    // The channel as the agent wrote it is part of the arguments: "#ops" and "OPS" are two payloads for one scope.
    expect(hash(b)).not.toBe(hash(a))
  })
  it('hashes the canonical JSON of operation, account, generation, scope and parsed arguments, as the egress does', async () => {
    const r = await resolve(facts, { operation: 'slack.channel.post', args: { text: 'hi', channel: '#ops' } })
    expect((r as { payloadHash: string }).payloadHash).toBe(await auditInputSha256({ scope: { channelId: 'C0123ABCD' }, operation: 'slack.channel.post', args: { channel: '#ops', text: 'hi' }, accountGen: 20, accountId: 'slack:workspace' }))
  })
})
