// What Settings > Always allowed and Activity's rows say about a permission (Stage 1 M2-H). Permissions.tsx draws them.
import type { Permission } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { NOT_FOUND } from '../../../shared/contract/error-codes'
import { fmtCount } from '../../lib/format'
import { display } from '../../state/display'
import { unitsText } from '../chat/ask-card'

/**
 * The line under a permission's title: the tool, where it applies, its limits and, for someone else's, whose it is. The
 * limits (Stage 1 M3, N23) are what really applies: the day's count under the Inhouse team's ceiling, and the largest
 * single call ("Up to 50 orders a day, 5 at a time").
 */
export function permissionDesc(p: Permission, meId: string | undefined, nameOf: (id: string) => string | undefined): string {
  const { effectivePerDay, unitsMax, unitsLabel } = p.limits
  const parts = [p.tool.label, p.scope, `Up to ${unitsText(effectivePerDay, unitsLabel)} a day, ${fmtCount(unitsMax, display())} at a time`]
  if (p.holder.kind === 'brand') parts.push('For the whole team')
  else if (p.holder.memberId !== meId) parts.push(`For ${nameOf(p.holder.memberId) ?? 'a teammate'}`)
  return parts.join(' · ')
}

/** What a refused Remove says. A stale one shows the permission as it is now (the list is read again). */
export function removeRefusal(e: unknown): string {
  if (e instanceof AgentError && e.code === 'conflict') return 'This permission changed first. Here it is now.'
  if (e instanceof AgentError && e.code === NOT_FOUND) return 'This permission was already removed.'
  if (e instanceof AgentError && e.code === 'forbidden') return "You can't remove this permission."
  return e instanceof AgentError ? e.message : 'Something went wrong. Try again.'
}
