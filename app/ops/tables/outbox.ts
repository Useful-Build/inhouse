// Stage 1 M2-B's stores (N11, N12). The gate is one row of configuration (no person). The actions are every write the
// agent proposed, through its whole life: who asked, who approves, who approved and who resolved a check (member ids;
// `approved_by` may instead name a permission), the parsed arguments the send needs, and the card's words. They go by
// retention once final (`final_at_ms`), never while open.
import type { TableEntry } from './types.ts'

export const outboxTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'outbox_gate', retention: 'config', personKeys: [], export: false },
  { kind: 'd1', name: 'outbox_actions', retention: 'retention_period', personKeys: ['asked_by', 'approver', 'approved_by', 'resolved_by'], export: true },
]
