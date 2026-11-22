// P4 W4's registry entries (p4-w4 section 2b; P8 C1's store rows 21 to 23). Rows hold ids and fields, never names, so a
// person deletion needs nothing in `activity_lines` (names render as "A former member"), and removes the `notices`
// rows whose `audience_member_id` is the person and their `notice_reads`. Retention columns for C1's rule (TableEntry
// has no field for it): `activity_lines.at_ms`, `notices.at_ms`, `notice_reads.at_ms` (with its notice).
import type { TableEntry } from './types.ts'

export const activityTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'activity_lines', retention: 'retention_period', personKeys: ['actor_id', 'subject_id'], export: true },
]
