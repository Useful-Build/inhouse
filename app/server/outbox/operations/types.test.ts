// The operation table's type (W0-A, N9): an entry typed with its own arguments fits the table, and only under its own
// key. Checked by `npm run typecheck` (the @ts-expect-error lines fail the build if they stop being errors).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { OperationEntry, OperationTable } from './types.ts'

const effects = { money: false, customer: false, destructive: false, access: false }
const tag: OperationEntry<{ orderId: string; tags: string[] }> & { key: 'shopify.order.tag_add' } = {
  key: 'shopify.order.tag_add', tool: 'shopify_order_tag_add', description: 'Adds tags to one order.',
  args: z.strictObject({ orderId: z.string(), tags: z.array(z.string()).min(1).max(5) }), connector: 'shopify',
  scope: () => ({ shop: 'example' }), records: () => 1, units: () => 1, effects, memberMay: true, reversible: true,
  unitsLabel: 'orders', itemLine: a => `Order ${a.orderId}: add ${a.tags.join(', ')}`,
  idempotent: false, coalesces: true, defaults: { perDay: 50, unitsMax: 5, ceiling: { perDayMax: 200, unitsMax: 100 } },
  card: a => ({ title: `Tag order ${a.orderId}`, lines: a.tags }),
}
const post: OperationEntry<{ channel: string; text: string }> & { key: 'slack.channel.post' } = {
  key: 'slack.channel.post', tool: 'slack_channel_post', description: 'Posts to a listed channel.',
  args: z.strictObject({ channel: z.string(), text: z.string() }), connector: 'slack',
  scope: (a, f): Record<string, string> | { refuse: 'not_listed' } => { const c = f.listedChannels.find(x => x.name === a.channel); return c ? { channelId: c.id } : { refuse: 'not_listed' } },
  records: () => 1, units: () => 1, unitsLabel: 'posts', itemLine: a => `${a.channel}: ${a.text}`, effects, memberMay: true,
  reversible: false, idempotent: false, coalesces: true, defaults: { perDay: 50, unitsMax: 1, ceiling: { perDayMax: 200, unitsMax: 1 } },
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
