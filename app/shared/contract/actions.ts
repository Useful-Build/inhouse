// Stage 1 M2 (frozen by W0-A, N18): an action the agent proposed, as its card shows it, and the person's answers to it.
// The card's words (`title`, `lines`, `result`, `lapsed`) are the server's own. `can` is for display only: the answering
// update itself checks who may answer (N15). The hold's countdown is drawn from `sendAt` and `serverNow`, never a
// browser timer.
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { ChatIdSchema } from './chat-ids.ts'
import { IfRevSchema, MemberIdSchema } from './members.ts'
import { GuardrailSchema, WriteToolRefSchema } from './permissions.ts'

/** An outbox action's id: `a_` + 128 random bits. */
export const ActionIdSchema = z.string().regex(/^a_[A-Za-z0-9_-]{22}$/)
export type ActionId = z.infer<typeof ActionIdSchema>

/** The outbox row's state (N11's `outbox_actions.state`). */
export const ActionStateSchema = z.enum(['waiting', 'approved', 'sending', 'sent', 'failed', 'needs_check', 'undone', 'denied', 'withdrawn', 'expired'])
export type ActionState = z.infer<typeof ActionStateSchema>

/** `ask`: Allow once, Always allow or No. `exact`: Approve or No (a guardrail applies; never Always allow). */
export const ActionKindSchema = z.enum(['ask', 'exact'])
export type ActionKind = z.infer<typeof ActionKindSchema>

export const ActionCardSchema = z.object({
  id: ActionIdSchema,
  rev: z.number().int().min(1),
  kind: ActionKindSchema,
  state: ActionStateSchema,
  title: z.string(),
  lines: z.array(z.string()),
  tool: WriteToolRefSchema,
  records: z.number().int().min(0),
  reachesCustomer: z.boolean(),
  reversible: z.boolean(),
  guardrail: GuardrailSchema.optional(),
  /** Null for a viewer who may not open the chat (an admin in Approvals). */
  chatId: ChatIdSchema.nullable(),
  askedBy: MemberIdSchema,
  askedAt: InstantSchema,
  /** When the hold ends and the send may start (an approved action). */
  sendAt: InstantSchema.optional(),
  /** The server's clock when it built the card. */
  serverNow: InstantSchema,
  /** The outcome in server words (sent, with the safe ref; or the failure). */
  result: z.string().optional(),
  /** Why an approval lapsed, in server words (paused, the account changed, the grant was removed). */
  lapsed: z.string().optional(),
  can: z.object({ allowOnce: z.boolean(), alwaysAllow: z.boolean(), approve: z.boolean(), deny: z.boolean(), undo: z.boolean(), resolve: z.boolean() }),
  /** Offer Always allow first: this person said Allow once 3 times for this operation and scope in 30 days. */
  nudgeAlways: z.boolean(),
})
export type ActionCard = z.infer<typeof ActionCardSchema>

/** `actions(filter)`: the cards this person may see, newest first, narrowed to some states or one chat. */
export const ActionFilterSchema = z.object({
  states: z.array(ActionStateSchema).min(1).max(10).optional(),
  chatId: ChatIdSchema.optional(),
}).strict()
export type ActionFilter = z.infer<typeof ActionFilterSchema>

export const ActionsListSchema = z.object({ items: z.array(ActionCardSchema) })
export type ActionsList = z.infer<typeof ActionsListSchema>

/** `once` and `always` answer an `ask` card, `approve` an `exact` one; `deny` either. */
export const ActionChoiceSchema = z.enum(['once', 'always', 'approve', 'deny'])
export type ActionChoice = z.infer<typeof ActionChoiceSchema>

/** `POST /api/actions/:id/answer`. */
export const AnswerActionInputSchema = z.object({ choice: ActionChoiceSchema, ifRev: IfRevSchema }).strict()
export type AnswerActionInput = z.infer<typeof AnswerActionInputSchema>

/** `undoAction(id, ifRev)`: an approved action, before its claim. */
export const UndoActionInputSchema = z.object({ ifRev: IfRevSchema }).strict()
export type UndoActionInput = z.infer<typeof UndoActionInputSchema>

/** What a person says about a "Needs a check" action. */
export const ActionResolutionSchema = z.enum(['sent', 'failed'])
export type ActionResolution = z.infer<typeof ActionResolutionSchema>

/** `resolveAction(id, ifRev, outcome)`: `needs_check` to `sent` or `failed`. */
export const ResolveActionInputSchema = z.object({ outcome: ActionResolutionSchema, ifRev: IfRevSchema }).strict()
export type ResolveActionInput = z.infer<typeof ResolveActionInputSchema>
