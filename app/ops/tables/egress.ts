// P8a's egress record (0600): one row per outbound HTTPS request from a runner container, by host and verdict
// (server/egress/webfetch.ts). No member id: the egress knows the container, not the run. Kept 30 days (a fixed
// period, ops/retention/rules.ts), not exported (an operations log).
import type { TableEntry } from './types.ts'

export const egressTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'egress_fetches', retention: 'retention_period', personKeys: [], export: false },
]
