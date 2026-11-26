// An outbox row as its card shows it (N15, N18): server words only, `can` for display (the answering update checks who
// may answer itself). The asker sees the card with its chat; an admin sees another person's card's facts, never the
// chat (`chatId: null`), and may resolve a "Needs a check".
import type { ActionCard, ActionKind } from '../../shared/contract/actions.ts'
import { ActionCardSchema } from '../../shared/contract/actions.ts'
import type { MemberRole } from '../../shared/contract/members.ts'
import { operationEntry } from './operations/index.ts'
import type { OutboxActionRow } from './types.ts'
import { FAILED_TEXT, LAPSE_TEXT, NEEDS_CHECK_TEXT, SENT_TEXT } from './words.ts'
import type { LapseReason } from './sql.ts'

/** What the request stored for the card (`card_json`): the operation's own words, the tool's label and the nudge. */
export interface StoredCard { title: string; lines: string[]; label: string; nudge: boolean }

export interface Viewer { memberId: string; role: MemberRole }

/**
 * Which buttons the card has. A routine's card is always an exact approval (M2-A: a routine never gets "Always allow",
 * the claim refuses grant-backed actions from routines). A `run` row that lapsed back to waiting is asked like any other.
 */
export const kindOf = (row: Pick<OutboxActionRow, 'verdict' | 'origin'>): ActionKind =>
  row.verdict === 'exact' || row.origin === 'routine' ? 'exact' : 'ask'

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

export function cardOf(row: OutboxActionRow, viewer: Viewer, nowMs: number): ActionCard {
  const stored = JSON.parse(row.card_json) as StoredCard
  const entry = operationEntry(row.operation)
  if (!entry) throw new Error(`outbox: a stored action names no operation (${row.id})`)
  const own = viewer.memberId === row.approver
  const asker = viewer.memberId === row.asked_by
  const waiting = row.state === 'waiting' && row.expires_at_ms > nowMs
  const kind = kindOf(row)
  const lapsed = row.lapsed_reason && (row.state === 'waiting' || row.state === 'expired') ? LAPSE_TEXT[row.lapsed_reason as LapseReason] : undefined
  const result = resultText(row)
  return ActionCardSchema.parse({
    id: row.id,
    rev: row.rev,
    kind,
    state: row.state,
    title: stored.title,
    lines: stored.lines,
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
    can: {
      allowOnce: own && waiting && kind === 'ask',
      alwaysAllow: own && waiting && kind === 'ask',
      approve: own && waiting && kind === 'exact',
      deny: own && waiting,
      undo: own && row.state === 'approved',
      resolve: row.state === 'needs_check' && (own || viewer.role === 'admin'),
    },
    nudgeAlways: own && waiting && kind === 'ask' && stored.nudge,
  })
}
