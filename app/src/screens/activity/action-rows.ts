// Activity's action rows (Stage 1 M2-H): their line, and what each offers about the permission behind it. ActionRows.tsx
// draws them.
import type { ActionCard, Permission } from '../../agent/types'
import { kickerOf, outcomeOf } from '../chat/ask-card'

/** The most rows the section lists: the newest. The audit log keeps every one. */
export const ACTION_ROWS_MAX = 20

/** What a row offers about the permission behind its action: the one to stop, the Settings page, or nothing. */
export function stopAllowing(card: ActionCard, permissions: readonly Permission[]): { kind: 'one'; permission: Permission } | { kind: 'many' } | null {
  const covering = permissions.filter(p => p.can.remove && p.tool.accountId === card.tool.accountId)
  if (covering.length === 0) return null
  return covering.length === 1 ? { kind: 'one', permission: covering[0]! } : { kind: 'many' }
}

/** The row's one line: the title, then where it got to. */
export const actionLine = (card: ActionCard): string => `${card.title}. ${outcomeOf(card) ?? kickerOf(card)}`
