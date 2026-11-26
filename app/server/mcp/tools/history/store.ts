// The history tools' reads (p3-design section 10, W6): a member's own past chats, searched through the FTS5 index over
// chat_messages (0141) and read in full. One visibility rule with memory (../memory/visibility.ts): the member's own
// chats that aren't deleted. User and agent messages only; event rows aren't conversation. A user row the server wrote
// itself (a job's carry-on note, an action's result: `extra_json.source` `job` or `action`) reads as `inhouse`, never as
// the person's words, in a search hit (whose snippet can drop the note's prefix) and in a read (Stage 1 M2-G, #441 review).
import { all, first, stmt } from '../../../db/sql.ts'
import { chatVisible, matchExpression } from '../memory/visibility.ts'

/** Who wrote a message: the person, the agent, or Inhouse itself (an automatic note the server sent into the chat). */
export type HistoryRole = 'user' | 'agent' | 'inhouse'

/** A row's role as the history tools give it (the SQL below), for the table alias `cm`. */
const ROLE = `CASE WHEN cm.role = 'user' AND json_extract(cm.extra_json, '$.source') IN ('job', 'action') THEN 'inhouse' ELSE cm.role END`

export interface HistoryHit {
  chatId: string
  chatTitle: string
  messageId: string
  role: HistoryRole
  /** The matching words in context, matches marked `**like this**`. */
  snippet: string
  atMs: number
}

export interface HistoryMessage {
  pos: number
  role: HistoryRole
  text: string
  atMs: number
}

export interface HistoryChat {
  id: string
  title: string
  createdAtMs: number
  lastAtMs: number
  messages: HistoryMessage[]
  /** The position to read on from, or null on the last page. */
  nextPos: number | null
}

export interface HistoryStore {
  search(memberId: string, query: string, opts: { afterMs: number | null; beforeMs: number | null; limit: number }): Promise<HistoryHit[]>
  /** A visible chat's messages in order from `fromPos`, or null when the chat isn't the member's (or is deleted). */
  read(memberId: string, chatId: string, opts: { fromPos: number; limit: number }): Promise<HistoryChat | null>
}

export function historyStore({ db }: { db: D1Database }): HistoryStore {
  return {
    async search(memberId, query, { afterMs, beforeMs, limit }) {
      const match = matchExpression(query)
      if (match === null) return []
      return all<HistoryHit>(db, stmt(
        `SELECT cm.chat_id AS chatId, COALESCE(ch.custom_title, ch.title) AS chatTitle, cm.id AS messageId, ${ROLE} AS role,
           snippet(chat_messages_fts, 0, '**', '**', '…', 16) AS snippet, cm.at_ms AS atMs
         FROM chat_messages_fts f JOIN chat_messages cm ON cm.n = f.rowid JOIN chats ch ON ch.id = cm.chat_id
         WHERE chat_messages_fts MATCH ? AND ${chatVisible('ch')} AND cm.role IN ('user', 'agent')
           AND (? IS NULL OR cm.at_ms >= ?) AND (? IS NULL OR cm.at_ms < ?)
         ORDER BY bm25(chat_messages_fts), cm.n DESC LIMIT ?`,
        match, memberId, afterMs, afterMs, beforeMs, beforeMs, limit,
      ))
    },

    async read(memberId, chatId, { fromPos, limit }) {
      const chat = await first<{ id: string; title: string; createdAtMs: number; lastAtMs: number }>(db, stmt(
        `SELECT ch.id AS id, COALESCE(ch.custom_title, ch.title) AS title, ch.created_at_ms AS createdAtMs, ch.last_at_ms AS lastAtMs
         FROM chats ch WHERE ch.id = ? AND ${chatVisible('ch')}`,
        chatId, memberId,
      ))
      if (!chat) return null
      const rows = await all<HistoryMessage>(db, stmt(
        `SELECT cm.pos AS pos, ${ROLE} AS role, cm.text AS text, cm.at_ms AS atMs FROM chat_messages cm
         WHERE cm.chat_id = ? AND cm.role IN ('user', 'agent') AND cm.pos >= ? ORDER BY cm.pos LIMIT ?`,
        chatId, fromPos, limit + 1,
      ))
      const messages = rows.slice(0, limit)
      return { ...chat, messages, nextPos: rows.length > limit ? rows[limit].pos : null }
    },
  }
}
