// Chats: the parts of an answer, the messages, the seed turns and the chat list.
import './jitless.ts'
import { z } from 'zod'
import { ClockTimeSchema, InstantSchema, StageSchema } from './common.ts'

export const AttachmentSchema = z.object({ name: z.string(), meta: z.string(), icon: z.string() })
export type Attachment = z.infer<typeof AttachmentSchema>

export const TablePartSchema = z.object({
  title: z.string(),
  summary: z.string(),
  /** Material Symbols name for the header. Default: a delivery truck. */
  icon: z.string().optional(),
  rows: z.array(z.object({ order: z.string(), age: z.string(), why: z.string(), value: z.string() })),
  sources: z.array(z.string()),
})
export type TablePart = z.infer<typeof TablePartSchema>

export const RoutineCardSchema = z.object({
  /** The agent's own id for the routine, as on RoutineDef. */
  id: z.string(),
  name: z.string(),
  freq: z.string(),
  day: z.string(),
  /** The time of day it runs, in the brand's time zone. */
  time: ClockTimeSchema,
  /** When it runs next. */
  next: InstantSchema,
  note: z.string(),
  /** Original request, for routines created in a chat. */
  what: z.string().optional(),
  /** Revision of this routine once a write moved it (delete, restore, regenerate); missing means its first. */
  rev: z.number().int().min(1).optional(),
})
export type RoutineCard = z.infer<typeof RoutineCardSchema>

export const SkillCardSchema = z.object({ name: z.string(), desc: z.string(), tools: z.string(), mode: z.string() })
export type SkillCard = z.infer<typeof SkillCardSchema>

/** One part of the agent's reply. Matches the README's MessagePart list. */
export const MessagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('table'), table: TablePartSchema }),
  z.object({ type: z.literal('approval'), problemId: z.string() }),
  z.object({ type: z.literal('routine'), routine: RoutineCardSchema }),
  z.object({ type: z.literal('skill'), skill: SkillCardSchema }),
  z.object({ type: z.literal('workRow'), text: z.string(), at: InstantSchema }),
  z.object({ type: z.literal('notInThisStage'), text: z.string() }),
  z.object({ type: z.literal('error'), text: z.string(), retryQuestion: z.string() }),
  /** Questions to ask next, offered as chips under an answer the agent couldn't give (decision D8). */
  z.object({ type: z.literal('suggestions'), questions: z.array(z.string()) }),
])
export type MessagePart = z.infer<typeof MessagePartSchema>

export const ChatMessageSchema = z.discriminatedUnion('role', [
  z.object({ id: z.string(), role: z.literal('user'), text: z.string(), quote: z.string().optional(), atts: z.array(AttachmentSchema).optional() }),
  /**
   * `model` (the model id from models.json, shown by its label) and `at` (when it answered) are set
   * on answers given in this session; seed answers have neither. Phase 1 stamps them in the store; in phase 2 the agent
   * fills them in on each `part` event.
   */
  z.object({ id: z.string(), role: z.literal('agent'), part: MessagePartSchema, trace: z.string(), model: z.string().optional(), at: InstantSchema.optional() }),
  z.object({ id: z.string(), role: z.literal('event'), text: z.string() }),
])
export type ChatMessage = z.infer<typeof ChatMessageSchema>

/** One turn of the seed conversation. `stage` limits an agent turn to that stage. */
export const SeedTurnSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), text: z.string() }),
  z.object({ role: z.literal('agent'), stage: StageSchema.optional(), trace: z.string(), model: z.string(), parts: z.array(MessagePartSchema) }),
])
export type SeedTurn = z.infer<typeof SeedTurnSchema>

/** One chat in the sidebar and in See all. Its messages are the turns, then whatever the person adds. */
export const ChatThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** When it was last active: what the list's newest-first order and its day groups follow. */
  at: InstantSchema,
  turns: z.array(SeedTurnSchema),
})
export type ChatThread = z.infer<typeof ChatThreadSchema>

export const ChatDataSchema = z.object({
  /** Every chat, newest first. */
  chats: z.array(ChatThreadSchema),
  /** How many of them the sidebar lists. */
  recentCount: z.number(),
  suggestions: z.array(z.string()),
})
export type ChatData = z.infer<typeof ChatDataSchema>
