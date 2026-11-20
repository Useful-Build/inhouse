// P3's contract for chats, their messages and pages (p3-design section 2). Owner: W1. A chat belongs to the person who
// started it (BD11); lists page by `(last_at_ms DESC, id DESC)`, a chat's history by `pos DESC`.
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { ChatMessageSchema } from './chat.ts'
import { ChatIdSchema, RunIdSchema, TurnIdSchema } from './chat-ids.ts'
import { IfRevSchema } from './members.ts'
import { CursorSchema } from './paging.ts'
import { ActiveRunSchema } from './runs.ts'

export { ChatIdSchema }
export type { ChatId } from './chat-ids.ts'

/** A chat's title: 1 to 200 characters. */
export const ChatTitleSchema = z.string().min(1).max(200)

/** One chat in the list. `title` is what shows (the custom title, else the first question's); `running` while a run is live. */
export const ChatSummarySchema = z.object({
  id: ChatIdSchema,
  title: ChatTitleSchema,
  customTitle: ChatTitleSchema.nullable(),
  pinned: z.boolean(),
  deleted: z.boolean(),
  at: InstantSchema,
  rev: z.number().int().min(1),
  running: z.boolean(),
})
export type ChatSummary = z.infer<typeof ChatSummarySchema>

/** Where a stored message sits: its turn and run, its position in the chat (from 0) and when it was written. */
const stored = { turnId: TurnIdSchema, runId: RunIdSchema, pos: z.number().int().min(0), at: InstantSchema }
const [userMsg, agentMsg, eventMsg] = ChatMessageSchema.options

/** A message as D1 keeps it: chat.ts's message plus where it sits. */
export const StoredMessageSchema = z.discriminatedUnion('role', [userMsg.extend(stored), agentMsg.extend(stored), eventMsg.extend(stored)])
export type StoredMessage = z.infer<typeof StoredMessageSchema>

/** `GET /api/chats?cursor&limit&deleted`. */
export const ChatListSchema = z.object({ items: z.array(ChatSummarySchema), nextCursor: CursorSchema.nullable() })
export type ChatList = z.infer<typeof ChatListSchema>

/**
 * `GET /api/chats/:id?cursor`: the chat, a page of its history (newest first), and its runs to attach to: the live run
 * and any ended run whose turns aren't all in D1 yet.
 */
export const ChatPageSchema = z.object({
  chat: ChatSummarySchema,
  messages: z.array(StoredMessageSchema),
  nextCursor: CursorSchema.nullable(),
  runs: z.array(ActiveRunSchema),
})
export type ChatPage = z.infer<typeof ChatPageSchema>

/** `PUT /api/chats/:id/title`: a custom title, or null to go back to the first question's. */
export const ChatRenameInputSchema = z.object({ title: ChatTitleSchema.nullable(), ifRev: IfRevSchema }).strict()
export type ChatRenameInput = z.infer<typeof ChatRenameInputSchema>

/** `PUT /api/chats/:id/pin`. */
export const ChatPinInputSchema = z.object({ pinned: z.boolean(), ifRev: IfRevSchema }).strict()
export type ChatPinInput = z.infer<typeof ChatPinInputSchema>

/** `POST /api/chats/delete` and `/restore`: 1 to 50 of the caller's chats (D1's 100 bound parameters a statement). */
export const ChatIdsInputSchema = z.object({ ids: z.array(ChatIdSchema).min(1).max(50) }).strict()
export type ChatIdsInput = z.infer<typeof ChatIdsInputSchema>
