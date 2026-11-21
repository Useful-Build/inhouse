// P3's `chats` store slot (p3-design section 12). Owner: W1 (p3-w1.md). Every method takes data and returns data (the
// store contract in server/routes.ts): the owner lookup routes 29 and 49 prefilter with, the `agent.paused` /
// `agent.resumed` lines (routes 36 and 37), and the chats and their history (routes 22 to 28; 4.8 writes the history,
// from the BrandAgent). Whether a chat is `running` is the BrandAgent's, so records here leave it out.
import type { StoredMessage, TurnEnd } from '../../shared/contract/chats.ts'
import type { CancelWhy, TurnFailure } from '../../shared/contract/runs.ts'
import { auditInsert } from './audit.ts'
import type { At } from './members.ts'
import { all, first, runBatch, stmt } from './sql.ts'
import { SYSTEM_MEMBER_ID } from './ids.ts'

/** A chat's owner and whether it's deleted, or null when there's no such chat. */
export interface ChatOwner { ownerId: string; deleted: boolean }

/** A chat as D1 has it: the contract's summary without `running`, plus its owner. */
export interface ChatRecord {
  id: string
  ownerId: string
  title: string
  customTitle: string | null
  pinned: boolean
  deleted: boolean
  at: { iso: string; ms: number }
  rev: number
}

/** Where a page of chats starts: after this `(last_at_ms, id)`. */
export interface ChatKey { atMs: number; id: string }

export type RevWrite = { ok: ChatRecord } | { conflict: ChatRecord } | null

export interface ChatStore {
  ownerOf(chatId: string): Promise<ChatOwner | null>
  /** The pause or resume line, by the Admin or Inhouse member who did it (item 19). */
  recordAgentLine(action: 'agent.paused' | 'agent.resumed', at: At): Promise<void>
  /**
   * Route 51's line (PR 6): one revive by the release job, whatever its result. The release token has no member row,
   * so the line's actor is the system row (`m_system`); only the release token reaches the route (class `open`).
   */
  recordTaskRevive(r: { kind: string; id: string; result: 'revived' | 'not_quarantined' | 'not_found' }, at: { nowMs: number; requestId: string }): Promise<void>
  get(chatId: string): Promise<ChatRecord | null>
  /** Up to `limit` chats, `(last_at_ms DESC, id DESC)` after `after`; one owner's, or every one's (`ownerId` null). */
  list(q: { ownerId: string | null; deleted: boolean; limit: number; after: ChatKey | null }): Promise<ChatRecord[]>
  /** Saves the chat unless its id exists (idempotent), then answers the chat with that id, whoever owns it. */
  create(chat: { id: string; title: string }, at: At): Promise<ChatRecord>
  /** The custom title (null: back to the first question's), while the rev is `ifRev`; null when the chat isn't the owner's. */
  setTitle(chatId: string, ownerId: string, title: string | null, ifRev: number, at: At): Promise<RevWrite>
  setPinned(chatId: string, ownerId: string, pinned: boolean, ifRev: number, at: At): Promise<RevWrite>
  /** Each id's owner, rev and whether it's deleted (ids not found are absent). */
  statesOf(chatIds: string[]): Promise<Map<string, { ownerId: string; rev: number; deleted: boolean }>>
  /**
   * Marks the owner's chats deleted and reads them back in the same batch (one D1 transaction), so each record carries
   * this delete's own rev. A chat already deleted keeps its deletion time, and its rev moves too: a restore that read
   * it before no longer applies (`restore`). The chats after, in order.
   */
  markDeleted(chatIds: string[], ownerId: string, at: At): Promise<ChatRecord[]>
  /**
   * Restores `chats`, all or none: one statement that changes a row only while every one of them is still deleted at
   * the rev it was read at. Reads `chatIds` back in the same batch. `applied`: they were restored.
   */
  restore(chats: { id: string; rev: number }[], chatIds: string[], ownerId: string, at: At): Promise<{ records: ChatRecord[]; applied: boolean }>
  /** Up to `limit` messages, `pos DESC`, below `beforePos` when given. */
  messages(chatId: string, beforePos: number | null, limit: number): Promise<StoredMessage[]>
}

interface ChatRow {
  id: string; owner_id: string; title: string; custom_title: string | null; pinned: number; deleted_at_ms: number | null
  last_at_ms: number; rev: number
}
interface MessageRow {
  id: string; run_id: string; turn_id: string; pos: number; role: 'user' | 'agent' | 'event'; text: string
  part_json: string | null; extra_json: string | null; model: string | null; at_ms: number
}

const CHAT_COLUMNS = 'id, owner_id, title, custom_title, pinned, deleted_at_ms, last_at_ms, rev'
const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ')

const readBack = (chatIds: string[]) => stmt(`SELECT ${CHAT_COLUMNS} FROM chats WHERE id IN (${marks(chatIds.length)})`, ...chatIds)
const inOrder = (chatIds: string[], rows: ChatRow[]): ChatRecord[] => {
  const byId = new Map(rows.map(r => [r.id, record(r)]))
  return chatIds.map(id => byId.get(id)!)
}

const record = (r: ChatRow): ChatRecord => ({
  id: r.id, ownerId: r.owner_id, title: r.custom_title ?? r.title, customTitle: r.custom_title, pinned: r.pinned === 1,
  deleted: r.deleted_at_ms !== null, at: instant(r.last_at_ms), rev: r.rev,
})

/**
 * A stored row as the contract's message (`extra_json`: a user message's quote and attachments, an agent part's
 * trace). An attachment shows by its name, with the generic file icon (as W5's demo engine projects it).
 */
function message(r: MessageRow): StoredMessage {
  const where = { turnId: r.turn_id, runId: r.run_id, pos: r.pos, at: instant(r.at_ms) }
  const extra = (r.extra_json === null ? {} : JSON.parse(r.extra_json)) as {
    quote?: string; attachments?: { name: string }[]; trace?: string; failure?: TurnFailure; retryQuestion?: string; why?: CancelWhy
    outcome?: 'stopped' | 'interrupted'
  }
  if (r.role === 'user') {
    return {
      id: r.id, role: 'user', text: r.text, ...(extra.quote === undefined ? {} : { quote: extra.quote }),
      ...(extra.attachments?.length ? { atts: extra.attachments.map(a => ({ name: a.name, meta: '', icon: 'description' })) } : {}), ...where,
    }
  }
  if (r.role === 'agent') {
    if (r.part_json === null) throw new Error(`chat_messages ${r.id}: an agent row without a part`)
    return { id: r.id, role: 'agent', part: JSON.parse(r.part_json), trace: extra.trace ?? r.turn_id, ...(r.model === null ? {} : { model: r.model }), ...where }
  }
  // An end row (projection.ts): how its turn ended, for the client to put in words.
  const end: TurnEnd | null = extra.failure !== undefined ? { failure: extra.failure, retryQuestion: extra.retryQuestion ?? '' }
    : extra.outcome !== undefined ? { outcome: extra.outcome } : extra.why !== undefined ? { why: extra.why } : null
  return { id: r.id, role: 'event', text: r.text, ...(end === null ? {} : { end }), ...where }
}

export function chatStore(deps: { db: D1Database }): ChatStore {
  const { db } = deps
  const get = async (chatId: string) => {
    const r = await first<ChatRow>(db, stmt(`SELECT ${CHAT_COLUMNS} FROM chats WHERE id = ?`, chatId))
    return r ? record(r) : null
  }
  /** A guarded write: the changed chat, or the chat as it is (`conflict`), or null when it isn't the owner's. */
  const revWrite = async (chatId: string, ownerId: string, set: string, value: string | number | null, ifRev: number, at: At): Promise<RevWrite> => {
    const [res] = await runBatch(db, [stmt(
      `UPDATE chats SET ${set} = ?, rev = rev + 1, req_id = ? WHERE id = ? AND owner_id = ? AND rev = ? RETURNING ${CHAT_COLUMNS}`,
      value, at.requestId, chatId, ownerId, ifRev)])
    const changed = (res.results as ChatRow[])[0]
    if (changed) return { ok: record(changed) }
    const now = await get(chatId)
    return now && now.ownerId === ownerId ? { conflict: now } : null
  }
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
        atMs: at.nowMs, actorId: SYSTEM_MEMBER_ID, args: { action: 'ops_task_revive', kind: r.kind, id: r.id, result: r.result, by: 'release' }, target: null,
        requestId: at.requestId,
      }, null)])
    },
    get,
    async list(q) {
      const where = [q.deleted ? 'deleted_at_ms IS NOT NULL' : 'deleted_at_ms IS NULL']
      const params: (string | number)[] = []
      if (q.ownerId !== null) { where.push('owner_id = ?'); params.push(q.ownerId) }
      if (q.after) { where.push('(last_at_ms < ? OR (last_at_ms = ? AND id < ?))'); params.push(q.after.atMs, q.after.atMs, q.after.id) }
      const rows = await all<ChatRow>(db, stmt(
        `SELECT ${CHAT_COLUMNS} FROM chats WHERE ${where.join(' AND ')} ORDER BY last_at_ms DESC, id DESC LIMIT ?`, ...params, q.limit))
      return rows.map(record)
    },
    async create(chat, at) {
      await runBatch(db, [stmt(
        'INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms, req_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
        chat.id, at.actorId, chat.title, at.nowMs, at.nowMs, at.requestId)])
      const saved = await get(chat.id)
      if (!saved) throw new Error(`chats ${chat.id}: not there after its insert`)
      return saved
    },
    setTitle: (chatId, ownerId, title, ifRev, at) => revWrite(chatId, ownerId, 'custom_title', title, ifRev, at),
    setPinned: (chatId, ownerId, pinned, ifRev, at) => revWrite(chatId, ownerId, 'pinned', pinned ? 1 : 0, ifRev, at),
    async statesOf(chatIds) {
      const rows = await all<{ id: string; owner_id: string; rev: number; deleted_at_ms: number | null }>(db,
        stmt(`SELECT id, owner_id, rev, deleted_at_ms FROM chats WHERE id IN (${marks(chatIds.length)})`, ...chatIds))
      return new Map(rows.map(r => [r.id, { ownerId: r.owner_id, rev: r.rev, deleted: r.deleted_at_ms !== null }]))
    },
    async markDeleted(chatIds, ownerId, at) {
      const results = await runBatch(db, [
        stmt(`UPDATE chats SET deleted_at_ms = COALESCE(deleted_at_ms, ?), rev = rev + 1, req_id = ? WHERE id IN (${marks(chatIds.length)}) AND owner_id = ?`,
          at.nowMs, at.requestId, ...chatIds, ownerId),
        readBack(chatIds),
      ])
      return inOrder(chatIds, results[1].results as ChatRow[])
    },
    async restore(chats, chatIds, ownerId, at) {
      // `{ id: rev }` as one bound JSON value (50 pairs would pass D1's 100 bound parameters), read with `json_each`:
      // https://developers.cloudflare.com/d1/sql-api/query-json/ (read 2026-11-21). The count is over the chats still
      // deleted at their rev, so one that moved leaves every row as it was.
      const want = JSON.stringify(Object.fromEntries(chats.map(c => [c.id, c.rev])))
      const writes = chats.length === 0 ? [] : [stmt(
        `UPDATE chats SET deleted_at_ms = NULL, rev = rev + 1, req_id = ? WHERE id IN (SELECT key FROM json_each(?))
          AND (SELECT COUNT(*) FROM chats c JOIN json_each(?) w ON w.key = c.id AND w.value = c.rev
            WHERE c.owner_id = ? AND c.deleted_at_ms IS NOT NULL) = ?`,
        at.requestId, want, want, ownerId, chats.length)]
      const results = await runBatch(db, [...writes, readBack(chatIds)])
      const applied = writes.length === 0 || results[0].meta.changes === chats.length
      return { records: inOrder(chatIds, results[writes.length].results as ChatRow[]), applied }
    },
    async messages(chatId, beforePos, limit) {
      const rows = await all<MessageRow>(db, beforePos === null
        ? stmt('SELECT id, run_id, turn_id, pos, role, text, part_json, extra_json, model, at_ms FROM chat_messages WHERE chat_id = ? ORDER BY pos DESC LIMIT ?', chatId, limit)
        : stmt('SELECT id, run_id, turn_id, pos, role, text, part_json, extra_json, model, at_ms FROM chat_messages WHERE chat_id = ? AND pos < ? ORDER BY pos DESC LIMIT ?', chatId, beforePos, limit))
      return rows.map(message)
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
