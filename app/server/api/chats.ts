// Chats (P3, p3-design sections 2, 3, 4.7 and 4.8): routes 22 to 28 and 49. Owner: W1 (p3-w1.md).
//
// A chat is its owner's (BD11): a member (a person, or the smoke check on its own chat) reads and changes only their
// own, and another person's chat answers 404 before `requireObject` (a caught refusal would be a 403); a list filters
// by owner, then `requireObject({ ownerId: self })`. Inhouse reads (22, 24) pass under a live grant without an owner
// (api.ts checked the grant and wrote the `support.access` line). Whether a chat is `running`, and the runs a reload
// attaches to, come from the BrandAgent (`chatRuns`).
import { z } from 'zod'
import { ChatIdsInputSchema, ChatPinInputSchema, ChatRenameInputSchema } from '../../shared/contract/chats.ts'
import type { ChatSummary, StoredMessage } from '../../shared/contract/chats.ts'
import { ChatIdSchema } from '../../shared/contract/chat-ids.ts'
import { CursorSchema } from '../../shared/contract/paging.ts'
import { CreateChatInputSchema } from '../../shared/contract/requests.ts'
import type { Handler, HandlerContext } from '../routes.ts'
import { apiError, apiJson } from '../http.ts'
import { decodeCursor, encodeCursor, readBody, readQuery, storesOf, writer } from '../db/handler-kit.ts'
import type { ChatKey, ChatRecord } from '../db/chats.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import { actorOf } from './runs.ts'

/** A chat's history comes 50 messages a page (as W5's demo engine pages it). */
export const HISTORY_PAGE = 50

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: CursorSchema.optional(),
  deleted: z.enum(['true', 'false']).optional(),
}).strict()
const HistoryQuerySchema = z.object({ cursor: CursorSchema.optional() }).strict()

/** Who reads: a member reads their own chats; Inhouse (under the grant api.ts checked) any; nobody else. */
function reader(c: HandlerContext): { ownerId: string } | { inhouse: true } | null {
  if (c.principal.kind === 'inhouse') return { inhouse: true }
  const by = actorOf(c.principal)
  return by ? { ownerId: by.memberId } : null
}

/** The chats among `ids` with a live run in the BrandAgent. */
async function runningOf(c: HandlerContext, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const runs = await brandAgent(c.env).chatRuns(ids)
  return new Set(runs.filter(r => r.live).map(r => r.chatId))
}

const summary = (r: ChatRecord, running: Set<string>): ChatSummary =>
  ({ id: r.id, title: r.title, customTitle: r.customTitle, pinned: r.pinned, deleted: r.deleted, at: r.at, rev: r.rev, running: running.has(r.id) })

const summaries = async (c: HandlerContext, rs: ChatRecord[]) => {
  const running = await runningOf(c, rs.map(r => r.id))
  return rs.map(r => summary(r, running))
}

/** `<ms>:<id>`, the list's keyset. */
function chatKey(cursor: string | undefined): ChatKey | null | undefined {
  if (cursor === undefined) return null
  const key = decodeCursor(cursor)
  const m = key === null ? null : /^(\d+):(.+)$/.exec(key)
  return m && ChatIdSchema.safeParse(m[2]).success ? { atMs: Number(m[1]), id: m[2] } : undefined
}

/** Route 22, `GET /api/chats?cursor&limit&deleted`: newest first, `(last_at_ms DESC, id DESC)`. */
export const listChats: Handler = async c => {
  const who = reader(c)
  if (!who) return apiError('forbidden')
  const q = readQuery(c.request, ListQuerySchema)
  if ('error' in q) return q.error
  const after = chatKey(q.ok.cursor)
  if (after === undefined) return apiError('invalid')
  const ownerId = 'ownerId' in who ? who.ownerId : null
  const rows = await storesOf(c).chats.list({ ownerId, deleted: q.ok.deleted === 'true', limit: q.ok.limit + 1, after })
  if (ownerId !== null) c.access.requireObject({ ownerId })
  const page = rows.slice(0, q.ok.limit)
  const last = page.at(-1)
  return apiJson({ items: await summaries(c, page), nextCursor: rows.length > q.ok.limit && last ? encodeCursor(`${last.at.ms}:${last.id}`) : null })
}

/** Route 23, `POST /api/chats` `{ id, title }`: idempotent for its owner (the chat as saved); another person's id is 404. */
export const createChat: Handler = async c => {
  const by = actorOf(c.principal)
  if (!by) return apiError('forbidden')
  const body = await readBody(c.request, CreateChatInputSchema)
  if ('error' in body) return body.error
  const saved = await storesOf(c).chats.create(body.ok, writer(c))
  if (saved.ownerId !== by.memberId) return apiError('not_found')
  c.access.requireObject({ ownerId: saved.ownerId })
  return apiJson((await summaries(c, [saved]))[0])
}

/**
 * Route 24, `GET /api/chats/:id?cursor`: the chat, a page of its history (`pos DESC`) and the runs a reload attaches
 * to: the live run and every ended run whose turns aren't all in D1 yet.
 */
export const getChat: Handler = async c => {
  const who = reader(c)
  if (!who) return apiError('forbidden')
  const chatId = ChatIdSchema.safeParse(c.params.id)
  if (!chatId.success) return apiError('not_found')
  const q = readQuery(c.request, HistoryQuerySchema)
  if ('error' in q) return q.error
  let before: number | null = null
  if (q.ok.cursor !== undefined) {
    const m = /^p(\d+)$/.exec(decodeCursor(q.ok.cursor) ?? '')
    if (!m) return apiError('invalid')
    before = Number(m[1])
  }
  const stores = storesOf(c)
  const chat = await stores.chats.get(chatId.data)
  if (!chat || ('ownerId' in who && chat.ownerId !== who.ownerId)) return apiError('not_found')
  if ('ownerId' in who) c.access.requireObject({ ownerId: chat.ownerId })
  const rows: StoredMessage[] = await stores.chats.messages(chatId.data, before, HISTORY_PAGE + 1)
  const messages = rows.slice(0, HISTORY_PAGE)
  const runs = await brandAgent(c.env).chatRuns([chatId.data])
  const last = messages.at(-1)
  return apiJson({
    chat: summary(chat, new Set(runs.filter(r => r.live).map(r => r.chatId))),
    messages,
    nextCursor: rows.length > HISTORY_PAGE && last ? encodeCursor(`p${last.pos}`) : null,
    runs,
  })
}

/** The owner's own chat for a write (25, 26), or the 404 answer; `requireObject` passed. */
async function ownChat(c: HandlerContext): Promise<{ chatId: string; ownerId: string } | { error: Response }> {
  const by = actorOf(c.principal)
  if (!by) return { error: apiError('forbidden') }
  const chatId = ChatIdSchema.safeParse(c.params.id)
  if (!chatId.success) return { error: apiError('not_found') }
  const owner = await storesOf(c).chats.ownerOf(chatId.data)
  if (!owner || owner.ownerId !== by.memberId) return { error: apiError('not_found') }
  c.access.requireObject({ ownerId: owner.ownerId })
  return { chatId: chatId.data, ownerId: owner.ownerId }
}

/** The answer to a guarded write: the chat, or 409 with the chat as it is now. */
async function revAnswer(c: HandlerContext, done: { ok: ChatRecord } | { conflict: ChatRecord } | null): Promise<Response> {
  if (done === null) return apiError('not_found')
  if ('conflict' in done) return apiError('conflict', { current: (await summaries(c, [done.conflict]))[0] })
  return apiJson((await summaries(c, [done.ok]))[0])
}

/** Route 25, `PUT /api/chats/:id/title` `{ title|null, ifRev }`. */
export const renameChat: Handler = async c => {
  const body = await readBody(c.request, ChatRenameInputSchema)
  if ('error' in body) return body.error
  const own = await ownChat(c)
  if ('error' in own) return own.error
  return revAnswer(c, await storesOf(c).chats.setTitle(own.chatId, own.ownerId, body.ok.title, body.ok.ifRev, writer(c)))
}

/** Route 26, `PUT /api/chats/:id/pin` `{ pinned, ifRev }`. */
export const pinChat: Handler = async c => {
  const body = await readBody(c.request, ChatPinInputSchema)
  if ('error' in body) return body.error
  const own = await ownChat(c)
  if ('error' in own) return own.error
  return revAnswer(c, await storesOf(c).chats.setPinned(own.chatId, own.ownerId, body.ok.pinned, body.ok.ifRev, writer(c)))
}

/** Routes 27 and 28: 1 to 50 of the caller's chats, all or nothing (any id not theirs: 404, nothing changes). */
function deleteOrRestore(deleted: boolean): Handler {
  return async c => {
    const by = actorOf(c.principal)
    if (!by) return apiError('forbidden')
    const body = await readBody(c.request, ChatIdsInputSchema)
    if ('error' in body) return body.error
    const ids = [...new Set(body.ok.ids)]
    const stores = storesOf(c)
    const owners = await stores.chats.ownersOf(ids)
    if (ids.some(id => owners.get(id) !== by.memberId)) return apiError('not_found')
    c.access.requireObject({ ownerId: by.memberId })
    const after = await stores.chats.setDeleted(ids, by.memberId, deleted, writer(c))
    // A deleted chat's queued turns are cancelled and its running one stopped, each through the BrandAgent's own
    // paths (every one ends in its final-state step), and the BrandAgent refuses sends into it until a restore tells it
    // otherwise (route 29's D1 read may predate the delete). A retry after a failure here repeats it (the write is
    // idempotent).
    if (deleted) await brandAgent(c.env).endChats(ids)
    else await brandAgent(c.env).restoreChats(ids)
    return apiJson({ items: await summaries(c, after) })
  }
}

/** Route 27, `POST /api/chats/delete` `{ ids }`: also cancels the chats' queued turns and stops their running one. */
export const deleteChats: Handler = deleteOrRestore(true)
/** Route 28, `POST /api/chats/restore` `{ ids }`: sends into the chats are admitted again. */
export const restoreChats: Handler = deleteOrRestore(false)

/**
 * Route 49, `POST /api/chats/:id/session/reset` (4.7): the owner's explicit recovery from a damaged session. A fresh
 * session on the next turn; the history stays. Another person's chat is 404 before the object check.
 */
export const resetSession: Handler = async c => {
  const by = actorOf(c.principal)
  if (!by) return apiError('forbidden')
  const chatId = ChatIdSchema.safeParse(c.params.id)
  if (!chatId.success) return apiError('not_found')
  const chat = await storesOf(c).chats.ownerOf(chatId.data)
  if (!chat || chat.ownerId !== by.memberId || chat.deleted) return apiError('not_found')
  c.access.requireObject({ ownerId: chat.ownerId })
  const answer = await brandAgent(c.env).resetSession(chatId.data, by)
  return 'refused' in answer ? apiError(answer.refused.code, answer.refused.reason === undefined ? {} : { reason: answer.refused.reason }) : apiJson(answer)
}
