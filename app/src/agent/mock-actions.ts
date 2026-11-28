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
// notice), and no approval while paused. Demo catch-up PR 3 adds: the agent's questions (Approvals' "Questions for you", an
// answer closes one and the agent's next line joins its chat), the follow-up the agent adds to a chat once a card it asked
// is settled (the late answer), a batch that partly went out (its failed items in the full list), a draft order and a
// stock reduction that went out, the Inhouse ceiling's seven rows (read-only: editing is off, as in a deployable build),
// the alerts channel's standing permission (an admin's mark gives it), and the "View as" switch: a Member sees only their
// own cards, and an admins card of theirs waits for an admin until they withdraw it. In memory only: a reload or Reset demo
// starts them again.
import actionsRaw from '@sample/actions.json'
import type { ActionCard, ActionChoice, ActionFilter, ActionItem, ActionItemsPage, ActionResolution, BatchCovers, CeilingList, CeilingRow, MessagePart, Permission, Question, StoredMessage } from './types'
import { AgentError } from './types'
import { FORBIDDEN, NOT_FOUND, REASON, TOTALS_CHANGED } from '../../shared/contract/error-codes'
import { WRITES_OFF } from '../../shared/contract/ceiling-codes'
import { NEEDS_CHECK } from '../../shared/contract/action-states'
import { demoAt } from './demo-clock'
import { instantOf as instant } from '../lib/format'

type RawBatch = { id: string; chatId: string; title: string; unitsLabel: string; guardrail: 'bulk' | 'count'; askedAt: string } & (
  | { kind: 'tags'; count: number; firstOrder: number; tag: string; customers: [string, string][] }
  | { kind: 'restock'; firstItem: number; location: number; reason: string; quantities: number[] }
) & {
  /** A batch that has already gone out, in part: the positions of the items that didn't (M3-B, "447 of 450 went out"). */
  settled?: { failed: number[]; approvedAt: string }
}
type ToolKey = 'shopify' | 'slack'
/** An operation as the demo knows it: its permission's words and default limits (server/outbox/operations). */
interface RawOperation {
  title: string; tool: ToolKey; scope: string; unitsLabel: string
  /** The default grant's limits; null for an operation no grant covers (it is always an exact approval, N24). */
  perDay: number | null; unitsMax: number | null
  ceilingPerDay: number; ceilingUnitsMax: number; reversible?: boolean
}
/** A one-change card: an ask, one that needs a check, a teammate's, or one that went out under a permission. */
type RawSingle = {
  id: string; operation: string; chatId: string | null; title: string; lines: string[]; askedAt: string; askedBy?: string
  nudge?: boolean; result?: string; permission?: string
  /** An operation that always needs an exact approval (a stock reduction: destructive), with Approve and No instead of Allow once. */
  exact?: boolean
  /** A tag card's order, as the store described it: its customer and total (#488's card details). */
  order?: { number: number; customer: string; amount: string }
  /** A draft order's lines, as the store described them: product, SKU and quantity (#488's card details). */
  details?: NonNullable<ActionCard['detail']>['rows']
  state: 'waiting' | typeof NEEDS_CHECK | 'sent'
}
type RawPermission = { id: string; operation: string; holder: string; grantedBy: string; grantedAt: string }
/** A question the agent asked this person (actions.json `questions`): `next` is the agent's next line in its chat, per option. */
type RawQuestion = { id: string; askedAt: string; chatId: string | null; question: string; options: string[]; next?: Record<string, string> }
/** One operation's row of the Inhouse ceiling, as the page reads it (server/api/ceiling-store.ts `rowOf`). */
type RawCeiling = Omit<CeilingRow, 'rev' | 'updatedAt' | 'updatedBy'>
/** A message of a chat the agent keeps (its history is read, not seeded): the same shape as the job chats' (jobs.json). */
type RawMessage = { id: string; role: 'user' | 'agent'; text?: string; part?: MessagePart; trace?: string; model?: string; at: string; turnId: string; runId: string }
const raw = actionsRaw as {
  tool: string; shop: string; batches: RawBatch[]; batchResult: string
  refund: { id: string; askedBy: string; title: string; lines: string[]; askedAt: string; order: number; customer: string; amount: string; result: string }
  ceilingSetAt: string
  ceiling: RawCeiling[]
  questions: RawQuestion[]
  chats: Record<string, { messages: RawMessage[] }>
  /** What the agent says in a chat once a card it asked is settled: its turn and run, and the line for a card that went out or was refused. */
  resumes: Record<string, { turn: string; run: string; sent: string; denied: string }>
  late: { event: string; trace: string; questionTurns: Record<string, { turn: string; run: string }> }
  tools: Record<ToolKey, { accountId: string; label: string }>
  operations: Record<string, RawOperation>
  singles: RawSingle[]
  resolved: Record<ActionResolution, string>
  lapsed: { paused: string; permission_removed: string; channel_not_listed: string }
  permissions: RawPermission[]
}

/**
 * Items per page of the full list, and the lines a batch card carries (shared/contract/actions.ts's ACTION_ITEMS_PAGE
 * and BATCH_FIRST_LINES, written out here: that module brings zod, which the demo's bundle can't carry;
 * mock-actions.test.ts holds them equal).
 */
export const ITEMS_PAGE = 100
export const FIRST_LINES = 10
/** How long after a card settles (or a question is answered) the agent picks its chat up again. */
const RESUME_AFTER_MS = 3_000
/** The server's words for a refused ceiling change (the outbox words for a switched-off build, server/outbox/words.ts). */
const WRITES_OFF_TEXT = 'Changing what the agent can do is switched off in this build, so nothing changed.'
/** The demo's hold, as the product's (N11). */
export const DEMO_HOLD_MS = 10_000
const NONE: ActionCard['can'] = { allowOnce: false, alwaysAllow: false, approve: false, deny: false, undo: false, resolve: false, withdraw: false }
const ASK_CAN: ActionCard['can'] = { ...NONE, allowOnce: true, alwaysAllow: true, deny: true }
const TOOL = { accountId: `shopify:${raw.shop}`, label: raw.tool }
/** The refund as its asker, a member, sees it (the "View as" switch): the card is theirs, so only they can take it back. */
const MEMBER_REFUND = 'ac_demoSamRefund000000000'
/** Whom an admins card waits for, as the server says it (server/outbox/words.ts `WAITING_FOR_ADMIN`). */
const WAITING_FOR_ADMIN = 'an admin'
/** The brand's own grant, held by no one member: what an admin's alerts mark gives (M2-N). */
const BRAND = 'brand'
const POST = 'slack.channel.post'

export interface MockActionsHost {
  /** Now on the demo clock, epoch ms. */
  now(): number
  /** Whether the scenario shows the demo's actions. */
  shown(): boolean
  /** Whether the brand has this tool: a brand with no Slack (the demo's brand override) has no Slack card or permission. */
  hasTool(tool: ToolKey): boolean
  /** The Slack channels the brand lists now (Settings > Slack notices, mock-notify.ts), by name. */
  listedChannels(): readonly string[]
  /** The signed-in person's member id, and a member id for a sample person. */
  meId: string
  memberId(sampleId: string): string
  /** What the signed-in person is now (the demo's "View as"): an admin sees everyone's cards, a member only their own. */
  role(): 'admin' | 'member'
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
interface Row {
  card: ActionCard; sendAtMs: number | null; items: Item[]; waitingCan: ActionCard['can']; operation?: string
  /** When the card became final (it went out, or was said no to): the agent picks the chat up again just after (the late answer). */
  finalAtMs?: number
  /** A card only one of the two views has: the admin's view of a teammate's refund, the member's own (the same card, asked by them). */
  only?: 'admin' | 'member'
}

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
          detail: orderDetail(order, customer, total),
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
/** One order's detail row, as the real card carries it (#488): its name, customer and total. */
const orderDetail = (order: number, customer: string, amount: string): NonNullable<ActionCard['detail']> =>
  ({ rows: [{ ref: `Order ${order}`, order: `#${order}`, customer, amount: usd(amount), currency: 'USD' }] })

const sum = (items: Item[], k: 'records' | 'units') => items.reduce((n, i) => n + i[k], 0)
const visible = ({ records: _r, units: _u, ...item }: Item): ActionItem => item

function batchRow(h: MockActionsHost, b: RawBatch): Row {
  const { items, heads } = itemsOf(b)
  const settled = b.settled
  const first = items.slice(0, FIRST_LINES)
  const firstLines = first.map(i => i.line)
  const can = { ...NONE, approve: true, deny: true }
  // One that already went out in part (M3-B): each item went out or didn't, and the card says how many did, in the server's words.
  const failed = new Set(settled?.failed ?? [])
  const done = settled ? items.map(i => (failed.has(i.n) ? { ...i, state: 'failed' as const, result: raw.resolved.failed } : { ...i, state: 'sent' as const, result: raw.resolved.sent })) : items
  return {
    sendAtMs: null, items: done, waitingCan: can,
    card: {
      id: b.id, rev: settled ? 3 : 1, kind: 'exact', state: settled ? 'sent' : 'waiting', title: b.title, lines: firstLines, tool: TOOL, records: sum(items, 'records'),
      reachesCustomer: false, reversible: true, guardrail: b.guardrail, chatId: b.chatId, askedBy: h.meId, askedAt: demoAt(b.askedAt),
      serverNow: demoAt(b.askedAt), can: settled ? NONE : can, nudgeAlways: false, approverKind: 'person',
      ...(settled ? { result: `${raw.resolved.sent} ${items.length - failed.size} of ${items.length} went out` } : {}),
      batch: {
        itemCount: items.length, firstLines, firstRows: first.map(i => i.row), ...(heads ? { heads } : {}),
        ...(first.some(i => i.detail) ? { firstDetails: first.map(i => i.detail ?? null) } : {}),
        totals: { records: sum(items, 'records'), units: sum(items, 'units'), unitsLabel: b.unitsLabel },
      },
    },
  }
}

/** The refund an admin sees (a teammate's, theirs to answer), or, as a member, the same refund asked by them: it waits for an admin. */
function refundRow(h: MockActionsHost, view: 'admin' | 'member'): Row {
  const r = raw.refund
  const mine = view === 'member'
  const can = mine ? { ...NONE, withdraw: true } : { ...NONE, approve: true, deny: true }
  return {
    sendAtMs: null, items: [], waitingCan: can, only: view,
    card: {
      id: mine ? MEMBER_REFUND : r.id, rev: 1, kind: 'exact', state: 'waiting', title: r.title, lines: r.lines, tool: TOOL, records: 1, reachesCustomer: true,
      reversible: false, guardrail: 'money', chatId: null, askedBy: mine ? h.meId : h.memberId(r.askedBy), askedAt: demoAt(r.askedAt), serverNow: demoAt(r.askedAt),
      can, nudgeAlways: false, approverKind: 'admins', ...(mine ? { waitingFor: WAITING_FOR_ADMIN } : {}),
      detail: orderDetail(r.order, r.customer, r.amount),
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
  // Only the asker answers their own ask (N15): an admin sees a teammate's with no buttons, under Waiting on your team. An
  // operation that is always exact (a stock reduction: it can't be undone) offers Approve and No, never Always allow.
  const waitingCan = mine ? (s.exact ? { ...NONE, approve: true, deny: true } : ASK_CAN) : NONE
  const can = s.state === 'waiting' ? waitingCan : s.state === NEEDS_CHECK && mine ? { ...NONE, resolve: true } : NONE
  if (s.state !== 'waiting' && s.result === undefined) throw new Error(`Sample data: the card "${s.title}" has settled but says no result.`)
  return {
    sendAtMs: null, items: [], waitingCan, operation: s.operation,
    card: {
      id: s.id, rev: 1, kind: s.exact ? 'exact' : 'ask', state: s.state, title: s.title, lines: s.lines, tool: raw.tools[op.tool], records: 1, reachesCustomer: false,
      ...(s.exact ? { guardrail: 'destructive' as const } : {}), reversible: op.reversible ?? true, chatId: s.chatId, askedBy: mine ? h.meId : h.memberId(s.askedBy!), askedAt: demoAt(s.askedAt),
      serverNow: demoAt(s.askedAt), can, nudgeAlways: !!s.nudge, approverKind: 'person',
      ...(s.result !== undefined ? { result: s.result } : {}), ...(s.permission ? { permissionId: s.permission } : {}),
      ...(s.order ? { detail: orderDetail(s.order.number, s.order.customer, s.order.amount) } : s.details ? { detail: { rows: s.details } } : {}),
    },
  }
}

/** A permission as `permissions()` lists it: the operation's words and its limits under the Inhouse team's ceiling. */
interface Grant { id: string; rev: number; operation: string; holder: string; grantedBy: string; grantedAt: number; scope?: string }
/** Where a grant applies: its own scope (the alerts channel's), else its operation's. */
const scopeOf = (g: Grant): string => g.scope ?? operationOf(g.operation).scope
/** An operation's default grant: one no grant covers (always exact) has none, and a permission naming it is a bug, so it fails loud. */
function grantOf(operation: string): { perDay: number; unitsMax: number } {
  const { perDay, unitsMax } = operationOf(operation)
  if (perDay === null || unitsMax === null) throw new Error(`Sample data: "${operation}" has no grant, so no permission can name it.`)
  return { perDay, unitsMax }
}
/** The most a grant lets through in a day: the grant's own count under the Inhouse team's ceiling (N23). */
const effectivePerDay = (operation: string): number => Math.min(grantOf(operation).perDay, operationOf(operation).ceilingPerDay)
function permissionOf(g: Grant, admin: boolean): Permission {
  const op = operationOf(g.operation)
  return {
    id: g.id, rev: g.rev, holder: g.holder === BRAND ? { kind: 'brand' } : { kind: 'member', memberId: g.holder }, operation: g.operation, title: op.title, tool: raw.tools[op.tool],
    scope: scopeOf(g), perDay: grantOf(g.operation).perDay,
    limits: { perDay: grantOf(g.operation).perDay, unitsMax: Math.min(grantOf(g.operation).unitsMax, op.ceilingUnitsMax), unitsLabel: op.unitsLabel, effectivePerDay: effectivePerDay(g.operation) },
    grantedBy: g.grantedBy, grantedAt: instant(g.grantedAt),
    // An admin may remove anyone's, a member only their own, and the brand's is an admin's to remove (N15).
    can: { remove: admin || g.holder !== BRAND },
  }
}

/** A question as the agent holds it: what it asked, and the answer once there is one. */
interface QRow { q: Question; next?: Record<string, string> }

export class MockActions {
  private rows: Row[]
  private grants: Grant[]
  private asked: QRow[]
  /** How many permissions Always allow has made, for their ids. */
  private granted = 0
  private h: MockActionsHost
  constructor(h: MockActionsHost) { this.h = h; this.rows = this.fresh(); this.grants = this.freshGrants(); this.asked = this.freshQuestions() }

  private fresh(): Row[] {
    return [...raw.batches.map(b => batchRow(this.h, b)), refundRow(this.h, 'admin'), refundRow(this.h, 'member'), ...raw.singles.map(s => singleRow(this.h, s))]
  }
  /** The questions asked of this person, open: each lives 7 days (the server's expiry). */
  private freshQuestions(): QRow[] {
    return raw.questions.map(r => ({
      next: r.next,
      q: {
        id: r.id, state: 'open', question: r.question, options: r.options, chatId: r.chatId, askedAt: demoAt(r.askedAt),
        expiresAt: instant(demoAt(r.askedAt).ms + 7 * 86_400_000), answer: null, answeredBy: null, answeredAt: null,
      },
    }))
  }
  private freshGrants(): Grant[] {
    return raw.permissions.map(p => ({ id: p.id, rev: 1, operation: p.operation, holder: this.h.memberId(p.holder), grantedBy: this.h.memberId(p.grantedBy), grantedAt: demoAt(p.grantedAt).ms }))
  }
  /** The outbox's words for why an approval went back to waiting (a Pause, a removed permission, a channel that left the list). */
  lapseText(why: 'paused' | 'channel'): string { return why === 'paused' ? raw.lapsed.paused : raw.lapsed.channel_not_listed }
  /** Reset demo: every card waits again, and only the seeded permissions stand. */
  reset() { this.rows = this.fresh(); this.grants = this.freshGrants(); this.asked = this.freshQuestions(); this.granted = 0 }

  /** The row, sent once its hold has passed on the demo clock (the send itself takes no time here). */
  private settled(row: Row): Row {
    if (row.card.state === 'approved' && row.sendAtMs !== null && this.h.now() >= row.sendAtMs) {
      // The claim checks the post's scope again (server/outbox/claim.ts): a channel that isn't listed lapses it, it doesn't go out.
      if (row.operation && !this.listed(row.operation)) { this.sendBack(row, raw.lapsed.channel_not_listed); return row }
      const n = row.card.batch?.itemCount ?? 0
      row.items = row.items.map(i => (i.n <= n ? { ...i, state: 'sent' as const, result: 'Sent.' } : i))
      const result = row.card.batch ? raw.batchResult.replaceAll('{n}', String(n)) : row.card.id === raw.refund.id ? raw.refund.result : raw.resolved.sent
      row.card = { ...row.card, state: 'sent', rev: row.card.rev + 1, can: NONE, result }
      row.finalAtMs = row.sendAtMs
      row.sendAtMs = null
    }
    return row
  }
  private view(row: Row): ActionCard {
    const { card } = this.settled(row)
    return { ...card, serverNow: instant(this.h.now()), ...(row.sendAtMs !== null ? { sendAt: instant(row.sendAtMs) } : {}) }
  }
  /** The rows the brand has: none where the scenario hides them, none on a tool it lacks. */
  private present(): Row[] {
    if (!this.h.shown()) return []
    // A member sees only their own cards (route 120): not a teammate's, and the refund only as theirs, waiting for an admin.
    const view = this.h.role()
    return this.rows.filter(r => (!r.operation || this.h.hasTool(operationOf(r.operation).tool)) && (r.only ?? view) === view && (view === 'admin' || r.card.askedBy === this.h.meId))
  }
  private find(id: string): Row {
    const row = this.present().find(r => r.card.id === id)
    if (!row) throw new AgentError(NOT_FOUND, "That isn't there any more.")
    return row
  }
  private conflict(row: Row): never { throw new AgentError('conflict', 'This changed before your answer arrived.', { current: this.view(row) as unknown as Record<string, unknown> }) }

  list(filter: ActionFilter = {}): ActionCard[] {
    return this.present().map(r => this.view(r))
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
      row.finalAtMs = this.h.now()
    } else {
      // Always allow grants the operation's permission to the asker, with its default limits (N10, N23), and the card goes
      // out under it.
      // A channel that isn't listed gets no permission (one for it can't stand, #653): the answer goes through the hold and lapses at its end.
      const permissionId = choice === 'always' && row.operation && this.listed(row.operation) ? this.grant(row.operation, c.askedBy) : undefined
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
  /**
   * The asker takes back an admins card they asked (N25): the member's own refund. An admin asked none that someone else
   * answers, so for them it is refused as the server would.
   */
  withdraw(id: string, ifRev: number): ActionCard {
    const row = this.settled(this.find(id))
    if (row.card.rev !== ifRev || row.card.state !== 'waiting') this.conflict(row)
    if (!row.card.can.withdraw) throw new AgentError('forbidden', "You can't answer this one.")
    const { waitingFor: _w, ...card } = row.card
    row.card = { ...card, state: 'withdrawn', rev: card.rev + 1, can: NONE }
    return this.view(row)
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
    for (const row of this.rows) {
      this.settled(row)
      if (row.card.state === 'approved') this.sendBack(row, raw.lapsed.paused)
    }
  }
  /**
   * A card in its hold goes back to waiting (N12): with the server's words for why, its buttons back, no permission behind
   * it any more, an `action.updated` and a notice to its approver.
   */
  private sendBack(row: Row, why: string) {
    const { permissionId: _p, ...card } = row.card
    row.sendAtMs = null
    row.card = { ...card, state: 'waiting', rev: card.rev + 1, can: row.waitingCan, lapsed: why }
    row.items = row.items.map(i => ({ ...i, state: 'pending' as const }))
    this.h.changed({ actionId: card.id, rev: row.card.rev })
    this.h.sentBack({ actionId: card.id, rev: row.card.rev, atMs: this.h.now() })
  }

  // ---------- permissions (Settings > Always allowed, Activity's "Stop allowing this") ----------

  /** An admin's view: everyone's permissions and the brand's; a member's: their own. Newest first. */
  permissions(): Permission[] {
    const admin = this.h.role() === 'admin'
    return this.presentGrants().sort((a, b) => b.grantedAt - a.grantedAt).map(g => permissionOf(g, admin))
  }
  private presentGrants(): Grant[] {
    if (!this.h.shown()) return []
    const admin = this.h.role() === 'admin'
    return this.grants.filter(g => this.h.hasTool(operationOf(g.operation).tool) && this.grantListed(g) && (admin || g.holder === this.h.meId))
  }
  /** Whether an operation's channel, if it posts to one, is listed (#653): a permission for an unlisted one can't stand. */
  private listed(operation: string): boolean {
    const op = operationOf(operation)
    return op.tool !== 'slack' || this.h.listedChannels().includes(op.scope.replace(/^#/, ''))
  }
  private grantListed(g: Grant): boolean { return operationOf(g.operation).tool !== 'slack' || this.h.listedChannels().includes(scopeOf(g).replace(/^#/, '')) }
  /**
   * The channel list changed (#653): a permission to post to a channel no longer listed is revoked, and a post still in
   * its hold goes back to waiting with the server's words, as the product's unlisting does.
   */
  channelsChanged() {
    this.grants = this.grants.filter(g => this.grantListed(g))
    for (const row of this.rows) {
      this.settled(row)
      if (row.card.state === 'approved' && row.operation && !this.listed(row.operation)) this.sendBack(row, raw.lapsed.channel_not_listed)
    }
  }
  /** Stops one permission at the rev it was read at; a stale rev is a conflict with the permission as it is now. */
  removePermission(id: string, ifRev: number): Permission[] {
    const g = this.presentGrants().find(x => x.id === id)
    if (!g) throw new AgentError(NOT_FOUND, 'This permission was already removed.')
    const admin = this.h.role() === 'admin'
    if (g.rev !== ifRev) throw new AgentError('conflict', 'This permission changed first.', { current: permissionOf(g, admin) as unknown as Record<string, unknown> })
    if (!permissionOf(g, admin).can.remove) throw new AgentError(FORBIDDEN, "You can't remove this permission.")
    this.endGrant(g)
    return this.permissions()
  }
  /** A grant ends: a card still in its hold under it doesn't go out (#658), it waits for an OK again, as the server's. */
  private endGrant(g: Grant) {
    this.grants = this.grants.filter(x => x !== g)
    for (const row of this.rows) {
      this.settled(row)
      if (row.card.state === 'approved' && row.card.permissionId === g.id) this.sendBack(row, raw.lapsed.permission_removed)
    }
  }
  /** The holder's permission for this operation, made now unless one stands already (one grant per holder, operation and scope). */
  private grant(operation: string, holder: string, scope?: string): string {
    const have = this.grants.find(g => g.operation === operation && g.holder === holder && scopeOf(g) === (scope ?? operationOf(operation).scope))
    if (have) return have.id
    const id = `pg_demoAllowed${String(++this.granted).padStart(11, '0')}`
    this.grants.push({ id, rev: 1, operation, holder, grantedBy: this.h.meId, grantedAt: this.h.now(), ...(scope ? { scope } : {}) })
    return id
  }
  /**
   * The alerts mark moved (M2-N: "an admin marking a channel for alerts is the brand's grant for that channel", N27): the
   * brand's old standing permission to post ends, and an admin's mark onto `channel` (null: off every channel) makes a new
   * one, for the whole team, at the operation's default limit. The Inhouse team's mark gives none, and neither does a
   * member's (a member can't mark).
   */
  markAlerts(channel: string | null) {
    const old = this.grants.find(g => g.operation === POST && g.holder === BRAND)
    if (old) this.endGrant(old)
    if (channel !== null && this.h.role() === 'admin') this.grant(POST, BRAND, `#${channel}`)
  }
  /** The alerts channel's standing permission as the channel list names it (`NotifyChannel.permission`), or none. */
  alertsPermission(channel: string): { id: string; scope: string; perDay: number } | undefined {
    const g = this.grants.find(x => x.operation === POST && x.holder === BRAND && scopeOf(x) === `#${channel}`)
    return g && this.h.shown() ? { id: g.id, scope: scopeOf(g), perDay: effectivePerDay(POST) } : undefined
  }

  // ---------- questions (Approvals' "Questions for you") ----------

  /** The open questions asked of this person, oldest first (route 140). Only where the scenario shows the demo's actions. */
  questions(): Question[] {
    if (!this.h.shown()) return []
    return this.asked.filter(r => r.q.state === 'open').map(r => r.q).sort((a, b) => a.askedAt.ms - b.askedAt.ms)
  }
  /** The person's choice, exactly one of the options: it closes the question, and the agent's next line joins its chat. */
  answerQuestion(id: string, choice: string): Question {
    const row = this.asked.find(r => r.q.id === id)
    if (!row || !this.h.shown()) throw new AgentError(NOT_FOUND, "That isn't there any more.")
    // Answered already (here or by someone else): the question as it is now, so the card says so.
    if (row.q.state !== 'open') throw new AgentError('conflict', 'This changed before your answer arrived.', { current: row.q as unknown as Record<string, unknown> })
    if (!row.q.options.includes(choice)) throw new AgentError('invalid', 'Choose one of the options.')
    row.q = { ...row.q, state: 'answered', answer: choice, answeredBy: this.h.meId, answeredAt: instant(this.h.now()) }
    return row.q
  }

  // ---------- the agent's follow-up in a chat it keeps (the late answer) ----------

  /**
   * The messages of a chat the agent keeps (its history is read, not seeded): what it said, then what it added after each
   * card it asked was settled and each question was answered (the agent picks the chat up again: an action's resume turn
   * shows its note, a question's shows none). Positions follow the order they happened.
   */
  messages(chatId: string): StoredMessage[] {
    if (!Object.hasOwn(raw.chats, chatId)) return []
    const out: StoredMessage[] = raw.chats[chatId]!.messages.map(m => {
      const at = demoAt(m.at)
      const base = { id: m.id, turnId: m.turnId, runId: m.runId, pos: 0, at }
      return m.role === 'user' ? { ...base, role: 'user' as const, text: m.text! } : { ...base, role: 'agent' as const, part: m.part!, trace: m.trace!, model: m.model! }
    })
    const late: { at: number; list: StoredMessage[] }[] = []
    const reply = (turn: string, run: string, atMs: number, text: string, note: boolean) => {
      const at = instant(atMs)
      const list: StoredMessage[] = [
        ...(note ? [{ id: `${turn}.u`, role: 'event' as const, text: raw.late.event, turnId: turn, runId: run, pos: 0, at }] : []),
        { id: `${turn}.0`, role: 'agent' as const, part: { type: 'text' as const, text }, trace: raw.late.trace, model: 'sonnet', turnId: turn, runId: run, pos: 0, at },
      ]
      late.push({ at: atMs, list })
    }
    for (const row of this.rows) {
      const r = Object.hasOwn(raw.resumes, row.card.id) ? raw.resumes[row.card.id] : undefined
      if (!r || row.card.chatId !== chatId) continue
      const c = this.settled(row).card
      if ((c.state === 'sent' || c.state === 'denied') && row.finalAtMs !== undefined) reply(r.turn, r.run, row.finalAtMs + RESUME_AFTER_MS, c.state === 'sent' ? r.sent : r.denied, true)
    }
    for (const row of this.asked) {
      const t = Object.hasOwn(raw.late.questionTurns, row.q.id) ? raw.late.questionTurns[row.q.id] : undefined
      const line = row.q.answer !== null ? row.next?.[row.q.answer] : undefined
      if (t && line !== undefined && row.q.chatId === chatId && row.q.answeredAt) reply(t.turn, t.run, row.q.answeredAt.ms + RESUME_AFTER_MS, line, false)
    }
    return [...out, ...late.sort((a, b) => a.at - b.at).flatMap(l => l.list)].map((m, pos) => ({ ...m, pos }))
  }

  // ---------- the Inhouse ceiling (Settings > What the agent can do) ----------

  /**
   * Every operation's row, as the page reads them: the Inhouse team's values, read-only, since editing is off in a deployable
   * build (`CEILING_EDIT_ON` is false, N2). Only admins and the Inhouse team read it (route 150): a member is refused.
   */
  ceiling(): CeilingList {
    if (this.h.role() === 'member') throw new AgentError(FORBIDDEN, 'Only admins and the Inhouse team can see this.')
    const at = demoAt(raw.ceilingSetAt)
    return {
      items: raw.ceiling.map((r): CeilingRow => ({ ...r, rev: 1, updatedAt: at, updatedBy: 'Inhouse team' })),
      can: { edit: false }, writesOff: true,
    }
  }
  /** A change is refused as a deployable build's server refuses it: no one's, while editing is off. */
  setCeiling(): never {
    throw new AgentError(FORBIDDEN, WRITES_OFF_TEXT, { reason: WRITES_OFF })
  }
}
