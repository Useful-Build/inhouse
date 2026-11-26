// A deleted chat withdraws its actions (Stage 1 M2-D, N11; from #433's review): every `waiting` or `approved` action asked
// in a chat its owner deleted moves to `withdrawn` (`lapsed_reason = 'chat_deleted'`), in the same D1 batch as the
// deletion, so a card in the trash can't be approved and an approval in its hold can't be claimed. An approved row's use
// goes back. A `sending` row is already in flight and keeps its course; a final one is left as it is. Restoring the chat
// doesn't bring a withdrawn action back: the agent can propose it again.
import { writeStamp } from '../db/ids.ts'
import { stmt } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'
import { linesForStamped } from './sql.ts'

/** The statements for `chats.markDeleted`'s batch, after its update: they act only on chats that update left deleted. */
export function withdrawForDeletedChats(chatIds: readonly string[], ownerId: string, at: { nowMs: number; requestId: string; actorId: string }): Stmt[] {
  if (chatIds.length === 0) return []
  const stamp = writeStamp(at.requestId)
  const marks = chatIds.map(() => '?').join(', ')
  return [
    stmt(
      `UPDATE outbox_actions SET state = 'withdrawn', rev = rev + 1, lapsed_reason = 'chat_deleted', final_at_ms = ?, updated_at_ms = ?, stamp = ?
       WHERE state IN ('waiting', 'approved') AND chat_id IN (${marks})
         AND EXISTS (SELECT 1 FROM chats c WHERE c.id = outbox_actions.chat_id AND c.owner_id = ? AND c.deleted_at_ms IS NOT NULL)`,
      at.nowMs, at.nowMs, stamp, ...chatIds, ownerId,
    ),
    // An approved row's use was reserved at its approved revision (the update above left `approved_rev` as it was).
    stmt(
      `UPDATE permission_uses SET released_at_ms = ?, release_reason = 'lapsed'
       WHERE released_at_ms IS NULL AND id IN (SELECT a.id || '#' || a.approved_rev FROM outbox_actions a WHERE a.stamp = ? AND a.approved_rev IS NOT NULL)`,
      at.nowMs, stamp,
    ),
    linesForStamped('action.withdrawn', "json_object('actionId', a.id, 'by', 'member')", [], { atMs: at.nowMs, actorId: at.actorId, requestId: at.requestId }, stamp),
  ]
}
