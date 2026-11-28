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
  operations: Record<string, RawOperation>; singles: RawSingle[]; resolved: Record<string, string>; lapsed: { paused: string }
}
const single = (id: string) => demo.singles.find(s => s.id === id)!

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
    // The Slack post's card: `Post to #<channel> in Slack`, its text the one line (slack-channel-post.ts `card`).
    expect(single('ac_demoOpsAlertsPost00000').title).toBe('Post to #ops-alerts in Slack')
    for (const s of demo.singles) expect(Object.hasOwn(demo.operations, s.operation), s.id).toBe(true)
  })

  test('the settled, needs-check and lapse words are the outbox\'s', () => {
    expect(demo.resolved).toEqual({ sent: SENT_TEXT, failed: FAILED_TEXT })
    expect(demo.lapsed.paused).toBe(LAPSE_TEXT.paused)
    expect(demo.singles.filter(s => s.state === 'needs_check').map(s => s.result)).toEqual([NEEDS_CHECK_TEXT])
    expect(demo.singles.filter(s => s.state === 'sent').map(s => s.result)).toEqual([SENT_TEXT])
  })
})
