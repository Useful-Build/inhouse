// P3's memory registry entries (W6, p3-w6.md): `memories` (0140), and the two FTS5 indexes (0141). The indexes are
// derived (p3-design section 10, P8): rebuilt from their source tables by `rebuildSearchIndexes`
// (server/mcp/search-index.ts), never backed up; the backup skips them and their FTS5 shadow tables.
import type { TableEntry } from './types.ts'

export const memoryTables: readonly TableEntry[] = [
  // A person fact names its owner; any fact names who saved it (a member id, or the system row for a routine).
  { kind: 'd1', name: 'memories', retention: 'config', personKeys: ['owner_id', 'created_by'], export: true },
  { kind: 'd1', name: 'memories_fts', retention: 'config', personKeys: [], export: false, derived: { from: ['memories'] } },
  { kind: 'd1', name: 'chat_messages_fts', retention: 'retention_period', personKeys: [], export: false, derived: { from: ['chat_messages'] } },
]
