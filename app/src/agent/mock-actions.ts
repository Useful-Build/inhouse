// The demo's agent actions (Stage 1 M3-U): what the real agent's cards look like, on the invented data in
// sample-data/actions.json. A 450-change batch in a chat of the signed-in admin's, a 12-item restock (a table with its
// total), and a teammate's refund that only an admin may approve (an admins card, N25). They show in the Normal scenario whatever the stage (the stages are going); in the
// other scenarios the lists are empty and every answer is refused (not found), as before. Answers follow the outbox's rules as the screens
// see them: the rev an answer was read at, a batch's `upTo` and totals as the card showed them, Undo in the 10 second
// hold, and the send at its end, on the demo clock. In memory only: a reload or Reset demo starts them again.
import actionsRaw from '@sample/actions.json'
import type { ActionCard, ActionChoice, ActionFilter, ActionItem, ActionItemsPage, BatchCovers } from './types'
import { AgentError } from './types'
import { NOT_FOUND, TOTALS_CHANGED } from '../../shared/contract/error-codes'
import { NEEDS_CHECK } from '../../shared/contract/action-states'
import { demoAt } from './demo-clock'
import { instantOf as instant } from '../lib/format'

type RawBatch = { id: string; chatId: string; title: string; unitsLabel: string; guardrail: 'bulk' | 'count'; askedAt: string } & (
  | { kind: 'tags'; count: number; firstOrder: number; tag: string; customers: [string, string][] }
  | { kind: 'restock'; firstItem: number; location: number; reason: string; quantities: number[] }
)
const raw = actionsRaw as {
  tool: string; shop: string; batches: RawBatch[]; batchResult: string
  refund: { id: string; askedBy: string; title: string; lines: string[]; askedAt: string; order: number; customer: string; amount: string; result: string }
}

/**
 * Items per page of the full list, and the lines a batch card carries (shared/contract/actions.ts's ACTION_ITEMS_PAGE
 * and BATCH_FIRST_LINES, written out here: that module brings zod, which the demo's bundle can't carry;
 * mock-actions.test.ts holds them equal).
 */
export const ITEMS_PAGE = 100
export const FIRST_LINES = 10
/** The demo's hold, as the product's (N11). */
export const DEMO_HOLD_MS = 10_000
const NONE: ActionCard['can'] = { allowOnce: false, alwaysAllow: false, approve: false, deny: false, undo: false, resolve: false, withdraw: false }
const TOOL = { accountId: `shopify:${raw.shop}`, label: raw.tool }

export interface MockActionsHost {
  /** Now on the demo clock, epoch ms. */
  now(): number
  /** Whether the scenario shows the demo's actions. */
  shown(): boolean
  /** The signed-in person's member id, and a member id for a sample person. */
  meId: string
  memberId(sampleId: string): string
}

/** A demo item, with the records and units the totals count (as the server's item rows hold them). */
type Item = ActionItem & { records: number; units: number }
interface Row { card: ActionCard; sendAtMs: number | null; items: Item[] }

/** A batch's items in the server's words for its operation (operations/shopify-order-tags.ts, shopify-inventory.ts). */
function itemsOf(b: RawBatch): { items: Item[]; heads?: { ref: string; change: string; amount: string } } {
  if (b.kind === 'tags') {
    // A tag batch is a plain list (no heads); a stock batch is a table.
    return {
      items: Array.from({ length: b.count }, (_, i) => {
        const order = b.firstOrder + i
        const [customer, total] = b.customers[i % b.customers.length]!
        return {
          n: i + 1, line: `Order ${order} (${raw.shop}): add ${b.tag}`, row: { ref: `Order ${order}`, change: `add ${b.tag}` },
          // What the store said about the order, as the real card's details (server/outbox/detail.ts): its name, customer and total.
          detail: { rows: [{ ref: `Order ${order}`, order: `#${order}`, customer, amount: usd(total), currency: 'USD' }] },
          state: 'pending' as const, records: 1, units: 1,
        }
      }),
    }
  }
  return {
    heads: { ref: 'Item', change: 'Where and why', amount: 'Stock' },
    items: b.quantities.map((q, i) => {
      const item = b.firstItem + i
      return {
        n: i + 1, line: `Item ${item} at location ${b.location} (${raw.shop}): +${q} (${b.reason})`,
        row: { ref: `Item ${item}`, change: `Location ${b.location} · ${b.reason}`, amount: `+${q}` }, state: 'pending' as const, records: 1, units: q,
      }
    }),
  }
}

/** "$1,208.00": a demo amount as the server words it (detail.ts `amountWords`), its digits grouped by hand. */
function usd(amount: string): string {
  const [whole, cents = '00'] = amount.split('.')
  return `$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents.padEnd(2, '0')}`
}

const sum = (items: Item[], k: 'records' | 'units') => items.reduce((n, i) => n + i[k], 0)
const visible = ({ records: _r, units: _u, ...item }: Item): ActionItem => item

function batchRow(h: MockActionsHost, b: RawBatch): Row {
  const { items, heads } = itemsOf(b)
  const first = items.slice(0, FIRST_LINES)
  const firstLines = first.map(i => i.line)
  return {
    sendAtMs: null, items,
    card: {
      id: b.id, rev: 1, kind: 'exact', state: 'waiting', title: b.title, lines: firstLines, tool: TOOL, records: sum(items, 'records'),
      reachesCustomer: false, reversible: true, guardrail: b.guardrail, chatId: b.chatId, askedBy: h.meId, askedAt: demoAt(b.askedAt),
      serverNow: demoAt(b.askedAt), can: { ...NONE, approve: true, deny: true }, nudgeAlways: false, approverKind: 'person',
      batch: {
        itemCount: items.length, firstLines, firstRows: first.map(i => i.row), ...(heads ? { heads } : {}),
        ...(first.some(i => i.detail) ? { firstDetails: first.map(i => i.detail ?? null) } : {}),
        totals: { records: sum(items, 'records'), units: sum(items, 'units'), unitsLabel: b.unitsLabel },
      },
    },
  }
}

function refundRow(h: MockActionsHost): Row {
  const r = raw.refund
  return {
    sendAtMs: null, items: [],
    card: {
      id: r.id, rev: 1, kind: 'exact', state: 'waiting', title: r.title, lines: r.lines, tool: TOOL, records: 1, reachesCustomer: true,
      reversible: false, guardrail: 'money', chatId: null, askedBy: h.memberId(r.askedBy), askedAt: demoAt(r.askedAt), serverNow: demoAt(r.askedAt),
      can: { ...NONE, approve: true, deny: true }, nudgeAlways: false, approverKind: 'admins',
      detail: { rows: [{ ref: `Order ${r.order}`, order: `#${r.order}`, customer: r.customer, amount: usd(r.amount), currency: 'USD' }] },
    },
  }
}

export class MockActions {
  private rows: Row[]
  private h: MockActionsHost
  constructor(h: MockActionsHost) { this.h = h; this.rows = this.fresh() }

  private fresh(): Row[] { return [...raw.batches.map(b => batchRow(this.h, b)), refundRow(this.h)] }
  /** Reset demo: every card waits again. */
  reset() { this.rows = this.fresh() }

  /** The row, sent once its hold has passed on the demo clock (the send itself takes no time here). */
  private settled(row: Row): Row {
    if (row.card.state === 'approved' && row.sendAtMs !== null && this.h.now() >= row.sendAtMs) {
      const n = row.card.batch?.itemCount ?? 0
      row.items = row.items.map(i => (i.n <= n ? { ...i, state: 'sent' as const, result: 'Sent.' } : i))
      const result = row.card.batch ? raw.batchResult.replaceAll('{n}', String(n)) : raw.refund.result
      row.card = { ...row.card, state: 'sent', rev: row.card.rev + 1, can: NONE, result }
      row.sendAtMs = null
    }
    return row
  }
  private view(row: Row): ActionCard {
    const { card } = this.settled(row)
    return { ...card, serverNow: instant(this.h.now()), ...(row.sendAtMs !== null ? { sendAt: instant(row.sendAtMs) } : {}) }
  }
  private find(id: string): Row {
    const row = this.h.shown() ? this.rows.find(r => r.card.id === id) : undefined
    if (!row) throw new AgentError(NOT_FOUND, "That isn't there any more.")
    return row
  }
  private conflict(row: Row): never { throw new AgentError('conflict', 'This changed before your answer arrived.', { current: this.view(row) as unknown as Record<string, unknown> }) }

  list(filter: ActionFilter = {}): ActionCard[] {
    if (!this.h.shown()) return []
    return this.rows.map(r => this.view(r))
      .filter(c => (!filter.states || filter.states.includes(c.state)) && (!filter.chatId || c.chatId === filter.chatId))
      .sort((a, b) => b.askedAt.ms - a.askedAt.ms)
  }
  get(id: string): ActionCard { return this.view(this.find(id)) }

  answer(id: string, ifRev: number, choice: ActionChoice, covers?: BatchCovers): ActionCard {
    const row = this.settled(this.find(id))
    const c = row.card
    if (c.rev !== ifRev || c.state !== 'waiting') this.conflict(row)
    if (choice === 'once' || choice === 'always' || (choice === 'approve' && !c.can.approve)) throw new AgentError('forbidden', "You can't answer this one.")
    // A batch's answer names what it saw: the stored items 1 to `upTo` must add up to the totals it sends.
    const shown = covers ? row.items.filter(i => i.n <= covers.upTo) : []
    if (c.batch) {
      if (!covers || covers.upTo > c.batch.itemCount) throw new AgentError('invalid', 'That answer names items this card doesn’t have.')
      if (covers.totals.records !== sum(shown, 'records') || covers.totals.units !== sum(shown, 'units')) throw new AgentError('conflict', 'This changed before your answer arrived.', { reason: TOTALS_CHANGED })
    } else if (covers) throw new AgentError('invalid', 'Only a batch names its items.')
    const batch = c.batch && covers ? { ...c.batch, itemCount: covers.upTo, totals: { ...c.batch.totals, records: covers.totals.records, units: covers.totals.units } } : c.batch
    if (choice === 'deny') {
      row.card = { ...c, state: 'denied', rev: c.rev + 1, can: NONE, ...(batch ? { batch } : {}) }
      row.items = row.items.map(i => ({ ...i, state: 'withdrawn' as const }))
    } else {
      row.sendAtMs = this.h.now() + DEMO_HOLD_MS
      row.card = { ...c, state: 'approved', rev: c.rev + 1, can: { ...NONE, undo: true }, ...(batch ? { batch } : {}) }
    }
    return this.view(row)
  }

  undo(id: string, ifRev: number): ActionCard {
    const row = this.settled(this.find(id))
    if (row.card.rev !== ifRev || row.card.state !== 'approved') this.conflict(row)
    row.sendAtMs = null
    row.card = { ...row.card, state: 'undone', rev: row.card.rev + 1, can: NONE }
    return this.view(row)
  }

  /** No demo card needs a check, and the signed-in admin asked none they could take back: both are refused as the server would. */
  resolve(id: string, ifRev: number): ActionCard {
    const row = this.settled(this.find(id))
    if (row.card.rev !== ifRev || row.card.state !== NEEDS_CHECK) this.conflict(row)
    throw new AgentError('forbidden', "You can't answer this one.")
  }
  withdraw(id: string, ifRev: number): ActionCard {
    const row = this.settled(this.find(id))
    if (row.card.rev !== ifRev || row.card.state !== 'waiting') this.conflict(row)
    throw new AgentError('forbidden', "You can't answer this one.")
  }

  items(id: string, after: number): ActionItemsPage {
    const row = this.settled(this.find(id))
    if (!row.card.batch) throw new AgentError(NOT_FOUND, "That isn't there any more.")
    const page = row.items.filter(i => i.n > after).slice(0, ITEMS_PAGE)
    const last = page.at(-1)?.n
    return { items: page.map(visible), ...(last !== undefined && last < row.items.length ? { next: last } : {}) }
  }
}
