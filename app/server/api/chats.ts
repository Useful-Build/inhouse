// Chats (P3, p3-design sections 3 and 4.7): routes 22 to 28 and 49. Owner: W1 (p3-w1.md). Routes 22 to 28 are still
// PR0's stubs (503 `not_built`), built in W1's PR 3; route 49 is built here.
import { notBuilt } from './not-built.ts'
import type { Handler } from '../routes.ts'
import { ChatIdSchema } from '../../shared/contract/chat-ids.ts'
import { apiError, apiJson } from '../http.ts'
import { storesOf } from '../db/handler-kit.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import { actorOf } from './runs.ts'

/** Route 22, `GET /api/chats`. W1. */
export const listChats: Handler = notBuilt
/** Route 23, `POST /api/chats`. W1. */
export const createChat: Handler = notBuilt
/** Route 24, `GET /api/chats/:id`. W1. */
export const getChat: Handler = notBuilt
/** Route 25, `PUT /api/chats/:id/title`. W1. */
export const renameChat: Handler = notBuilt
/** Route 26, `PUT /api/chats/:id/pin`. W1. */
export const pinChat: Handler = notBuilt
/** Route 27, `POST /api/chats/delete`. W1. */
export const deleteChats: Handler = notBuilt
/** Route 28, `POST /api/chats/restore`. W1. */
export const restoreChats: Handler = notBuilt
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
