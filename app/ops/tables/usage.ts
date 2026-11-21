// P3's usage registry entries (W4, p3-design section 11): the ledger (0130) and the daily audit copy's cursor and R2
// objects. The ledger is the brand's bill, kept while the deployment lives (`account`); a turn names its member.
import type { TableEntry } from './types.ts'

export const usageTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'usage_months', retention: 'account', personKeys: [], export: true },
  { kind: 'd1', name: 'usage_turns', retention: 'account', personKeys: ['member_id'], export: true },
  // A call's hold and cost, keyed by its turn: kept with the turn it belongs to.
  { kind: 'd1', name: 'usage_extends', retention: 'account', personKeys: [], export: false },
  { kind: 'd1', name: 'audit_copy_state', retention: 'config', personKeys: [], export: false },
  // The audit log's daily copy: lines as the log holds them (people by member id only), never shortened or edited.
  { kind: 'r2', name: 'audit-copy/', retention: 'audit', personKeys: [], export: false },
]
