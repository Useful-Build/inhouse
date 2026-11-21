// P4 W4's bell entries (see ./activity.ts for the shared note). `notices.body` may hold model-written text (P5, P6),
// kept and deleted like chat content: with its notice by retention, with the person through `audience_member_id`.
import type { TableEntry } from './types.ts'

export const noticeTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'notices', retention: 'retention_period', personKeys: ['person_id', 'audience_member_id'], export: false },
  { kind: 'd1', name: 'notice_reads', retention: 'retention_period', personKeys: ['member_id'], export: false },
]
