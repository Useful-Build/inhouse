// Stage 1 M2 (frozen by W0-A; M2-B builds it, N11 and N12): the outbox's row, its gate row and its port. Types only.
// `request` is the only way a write gets in. Every other change to a row goes through this port, bound to `ifRev`.
import type { ActionAnswerTotals, ActionApproverKind, ActionChoice, ActionItemsPage, ActionItemState, ActionResolution, ActionState } from '../../shared/contract/actions.ts'
import type { AgentErrorCode, ErrorReason } from '../../shared/contract/common.ts'
import type { MemberRole } from '../../shared/contract/members.ts'
import type { DecideCtx, Guardrail, Origin, Proposed, RefuseReason, WriteOperationKey } from '../permissions/types.ts'

export type { ActionItemState, ActionState }

/** Stage 1 M3 (N22): a single action (M2's path) or a batch (one action with an item list, `outbox/batch/`). */
export type OutboxActionKind = 'single' | 'batch'
/** Stage 1 M3 (N25): who answers the row: its `approver` (a person), or any active admin (`approver = 'role:admin'`). */
export type OutboxApproverKind = ActionApproverKind

/** How a proposal arrived: the agent's write tool, or `approval_request` (never `run`). */
export type OutboxVia = 'tool' | 'approval_request'
/** Who tells the agent the result (N14). */
export type OutboxReport = 'tool' | 'later' | 'resume' | 'none'

/** One `outbox_actions` row, as D1 returns it (0730_outbox.sql). */
export interface OutboxActionRow {
  id: string
  rev: number
  state: ActionState
  verdict: 'run' | 'ask' | 'exact'
  guardrail: Guardrail | null
  origin: Origin
  via: OutboxVia
  asked_by: string
  approver: string
  chat_id: string
  run_id: string | null
  turn_id: string | null
  tool_use_id: string | null
  job_id: string | null
  account_id: string
  account_gen: number
  operation: WriteOperationKey
  policy_rev: number
  scope_json: string
  scope_key: string
  args_json: string
  payload_hash: string
  records: number
  units: number
  card_json: string
  /**
   * Stage 1 M3 (card details, #488): the facts the card shows beside the ids (shared/contract/actions.ts `ActionDetail`),
   * read from Shopify at request time and cleaned (detail.ts). Display only: never in `card_json`, whose words reach
   * the agent. Null when none were read. Set at insert only.
   */
  detail_json: string | null
  grant_id: string | null
  approved_by: string | null
  approved_rev: number | null
  approved_at_ms: number | null
  approved_epoch: number | null
  send_at_ms: number | null
  claimed_at_ms: number | null
  attempt: number
  result_json: string | null
  error_code: string | null
  lapsed_reason: string | null
  resolved_by: string | null
  resolved_at_ms: number | null
  report: OutboxReport | null
  expires_at_ms: number
  /** Set when the row enters a final state; null while open (M2-B: retention ages rows by it, never an open one). */
  final_at_ms: number | null
  // Stage 1 M3 (N22, N25; 0770_outbox_batches.sql, M3-B). Until 0770 runs these columns don't exist; nothing reads them
  // before M3-B.
  kind: OutboxActionKind
  approver_kind: OutboxApproverKind
  /** The tip: the items on a batch's card now (0 for a single action). */
  items_n: number
  /** The items the approval covers, 1 to this; null until a batch is approved (and for a single action). */
  approved_upto: number | null
  /** `operation`, account, generation and scope key while a batch collects; cleared when it leaves `waiting` or is full. */
  coalesce_key: string | null
  created_at_ms: number
  updated_at_ms: number
  stamp: string | null
}

/**
 * Stage 1 M3 (N22; 0770_outbox_batches.sql, M3-B): one item of a batch, one hub call. `item_id` (`oi_` + random) and the
 * call that made it are kept across moves; `action_id`, `n` and `moved_from` change only while `pending` (a trigger
 * refuses any other change to the item's identity, arguments, line or counts).
 *
 * Two ways an item is made: a call over the bulk threshold (or a multi-record call under a grant) is split by its
 * entry's `items` into one item per record, `tool_use_id` null (the call is on the batch row); a call that joins a
 * collecting batch is one item holding the whole call, up to `bulk_threshold` records (so 2 to 5 orders are one item and
 * one hub call), `tool_use_id` set.
 */
export interface OutboxItemRow {
  item_id: string
  action_id: string
  /** Position in its current batch, 1-based. */
  n: number
  chat_id: string
  /** The call that made it (a collected item, the whole call); null for an item split from a one-call batch. */
  tool_use_id: string | null
  args_json: string
  payload_hash: string
  line: string
  /** Stage 1 M3 (card details): the item's display-only facts, as `OutboxActionRow.detail_json`. */
  detail_json: string | null
  records: number
  units: number
  /** The batch it left, for the audit trail. */
  moved_from: string | null
  state: ActionItemState
  attempt: number
  /** Throttled answers so far (nothing ran); after 5 the item is `failed`. */
  throttles: number
  /** Not claimed before this (a throttle's `retryAfterMs`). */
  not_before_ms: number | null
  claimed_at_ms: number | null
  result_json: string | null
  error_code: string | null
  resolved_by: string | null
  resolved_at_ms: number | null
  /** M3-B (0770): when the item was made (the backup's paged read). */
  created_at_ms: number
  /** M3-B (0770): its batch's `final_at_ms` once the batch is final (retention's age); null while it's open. */
  final_at_ms: number | null
  updated_at_ms: number
  stamp: string | null
}

/** The one `outbox_gate` row: the truth for D1 about Pause and the restore hold (N12). */
export interface OutboxGateRow {
  id: 1
  paused: 0 | 1
  restore_hold: 0 | 1
  epoch: number
  /** BrandAgent's `pause_gen` as of the last successful sync. A claim needs it to equal the dispatcher's `pauseGen`. */
  do_gen: number
  updated_at_ms: number
  /** The last sync that moved the gate (its later statements act only under it). */
  stamp: string | null
}

/** The admitted main-agent tool call a proposal came from (N14's `admitAction`). */
export interface OutboxInvocation { runId: string; turnId: string; toolUseId: string }

/** `request`'s context: the decide context plus the invocation it came from. */
export interface OutboxRequestCtx extends DecideCtx {
  /**
   * Always set for a proposal from a turn, both modes: the row's `(chat_id, tool_use_id)` index makes a replay return the
   * same row. Null only for the test build's fakes hook (N19), which has no tool call behind it.
   */
  invocation: OutboxInvocation | null
  jobId: string | null
}

export type OutboxRequestMode = 'tool' | 'ask_only'

/**
 * `decide`'s refusals, plus `chat_deleted` (M2-D: the chat is in the trash) and `invocation_conflict`: a row for the same `(chat_id, tool_use_id)` holds other arguments
 * (another `payload_hash`). Nothing is written for either. `busy` (Stage 1 M3-B, N22): a collecting batch's tip moved under
 * the call three times in a row; nothing was written and the call may be made again.
 */
export type OutboxRefuseReason = RefuseReason | 'invocation_conflict' | 'chat_deleted' | 'busy'

export type OutboxRequestResult =
  /** Nothing was written. `text` is the plain refusal the agent reads. */
  | { outcome: 'refused'; reason: OutboxRefuseReason; text: string }
  /**
   * A new card waits for a person (`ask` or `exact`). `existing`: another invocation in this chat already has a waiting
   * card for the same `payload_hash`, and this is that card (no second card for a retry).
   */
  | { outcome: 'waiting'; action: OutboxActionRow; existing: boolean }
  /**
   * Stage 1 M3 (N22; M3-B returns it): the call joined a collecting batch. `item` is the call's own item; `action` is the
   * batch that holds it now, shared with other calls, so it is never this call's own action: its id isn't the call's
   * approval id, and its state isn't the call's outcome (read `item.state`). `existing`: nothing new was written (a
   * replay of this call, wherever its item now sits, or the same payload already pending in the open batch).
   */
  | { outcome: 'collected'; action: OutboxActionRow; item: OutboxItemRow; existing: boolean }
  /** New, approved under a grant with its use reserved; it sends after the hold. */
  | { outcome: 'approved'; action: OutboxActionRow }
  /**
   * A replay: this `(chat_id, tool_use_id)` already has a row with the same arguments, returned as it is in whatever
   * state it's in now (waiting, approved, sending, sent, failed, needs_check, undone, denied, withdrawn or expired).
   * Nothing is written.
   */
  | { outcome: 'existing'; action: OutboxActionRow }

/** A member acting on a row through the API. */
export interface OutboxActor { memberId: string; role: MemberRole }

/** The same shape as BrandAgent's refusals (`do/brand-agent/ports.ts` `Refusal`). */
export type OutboxRefusal = { refused: { code: AgentErrorCode; reason?: ErrorReason } }

export type OutboxChange = { action: OutboxActionRow } | OutboxRefusal

export interface OutboxPort {
  request(ctx: OutboxRequestCtx, proposed: Proposed, opts: { mode: OutboxRequestMode }): Promise<OutboxRequestResult>
  /**
   * `waiting` to `approved` or `denied`; `always` only on an `ask` row, and it adds the grant under this answer's stamp.
   * Stage 1 M3 (N22): a batch's answer carries `upTo` and the `totals` the card showed for items 1 to `upTo`.
   */
  answer(actor: OutboxActor, actionId: string, input: { choice: ActionChoice; ifRev: number; upTo?: number; totals?: ActionAnswerTotals }): Promise<OutboxChange>
  /** `approved` to `undone`, only before the claim. */
  undo(actor: OutboxActor, actionId: string, input: { ifRev: number }): Promise<OutboxChange>
  /**
   * `waiting` to `withdrawn`: the asker (a single card only, Stage 1 M3-X #527: never a batch, which holds other calls'
   * items), or the agent for its own action (`approval_withdraw`).
   */
  withdraw(by: { kind: 'member'; actor: OutboxActor } | { kind: 'agent'; chatId: string; turnId: string }, actionId: string, input: { ifRev: number }): Promise<OutboxChange>
  /**
   * `needs_check` to `sent` or `failed`: the approver or an admin. "It didn't go out" releases the use. Stage 1 M3 (N22):
   * a batch's unclear item by its position `item`; the batch ends once none is unclear.
   */
  resolve(actor: OutboxActor, actionId: string, input: { outcome: ActionResolution; ifRev: number; item?: number }): Promise<OutboxChange>
}

/**
 * Stage 1 M3 (N22, N33; M3-B builds it): a batch's full item list, `GET /api/actions/:id/items?after=n`, for a person
 * who may see the card. A single action has no items (`not_found`).
 */
export interface OutboxItemsPort {
  items(viewer: OutboxActor, actionId: string, query: { after: number }): Promise<{ page: ActionItemsPage } | OutboxRefusal>
}
