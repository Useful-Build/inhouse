// The demo's agent actions (Stage 1 M3-U): what the real agent's cards look like, on the invented data in
// sample-data/actions.json. A 450-change batch in a chat of the signed-in admin's, and a teammate's refund that only an
// admin may approve (an admins card, N25). They show in the Normal scenario whatever the stage (the stages are going); in the
// other scenarios the lists are empty and every answer is refused (not found), as before. Answers follow the outbox's rules as the screens
// see them: the rev an answer was read at, a batch's `upTo` and totals as the card showed them, Undo in the 10 second
// hold, and the send at its end, on the demo clock. In memory only: a reload or Reset demo starts them again.
import actionsRaw from '@sample/actions.json'
import type { ActionCard, ActionChoice, ActionFilter, ActionItem, ActionItemsPage, BatchCovers } from './types'
import { AgentError } from './types'
import { NOT_FOUND, TOTALS_CHANGED } from '../../shared/contract/error-codes'
import { NEEDS_CHECK } from '../../shared/contract/action-states'
import { ACTION_ITEMS_PAGE, BATCH_FIRST_LINES } from '../../shared/contract/actions'
import { demoAt } from './demo-clock'
import { instantOf as instant } from '../lib/format'

const raw = actionsRaw as {
  batch: { id: string; chatId: string; title: string; tool: string; itemCount: number; firstOrder: number; line: string; unitsLabel: string; guardrail: 'bulk'; askedAt: string; result: string }
  refund: { id: string; askedBy: string; title: string; lines: string[]; tool: string; askedAt: string; result: string }
}

/** The demo's hold, as the product's (N11). */
export const DEMO_HOLD_MS = 10_000
const NONE: ActionCard['can'] = { allowOnce: false, alwaysAllow: false, approve: false, deny: false, undo: false, resolve: false, withdraw: false }
const TOOL = { accountId: 'shopify:northline-outdoor', label: raw.batch.tool }

export interface MockActionsHost {
  /** Now on the demo clock, epoch ms. */
  now(): number
  /** Whether the scenario shows the demo's actions. */
  shown(): boolean
  /** The signed-in person's member id, and a member id for a sample person. */
  meId: string
  memberId(sampleId: string): string
}

interface Row { card: ActionCard; sendAtMs: number | null; items: ActionItem[] }

const lineOf = (n: number) => raw.batch.line.replace('{n}', String(raw.batch.firstOrder + n - 1))

function batchRow(h: MockActionsHost): Row {
  const b = raw.batch
  const items: ActionItem[] = Array.from({ length: b.itemCount }, (_, i) => ({ n: i + 1, line: lineOf(i + 1), state: 'pending' as const }))
  const firstLines = items.slice(0, BATCH_FIRST_LINES).map(i => i.line)
  return {
    sendAtMs: null, items,
    card: {
      id: b.id, rev: 1, kind: 'exact', state: 'waiting', title: b.title, lines: firstLines, tool: TOOL, records: b.itemCount,
      reachesCustomer: false, reversible: true, guardrail: b.guardrail, chatId: b.chatId, askedBy: h.meId, askedAt: demoAt(b.askedAt),
      serverNow: demoAt(b.askedAt), can: { ...NONE, approve: true, deny: true }, nudgeAlways: false, approverKind: 'person',
      batch: { itemCount: b.itemCount, firstLines, totals: { records: b.itemCount, units: b.itemCount, unitsLabel: b.unitsLabel } },
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
    },
  }
}

export class MockActions {
  private rows: Row[]
  private h: MockActionsHost
  constructor(h: MockActionsHost) { this.h = h; this.rows = this.fresh() }

  private fresh(): Row[] { return [batchRow(this.h), refundRow(this.h)] }
  /** Reset demo: every card waits again. */
  reset() { this.rows = this.fresh() }

  /** The row, sent once its hold has passed on the demo clock (the send itself takes no time here). */
  private settled(row: Row): Row {
    if (row.card.state === 'approved' && row.sendAtMs !== null && this.h.now() >= row.sendAtMs) {
      const n = row.card.batch?.itemCount ?? 0
      row.items = row.items.map(i => (i.n <= n ? { ...i, state: 'sent' as const, result: 'Sent.' } : i))
      const result = row.card.batch ? raw.batch.result.replaceAll('{n}', String(n)) : raw.refund.result
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
    // A batch's answer names what it saw (each of the demo's items is one order: records and units are its count).
    if (c.batch) {
      if (!covers || covers.upTo > c.batch.itemCount) throw new AgentError('invalid', 'That answer names items this card doesn’t have.')
      if (covers.totals.records !== covers.upTo || covers.totals.units !== covers.upTo) throw new AgentError('conflict', 'This changed before your answer arrived.', { reason: TOTALS_CHANGED })
    } else if (covers) throw new AgentError('invalid', 'Only a batch names its items.')
    const batch = c.batch && covers ? { ...c.batch, itemCount: covers.upTo, totals: { ...c.batch.totals, records: covers.upTo, units: covers.upTo } } : c.batch
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
    const page = row.items.filter(i => i.n > after).slice(0, ACTION_ITEMS_PAGE)
    const last = page.at(-1)?.n
    return { items: page, ...(last !== undefined && last < row.items.length ? { next: last } : {}) }
  }
}
