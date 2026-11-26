// What Settings > Always allowed and Activity's rows say about a permission (Stage 1 M2-H). Permissions.tsx draws them.
import type { Permission } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { NOT_FOUND } from '../../../shared/contract/error-codes'
import { fmtCount } from '../../lib/format'
import { display } from '../../state/display'

/** The line under a permission's title: the tool, where it applies, how many a day and, for someone else's, whose it is. */
export function permissionDesc(p: Permission, meId: string | undefined, nameOf: (id: string) => string | undefined): string {
  const parts = [p.tool.label, p.scope, `Up to ${fmtCount(p.perDay, display())} a day`]
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
