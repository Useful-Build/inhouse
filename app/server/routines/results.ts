// The result handlers (p4-w2.md section 6, step 2), by routine kind. `agent` (a team routine) has none. W3 adds
// `morning_check` by an orchestrator line. A handler reads what it needs before the end's batch and returns idempotent
// statements keyed by the slot, so a re-delivered end writes nothing twice.
import type { OutputFormat } from '../../shared/protocol/index.ts'
import type { ActivityTemplateId } from '../activity/templates.ts'
import type { FieldValues } from '../activity/fields.ts'
import type { TurnEndPayload } from '../do/brand-agent/ports.ts'

/** The slot an end lands on, as the end handler read it. */
export interface EndSlot {
  slot_key: string
  routine_id: string
  kind: 'scheduled' | 'manual'
  local_date: string
  local_time: string | null
  claimed_at_ms: number
  creator_id: string
  requested_by: string | null
}

/** Seam B's payload as delivered: how the turn ended, its failure code or null, the structured result or null. */
export type EndOutcome = Pick<TurnEndPayload, 'outcome' | 'failure' | 'structuredOutput'>

export interface ResultOutput {
  statements: D1PreparedStatement[]
  /** The slot's `result_text` (the Routines page's last result); null when the handler has nothing to say. */
  summary: string | null
  /** `invalid_result`, `incomplete`, `not_connected` or `run_failed`: kept on the slot when P3 gave no failure. */
  failure?: string
  /** The Activity line on success instead of "Ran a routine" (a system routine's own words). */
  activity?: { template: ActivityTemplateId; fields: FieldValues }
}

export interface ResultHandler {
  /** Sent as the turn's `outputFormat`. */
  outputFormat?: OutputFormat
  run(slot: EndSlot, end: EndOutcome, ctx: { db: D1Database; nowMs: number }): Promise<ResultOutput>
}

export const RESULT_HANDLERS: Readonly<Record<string, ResultHandler>> = {}
