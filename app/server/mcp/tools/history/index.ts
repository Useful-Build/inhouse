// The history tools (agent-tools "5. History", p3-design section 10): search and read the run's person's own past
// chats. P3 searches chats only (routine runs aren't searchable yet; P4 decides).
import { z } from 'zod'
import { ChatIdSchema } from '../../../../shared/contract/chat-ids.ts'
import { answer, refusal, tool } from '../../server/tool.ts'
import type { InhouseToolName, ToolDeps, ToolHandler } from '../../server/tool.ts'
import { historyStore } from './store.ts'
import type { HistoryRole } from './store.ts'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const dayMs = (d: string) => {
  const ms = Date.parse(`${d}T00:00:00.000Z`)
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== d ? null : ms
}
/** One message's text, cut so one page stays readable. */
const MAX_TEXT = 4000
const cut = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}… (cut)` : s)
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
/** Stage 1 M2-G: a note the server wrote into the chat (a job's carry-on, an action's result) is never the person's. */
const who = (role: HistoryRole) => (role === 'user' ? 'Person' : role === 'agent' ? 'Agent' : 'Inhouse (an automatic note, not the person)')

const storeOf = (deps: ToolDeps) => historyStore({ db: deps.db })

/** The history area's handlers (composed in ../index.ts). */
export const handlers: Partial<Record<InhouseToolName, ToolHandler>> = {
  history_search: tool({
    input: z.object({
      query: z.string().min(1).max(200).describe('Keywords, or "an exact phrase" in double quotes. Any of the words can match; best matches first.'),
      after: z.string().regex(DAY).optional().describe('Only messages on or after this day, "YYYY-MM-DD" (UTC).'),
      before: z.string().regex(DAY).optional().describe('Only messages before this day, "YYYY-MM-DD" (UTC).'),
      limit: z.number().int().min(1).max(20).default(10).describe('At most this many matches (1 to 20).'),
    }).strict(),
    async call({ query, after, before, limit }, scope, deps) {
      const afterMs = after === undefined ? null : dayMs(after)
      const beforeMs = before === undefined ? null : dayMs(before)
      if (afterMs === null && after !== undefined) return refusal('invalid_date', `"${after}" isn't a day. Write it as YYYY-MM-DD, like "2026-11-03".`)
      if (beforeMs === null && before !== undefined) return refusal('invalid_date', `"${before}" isn't a day. Write it as YYYY-MM-DD, like "2026-11-03".`)
      const hits = await storeOf(deps).search(scope.memberId, query, { afterMs, beforeMs, limit })
      if (hits.length === 0) return answer(`No past chat matches "${query}". Try other words or a wider date range.`, { matches: [] })
      const lines = hits.map(h => `- ${day(h.atMs)}, "${h.chatTitle}" (chat_id: ${h.chatId}), ${who(h.role)}: ${h.snippet}`)
      return answer(`${hits.length} ${hits.length === 1 ? 'match' : 'matches'}. Read a chat in full with history_read:\n${lines.join('\n')}`, {
        matches: hits.map(h => ({ chat_id: h.chatId, chat_title: h.chatTitle, role: h.role, snippet: h.snippet, at: new Date(h.atMs).toISOString() })),
      })
    },
  }),

  history_read: tool({
    input: z.object({
      chat_id: ChatIdSchema.describe('The `chat_id` that history_search returned.'),
      from_position: z.number().int().min(0).default(0).describe('Read on from this position (the previous page\'s `next_position`).'),
      limit: z.number().int().min(1).max(50).default(20).describe('At most this many messages (1 to 50).'),
    }).strict(),
    async call({ chat_id, from_position, limit }, scope, deps) {
      const chat = await storeOf(deps).read(scope.memberId, chat_id, { fromPos: from_position, limit })
      if (!chat) return refusal('not_found', `No past chat of this person has chat_id "${chat_id}". Use history_search to find it.`)
      const lines = chat.messages.map(m => `${who(m.role)} (${day(m.atMs)}): ${cut(m.text)}`)
      const head = `"${chat.title}", started ${day(chat.createdAtMs)}, last ${day(chat.lastAtMs)}.`
      const body = lines.length === 0 ? 'No messages from that position.' : lines.join('\n\n')
      const more = chat.nextPos === null ? '' : `\n\nMore: call history_read with from_position ${chat.nextPos}.`
      return answer(`${head}\n\n${body}${more}`, {
        chat_id: chat.id,
        title: chat.title,
        messages: chat.messages.map(m => ({ position: m.pos, role: m.role, text: cut(m.text), at: new Date(m.atMs).toISOString() })),
        next_position: chat.nextPos,
      })
    },
  }),
}
