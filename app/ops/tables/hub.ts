// The hub stores a sealed credential per brand connector account. Attribution uses member ids, and pending
// OAuth items expire. A lost connection is reconnected rather than restored from a database backup.
import type { TableEntry } from './types.ts'

export const hubTables: readonly TableEntry[] = [
  { kind: 'do', name: 'SignIn', retention: 'config', personKeys: ['connectedBy', 'pending.memberId'], export: false },
]
