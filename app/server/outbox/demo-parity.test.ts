// The demo's agent actions and permissions (src/agent/sample-data/actions.json, drawn by src/agent/mock-actions.ts) say
// what the server says: the demo catch-up's rule is that the demo shows the real agent's screens. Ways it could drift,
// written first: a permission's title, units or default limits that aren't the operation's; a card's title or lines that
// aren't the operation's own card words; the settled, needs-check or lapse words of a card that aren't the outbox's.
import { describe, expect, test } from 'vitest'
import { OPERATION_TITLE } from '../../shared/audit-text.ts'
import { OPERATIONS } from './operations/index.ts'
import { tagsCard } from './operations/shopify-order-tags.ts'
import { stockCard } from './operations/shopify-inventory.ts'
import { FAILED_TEXT, LAPSE_TEXT, NEEDS_CHECK_TEXT, SENT_TEXT } from './words.ts'

type RawOperation = { title: string; unitsLabel: string; perDay: number; unitsMax: number; ceilingPerDay: number; ceilingUnitsMax: number; reversible?: boolean }
type RawSingle = { id: string; operation: string; title: string; lines: string[]; state: string; result?: string }
const demo = JSON.parse(Object.values(import.meta.glob('../../src/agent/sample-data/actions.json', { query: '?raw', import: 'default', eager: true }))[0] as string) as {
  operations: Record<string, RawOperation>; singles: RawSingle[]; resolved: Record<string, string>; lapsed: { paused: string; permission_removed: string; channel_not_listed: string }
}
const single = (id: string) => demo.singles.find(s => s.id === id)!
type RawDraft = { kind?: string; title: string; body?: string; destination?: string; amount?: unknown; money?: boolean; customer?: boolean; items?: unknown; lines: unknown[] }
const todays = (JSON.parse(Object.values(import.meta.glob('../../src/agent/sample-data/problems.json', { query: '?raw', import: 'default', eager: true }))[0] as string) as { problems: { id: string; draft: RawDraft }[] }).problems

describe("the demo's actions say what the server says", () => {
  test("each operation's permission title, units, default limits and whether it can be taken back", () => {
    expect(Object.keys(demo.operations).length).toBeGreaterThan(0)
    for (const [key, op] of Object.entries(demo.operations)) {
      const server = OPERATIONS[key as keyof typeof OPERATIONS]
      expect(server, key).toBeDefined()
      expect(op.title, key).toBe(OPERATION_TITLE[key as keyof typeof OPERATION_TITLE])
      expect(op.unitsLabel, key).toBe(server.unitsLabel)
      expect([op.perDay, op.unitsMax], key).toEqual([server.defaults.grant?.perDay, server.defaults.grant?.unitsMax])
      expect([op.ceilingPerDay, op.ceilingUnitsMax], key).toEqual([server.defaults.ceiling.perDayMax, server.defaults.ceiling.unitsMax])
      expect(op.reversible ?? true, key).toBe(server.reversible)
    }
  })

  test("each single card's title and lines are its operation's card words", () => {
    const words = (s: RawSingle) => ({ title: s.title, lines: s.lines })
    expect(words(single('ac_demoWholesaleTag000000'))).toEqual(tagsCard('Add', { orderIds: ['gid://shopify/Order/4512'], tags: ['Wholesale'] }))
    expect(words(single('ac_demoGiftTagCheck000000'))).toEqual(tagsCard('Add', { orderIds: ['gid://shopify/Order/4377'], tags: ['Gift'] }))
    expect(words(single('ac_demoPriyaHoldTag000000'))).toEqual(tagsCard('Remove', { orderIds: ['gid://shopify/Order/4470'], tags: ['Hold'] }))
    expect(words(single('ac_demoStockAdded00000000'))).toEqual(stockCard('Add', { inventoryItemId: 'gid://shopify/InventoryItem/8012', locationId: 'gid://shopify/Location/601', quantity: 40, reason: 'received' }))
    // The Slack post's card, from the operation's own `card` with the demo's listed channel.
    const post = single('ac_demoOpsAlertsPost00000')
    const facts = { listedChannels: [{ id: 'C0DEMO0001', name: 'ops-alerts' }] } as unknown as Parameters<typeof OPERATIONS['slack.channel.post']['card']>[1]
    expect(words(post)).toEqual(OPERATIONS['slack.channel.post'].card({ channel: '#ops-alerts', text: post.lines[0]! }, facts))
    for (const s of demo.singles) expect(Object.hasOwn(demo.operations, s.operation), s.id).toBe(true)
  })

  // Today's two Slack posts (the payout, the stuck order) stand for the same operation: its card, and what its effects say.
  test("Today's Slack posts are the post operation's card: its title and text, no attachment, no money pill, no customer, no table", () => {
    const posts = todays.filter(p => p.draft.kind === 'Slack post')
    expect(posts.map(p => p.id)).toEqual(['payout', 'stuck'])
    const facts = { listedChannels: [{ id: 'C0DEMO0001', name: 'ops-alerts' }] } as unknown as Parameters<typeof OPERATIONS['slack.channel.post']['card']>[1]
    for (const { id, draft } of posts) {
      const card = OPERATIONS['slack.channel.post'].card({ channel: draft.destination!, text: draft.body! }, facts)
      expect(draft.title, id).toBe(card.title)
      expect(draft.destination, id).toBe('#ops-alerts')
      expect(draft.body, id).toBe(card.lines[0])
      expect(draft.body, id).not.toMatch(/attach/i)
      // The operation's own effects: a post claims no money, reaches no customer and is a text, not a table.
      const { effects } = OPERATIONS['slack.channel.post']
      expect([draft.money === true, draft.customer === true], id).toEqual([effects.money, effects.customer])
      expect([draft.amount, draft.items], id).toEqual([undefined, undefined])
    }
  })

  test('the settled, needs-check and lapse words are the outbox\'s', () => {
    expect(demo.resolved).toEqual({ sent: SENT_TEXT, failed: FAILED_TEXT })
    expect(demo.lapsed).toEqual({ paused: LAPSE_TEXT.paused, permission_removed: LAPSE_TEXT.permission_removed, channel_not_listed: LAPSE_TEXT.channel_not_listed })
    expect(demo.singles.filter(s => s.state === 'needs_check').map(s => s.result)).toEqual([NEEDS_CHECK_TEXT])
    expect(demo.singles.filter(s => s.state === 'sent').map(s => s.result)).toEqual([SENT_TEXT])
  })
})
