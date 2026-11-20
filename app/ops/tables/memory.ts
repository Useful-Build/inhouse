// P3's memory registry entries (W6, p3-w6.md): `memories` (0140) joins here in the PR that adds it. The FTS5 tables are
// derived indexes and get no `d1` entry (p3-design section 10). Empty until then (PR0).
import type { TableEntry } from './types.ts'

export const memoryTables: readonly TableEntry[] = []
