// P5 W1's store (p5-w1.md section 9, decided by the orchestrator 2026-11-21): `account`, since the connection belongs
// to the brand and outlives the person who made it. A person deletion pseudonymises their member row in place, so the
// ids in `connected_by` and `disconnected_by` stay and name "Former member" (decision Q3).
import type { TableEntry } from './types.ts'

export const connectorTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'connector_accounts', retention: 'account', personKeys: ['connected_by', 'disconnected_by'], export: true },
]
