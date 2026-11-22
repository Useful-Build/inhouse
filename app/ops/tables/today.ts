// P4 W3's registry entries (p4-w3.md section 4, revision 3.2; P8 C1's store rows 19 and 20). Both are `retention_period`
// (group `steps`): `today_items.created_at_ms` and `today_aside.at_ms` are the retention columns for C1's rule
// (TableEntry has no field for it). `today_items` is store data (level 1: no person keys). C1's person-deletion rule for
// `today_aside` is keep (its Q6): `by` goes pseudonymous with the member row.
import type { TableEntry } from './types.ts'

export const todayTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'today_items', retention: 'retention_period', personKeys: [], export: true },
  { kind: 'd1', name: 'today_aside', retention: 'retention_period', personKeys: ['by'], export: true },
]
