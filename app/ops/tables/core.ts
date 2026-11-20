// P2's registry entries: the four D1 tables of migrations 0001 to 0004 and the photos prefix (server/db/r2-keys.ts).
import type { TableEntry } from './types.ts'

export const coreTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'members', retention: 'account', personKey: 'id', export: true },
  { kind: 'd1', name: 'settings', retention: 'config', personKey: 'owner', export: true },
  { kind: 'd1', name: 'support_grants', retention: 'config', personKey: 'created_by', export: true },
  { kind: 'd1', name: 'audit_log', retention: 'audit', personKey: 'actor_id', export: true },
  { kind: 'r2', name: 'photos/', retention: 'person', personKey: 'photos/<memberId>/', export: true },
]
