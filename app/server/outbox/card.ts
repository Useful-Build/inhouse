// An outbox row as its card shows it (N15, N18): server words only, `can` for display (the answering update checks who
// may answer itself). The asker sees the card with its chat; an admin sees another person's card's facts, never the
// chat (`chatId: null`), and may resolve a "Needs a check".
import type { ActionCard, ActionKind, ActionState } from '../../shared/contract/actions.ts'
import { ActionCardSchema } from '../../shared/contract/actions.ts'
import type { MemberRole } from '../../shared/contract/members.ts'
import { operationEntry } from './operations/index.ts'
import type { OutboxActionRow, OutboxItemRow } from './types.ts'
import { batchSummaries } from './batch/rows.ts'
import type { BatchSummary } from './batch/rows.ts'
import { batchTitle, FAILED_TEXT, LAPSE_TEXT, NEEDS_CHECK_TEXT, SENT_TEXT, WITHDRAWN_TEXT } from './words.ts'
import type { LapseReason } from './sql.ts'

/** What the request stored for the card (`card_json`): the operation's own words, the tool's label and the nudge. */
export interface StoredCard { title: string; lines: string[]; label: string; nudge: boolean }

export interface Viewer { memberId: string; role: MemberRole }

/**
 * Which buttons the card has. A routine's card is always an exact approval (M2-A: a routine never gets "Always allow",
 * the claim refuses grant-backed actions from routines). A `run` row that lapsed back to waiting is asked like any other.
 */
export const kindOf = (row: Pick<OutboxActionRow, 'verdict' | 'origin' | 'kind'>): ActionKind =>
  row.verdict === 'exact' || row.origin === 'routine' || row.kind === 'batch' ? 'exact' : 'ask'

const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })

function resultText(row: OutboxActionRow): string | undefined {
  if (row.state === 'sent') {
    const ref = row.result_json ? (JSON.parse(row.result_json) as { ref?: unknown }).ref : undefined
    return typeof ref === 'string' && ref !== '' ? `${SENT_TEXT} ${ref}` : SENT_TEXT
  }
  if (row.state === 'failed') return FAILED_TEXT
  if (row.state === 'needs_check') return NEEDS_CHECK_TEXT
  return undefined
}

/**
 * The card. A batch (Stage 1 M3-B, N33) also needs its first lines (`batch`, rows.ts `batchSummaries`): its title is its
 * call's own when it is one call's batch, else the count of its changes; its lines are its first 10 items'; its totals
 * are the row's (the items on the card now).
 */
export function cardOf(row: OutboxActionRow, viewer: Viewer, nowMs: number, batch?: BatchSummary): ActionCard {
  const stored = JSON.parse(row.card_json) as StoredCard
  if (row.kind === 'batch' && batch === undefined) throw new Error(`outbox: batch ${row.id}'s card was asked for without its lines`)
  const entry = operationEntry(row.operation)
  if (!entry) throw new Error(`outbox: a stored action names no operation (${row.id})`)
  const own = viewer.memberId === row.approver
  const asker = viewer.memberId === row.asked_by
  const waiting = row.state === 'waiting' && row.expires_at_ms > nowMs
  const kind = kindOf(row)
  const reason = row.lapsed_reason as LapseReason | null
  const lapsed = reason === null ? undefined
    : row.state === 'withdrawn' ? WITHDRAWN_TEXT[reason]
      : row.state === 'waiting' || row.state === 'expired' ? LAPSE_TEXT[reason] : undefined
  const result = resultText(row)
  return ActionCardSchema.parse({
    id: row.id,
    rev: row.rev,
    kind,
    state: row.state,
    title: batch === undefined || row.tool_use_id !== null ? stored.title : batchTitle(row.items_n, stored.label),
    lines: batch === undefined ? stored.lines : batch.firstLines,
    tool: { accountId: row.account_id, label: stored.label },
    records: row.records,
    reachesCustomer: entry.effects.customer,
    reversible: entry.reversible,
    ...(row.guardrail ? { guardrail: row.guardrail } : {}),
    chatId: asker ? row.chat_id : null,
    askedBy: row.asked_by,
    askedAt: instant(row.created_at_ms),
    ...(row.state === 'approved' && row.send_at_ms !== null ? { sendAt: instant(row.send_at_ms) } : {}),
    serverNow: instant(nowMs),
    ...(result !== undefined ? { result } : {}),
    ...(lapsed !== undefined ? { lapsed } : {}),
    ...(row.grant_id !== null && (asker || viewer.role === 'admin') ? { permissionId: row.grant_id } : {}),
    can: {
      allowOnce: own && waiting && kind === 'ask',
      alwaysAllow: own && waiting && kind === 'ask',
      approve: own && waiting && kind === 'exact',
      deny: own && waiting,
      undo: own && row.state === 'approved',
      resolve: row.state === 'needs_check' && (own || viewer.role === 'admin'),
      // Stage 1 M3-A: no member withdraw before M3-X's admins card (the agent's approval_withdraw is its own tool).
      withdraw: false,
    },
    nudgeAlways: own && waiting && kind === 'ask' && stored.nudge,
    ...(batch !== undefined
      ? { batch: { itemCount: row.items_n, firstLines: batch.firstLines, totals: { records: row.records, units: row.units, unitsLabel: entry.unitsLabel } } }
      : {}),
    approverKind: row.approver_kind,
  })
}

/** Cards for a list of rows, each batch's first lines read in one go. */
export async function cardsOf(db: D1Database, rows: readonly OutboxActionRow[], viewer: Viewer, nowMs: number): Promise<ActionCard[]> {
  const lines = await batchSummaries(db, rows.filter(r => r.kind === 'batch').map(r => r.id))
  return rows.map(r => cardOf(r, viewer, nowMs, r.kind === 'batch' ? lines.get(r.id) : undefined))
}

/**
 * Stage 1 M3-B (N22): a collected call's own state, from its item (never the batch's end, which other calls' items
 * share): an item still pending waits with its batch, or is being sent once the batch is; an item the batch's end
 * withdrew (0770's trigger) ended the way the batch did.
 */
export function itemState(item: Pick<OutboxItemRow, 'state'>, batch: Pick<OutboxActionRow, 'state'>): ActionState {
  switch (item.state) {
    case 'pending': return batch.state === 'approved' || batch.state === 'sending' ? 'approved' : batch.state === 'needs_check' ? 'needs_check' : 'waiting'
    case 'sending': return 'sending'
    case 'sent': return 'sent'
    case 'failed': return 'failed'
    case 'needs_check': return 'needs_check'
    case 'withdrawn': return batch.state === 'denied' || batch.state === 'expired' || batch.state === 'undone' ? batch.state : 'withdrawn'
  }
}
