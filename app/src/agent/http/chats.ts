// Chats over HTTP (P3, p3-design section 3, routes 22 to 28 and 49). Each helper builds one request; the caller (client.ts)
// keeps each chat's `rev` and sends it as `ifRev`. Bodies come from the lazily loaded schemas (`Contract`), so a body the
// server would refuse is refused here first. Plain code, no zod (the entry's size budget, schemas.ts).
import type { ChatList, ChatPage } from '../types'
import type { ChatSummary } from '../../../shared/contract/chats'
import type { Contract, Transport } from './transport'

export function readChats(http: Transport, o: { cursor?: string; limit?: number; deleted?: boolean } = {}): Promise<ChatList> {
  const q = new URLSearchParams()
  if (o.cursor !== undefined) q.set('cursor', o.cursor)
  if (o.limit !== undefined) q.set('limit', String(o.limit))
  if (o.deleted) q.set('deleted', 'true')
  const s = q.toString()
  return http.call({ method: 'GET', path: s ? `/api/chats?${s}` : '/api/chats', schema: 'chatList' })
}

export const readChat = (http: Transport, id: string, cursor?: string): Promise<ChatPage> =>
  http.call({ method: 'GET', path: `/api/chats/${encodeURIComponent(id)}${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, schema: 'chatPage' })

export const saveChat = (http: Transport, k: Contract, chat: { id: string; title: string }): Promise<ChatSummary> =>
  http.call({ method: 'POST', path: '/api/chats', schema: 'chat', json: k.BODIES.createChat.parse(chat) })

export const putTitle = (http: Transport, k: Contract, id: string, title: string | null, ifRev: number): Promise<ChatSummary> =>
  http.call({ method: 'PUT', path: `/api/chats/${encodeURIComponent(id)}/title`, schema: 'chat', json: k.BODIES.chatRename.parse({ title, ifRev }) })

export const putPin = (http: Transport, k: Contract, id: string, pinned: boolean, ifRev: number): Promise<ChatSummary> =>
  http.call({ method: 'PUT', path: `/api/chats/${encodeURIComponent(id)}/pin`, schema: 'chat', json: k.BODIES.chatPin.parse({ pinned, ifRev }) })

/** Routes 27 and 28: 1 to 50 of the person's own chats; the answer is each chat as it is now. */
export const postDeleted = (http: Transport, k: Contract, ids: string[], deleted: boolean): Promise<{ items: ChatSummary[] }> =>
  http.call({ method: 'POST', path: deleted ? '/api/chats/delete' : '/api/chats/restore', schema: 'chatItems', json: k.BODIES.chatIds.parse({ ids }) })

export const postSessionReset = (http: Transport, id: string): Promise<unknown> =>
  http.call({ method: 'POST', path: `/api/chats/${encodeURIComponent(id)}/session/reset`, schema: 'ack' })
