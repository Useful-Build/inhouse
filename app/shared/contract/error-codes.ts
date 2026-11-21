// The error codes the client code names in a place where the schema (zod) can't be imported: this file has no imports, so
// it adds nothing to a bundle but the string. Keep each in step with `AgentErrorCodeSchema` in ./common.ts.
// (Also keeps `scripts/check-icons.mjs` from reading a snake_case code in src/ as an icon name.)
import type { AgentErrorCode } from './common.ts'

export const NOT_FOUND = 'not_found' satisfies AgentErrorCode
