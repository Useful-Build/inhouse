// P3's contract for chat runs, turns and socket frames (p3-design section 2). Owner: W1. Names are prefixed (`Chat…`,
// `Turn…`, `Send…`) so `export *` from contract/index.ts can't clash; the trace stays `TraceSchema` in trace.ts.
import { z } from 'zod'
import { PROMPT_MAX_CHARS } from '../protocol/index.ts'
import { AgentErrorCodeSchema, InstantSchema, MoneySchema } from './common.ts'
import { MessagePartSchema } from './chat.ts'
import { ChatIdSchema, FileIdSchema, MessageIdSchema, RunIdSchema, StepIdSchema, TurnIdSchema } from './chat-ids.ts'
import { AttachmentRefSchema, FileRefusalReasonSchema } from './attachments.ts'
import { MemberIdSchema } from './members.ts'
import { SendPrioritySchema } from './requests.ts'

export { FileIdSchema, MessageIdSchema, RunIdSchema, StepIdSchema, TurnIdSchema }
export type { RunId, TurnId } from './chat-ids.ts'

// ---------- the socket's frames ----------

/** The chat socket's protocol version (the browser's `?v=`), separate from the Worker-runner protocol's. */
export const CHAT_PROTOCOL_VERSION = 1
export const CHAT_PROTOCOL_ACCEPTED: readonly number[] = [1]
/** Whether this build reads frames of version `v`. */
export const acceptsChatVersion = (v: number): boolean => CHAT_PROTOCOL_ACCEPTED.includes(v)

/**
 * A frame as it travels: parsed first, before its event (version-first decode). A frame whose `v` isn't accepted asks
 * for a reload; an accepted `v` whose event doesn't parse advances `seq` and is skipped (logged once).
 */
export const ChatFrameEnvelopeSchema = z.object({
  v: z.number().int(),
  chatId: ChatIdSchema,
  runId: RunIdSchema,
  seq: z.number().int().min(1),
  at: InstantSchema,
  event: z.unknown(),
})
export type ChatFrameEnvelope = z.infer<typeof ChatFrameEnvelopeSchema>

/** Why a turn failed. `budget_busy`, `max_turns` and `turn_budget` are P3's own; the rest the runner's or the pool's. */
export const TurnFailureSchema = z.enum([
  'session_crashed', 'protocol', 'store', 'files', 'timeout', 'sdk_error', 'max_turns', 'turn_budget', 'cap_reached',
  'budget_busy', 'pool_full', 'unknown',
  // The turn's model was switched off (or lost its price) while the turn waited (W1 PR 2b rechecks at start).
  'model_off',
  // The run was asked for structured output and has none it can give (R3 #151; W1 PR 5 maps the runner's reason).
  'structured_output',
])
export type TurnFailure = z.infer<typeof TurnFailureSchema>

/** Why a turn that never ran was cancelled. */
export const CancelWhySchema = z.enum(['paused', 'removed', 'deleted', 'cap_reached', 'pool_full', 'session_unusable'])
export type CancelWhy = z.infer<typeof CancelWhySchema>

/** One event of a run, in order by the envelope's `seq`. */
export const ChatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started'), runId: RunIdSchema, chatId: ChatIdSchema }),
  z.object({
    type: z.literal('turn.queued'), turnId: TurnIdSchema, messageId: MessageIdSchema, text: z.string(), quote: z.string().optional(),
    attachments: AttachmentRefSchema.array(), priority: SendPrioritySchema, by: MemberIdSchema,
  }),
  z.object({ type: z.literal('turn.started'), turnId: TurnIdSchema, model: z.string() }),
  z.object({ type: z.literal('part'), turnId: TurnIdSchema, messageId: MessageIdSchema, part: MessagePartSchema, model: z.string(), at: InstantSchema }),
  z.object({ type: z.literal('step'), turnId: TurnIdSchema, stepId: StepIdSchema, label: z.string(), tool: z.string().optional() }),
  z.object({ type: z.literal('file'), turnId: TurnIdSchema, fileId: FileIdSchema, name: z.string(), bytes: z.number().int().min(0), contentType: z.string() }),
  z.object({ type: z.literal('file.refused'), turnId: TurnIdSchema, name: z.string(), reason: FileRefusalReasonSchema }),
  z.object({ type: z.literal('files.restored'), turnId: TurnIdSchema, restored: z.number().int(), leftOut: z.array(z.string()) }),
  z.object({
    type: z.literal('turn.finished'), turnId: TurnIdSchema, outcome: z.enum(['done', 'interrupted', 'stopped', 'failed']),
    reason: TurnFailureSchema.optional(),
  }),
  z.object({
    type: z.literal('turn.cancelled'), turnId: TurnIdSchema, why: CancelWhySchema,
  }),
  z.object({ type: z.literal('notice'), code: z.enum(['mirror_error', 'cap_reached', 'budget_busy', 'paused', 'pool_busy', 'session_damaged']) }),
  z.object({ type: z.literal('run.finished'), runId: RunIdSchema, turns: z.number().int(), durationMs: z.number().int().min(0), cost: MoneySchema }),
])
export type ChatEvent = z.infer<typeof ChatEventSchema>

/** What the browser sends on the socket: follow a run from after `fromSeq`, or stop following it. */
export const SocketClientMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('attach'), runId: RunIdSchema, fromSeq: z.number().int().min(0) }),
  z.object({ type: z.literal('detach'), runId: RunIdSchema }),
])

/** What the server sends: a frame, an attach's answer (the run's last seq and whether it's live), or a refusal. */
export const SocketServerMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('frame'), frame: ChatFrameEnvelopeSchema }),
  z.object({ type: z.literal('attached'), runId: RunIdSchema, lastSeq: z.number().int().min(0), live: z.boolean() }),
  z.object({ type: z.literal('refused'), runId: RunIdSchema, code: AgentErrorCodeSchema }),
])
export type SocketServerMsg = z.infer<typeof SocketServerMsgSchema>

// ---------- sending a turn (route 29) ----------

/** A model as the picker names it (`fable`, `opus`, `sonnet`, `haiku`): the id in the `tm:<id>:…` settings keys. */
export const ModelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)

/** The longest prompt a send may compose: the runner's cap, less a margin for what the server adds. */
export const SEND_PROMPT_MAX_CHARS = PROMPT_MAX_CHARS - 2000

/**
 * The prompt a turn sends the runner (p3-design 4.4): the quote as a Markdown quote, then the text, then one line per
 * attachment naming its path under `inputs/` (`inputs/<fileId>-<name>`, as route 39 saves it).
 */
export function composeTurnPrompt(v: { text: string; quote?: string; attachments?: readonly { fileId: string; name: string }[] }): string {
  const parts: string[] = []
  if (v.quote !== undefined) parts.push(v.quote.split('\n').map(l => `> ${l}`).join('\n'))
  parts.push(v.text)
  const atts = v.attachments ?? []
  if (atts.length > 0) parts.push(atts.map(a => `Attached file: inputs/${a.fileId}-${a.name}`).join('\n'))
  return parts.join('\n\n')
}

/** `POST /api/chats/:id/turns`: one message into the chat (a new run, or a queued turn of its live run). */
export const SendTurnInputSchema = z.object({
  /** The client's key for this send: a retried POST with the same key and payload answers the same turn. */
  clientTurnKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  text: z.string().min(1),
  quote: z.string().max(4000).optional(),
  priority: SendPrioritySchema.default('next'),
  model: ModelIdSchema,
  replacesRun: RunIdSchema.optional(),
  attachments: AttachmentRefSchema.array().max(10).default([]),
}).refine(v => composeTurnPrompt(v).length <= SEND_PROMPT_MAX_CHARS, { path: ['text'], message: 'Too long' })
  // The runner refuses a RunStart that names an attachment twice: refused here, at the send, instead.
  .refine(v => new Set(v.attachments.map(a => a.fileId)).size === v.attachments.length, { path: ['attachments'], message: 'An attachment is named twice' })
export type SendTurnInput = z.infer<typeof SendTurnInputSchema>

export const SendTurnResultSchema = z.object({
  runId: RunIdSchema,
  turnId: TurnIdSchema,
  messageId: MessageIdSchema,
  /** `starting`: the turn is starting now; `queued`: it waits behind the run's live turn. */
  position: z.enum(['starting', 'queued']),
})
export type SendTurnResult = z.infer<typeof SendTurnResultSchema>

/** A run the browser may attach to: the live one, or an ended one whose turns aren't all in D1 yet. */
export const ActiveRunSchema = z.object({ runId: RunIdSchema, chatId: ChatIdSchema, lastSeq: z.number().int(), live: z.boolean() })
export type ActiveRun = z.infer<typeof ActiveRunSchema>
/** Route 32's answer (`GET /api/runs/active`), oldest run first. */
export const ActiveRunsSchema = z.object({ runs: z.array(ActiveRunSchema) })
export type ActiveRuns = z.infer<typeof ActiveRunsSchema>

/** Whether the brand's agent is paused (`GET /api/pause`). `by` is a member id: an Admin's, or an Inhouse member's (item 19). */
export const PauseStateSchema = z.object({ paused: z.boolean(), at: InstantSchema.nullable(), by: MemberIdSchema.nullable() })
export type PauseState = z.infer<typeof PauseStateSchema>
