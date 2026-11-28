// Activity's action rows (Stage 1 M2-H): their line, and what each offers about the permission behind it. ActionRows.tsx
// draws them.
import type { ActionCard, Permission } from '../../agent/types'
import { kickerOf, outcomeOf } from '../chat/ask-card'
import type { Whose } from '../chat/ask-card'

/** The most rows the section lists: the newest. The audit log keeps every one. */
export const ACTION_ROWS_MAX = 20

/**
 * The permission a row offers to stop: the one its action ran under (the card's `permissionId`, set only for a viewer who
 * may remove it), while it still stands and this viewer may remove it. None for an action a person answered (#655: never
 * a guess by tool account, which named a permission that didn't cover the action).
 */
export function stopAllowing(card: ActionCard, permissions: readonly Permission[]): Permission | null {
  if (!card.permissionId) return null
  return permissions.find(p => p.id === card.permissionId && p.can.remove) ?? null
}

/** The row's one line: the title, then where it got to. */
export const actionLine = (card: ActionCard, whose: Whose = null): string => `${card.title}. ${outcomeOf(card, whose) ?? kickerOf(card, whose)}`
