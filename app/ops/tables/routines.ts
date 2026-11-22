// P4 W2's registry entries (p4-w2.md section 2, revision 3.2; P8 C1's store rows 17 and 18). C1's person-deletion rule
// for both is keep: the ids go pseudonymous with the member row (its Q6). Retention columns for C1's rule (TableEntry has
// no field for it): `routines` none (config, kept while the routine is); `routine_slots.claimed_at_ms` (group `steps`).
// `routine_alerts` holds two invariant codes and a count, no person data.
import type { TableEntry } from './types.ts'

export const routineTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'routines', retention: 'config', personKeys: ['creator_id'], export: true },
  { kind: 'd1', name: 'routine_slots', retention: 'retention_period', personKeys: ['creator_id', 'requested_by'], export: true },
  { kind: 'd1', name: 'routine_alerts', retention: 'config', personKeys: [], export: false },
]
