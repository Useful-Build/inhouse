// The demo's agent actions and permissions (src/agent/sample-data/actions.json, drawn by src/agent/mock-actions.ts) say
// what the server says: the demo catch-up's rule is that the demo shows the real agent's screens. Ways it could drift,
// written first: a permission's title, units or default limits that aren't the operation's; a card's title or lines that
// aren't the operation's own card words; the settled, needs-check or lapse words of a card that aren't the outbox's.
// The demo catch-up's PR 3 adds, written first: a draft order, a stock reduction or a partly sent batch worded other than the
// server's; a ceiling row (its title, words, limits, guardrails, who approves) that isn't the server's, or one missing or in
// another order; a refusal the demo's chat explains with a limit other than the ceiling's.
import { env } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'
import { OPERATION_TITLE } from '../../shared/audit-text.ts'
import { ceilingStore } from '../api/ceiling-store.ts'
import { OPERATIONS, OPERATION_KEYS } from './operations/index.ts'
import { tagsBatchTitle, tagsCard } from './operations/shopify-order-tags.ts'
import { stockCard } from './operations/shopify-inventory.ts'
import { FAILED_TEXT, LAPSE_TEXT, NEEDS_CHECK_TEXT, SENT_TEXT } from './words.ts'

type RawOperation = { title: string; unitsLabel: string; perDay: number | null; unitsMax: number | null; ceilingPerDay: number; ceilingUnitsMax: number; reversible?: boolean }
type RawSingle = { id: string; operation: string; title: string; lines: string[]; state: string; result?: string; details?: unknown[] }
type RawBatch = { id: string; title: string; kind: string; count: number; tag: string; settled?: { failed: number[] } }
const demo = JSON.parse(Object.values(import.meta.glob('../../src/agent/sample-data/actions.json', { query: '?raw', import: 'default', eager: true }))[0] as string) as {
  operations: Record<string, RawOperation>; singles: RawSingle[]; resolved: Record<string, string>; lapsed: { paused: string; permission_removed: string; channel_not_listed: string }
  batches: RawBatch[]; ceiling: Record<string, unknown>[]
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
      // An operation no grant covers (a stock reduction) has none, and the demo says so.
      expect([op.perDay, op.unitsMax], key).toEqual([server.defaults.grant?.perDay ?? null, server.defaults.grant?.unitsMax ?? null])
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

  test("the draft order and the stock reduction are their operations' card words, with each line's product and SKU from the store", () => {
    const words = (s: RawSingle) => ({ title: s.title, lines: s.lines })
    const draft = single('ac_demoDraftOrder00000000')
    // The card's words need no store facts: the draft order's own `card` reads only its arguments.
    const noFacts = {} as unknown as Parameters<typeof OPERATIONS['shopify.draft_order.create']['card']>[1]
    expect(words(draft)).toEqual(OPERATIONS['shopify.draft_order.create'].card({
      lines: [{ variantId: 'gid://shopify/ProductVariant/7041', quantity: 8 }, { variantId: 'gid://shopify/ProductVariant/7042', quantity: 4 }], note: 'Samples for Dana’s photo shoot', tags: ['Samples'],
    }, noFacts))
    expect(draft.details).toHaveLength(2)
    expect(words(single('ac_demoStockReduce0000000'))).toEqual(stockCard('Remove', { inventoryItemId: 'gid://shopify/InventoryItem/8012', locationId: 'gid://shopify/Location/601', quantity: 40, reason: 'damaged' }))
  })

  test('the batch that partly went out says what the server says: its title, "Sent." and how many of how many went out', () => {
    const b = demo.batches.find(x => x.settled)!
    expect(b.title).toBe(tagsBatchTitle('add', b.count, { orderIds: ['gid://shopify/Order/4101'], tags: [b.tag] }))
    expect(b.settled!.failed.length).toBeGreaterThan(0)
    // server/outbox/batch/answer.ts `endBatchStmts`: `${SENT_TEXT} ${sent} of ${total} went out`, a failed item says FAILED_TEXT.
    expect(`${demo.resolved.sent} ${b.count - b.settled!.failed.length} of ${b.count} went out`).toBe(`${SENT_TEXT} 447 of 450 went out`)
    expect(demo.resolved.failed).toBe(FAILED_TEXT)
  })

  test("What the agent can do: the demo's seven rows are the server's, in its order, each at the values the server suggests, on", async () => {
    const server = await ceilingStore({ db: env.DB, env: {}, build: { testBuild: false, evalBuild: false } }).list()
    expect(server.map(r => r.operation)).toEqual(OPERATION_KEYS)
    expect(demo.ceiling.map(r => r.operation)).toEqual(OPERATION_KEYS)
    for (const row of server) {
      const d = demo.ceiling.find(r => r.operation === row.operation)!
      // The shop's currency is the connected store's; the demo's store sells in dollars.
      const measure = row.measure.kind === 'money' ? { kind: 'money', currency: 'USD' } : row.measure
      expect({ ...d, measure: undefined }, row.operation).toEqual({
        operation: row.operation, title: row.title, description: row.description, tool: row.tool, measure: undefined, applies: row.applies, guardrails: row.guardrails,
        approverKind: row.approverKind, enabled: true, perDayMax: row.suggested.perDayMax, unitsMax: row.suggested.unitsMax, bulkThreshold: row.bulkThreshold, batchMax: row.batchMax, suggested: row.suggested,
      })
      expect(d.measure, row.operation).toEqual(measure)
    }
  })

  test("the stock chat refuses 900 units against the ceiling's own largest call for a stock reduction", () => {
    const largest = demo.ceiling.find(r => r.operation === 'shopify.inventory.reduce')!.unitsMax as number
    expect(largest).toBe(500)
    expect(900).toBeGreaterThan(largest)
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
    expect(demo.singles.filter(s => s.state === 'sent').map(s => s.result)).toEqual(demo.singles.filter(s => s.state === 'sent').map(() => SENT_TEXT))
  })
})
