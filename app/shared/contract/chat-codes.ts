// The snake_case names of P3's turn failures, run notices and cancel reasons, for the client code that has to name one. The
// icon check (scripts/check-icons.mjs) reads a quoted snake_case string in src/ as an icon name, so these live here, like
// error-codes.ts. Plain values: the only import is a type, so the entry bundle takes it without zod. Each is checked
// against its schema in runs.ts by `satisfies`.
import type { ChatEvent, TurnFailure } from './runs.ts'

type Notice = Extract<ChatEvent, { type: 'notice' }>['code']
type Cancel = Extract<ChatEvent, { type: 'turn.cancelled' }>['why']

export const FAIL = {
  sessionCrashed: 'session_crashed', protocol: 'protocol', store: 'store', files: 'files', timeout: 'timeout', sdkError: 'sdk_error',
  maxTurns: 'max_turns', turnBudget: 'turn_budget', capReached: 'cap_reached', budgetBusy: 'budget_busy', poolFull: 'pool_full', unknown: 'unknown',
  modelOff: 'model_off',
  structuredOutput: 'structured_output',
  jobBudget: 'job_budget',
} as const satisfies Record<string, TurnFailure>

export const NOTICE = {
  mirrorError: 'mirror_error', capReached: 'cap_reached', budgetBusy: 'budget_busy', paused: 'paused', poolBusy: 'pool_busy', sessionDamaged: 'session_damaged',
} as const satisfies Record<string, Notice>

export const CANCEL = {
  paused: 'paused', removed: 'removed', deleted: 'deleted', capReached: 'cap_reached', poolFull: 'pool_full', sessionUnusable: 'session_unusable',
  jobBudget: 'job_budget',
} as const satisfies Record<string, Cancel>
