// The access matrix (p2-design section 3): one row per route in routes.ts, read by `checkAccess`. Orchestrator only.
// PR0b adds the 21 rows once W1's first PR defines the row type; until then the type is a placeholder and the table is
// empty, so any route without a row fails closed (server/index.ts).

import type { AccessRow } from './auth/matrix.ts'

export type { AccessRow }

export const accessMatrix: readonly AccessRow[] = []
