// P4 W5's registry entries (p4-w5 section 2, revision 3.2; P8 C1's store rows 24 to 26). `TableEntry` has no retention
// column, so each entry names C1's rule here. A person deletion keeps these rows (C1 Q6): an upload is the team's.
// - `library_uploads`, by `created_at_ms`: a `pending` row (an upload a crash cut short) after a day, with its
//   `library/` object; a marked-deleted upload 30 days after its mark (`library_marks.deleted_at_ms`); a saved unmarked
//   upload never.
// - `library_marks`, by `deleted_at_ms`: with its file (a mark on a chat output goes with that output's retention).
// - `library/` (keys `library/<fileId>`, no person in them): with its `library_uploads` row, never by object age.
import type { TableEntry } from './types.ts'

export const libraryTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'library_uploads', retention: 'retention_period', personKeys: ['created_by'], export: true },
  { kind: 'd1', name: 'library_marks', retention: 'retention_period', personKeys: ['deleted_by'], export: true },
  { kind: 'r2', name: 'library/', retention: 'retention_period', personKeys: [], export: true },
]
