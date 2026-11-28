// The operations (N9; M3-S1 adds tag_remove and draft_order.create) as `resolve` uses them. Ways it can fail: an argument outside the hub's strict shape gets
// through (a sixth tag, a comma in a tag, an order that isn't an order id, an extra key); a Slack post keeps a link or
// a control character, or is cut instead of refused; an unlisted channel resolves; the table's tool names drift.
import { describe, expect, it } from 'vitest'
import { TEXT_MAX } from '../../../shared/notify/bound.ts'
import { auditInputSha256 } from '../../../shared/protocol/index.ts'
import { resolve } from '../../permissions/resolve.ts'
import type { ResolveFacts } from '../../permissions/types.ts'
import { OPERATION_LIMITS } from '../../../shared/audit-text.ts'
import { OPERATIONS, grantDefaults, operationForTool } from './index.ts'
import { TagAddArgsSchema, type TagAddArgs } from './shopify-order-tag-add.ts'
import type { OperationEntry } from './types.ts'
import { DraftOrderArgsSchema } from './shopify-draft-order-create.ts'
import { PostArgsSchema } from './slack-channel-post.ts'

const facts: ResolveFacts = {
  nowMs: 1,
  accounts: {
    shopify: { accountId: 'shopify:store', connectedAtMs: 10, connected: true, paused: false, label: 'Shopify (Store A)', shop: 'store-a', currency: null },
    slack: { accountId: 'slack:workspace', connectedAtMs: 20, connected: true, paused: false, label: 'Slack', shop: null, currency: null },
  },
  listedChannels: [{ id: 'C0123ABCD', name: 'Ops' }],
}

describe('shopify.order.tag_add', () => {
  const ok = (a: unknown) => TagAddArgsSchema.safeParse(a).success
  const one = (tags: unknown, extra: object = {}) => ({ orderIds: ['gid://shopify/Order/42'], tags, ...extra })
  it('takes 1 to 100 distinct orders and 1 to 5 distinct clean tags, nothing else', async () => {
    expect(ok(one(['vip', 'gift']))).toBe(true)
    expect(ok(one([]))).toBe(false)
    expect(ok(one(['a', 'b', 'c', 'd', 'e', 'f']))).toBe(false)
    expect(ok(one(['vip', 'VIP']))).toBe(false)
    expect(ok(one(['a,b']))).toBe(false)
    expect(ok(one([' vip']))).toBe(false)
    expect(ok(one(['v\u202eip']))).toBe(false)
    expect(ok(one(['x'.repeat(41)]))).toBe(false)
    expect(ok({ orderIds: ['gid://shopify/Customer/42'], tags: ['vip'] })).toBe(false)
    expect(ok({ orderIds: ['42'], tags: ['vip'] })).toBe(false)
    expect(ok(one(['vip'], { shop: 'other' }))).toBe(false)
    // M3-S1: the list form only (M2's single `orderId` is gone); 1 to 100, each once.
    expect(ok({ orderId: 'gid://shopify/Order/42', tags: ['vip'] })).toBe(false)
    expect(ok({ orderIds: [], tags: ['vip'] })).toBe(false)
    expect(ok({ orderIds: ['gid://shopify/Order/42', 'gid://shopify/Order/42'], tags: ['vip'] })).toBe(false)
    expect(ok({ orderIds: Array.from({ length: 100 }, (_, i) => `gid://shopify/Order/${i + 1}`), tags: ['vip'] })).toBe(true)
    expect(ok({ orderIds: Array.from({ length: 101 }, (_, i) => `gid://shopify/Order/${i + 1}`), tags: ['vip'] })).toBe(false)
  })
  it('resolves to the connected shop, one record and one unit per order, and its card in server words', async () => {
    const r = await resolve(facts, { operation: 'shopify.order.tag_add', args: one(['vip']) })
    expect(r).toMatchObject({ accountId: 'shopify:store', accountGen: 10, scope: { shop: 'store-a' }, scopeKey: 'shop=store-a', records: 1, units: 1 })
    expect(OPERATIONS['shopify.order.tag_add'].card(one(['vip', 'gift']), facts)).toEqual({ title: 'Add 2 tags to order 42', lines: ['Tag: vip', 'Tag: gift'] })
    const many = { orderIds: [1042, 1043, 1044].map(n => `gid://shopify/Order/${n}`), tags: ['vip'] }
    expect(await resolve(facts, { operation: 'shopify.order.tag_add', args: many })).toMatchObject({ records: 3, units: 3 })
    expect(OPERATIONS['shopify.order.tag_add'].card(many, facts)).toEqual({ title: 'Add a tag to 3 orders', lines: ['Tag: vip', 'Orders: 1042, 1043, 1044'] })
  })
  it('refuses an account that is gone, paused or has no shop', async () => {
    for (const shopify of [null, { ...facts.accounts.shopify!, paused: true }, { ...facts.accounts.shopify!, connected: false }, { ...facts.accounts.shopify!, shop: null }, { ...facts.accounts.shopify!, connectedAtMs: null }]) {
      expect(await resolve({ ...facts, accounts: { ...facts.accounts, shopify } }, { operation: 'shopify.order.tag_add', args: one(['vip']) }))
        .toEqual({ refuse: { verdict: 'refuse', reason: 'account_unavailable' } })
    }
  })
})

// Stage 1 M3-S1 (N21, N22). Ways it can go wrong: a multi-order call's items don't add up to the call or aren't the
// operation's own arguments; an item line drops an order, a tag or the shop (a collected call of 2 to 5 orders is one
// item, so its line must name every order); tag_remove's words say add; a draft's line or card drops a product, a
// quantity, the note or a tag; a draft takes a field that could reach a customer or hold stock.
describe.each(['shopify.order.tag_add', 'shopify.order.tag_remove'] as const)('%s items and lines (M3-S1)', key => {
  // Both entries take the same arguments (shopify-order-tags.ts).
  const e = OPERATIONS[key] as OperationEntry<TagAddArgs>
  const verb = key === 'shopify.order.tag_add' ? 'add' : 'remove'
  it('splits a call into one item per order, each its own valid arguments, the units adding up', () => {
    const a = { orderIds: [1042, 1043, 1044].map(n => `gid://shopify/Order/${n}`), tags: ['VIP', 'rush'] }
    const items = e.items!(a)
    expect(items).toEqual(a.orderIds.map(id => ({ orderIds: [id], tags: a.tags })))
    for (const it of items) expect(e.args.safeParse(it).success).toBe(true)
    expect(items.reduce((n, it) => n + e.units(it), 0)).toBe(e.units(a))
    expect(items.reduce((n, it) => n + e.records(it), 0)).toBe(e.records(a))
  })
  it('names the shop, every order and every tag in an item line, whatever the call holds', () => {
    expect(e.itemLine({ orderIds: ['gid://shopify/Order/1042'], tags: ['VIP', 'rush'] }, facts)).toBe(`Order 1042 (store-a): ${verb} VIP, rush`)
    const five = [1042, 1043, 1044, 1045, 1046].map(n => `gid://shopify/Order/${n}`)
    expect(e.itemLine({ orderIds: five, tags: ['VIP'] }, facts)).toBe(`Orders 1042, 1043, 1044, 1045, 1046 (store-a): ${verb} VIP`)
  })
  it('has N24\'s limits and no effect flag', () => {
    expect(e).toMatchObject({ unitsLabel: 'orders', coalesces: true, memberMay: true, reversible: true, connector: 'shopify', defaults: { grant: { perDay: 50, unitsMax: 5 }, ceiling: { perDayMax: 200, unitsMax: 100 } } })
  })
})

describe('shopify.order.tag_remove (M3-S1)', () => {
  it('takes what tag_add takes, resolves to the shop, and its card says remove', async () => {
    const a = { orderIds: ['gid://shopify/Order/42'], tags: ['vip'] }
    expect(await resolve(facts, { operation: 'shopify.order.tag_remove', args: a })).toMatchObject({ scope: { shop: 'store-a' }, records: 1, units: 1 })
    expect(await resolve(facts, { operation: 'shopify.order.tag_remove', args: { orderId: 'gid://shopify/Order/42', tags: ['vip'] } })).toEqual({ refuse: { verdict: 'refuse', reason: 'invalid_args' } })
    expect(OPERATIONS['shopify.order.tag_remove'].card(a, facts)).toEqual({ title: 'Remove a tag from order 42', lines: ['Tag: vip'] })
    expect(OPERATIONS['shopify.order.tag_remove'].card({ orderIds: ['gid://shopify/Order/1', 'gid://shopify/Order/2'], tags: ['a', 'b'] }, facts))
      .toEqual({ title: 'Remove 2 tags from 2 orders', lines: ['Tag: a', 'Tag: b', 'Orders: 1, 2'] })
  })
})

describe('shopify.draft_order.create (M3-S1)', () => {
  const e = OPERATIONS['shopify.draft_order.create']
  const line = { variantId: 'gid://shopify/ProductVariant/7001', quantity: 2 }
  const ok = (a: unknown) => DraftOrderArgsSchema.safeParse(a).success
  it('takes 1 to 20 distinct variants with 1 to 100 each, an optional note and tags, nothing else', () => {
    expect(ok({ lines: [line] })).toBe(true)
    expect(ok({ lines: [line], note: 'For the\nshowroom', tags: ['sample'] })).toBe(true)
    for (const bad of [
      { lines: [] }, { lines: [line, line] }, { lines: Array.from({ length: 21 }, (_, i) => ({ variantId: `gid://shopify/ProductVariant/${i + 1}`, quantity: 1 })) },
      { lines: [{ ...line, quantity: 0 }] }, { lines: [{ ...line, quantity: 101 }] }, { lines: [{ ...line, quantity: 1.5 }] },
      { lines: [{ ...line, price: '0.00' }] }, { lines: [{ variantId: 'gid://shopify/Product/7001', quantity: 1 }] },
      { lines: [line], note: '' }, { lines: [line], note: 'x'.repeat(501) }, { lines: [line], note: 'a\u202eb' }, { lines: [line], note: 'a\tb' },
      { lines: [line], tags: [] }, { lines: [line], tags: ['a,b'] }, { lines: [line], tags: ['a', 'A'] },
      { lines: [line], customerId: 'gid://shopify/Customer/1' }, { lines: [line], email: 'a@example.com' },
      { lines: [line], shippingAddress: {} }, { lines: [line], appliedDiscount: {} }, { lines: [line], reserveInventoryUntil: '2030-01-01' },
    ]) expect(ok(bad), JSON.stringify(bad)).toBe(false)
  })
  it('resolves to the shop as one record and one unit, with every product, quantity, the note and tags on its line and card', async () => {
    const a = { lines: [line, { variantId: 'gid://shopify/ProductVariant/7003', quantity: 1 }], note: 'For the showroom', tags: ['sample', 'q4'] }
    expect(await resolve(facts, { operation: 'shopify.draft_order.create', args: a })).toMatchObject({ scope: { shop: 'store-a' }, scopeKey: 'shop=store-a', records: 1, units: 1 })
    expect(e.itemLine(a, facts)).toBe('Draft order (store-a): 2 × variant 7001, 1 × variant 7003; note: For the showroom; tags: sample, q4')
    expect(e.card(a, facts)).toEqual({ title: 'Create a draft order of 3 items', lines: ['2 × variant 7001', '1 × variant 7003', 'Note: For the showroom', 'Tags: sample, q4'] })
    expect(e.card({ lines: [{ ...line, quantity: 1 }] }, facts)).toEqual({ title: 'Create a draft order of 1 item', lines: ['1 × variant 7001'] })
    expect(e.items).toBeUndefined()
  })
  it('has N24\'s limits and no effect flag', () => {
    expect(e).toMatchObject({ unitsLabel: 'draft orders', coalesces: true, memberMay: true, connector: 'shopify', effects: { money: false, customer: false, destructive: false, access: false }, defaults: { grant: { perDay: 10, unitsMax: 1 }, ceiling: { perDayMax: 50, unitsMax: 1 } } })
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
    expect(operationForTool('shopify_order_tag_remove')).toBe('shopify.order.tag_remove')
    expect(operationForTool('shopify_draft_order_create')).toBe('shopify.draft_order.create')
    expect(operationForTool('shopify_inventory_restock')).toBe('shopify.inventory.restock')
    expect(operationForTool('shopify_inventory_reduce')).toBe('shopify.inventory.reduce')
    expect(operationForTool('shopify_refund_create')).toBe('shopify.refund.create')
    expect(operationForTool('notification_send')).toBeNull()
    // M3-S2 adds the first operations with an effect flag (reduce: destructive; refund: money and the customer, admins
    // only; stock-refund.test.ts). Every other one has none, so a member may ask for it and a grant may cover it. None
    // resends by itself.
    const flagged: readonly string[] = ['shopify.inventory.reduce', 'shopify.refund.create']
    for (const e of Object.values(OPERATIONS)) {
      expect(e.idempotent, e.key).toBe(false)
      if (flagged.includes(e.key)) continue
      expect(e, e.key).toMatchObject({ defaults: { grant: { perDay: expect.any(Number) } }, memberMay: true, effects: { money: false, customer: false, destructive: false, access: false } })
    }
    expect(OPERATIONS['shopify.order.tag_add'].defaults.grant?.perDay).toBe(50)
    expect(OPERATIONS['slack.channel.post'].defaults.grant?.perDay).toBe(50)
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

// Stage 1 M3-A (section 0, N21, N22, N24, N25): the class rules over the whole table, as the type states them, so an entry
// that slips past the type (a cast, a widened literal) still can't ship. Ways it can go wrong: a money, destructive or
// admin-only operation that collects into a batch (a batch then moves money, can't be undone item by item, or needs an
// admin); money with no amount; destructive marked reversible; grant numbers on an operation no grant covers, or none
// on one a grant can, or over the ceiling it suggests; the audit and screen's view of which limits apply drifting from
// the entry.
describe('the table keeps the class rules (M3-A)', () => {
  const entries = Object.values(OPERATIONS)
  const flagged = (e: (typeof entries)[number]) => e.effects.money || e.effects.customer || e.effects.destructive || e.effects.access
  it('never collects money, destructive or admin-only operations', () => {
    for (const e of entries) if (e.effects.money || e.effects.destructive || !e.memberMay) expect(e.coalesces, e.key).toBe(false)
  })
  it('defines an amount exactly for money, and never undoes the destructive', () => {
    for (const e of entries) {
      expect(typeof e.amount === 'function', e.key).toBe(e.effects.money)
      if (e.effects.destructive) expect(e.reversible, e.key).toBe(false)
    }
  })
  it('names grant defaults only where a grant can cover it, under the ceiling it suggests', () => {
    for (const e of entries) {
      if (flagged(e)) {
        expect(e.defaults.grant, e.key).toBeNull()
        expect(() => grantDefaults(e.key), e.key).toThrow()
        continue
      }
      const g = grantDefaults(e.key)
      expect(g.perDay, e.key).toBeLessThanOrEqual(e.defaults.ceiling.perDayMax)
      expect(g.unitsMax, e.key).toBeLessThanOrEqual(e.defaults.ceiling.unitsMax)
      for (const n of [g.perDay, g.unitsMax, e.defaults.ceiling.perDayMax, e.defaults.ceiling.unitsMax]) expect(Number.isSafeInteger(n) && n >= 1, e.key).toBe(true)
    }
  })
  it('says which limits apply as the entry does (audit-text OPERATION_LIMITS)', () => {
    expect(Object.keys(OPERATION_LIMITS).sort()).toEqual(Object.keys(OPERATIONS).sort())
    for (const e of entries) {
      expect(OPERATION_LIMITS[e.key], e.key).toEqual({ perDay: !flagged(e), batch: e.coalesces || e.items !== undefined, money: e.effects.money })
    }
  })
  it('shows every word a post holds in its item line', () => {
    const post = OPERATIONS['slack.channel.post']
    const text = 'Line one\nLine two, which is long enough to be cut by anything that cuts: '.padEnd(400, 'x')
    const line = post.itemLine({ channel: '#ops', title: 'Heads up', text }, facts)
    expect(line).toContain('Heads up')
    expect(line).toContain(text)
  })
})

// Stage 1 M3-U (N33): a batch's rows and title. Ways it could break: an operation that collects has no row, no heads or
// no title (its card would fall back to a bare line or "450 changes in Shopify"); a row drops the record or the change;
// a stock row loses its sign; a title names tags the items don't all share, or counts the wrong thing.
describe('batch rows and titles (M3-U)', () => {
  it('every operation that collects defines its row and its title; only stock shows as a table (its heads)', () => {
    for (const e of Object.values(OPERATIONS) as OperationEntry[]) {
      if (!e.coalesces) continue
      expect([e.key, typeof e.itemRow, typeof e.batchTitle]).toEqual([e.key, 'function', 'function'])
    }
    const tables = (Object.values(OPERATIONS) as OperationEntry[]).filter(e => e.rowHeads).map(e => e.key).sort()
    expect(tables).toEqual(['shopify.inventory.reduce', 'shopify.inventory.restock'])
  })
  it('tags: the orders and the change; the title names the tags only when every item shares them', () => {
    const add = OPERATIONS['shopify.order.tag_add'] as OperationEntry<TagAddArgs>
    const rm = OPERATIONS['shopify.order.tag_remove'] as OperationEntry<TagAddArgs>
    const a = { orderIds: ['gid://shopify/Order/1042', 'gid://shopify/Order/1043'], tags: ['VIP', 'rush'] }
    expect(add.itemRow!(a)).toEqual({ ref: 'Orders 1042, 1043', change: 'add VIP, rush' })
    expect(rm.itemRow!(a)).toEqual({ ref: 'Orders 1042, 1043', change: 'remove VIP, rush' })
    expect(add.titleKey).toBe('$.tags')
    expect(add.batchTitle!({ records: 450, units: 450 }, { orderIds: ['gid://shopify/Order/1'], tags: ['VIP'] })).toBe('Tag 450 orders as VIP')
    expect(add.batchTitle!({ records: 1, units: 1 }, a)).toBe('Tag 1 order as VIP and rush')
    expect(add.batchTitle!({ records: 1200, units: 1200 }, { orderIds: ['gid://shopify/Order/1'], tags: ['a', 'b', 'c'] })).toBe('Tag 1,200 orders as a, b and c')
    expect(add.batchTitle!({ records: 450, units: 450 }, null)).toBe('Add tags to 450 orders')
    expect(rm.batchTitle!({ records: 12, units: 12 }, a)).toBe('Remove VIP and rush from 12 orders')
    expect(rm.batchTitle!({ records: 12, units: 12 }, null)).toBe('Remove tags from 12 orders')
  })
  it('stock: the item, where and why, and the signed quantity; drafts: their products', () => {
    const restock = OPERATIONS['shopify.inventory.restock'] as OperationEntry<{ inventoryItemId: string; locationId: string; quantity: number; reason: string }>
    const reduce = OPERATIONS['shopify.inventory.reduce'] as OperationEntry<{ inventoryItemId: string; locationId: string; quantity: number; reason: string }>
    const s = { inventoryItemId: 'gid://shopify/InventoryItem/8001', locationId: 'gid://shopify/Location/601', quantity: 1200, reason: 'received' }
    expect(restock.itemRow!(s)).toEqual({ ref: 'Item 8001', change: 'Location 601 · stock received', amount: '+1,200' })
    expect(reduce.itemRow!({ ...s, reason: 'damaged' })).toEqual({ ref: 'Item 8001', change: 'Location 601 · damaged', amount: '-1,200' })
    expect(restock.batchTitle!({ records: 120, units: 2400 }, null)).toBe('Restock 120 items')
    const draft = OPERATIONS['shopify.draft_order.create']
    expect(draft.itemRow!({ lines: [{ variantId: 'gid://shopify/ProductVariant/7001', quantity: 2 }], note: 'Showroom' })).toEqual({ ref: '', change: '2 × variant 7001; note: Showroom' })
    expect(draft.batchTitle!({ records: 10, units: 10 }, null)).toBe('Create 10 draft orders')
  })
})
