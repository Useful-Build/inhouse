// Stage 1 M2 (frozen by W0-A; M2-B builds it, N11 and N12): the outbox's row, its gate row and its port. Types only.
// `request` is the only way a write gets in. Every other change to a row goes through this port, bound to `ifRev`.
import type { ActionChoice, ActionResolution, ActionState } from '../../shared/contract/actions.ts'
import type { AgentErrorCode, ErrorReason } from '../../shared/contract/common.ts'
import type { MemberRole } from '../../shared/contract/members.ts'
import type { DecideCtx, Guardrail, Origin, Proposed, RefuseReason, WriteOperationKey } from '../permissions/types.ts'

export type { ActionState }

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
  created_at_ms: number
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
}

/** `request`'s context: the decide context plus the invocation it came from. */
export interface OutboxRequestCtx extends DecideCtx {
  runId: string | null
  turnId: string | null
  /** The admitted main-agent invocation (N14). Null for a proposal with no tool call behind it. */
  toolUseId: string | null
  jobId: string | null
}

export type OutboxRequestMode = 'tool' | 'ask_only'

export type OutboxRequestResult =
  /** Nothing was written. `text` is the plain refusal the agent reads. */
  | { outcome: 'refused'; reason: RefuseReason; text: string }
  /** A card waits for a person (`ask` or `exact`). `existing`: a retry got the waiting card it already made. */
  | { outcome: 'waiting'; action: OutboxActionRow; existing: boolean }
  /** Approved under a grant with its use reserved; it sends after the hold. */
  | { outcome: 'approved'; action: OutboxActionRow }

/** A member acting on a row through the API. */
export interface OutboxActor { memberId: string; role: MemberRole }

/** The same shape as BrandAgent's refusals (`do/brand-agent/ports.ts` `Refusal`). */
export type OutboxRefusal = { refused: { code: AgentErrorCode; reason?: ErrorReason } }

export type OutboxChange = { action: OutboxActionRow } | OutboxRefusal

export interface OutboxPort {
  request(ctx: OutboxRequestCtx, proposed: Proposed, opts: { mode: OutboxRequestMode }): Promise<OutboxRequestResult>
  /** `waiting` to `approved` or `denied`; `always` only on an `ask` row, and it adds the grant under this answer's stamp. */
  answer(actor: OutboxActor, actionId: string, input: { choice: ActionChoice; ifRev: number }): Promise<OutboxChange>
  /** `approved` to `undone`, only before the claim. */
  undo(actor: OutboxActor, actionId: string, input: { ifRev: number }): Promise<OutboxChange>
  /** `waiting` to `withdrawn`: the asker, or the agent for its own action (`approval_withdraw`). */
  withdraw(by: { kind: 'member'; actor: OutboxActor } | { kind: 'agent'; chatId: string; turnId: string }, actionId: string, input: { ifRev: number }): Promise<OutboxChange>
  /** `needs_check` to `sent` or `failed`: the approver or an admin. "It didn't go out" releases the use. */
  resolve(actor: OutboxActor, actionId: string, input: { outcome: ActionResolution; ifRev: number }): Promise<OutboxChange>
}
