// Stage 1 M2-H: the action state with an underscore, spelled once for the client. scripts/check-icons.mjs reads any
// underscored string in src/ as an icon name, so src/ names it through this constant (as it names `not_found` through
// error-codes.ts). Type-only import: no zod reaches the screens that use it.
import type { ActionState } from './actions.ts'

export const NEEDS_CHECK = 'needs_check' satisfies ActionState
