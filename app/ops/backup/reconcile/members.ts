// Step 3b of a restore (P8a R, review M4): the restored member rows are the backup's, so a member removed, or demoted,
// after the backup would come back with their old access once the deployment switches. The audit lines re-appended in
// step 3 record those changes (`member.removed`, `member.role_changed`, written in one batch with the change itself,
// server/db/members.ts), so they're applied again here, in line order, to the rows above the backup's audit id:
// a removal sets `removed` (and `removed_at_ms` from the line), a role change sets the line's `to`. Idempotent: a row
// already in that state is left alone. A row the target doesn't hold (a placeholder, or a member added after the backup)
// changes nothing. Re-invites and restores after a removal aren't applied: the member stays removed and is invited
// again, the safe side of a restore.
import { z } from 'zod'
import type { Reconcile } from '../manifest.ts'

const Removed = z.object({ memberId: z.string() })
const RoleChanged = z.object({ memberId: z.string(), to: z.enum(['member', 'admin']) })

export async function reapplyMemberChanges(target: D1Database, afterId: number): Promise<NonNullable<Reconcile['members']>> {
  const lines = (await target.prepare("SELECT action, at_ms, args_json FROM audit_log WHERE id > ? AND action IN ('member.removed', 'member.role_changed') ORDER BY id")
    .bind(afterId).all<{ action: string; at_ms: number; args_json: string }>()).results
  const removed = new Set<string>()
  const roles = new Map<string, 'member' | 'admin'>()
  for (const l of lines) {
    const args = JSON.parse(l.args_json) as unknown
    if (l.action === 'member.removed') {
      const { memberId } = Removed.parse(args)
      await target.prepare("UPDATE members SET status = 'removed', removed_at_ms = COALESCE(removed_at_ms, ?), rev = rev + 1 WHERE id = ? AND kind = 'person' AND status <> 'removed'")
        .bind(l.at_ms, memberId).run()
      removed.add(memberId)
    } else {
      const { memberId, to } = RoleChanged.parse(args)
      await target.prepare("UPDATE members SET role = ?, rev = rev + 1 WHERE id = ? AND kind = 'person' AND role <> ?").bind(to, memberId, to).run()
      roles.set(memberId, to)
    }
  }
  return { removed: [...removed].sort(), roles: [...roles].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([memberId, role]) => ({ memberId, role })) }
}
