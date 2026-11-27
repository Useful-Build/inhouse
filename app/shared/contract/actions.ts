// Stage 1 M2 (frozen by W0-A, N18): an action the agent proposed, as its card shows it, and the person's answers to it.
// The card's words (`title`, `lines`, `result`, `lapsed`) are the server's own. `can` is for display only: the answering
// update itself checks who may answer (N15). The hold's countdown is drawn from `sendAt` and `serverNow`, never a
// browser timer.
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { ChatIdSchema } from './chat-ids.ts'
import { MemberIdSchema } from './members.ts'
import { GuardrailSchema, PermissionIdSchema, RowIfRevSchema, WriteToolRefSchema } from './permissions.ts'

/** An outbox action's id: `ac_` + 128 random bits (`a_` is an Activity line's). */
export const ActionIdSchema = z.string().regex(/^ac_[A-Za-z0-9_-]{22}$/)
export type ActionId = z.infer<typeof ActionIdSchema>

/** The outbox row's state (N11's `outbox_actions.state`). */
export const ActionStateSchema = z.enum(['waiting', 'approved', 'sending', 'sent', 'failed', 'needs_check', 'undone', 'denied', 'withdrawn', 'expired'])
export type ActionState = z.infer<typeof ActionStateSchema>

/** `ask`: Allow once, Always allow or No. `exact`: Approve or No (a guardrail applies; never Always allow). */
export const ActionKindSchema = z.enum(['ask', 'exact'])
export type ActionKind = z.infer<typeof ActionKindSchema>

/**
 * Stage 1 M3 (N25): who answers the card. `person`: the one approver the row names (the asker, M2's cards). `admins`:
 * any active admin, first answer wins (an operation a member may not approve, such as a refund). Single actions only:
 * a batch is always `person` (money and destructive operations never collect into one).
 */
export const ActionApproverKindSchema = z.enum(['person', 'admins'])
export type ActionApproverKind = z.infer<typeof ActionApproverKindSchema>

/** Stage 1 M3 (N22): the most items one batch holds (the ceiling's `batch_max` is 1 to this). */
export const BATCH_ITEMS_MAX = 500
/** Stage 1 M3 (N33): how many of a batch's item lines the card itself carries; the rest page through the items route. */
export const BATCH_FIRST_LINES = 10

/**
 * Stage 1 M3 (N33): a batch card's list, as the card holds it. `itemCount` is the tip (the items on the card now);
 * `firstLines` the first 10 items' lines (destination and material arguments, server words); `totals` sum items 1 to
 * `itemCount` in the person's words ("120 orders", "+2,400 stock units"). `amount` is a money total already formatted by
 * the server ("$24.90 (USD)"); a batch never moves money today, so it's set by no operation yet.
 */
// ---------- Stage 1 M3 (card details, #488): who and how much, beside the ids ----------

/** The longest text a detail row holds, in code points (cleaned and cut by the server, server/outbox/detail.ts). */
export const DETAIL_TEXT_MAX = { order: 40, customer: 80, product: 120, sku: 64 } as const

/**
 * One row of what a card or an item is about, read from the connected store when the agent asked (display only: the
 * agent never sees these). `ref` is always there; each other field only when the store answered it:
 * - `order`: the order's name as the shop shows it ("#3901"); `customer`: its customer's name ("Alex Moore");
 * - `amount`: the money that matters, already formatted ("$642.10": the order's total, or a refund's amount) with its
 *   ISO 4217 `currency`;
 * - `product`: a draft-order line's product and variant ("Linen shirt, M"), its `sku` and `quantity`;
 * - `notFound`: the store has no such order or product now (deleted, or the id is wrong): show the id and say so.
 * The text is the store's, cleaned: no control or bidi characters, no links, no markup, cut to `DETAIL_TEXT_MAX`.
 */
export const ActionDetailRowSchema = z.object({
  /** What the ids say, in server words ("Order 9001", "Variant 7001"): always there, so a row stands on its own. */
  ref: z.string().max(60),
  order: z.string().max(DETAIL_TEXT_MAX.order).optional(),
  customer: z.string().max(DETAIL_TEXT_MAX.customer).optional(),
  amount: z.string().max(40).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  product: z.string().max(DETAIL_TEXT_MAX.product).optional(),
  sku: z.string().max(DETAIL_TEXT_MAX.sku).optional(),
  quantity: z.number().int().min(1).optional(),
  notFound: z.literal(true).optional(),
}).strict()
export type ActionDetailRow = z.infer<typeof ActionDetailRowSchema>

/**
 * A card's or an item's detail rows, in the order of its ids: one per order (a tag call, a refund), or one per line (a
 * draft order). Absent when nothing was read (the store didn't answer, or the operation has no such facts).
 */
export const ActionDetailSchema = z.object({ rows: z.array(ActionDetailRowSchema).min(1).max(100) }).strict()
export type ActionDetail = z.infer<typeof ActionDetailSchema>

export const ActionBatchSchema = z.object({
  /** 0 only for a batch whose every item moved to a new card before any was sent (the old card lapses in place). */
  itemCount: z.number().int().min(0).max(BATCH_ITEMS_MAX),
  firstLines: z.array(z.string()).max(BATCH_FIRST_LINES),
  totals: z.object({
    records: z.number().int().min(0),
    units: z.number().int().min(0),
    unitsLabel: z.string(),
    amount: z.string().optional(),
  }),
  /**
   * Stage 1 M3 (card details): the first lines' details, one per entry of `firstLines` in the same order (null where an
   * item has none). Absent on a card built before details existed.
   */
  firstDetails: z.array(ActionDetailSchema.nullable()).max(BATCH_FIRST_LINES).optional(),
})
export type ActionBatch = z.infer<typeof ActionBatchSchema>

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
  /**
   * Stage 1 M2-D: the permission the action ran under ("Always allow"), so "Stop allowing this" names that one. Only for
   * a viewer who may remove it (its holder, the asker, or an admin).
   */
  permissionId: PermissionIdSchema.optional(),
  /**
   * `withdraw` (Stage 1 M3, N25): the asker may take back a card someone else answers (an admins card); the route is
   * M3-X's. False on every card before then.
   */
  can: z.object({ allowOnce: z.boolean(), alwaysAllow: z.boolean(), approve: z.boolean(), deny: z.boolean(), undo: z.boolean(), resolve: z.boolean(), withdraw: z.boolean() }),
  /** Offer Always allow first: this person said Allow once 3 times for this operation and scope in 30 days. */
  nudgeAlways: z.boolean(),
  /** Stage 1 M3 (N22, N33): set only for a batch (one action with an item list). */
  batch: ActionBatchSchema.optional(),
  /** Stage 1 M3 (card details, #488): a single action's detail rows (a batch's are its items'). */
  detail: ActionDetailSchema.optional(),
  /** Stage 1 M3 (N25): who answers it. */
  approverKind: ActionApproverKindSchema,
  /** Stage 1 M3 (N25): whom a waiting card waits for, in server words ("an admin"), for a viewer who can't answer it. */
  waitingFor: z.string().optional(),
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

/**
 * Stage 1 M3 (N22, N33): what a batch answer says it saw. `upTo`: the items it covers, 1 to `upTo` (at most the tip
 * when it answers); `totals`: those items' records and units as the card showed them. The server refuses the answer
 * (`totals_changed`) when they don't match the stored items 1 to `upTo`. Required for a batch, for Approve and No
 * alike, refused for a single action (the server checks which the row is). Either way, items after `upTo` (added while
 * the card was open) move to a new collecting card that needs its own answer: a No covers only what it saw.
 */
export const ActionAnswerTotalsSchema = z.object({ records: z.number().int().min(0), units: z.number().int().min(0) }).strict()
export type ActionAnswerTotals = z.infer<typeof ActionAnswerTotalsSchema>

/** `POST /api/actions/:id/answer`. `upTo` and `totals` come together or not at all (Stage 1 M3). */
export const AnswerActionInputSchema = z.object({
  choice: ActionChoiceSchema,
  ifRev: RowIfRevSchema,
  upTo: z.number().int().min(1).max(BATCH_ITEMS_MAX).optional(),
  totals: ActionAnswerTotalsSchema.optional(),
}).strict().refine(a => (a.upTo === undefined) === (a.totals === undefined), { message: 'upTo and totals come together', path: ['totals'] })
export type AnswerActionInput = z.infer<typeof AnswerActionInputSchema>

/** `undoAction(id, ifRev)`: an approved action, before its claim. */
export const UndoActionInputSchema = z.object({ ifRev: RowIfRevSchema }).strict()
export type UndoActionInput = z.infer<typeof UndoActionInputSchema>

/** What a person says about a "Needs a check" action. */
export const ActionResolutionSchema = z.enum(['sent', 'failed'])
export type ActionResolution = z.infer<typeof ActionResolutionSchema>

/**
 * `resolveAction(id, ifRev, outcome)`: `needs_check` to `sent` or `failed`. `item` (Stage 1 M3, N22): a batch's unclear
 * items are resolved one at a time, by position; the batch ends `sent` or `failed` once none is unclear. Required for a
 * batch, refused for a single action.
 */
export const ResolveActionInputSchema = z.object({
  outcome: ActionResolutionSchema,
  ifRev: RowIfRevSchema,
  item: z.number().int().min(1).max(BATCH_ITEMS_MAX).optional(),
}).strict()
export type ResolveActionInput = z.infer<typeof ResolveActionInputSchema>

/** Stage 1 M3 (N25; M3-X's route): the asker takes back a waiting card (`can.withdraw`). */
export const WithdrawActionInputSchema = z.object({ ifRev: RowIfRevSchema }).strict()
export type WithdrawActionInput = z.infer<typeof WithdrawActionInputSchema>

// ---------- Stage 1 M3 (N22, N33): a batch's items ----------

/**
 * One item's state (`outbox_items.state`): `pending` until its claim; `sending` while its hub call runs; then `sent`,
 * `failed` or `needs_check`; `withdrawn` when it can never be approved (the asker removed, the chat deleted). An item
 * moved to a new card keeps its id and is `pending` there.
 */
export const ActionItemStateSchema = z.enum(['pending', 'sending', 'sent', 'failed', 'needs_check', 'withdrawn'])
export type ActionItemState = z.infer<typeof ActionItemStateSchema>

/** One item as the full list shows it: its position in the batch, its line (server words) and its outcome. */
export const ActionItemSchema = z.object({
  n: z.number().int().min(1).max(BATCH_ITEMS_MAX),
  line: z.string(),
  state: ActionItemStateSchema,
  /** The outcome in server words, once it has one (sent with its safe ref, or the failure). */
  result: z.string().optional(),
  /** Stage 1 M3 (card details, #488): the item's detail rows ("#3901 · Alex Moore · $642.10"). */
  detail: ActionDetailSchema.optional(),
})
export type ActionItem = z.infer<typeof ActionItemSchema>

/** Items per page of `GET /api/actions/:id/items`. */
export const ACTION_ITEMS_PAGE = 100

/** `GET /api/actions/:id/items?after=n`: items after position `n` (0 for the first page), arriving as query text. */
export const ActionItemsQuerySchema = z.object({ after: z.coerce.number().int().min(0).max(BATCH_ITEMS_MAX).default(0) }).strict()
export type ActionItemsQuery = z.infer<typeof ActionItemsQuerySchema>

/** One page of a batch's items, in order. `next`: the `after` for the next page; absent on the last. */
export const ActionItemsPageSchema = z.object({
  items: z.array(ActionItemSchema).max(ACTION_ITEMS_PAGE),
  next: z.number().int().min(1).max(BATCH_ITEMS_MAX).optional(),
})
export type ActionItemsPage = z.infer<typeof ActionItemsPageSchema>
