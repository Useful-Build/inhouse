// P5 W4's stores (p5-w4.md section 7). The channel list is configuration (member ids in `added_by`, `removed_by`); the
// sends are the caps' counter and the idempotency key, kept for the retention period. Neither holds notice text: the
// bell's copy lives in P4's `notices` under its own retention.
import type { TableEntry } from './types.ts'

export const notifyTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'notify_channels', retention: 'config', personKeys: ['added_by', 'removed_by'], export: true },
  { kind: 'd1', name: 'notify_channel_list', retention: 'config', personKeys: [], export: true },
  { kind: 'd1', name: 'notify_sends', retention: 'retention_period', personKeys: ['actor_id', 'target'], export: false },
]
