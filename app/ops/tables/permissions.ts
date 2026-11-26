// Stage 1 M2-A's stores (N10). The ceiling and the grants are configuration (member ids in `updated_by`, the grant's
// holder, who granted it and who revoked it); the uses are a grant's day counter, kept for the retention period. None
// holds an action's arguments.
import type { TableEntry } from './types.ts'

export const permissionTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'permission_ceiling', retention: 'config', personKeys: ['updated_by'], export: true },
  { kind: 'd1', name: 'permission_grants', retention: 'config', personKeys: ['holder_member', 'granted_by', 'revoked_by'], export: true },
  { kind: 'd1', name: 'permission_uses', retention: 'retention_period', personKeys: [], export: false },
]
