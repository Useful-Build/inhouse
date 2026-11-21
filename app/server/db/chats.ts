// P3's `chats` store slot (p3-design section 12). Owner: W1 (p3-w1.md). Every method takes data and returns data (the
// store contract in server/routes.ts). This PR's part: the owner lookup routes 29 and 49 prefilter with, and the
// `agent.paused` / `agent.resumed` lines (routes 36 and 37). The history (routes 22-28) is PR 3's.
import { auditInsert } from './audit.ts'
import type { At } from './members.ts'
import { first, runBatch, stmt } from './sql.ts'
import { SYSTEM_MEMBER_ID } from './ids.ts'

/** A chat's owner and whether it's deleted, or null when there's no such chat. */
export interface ChatOwner { ownerId: string; deleted: boolean }

export interface ChatStore {
  ownerOf(chatId: string): Promise<ChatOwner | null>
  /** The pause or resume line, by the Admin or Inhouse member who did it (item 19). */
  recordAgentLine(action: 'agent.paused' | 'agent.resumed', at: At): Promise<void>
  /**
   * Route 51's line (PR 6): one revive by the release job, whatever its result. The release token has no member row,
   * so the line's actor is the system row (`m_system`); only the release token reaches the route (class `open`).
   */
  recordTaskRevive(r: { kind: string; id: string; result: 'revived' | 'not_quarantined' | 'not_found' }, at: { nowMs: number; requestId: string }): Promise<void>
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
    async recordTaskRevive(r, at) {
      await runBatch(db, [auditInsert({
        atMs: at.nowMs, actorId: SYSTEM_MEMBER_ID, args: { action: 'ops_task_revive', kind: r.kind, id: r.id, result: r.result }, target: null,
        requestId: at.requestId,
      }, null)])
    },
  }
}

/**
 * Makes the chat if it isn't there (PR 5, ask G): idempotent by id, for any member owner, the system member (`m_system`,
 * P4's routine chats) included. A chat that exists keeps its title and everything else. Throws when the id belongs to
 * another owner (a routine's derived id colliding with a person's chat): never a silent share.
 */
export async function ensureChat(db: D1Database, c: { id: string; ownerId: string; title: string }, nowMs: number = Date.now()): Promise<void> {
  await db.prepare('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
    .bind(c.id, c.ownerId, c.title, nowMs, nowMs).run()
  const row = await db.prepare('SELECT owner_id FROM chats WHERE id = ?').bind(c.id).first<{ owner_id: string }>()
  if (!row || row.owner_id !== c.ownerId) throw new Error('ensureChat: the chat id belongs to another owner')
}
