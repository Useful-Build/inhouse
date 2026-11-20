// The inputs of the client's calls that carry options, as zod schemas (from #58's review): the client's types are inferred from these.
import { z } from 'zod'
import { EffortSchema, ScenarioSchema, StageSchema } from './common.ts'
import { AttachmentSchema } from './chat.ts'

/** How soon a message sent into a running answer is taken: `now` steers at the next step, `next` when the turn ends, `later` after everything waiting. */
export const SendPrioritySchema = z.enum(['now', 'next', 'later'])
export type SendPriority = z.infer<typeof SendPrioritySchema>

/** The demo's stage and scenario. */
export const DemoContextSchema = z.object({ stage: StageSchema, scenario: ScenarioSchema })
export type DemoContext = z.infer<typeof DemoContextSchema>

/** `ask`'s options. */
export const AskOptionsSchema = z.object({
  /** The chat the question is asked in: a sample chat's id, or one made with `createChat`. */
  chatId: z.string(),
  /** The part of an answer the person is replying to. */
  quote: z.string().optional(),
  /** The run whose answer this one replaces (Regenerate, Edit of its question, Try again on a failed answer). */
  replacesRun: z.string().optional(),
  attachments: z.array(AttachmentSchema).optional(),
  /** Model id from models.json. */
  mode: z.string().optional(),
  /** How hard that mode thinks, as set in Settings. */
  effort: EffortSchema.optional(),
})
export type AskOptions = z.infer<typeof AskOptionsSchema>

/** `createChat`'s input: the client makes the id, so the chat shows at once. */
export const CreateChatInputSchema = z.object({ id: z.string().min(1), title: z.string() })
export type CreateChatInput = z.infer<typeof CreateChatInputSchema>

/** `send`'s options. */
export const SendOptionsSchema = z.object({ priority: SendPrioritySchema.optional(), attachments: z.array(AttachmentSchema).optional() })
export type SendOptions = z.infer<typeof SendOptionsSchema>
