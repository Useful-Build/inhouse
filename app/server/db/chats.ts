// P3's `chats` store slot (p3-design section 12). Owner: W1 (p3-w1.md). Every method takes data and returns data (the
// store contract in server/routes.ts). This PR's part: the owner lookup routes 29 and 49 prefilter with, and the
// `agent.paused` / `agent.resumed` lines (routes 36 and 37). The history (routes 22-28) is PR 3's.
import { auditInsert } from './audit.ts'
import type { At } from './members.ts'
import { first, runBatch, stmt } from './sql.ts'

/** A chat's owner and whether it's deleted, or null when there's no such chat. */
export interface ChatOwner { ownerId: string; deleted: boolean }

export interface ChatStore {
  ownerOf(chatId: string): Promise<ChatOwner | null>
  /** The pause or resume line, by the Admin or Inhouse member who did it (item 19). */
  recordAgentLine(action: 'agent.paused' | 'agent.resumed', at: At): Promise<void>
}

export function chatStore(deps: { db: D1Database }): ChatStore {
  const { db } = deps
  return {
    async ownerOf(chatId) {
      const row = await first<{ owner_id: string; deleted_at_ms: number | null }>(db, stmt('SELECT owner_id, deleted_at_ms FROM chats WHERE id = ?', chatId))
      return row ? { ownerId: row.owner_id, deleted: row.deleted_at_ms !== null } : null
    },
    async recordAgentLine(action, at) {
      await runBatch(db, [auditInsert({ atMs: at.nowMs, actorId: at.actorId, args: { action }, target: null, requestId: at.requestId }, null)])
    },
  }
}
