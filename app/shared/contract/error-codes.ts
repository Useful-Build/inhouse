// The error codes the client code names in a place where the schema (zod) can't be imported: this file has no imports, so
// it adds nothing to a bundle but the string. Keep each in step with `AgentErrorCodeSchema` in ./common.ts.
// (Also keeps `scripts/check-icons.mjs` from reading a snake_case code in src/ as an icon name.)
import type { AgentErrorCode, ErrorReason } from './common.ts'
import type { FileRefusalReason } from './attachments.ts'

export const NOT_FOUND = 'not_found' satisfies AgentErrorCode
export const CONFLICT = 'conflict' satisfies AgentErrorCode
export const INVALID = 'invalid' satisfies AgentErrorCode
export const FORBIDDEN = 'forbidden' satisfies AgentErrorCode
export const UNAUTHORIZED = 'unauthorized' satisfies AgentErrorCode
/** The reasons the client code names (same reason as above: no snake_case string in src/). */
export const REASON = {
  badType: 'bad_type', wrongScope: 'wrong_scope', alreadyMember: 'already_member', lastAdmin: 'last_admin', grantLive: 'grant_live', notInvited: 'not_invited', removed: 'removed',
  // P3: the refusals the chat client tells apart (p3-design sections 4.3 and 4.9).
  paused: 'paused', draining: 'draining', modelOff: 'model_off', turnEnded: 'turn_ended', providerChanged: 'provider_changed',
  queueFull: 'queue_full', keyReused: 'key_reused', sessionDamaged: 'session_damaged', waitingAnswer: 'waiting_answer',
  tooMany: 'too_many', badName: 'bad_name',
  // Route 39 (an attachment's upload).
  tooLarge: 'too_large', typeNotAllowed: 'type_not_allowed',
} as const satisfies Record<string, ErrorReason>
/** Why the runner didn't save a file the agent made (the `file.refused` event), as the chat names them. */
export const FILE_REFUSAL = {
  tooLarge: 'too_large', tooMany: 'too_many', typeNotAllowed: 'type_not_allowed', saveFailed: 'save_failed', badName: 'bad_name',
} as const satisfies Record<string, FileRefusalReason>
export const RATE_LIMITED = 'rate_limited' satisfies AgentErrorCode
