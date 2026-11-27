// The operation table's type (W0-A, N9): an entry typed with its own arguments fits the table, and only under its own
// key. Stage 1 M3-A: an entry's effects and approver force its class (section 0, N21, N22, N25). Checked by
// `npm run typecheck` (the @ts-expect-error lines fail the build if they stop being errors).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { OperationEntry, OperationTable } from './types.ts'

const effects = { money: false, customer: false, destructive: false, access: false } as const
const tag: OperationEntry<{ orderId: string; tags: string[] }> & { key: 'shopify.order.tag_add' } = {
  key: 'shopify.order.tag_add', tool: 'shopify_order_tag_add', description: 'Adds tags to one order.',
  args: z.strictObject({ orderId: z.string(), tags: z.array(z.string()).min(1).max(5) }), connector: 'shopify',
  scope: () => ({ shop: 'example' }), records: () => 1, units: () => 1, effects, memberMay: true, reversible: true,
  unitsLabel: 'orders', itemLine: a => `Order ${a.orderId}: add ${a.tags.join(', ')}`,
  idempotent: false, coalesces: true, defaults: { grant: { perDay: 50, unitsMax: 5 }, ceiling: { perDayMax: 200, unitsMax: 100 } },
  card: a => ({ title: `Tag order ${a.orderId}`, lines: a.tags }),
}
const post: OperationEntry<{ channel: string; text: string }> & { key: 'slack.channel.post' } = {
  key: 'slack.channel.post', tool: 'slack_channel_post', description: 'Posts to a listed channel.',
  args: z.strictObject({ channel: z.string(), text: z.string() }), connector: 'slack',
  scope: (a, f): Record<string, string> | { refuse: 'not_listed' } => { const c = f.listedChannels.find(x => x.name === a.channel); return c ? { channelId: c.id } : { refuse: 'not_listed' } },
  records: () => 1, units: () => 1, unitsLabel: 'posts', itemLine: a => `${a.channel}: ${a.text}`, effects, memberMay: true,
  reversible: false, idempotent: false, coalesces: false, defaults: { grant: { perDay: 50, unitsMax: 1 }, ceiling: { perDayMax: 200, unitsMax: 1 } },
  card: a => ({ title: `Post to ${a.channel}`, lines: [a.text] }),
}

describe('OperationTable', () => {
  it('takes each entry under its own key only', () => {
    const table: OperationTable = { 'shopify.order.tag_add': tag, 'slack.channel.post': post }
    // @ts-expect-error: an entry under another operation's key
    const swapped: OperationTable = { 'shopify.order.tag_add': post, 'slack.channel.post': tag }
    // @ts-expect-error: a missing operation
    const missing: OperationTable = { 'shopify.order.tag_add': tag }
    expect(Object.keys(table)).toEqual(['shopify.order.tag_add', 'slack.channel.post'])
    expect([swapped, missing]).toHaveLength(2)
  })
})

// A made-up refund and stock reduction, with only what the class rules look at. Ways it can go wrong, written first: a
// money or destructive operation that collects into a batch; an admin-only one that does (a batch would need an
// admin); money without an amount, or an amount on an operation that moves none; a destructive one marked reversible;
// grant defaults on an operation no grant can cover.
type Refund = { orderId: string; minor: number }
const base = {
  key: 'shopify.order.tag_add' as const, tool: 'made_up', description: 'Made up.', args: z.strictObject({ orderId: z.string(), minor: z.int() }),
  connector: 'shopify' as const, scope: () => ({ shop: 'example' }), records: () => 1, units: (a: Refund) => a.minor, unitsLabel: 'minor units',
  itemLine: (a: Refund) => `Order ${a.orderId}: refund ${a.minor}`, idempotent: false as const, card: (a: Refund) => ({ title: `Refund ${a.orderId}`, lines: [] }),
}
const money = { money: true, customer: true, destructive: false, access: false } as const
const destructive = { money: false, customer: false, destructive: true, access: false } as const
const exactOnly = { grant: null, ceiling: { perDayMax: 1, unitsMax: 50_000 } }
const amount = (a: Refund) => ({ minor: a.minor, currency: 'USD' })

describe('OperationEntry classes (M3-A)', () => {
  it('takes each class as the plan writes it', () => {
    const refund: OperationEntry<Refund> = { ...base, effects: money, memberMay: false, reversible: false, coalesces: false, amount, defaults: exactOnly }
    const reduce: OperationEntry<Refund> = { ...base, effects: destructive, memberMay: true, reversible: false, coalesces: false, defaults: exactOnly }
    const adminOnly: OperationEntry<Refund> = { ...base, effects, memberMay: false, reversible: true, coalesces: false, defaults: { ...exactOnly, grant: { perDay: 1, unitsMax: 1 } } }
    expect([refund, reduce, adminOnly]).toHaveLength(3)
  })
  it('refuses what breaks a class rule', () => {
    // @ts-expect-error: money never coalesces
    const a: OperationEntry<Refund> = { ...base, effects: money, memberMay: false, reversible: false, coalesces: true, amount, defaults: exactOnly }
    // @ts-expect-error: money defines its amount
    const b: OperationEntry<Refund> = { ...base, effects: money, memberMay: false, reversible: false, coalesces: false, defaults: exactOnly }
    // @ts-expect-error: no amount on an operation that moves no money
    const c: OperationEntry<Refund> = { ...base, effects: destructive, memberMay: true, reversible: false, coalesces: false, amount, defaults: exactOnly }
    // @ts-expect-error: destructive never coalesces
    const d: OperationEntry<Refund> = { ...base, effects: destructive, memberMay: true, reversible: false, coalesces: true, defaults: exactOnly }
    // @ts-expect-error: destructive isn't reversible
    const e: OperationEntry<Refund> = { ...base, effects: destructive, memberMay: true, reversible: true, coalesces: false, defaults: exactOnly }
    // @ts-expect-error: admin-only never coalesces (a batch would need an admin)
    const f: OperationEntry<Refund> = { ...base, effects, memberMay: false, reversible: true, coalesces: true, defaults: exactOnly }
    // @ts-expect-error: money names no grant defaults (no grant covers it)
    const g: OperationEntry<Refund> = { ...base, effects: money, memberMay: false, reversible: false, coalesces: false, amount, defaults: { ...exactOnly, grant: { perDay: 1, unitsMax: 1 } } }
    expect([a, b, c, d, e, f, g]).toHaveLength(7)
  })
})
