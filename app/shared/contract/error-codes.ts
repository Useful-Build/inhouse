// The error codes the client code names in a place where the schema (zod) can't be imported: this file has no imports, so
// it adds nothing to a bundle but the string. Keep each in step with `AgentErrorCodeSchema` in ./common.ts.
// (Also keeps `scripts/check-icons.mjs` from reading a snake_case code in src/ as an icon name.)
import type { AgentErrorCode, ErrorReason } from './common.ts'

export const NOT_FOUND = 'not_found' satisfies AgentErrorCode
export const CONFLICT = 'conflict' satisfies AgentErrorCode
export const INVALID = 'invalid' satisfies AgentErrorCode
export const FORBIDDEN = 'forbidden' satisfies AgentErrorCode
export const UNAUTHORIZED = 'unauthorized' satisfies AgentErrorCode
/** The reasons the client code names (same reason as above: no snake_case string in src/). */
export const REASON = {
  badType: 'bad_type', wrongScope: 'wrong_scope', alreadyMember: 'already_member', lastAdmin: 'last_admin', grantLive: 'grant_live',
} as const satisfies Record<string, ErrorReason>
