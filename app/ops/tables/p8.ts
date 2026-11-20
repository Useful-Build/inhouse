// P8's registry entries: the R2 prefixes its jobs write (server/db/r2-keys.ts). The backup and restore prefixes are
// kept 30 days by the R2 lifecycle rule (C1); the deletion log is never shortened and sits outside the backup set.
import type { TableEntry } from './types.ts'

export const p8Tables: readonly TableEntry[] = [
  { kind: 'r2', name: 'backups/', retention: 'backup', personKeys: [], export: false },
  { kind: 'r2', name: 'restore/', retention: 'backup', personKeys: [], export: false },
  { kind: 'r2', name: 'deletion-log/', retention: 'audit', personKeys: [], export: true },
]
