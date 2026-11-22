// P2's registry entries: the four D1 tables of migrations 0001 to 0004 and the photos prefix (server/db/r2-keys.ts).
// `value_json` and `args_json:$.value` hold a member id for a setting whose value can be one (an approver, `a:<n>`).
import type { TableEntry } from './types.ts'

export const coreTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'members', retention: 'account', personKeys: ['id', 'invited_by'], export: true },
  { kind: 'd1', name: 'settings', retention: 'config', personKeys: ['owner', 'updated_by', 'value_json'], export: true },
  { kind: 'd1', name: 'support_grants', retention: 'config', personKeys: ['created_by', 'ended_by'], export: true },
  { kind: 'd1', name: 'audit_log', retention: 'audit', personKeys: ['actor_id', 'target_id', 'args_json:$.memberId', 'args_json:$.replaces', 'args_json:$.value', 'args_json:$.approvedBy'], export: true },
  { kind: 'r2', name: 'photos/', retention: 'person', personKeys: ['photos/<memberId>/'], export: true },
]
