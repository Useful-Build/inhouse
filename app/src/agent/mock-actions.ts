// The demo's agent actions and permissions (Stage 1 M3-U, then the demo catch-up's PR 1): what the real agent's cards and
// its Always allowed list look like, on the invented data in sample-data/actions.json. A 450-change batch in a chat of
// the signed-in admin's, a 12-item restock past their Add stock permission (a table with its total), a teammate's refund
// that only an admin may approve (an admins card, N25), two ask cards (Allow once, Always allow, No; one nudged to Always
// allow), a card that needs a check, a teammate's card the admin can only watch (Waiting on your team), and one that
// went out yesterday under a permission. They show in the Normal scenario (the demo has no stages, as the product); in the
// other scenarios the lists are empty and every answer is refused (not found), as before. Answers follow the outbox's
// rules as the screens see them: the rev an answer was read at, a batch's `upTo` and totals as the card showed them,
// Always allow granting the operation's permission (its default limits), Undo in the 10 second hold and the send at its
// end on the demo clock, a Pause sending a card in its hold back to waiting (with the server's lapse words and a bell
// notice), and no approval while paused. In memory only: a reload or Reset demo starts them again.
import actionsRaw from '@sample/actions.json'
import type { ActionCard, ActionChoice, ActionFilter, ActionItem, ActionItemsPage, ActionResolution, BatchCovers, Permission } from './types'
import { AgentError } from './types'
import { NOT_FOUND, REASON, TOTALS_CHANGED } from '../../shared/contract/error-codes'
import { NEEDS_CHECK } from '../../shared/contract/action-states'
import { demoAt } from './demo-clock'
import { instantOf as instant } from '../lib/format'

type RawBatch = { id: string; chatId: string; title: string; unitsLabel: string; guardrail: 'bulk' | 'count'; askedAt: string } & (
  | { kind: 'tags'; count: number; firstOrder: number; tag: string }
  | { kind: 'restock'; firstItem: number; location: number; reason: string; quantities: number[] }
)
type ToolKey = 'shopify' | 'slack'
/** An operation as the demo knows it: its permission's words and default limits (server/outbox/operations). */
interface RawOperation { title: string; tool: ToolKey; scope: string; unitsLabel: string; perDay: number; unitsMax: number; ceilingPerDay: number; ceilingUnitsMax: number; reversible?: boolean }
/** A one-change card: an ask, one that needs a check, a teammate's, or one that went out under a permission. */
type RawSingle = {
  id: string; operation: string; chatId: string | null; title: string; lines: string[]; askedAt: string; askedBy?: string
  nudge?: boolean; result?: string; permission?: string
  state: 'waiting' | typeof NEEDS_CHECK | 'sent'
}
type RawPermission = { id: string; operation: string; holder: string; grantedBy: string; grantedAt: string }
const raw = actionsRaw as {
  tool: string; shop: string; batches: RawBatch[]; batchResult: string
  refund: { id: string; askedBy: string; title: string; lines: string[]; askedAt: string; result: string }
  tools: Record<ToolKey, { accountId: string; label: string }>
  operations: Record<string, RawOperation>
  singles: RawSingle[]
  resolved: Record<ActionResolution, string>
  lapsed: { paused: string }
  permissions: RawPermission[]
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
const ASK_CAN: ActionCard['can'] = { ...NONE, allowOnce: true, alwaysAllow: true, deny: true }
const TOOL = { accountId: `shopify:${raw.shop}`, label: raw.tool }

export interface MockActionsHost {
  /** Now on the demo clock, epoch ms. */
  now(): number
  /** Whether the scenario shows the demo's actions. */
  shown(): boolean
  /** The signed-in person's member id, and a member id for a sample person. */
  meId: string
  memberId(sampleId: string): string
  /** Whether the agent is paused: no approval is taken then (the outbox's gate). */
  paused(): boolean
  /** A card changed by itself (a Pause sent it back): the `action.updated` the real client hears. */
  changed(u: { actionId: string; rev: number }): void
  /** A card in its hold was sent back by a Pause: the approver's bell notice ("Approval sent back"). */
  sentBack(u: { actionId: string; rev: number; atMs: number }): void
}

/** A demo item, with the records and units the totals count (as the server's item rows hold them). */
type Item = ActionItem & { records: number; units: number }
/**
 * A card, its items, when its hold ends, and what it offers while it waits (so a Pause gives its buttons back). `operation`:
 * a single card's, so Always allow knows what to grant.
 */
interface Row { card: ActionCard; sendAtMs: number | null; items: Item[]; waitingCan: ActionCard['can']; operation?: string }

/** A batch's items in the server's words for its operation (operations/shopify-order-tags.ts, shopify-inventory.ts). */
function itemsOf(b: RawBatch): { items: Item[]; heads?: { ref: string; change: string; amount: string } } {
  if (b.kind === 'tags') {
    // A tag batch is a plain list (no heads); a stock batch is a table.
    return {
      items: Array.from({ length: b.count }, (_, i) => {
        const order = b.firstOrder + i
        return { n: i + 1, line: `Order ${order} (${raw.shop}): add ${b.tag}`, row: { ref: `#${order}`, change: `add ${b.tag}` }, state: 'pending' as const, records: 1, units: 1 }
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

const sum = (items: Item[], k: 'records' | 'units') => items.reduce((n, i) => n + i[k], 0)
const visible = ({ records: _r, units: _u, ...item }: Item): ActionItem => item

function batchRow(h: MockActionsHost, b: RawBatch): Row {
  const { items, heads } = itemsOf(b)
  const first = items.slice(0, FIRST_LINES)
  const firstLines = first.map(i => i.line)
  const can = { ...NONE, approve: true, deny: true }
  return {
    sendAtMs: null, items, waitingCan: can,
    card: {
      id: b.id, rev: 1, kind: 'exact', state: 'waiting', title: b.title, lines: firstLines, tool: TOOL, records: sum(items, 'records'),
      reachesCustomer: false, reversible: true, guardrail: b.guardrail, chatId: b.chatId, askedBy: h.meId, askedAt: demoAt(b.askedAt),
      serverNow: demoAt(b.askedAt), can, nudgeAlways: false, approverKind: 'person',
      batch: {
        itemCount: items.length, firstLines, firstRows: first.map(i => i.row), ...(heads ? { heads } : {}),
        totals: { records: sum(items, 'records'), units: sum(items, 'units'), unitsLabel: b.unitsLabel },
      },
    },
  }
}

function refundRow(h: MockActionsHost): Row {
  const r = raw.refund
  const can = { ...NONE, approve: true, deny: true }
  return {
    sendAtMs: null, items: [], waitingCan: can,
    card: {
      id: r.id, rev: 1, kind: 'exact', state: 'waiting', title: r.title, lines: r.lines, tool: TOOL, records: 1, reachesCustomer: true,
      reversible: false, guardrail: 'money', chatId: null, askedBy: h.memberId(r.askedBy), askedAt: demoAt(r.askedAt), serverNow: demoAt(r.askedAt),
      can, nudgeAlways: false, approverKind: 'admins',
    },
  }
}

function operationOf(key: string): RawOperation {
  const op = Object.hasOwn(raw.operations, key) ? raw.operations[key] : undefined
  if (!op) throw new Error(`Sample data: actions.json names an unknown operation "${key}".`)
  return op
}

function singleRow(h: MockActionsHost, s: RawSingle): Row {
  const op = operationOf(s.operation)
  const mine = s.askedBy === undefined
  // Only the asker answers their own ask (N15): an admin sees a teammate's with no buttons, under Waiting on your team.
  const waitingCan = mine ? ASK_CAN : NONE
  const can = s.state === 'waiting' ? waitingCan : s.state === NEEDS_CHECK && mine ? { ...NONE, resolve: true } : NONE
  if (s.state !== 'waiting' && s.result === undefined) throw new Error(`Sample data: the card "${s.title}" has settled but says no result.`)
  return {
    sendAtMs: null, items: [], waitingCan, operation: s.operation,
    card: {
      id: s.id, rev: 1, kind: 'ask', state: s.state, title: s.title, lines: s.lines, tool: raw.tools[op.tool], records: 1, reachesCustomer: false,
      reversible: op.reversible ?? true, chatId: s.chatId, askedBy: mine ? h.meId : h.memberId(s.askedBy!), askedAt: demoAt(s.askedAt),
      serverNow: demoAt(s.askedAt), can, nudgeAlways: !!s.nudge, approverKind: 'person',
      ...(s.result !== undefined ? { result: s.result } : {}), ...(s.permission ? { permissionId: s.permission } : {}),
    },
  }
}

/** A permission as `permissions()` lists it: the operation's words and its limits under the Inhouse team's ceiling. */
interface Grant { id: string; rev: number; operation: string; holder: string; grantedBy: string; grantedAt: number }
function permissionOf(g: Grant): Permission {
  const op = operationOf(g.operation)
  return {
    id: g.id, rev: g.rev, holder: { kind: 'member', memberId: g.holder }, operation: g.operation, title: op.title, tool: raw.tools[op.tool],
    scope: op.scope, perDay: op.perDay,
    limits: { perDay: op.perDay, unitsMax: Math.min(op.unitsMax, op.ceilingUnitsMax), unitsLabel: op.unitsLabel, effectivePerDay: Math.min(op.perDay, op.ceilingPerDay) },
    grantedBy: g.grantedBy, grantedAt: instant(g.grantedAt),
    // The demo's person is an admin, who may remove anyone's (N15).
    can: { remove: true },
  }
}

export class MockActions {
  private rows: Row[]
  private grants: Grant[]
  /** How many permissions Always allow has made, for their ids. */
  private granted = 0
  private h: MockActionsHost
  constructor(h: MockActionsHost) { this.h = h; this.rows = this.fresh(); this.grants = this.freshGrants() }

  private fresh(): Row[] { return [...raw.batches.map(b => batchRow(this.h, b)), refundRow(this.h), ...raw.singles.map(s => singleRow(this.h, s))] }
  private freshGrants(): Grant[] {
    return raw.permissions.map(p => ({ id: p.id, rev: 1, operation: p.operation, holder: this.h.memberId(p.holder), grantedBy: this.h.memberId(p.grantedBy), grantedAt: demoAt(p.grantedAt).ms }))
  }
  /** Reset demo: every card waits again, and only the seeded permissions stand. */
  reset() { this.rows = this.fresh(); this.grants = this.freshGrants(); this.granted = 0 }

  /** The row, sent once its hold has passed on the demo clock (the send itself takes no time here). */
  private settled(row: Row): Row {
    if (row.card.state === 'approved' && row.sendAtMs !== null && this.h.now() >= row.sendAtMs) {
      const n = row.card.batch?.itemCount ?? 0
      row.items = row.items.map(i => (i.n <= n ? { ...i, state: 'sent' as const, result: 'Sent.' } : i))
      const result = row.card.batch ? raw.batchResult.replaceAll('{n}', String(n)) : row.card.id === raw.refund.id ? raw.refund.result : raw.resolved.sent
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
    const allowed = choice === 'once' ? c.can.allowOnce : choice === 'always' ? c.can.alwaysAllow : choice === 'approve' ? c.can.approve : c.can.deny
    if (!allowed) throw new AgentError('forbidden', "You can't answer this one.")
    // The outbox's gate: no approval while the agent is paused (server/outbox/store.ts), with no card in the refusal.
    if (choice !== 'deny' && this.h.paused()) throw new AgentError('conflict', 'The agent is paused.', { reason: REASON.paused })
    // A batch's answer names what it saw: the stored items 1 to `upTo` must add up to the totals it sends.
    const shown = covers ? row.items.filter(i => i.n <= covers.upTo) : []
    if (c.batch) {
      if (!covers || covers.upTo > c.batch.itemCount) throw new AgentError('invalid', 'That answer names items this card doesn’t have.')
      if (covers.totals.records !== sum(shown, 'records') || covers.totals.units !== sum(shown, 'units')) throw new AgentError('conflict', 'This changed before your answer arrived.', { reason: TOTALS_CHANGED })
    } else if (covers) throw new AgentError('invalid', 'Only a batch names its items.')
    const batch = c.batch && covers ? { ...c.batch, itemCount: covers.upTo, totals: { ...c.batch.totals, records: covers.totals.records, units: covers.totals.units } } : c.batch
    // A lapse said why the card waited again; an answer moves past it.
    const { lapsed: _lapsed, ...rest } = c
    if (choice === 'deny') {
      row.card = { ...rest, state: 'denied', rev: c.rev + 1, can: NONE, ...(batch ? { batch } : {}) }
      row.items = row.items.map(i => ({ ...i, state: 'withdrawn' as const }))
    } else {
      // Always allow grants the operation's permission to the asker, with its default limits (N10, N23), and the card goes
      // out under it.
      const permissionId = choice === 'always' && row.operation ? this.grant(row.operation, c.askedBy) : undefined
      row.sendAtMs = this.h.now() + DEMO_HOLD_MS
      row.card = { ...rest, state: 'approved', rev: c.rev + 1, can: { ...NONE, undo: true }, ...(batch ? { batch } : {}), ...(permissionId ? { permissionId } : {}) }
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

  /** "It went out" or "It didn't go out" on a card that needs a check: only its approver (or an admin) says. */
  resolve(id: string, ifRev: number, outcome: ActionResolution): ActionCard {
    const row = this.settled(this.find(id))
    if (row.card.rev !== ifRev || row.card.state !== NEEDS_CHECK) this.conflict(row)
    if (!row.card.can.resolve) throw new AgentError('forbidden', "You can't answer this one.")
    row.card = { ...row.card, state: outcome, rev: row.card.rev + 1, can: NONE, result: raw.resolved[outcome] }
    return this.view(row)
  }
  /** The signed-in admin asked no card someone else answers: a withdraw is refused as the server would. */
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

  /**
   * The agent was paused (N12): every card still in its hold goes back to waiting, with the server's words for why, its
   * buttons back, and a notice to its approver. One that already went out stays sent.
   */
  pause() {
    const atMs = this.h.now()
    for (const row of this.rows) {
      this.settled(row)
      if (row.card.state !== 'approved') continue
      const { permissionId: _p, ...card } = row.card
      row.sendAtMs = null
      row.card = { ...card, state: 'waiting', rev: card.rev + 1, can: row.waitingCan, lapsed: raw.lapsed.paused }
      row.items = row.items.map(i => ({ ...i, state: 'pending' as const }))
      this.h.changed({ actionId: card.id, rev: row.card.rev })
      this.h.sentBack({ actionId: card.id, rev: row.card.rev, atMs })
    }
  }

  // ---------- permissions (Settings > Always allowed, Activity's "Stop allowing this") ----------

  /** This admin's view: everyone's permissions, newest first. */
  permissions(): Permission[] {
    if (!this.h.shown()) return []
    return [...this.grants].sort((a, b) => b.grantedAt - a.grantedAt).map(permissionOf)
  }
  /** Stops one permission at the rev it was read at; a stale rev is a conflict with the permission as it is now. */
  removePermission(id: string, ifRev: number): Permission[] {
    const g = this.h.shown() ? this.grants.find(x => x.id === id) : undefined
    if (!g) throw new AgentError(NOT_FOUND, 'This permission was already removed.')
    if (g.rev !== ifRev) throw new AgentError('conflict', 'This permission changed first.', { current: permissionOf(g) as unknown as Record<string, unknown> })
    this.grants = this.grants.filter(x => x !== g)
    return this.permissions()
  }
  /** The holder's permission for this operation, made now unless one stands already (one grant per holder, operation and scope). */
  private grant(operation: string, holder: string): string {
    const have = this.grants.find(g => g.operation === operation && g.holder === holder)
    if (have) return have.id
    const id = `pg_demoAllowed${String(++this.granted).padStart(11, '0')}`
    this.grants.push({ id, rev: 1, operation, holder, grantedBy: this.h.meId, grantedAt: this.h.now() })
    return id
  }
}
