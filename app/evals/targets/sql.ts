// The doors' shared SQL pieces (door.ts, write-door.ts), with no Node import: the write door runs in the server tests'
// Workers runtime too (server/outbox/eval-write-log.test.ts). door.ts re-exports each, so its callers are unchanged.

export class DoorRefusal extends Error {
  override name = 'DoorRefusal'
}

export const sqlString = (s: string): string => `'${s.replaceAll("'", "''")}'`

/** Runs one SQL statement on the database and returns the rows it answered (none for a write). */
export type RunSql = (sql: string) => Promise<Record<string, unknown>[]>

/** D1's own clock in milliseconds, as SQL: one value for the whole statement. */
// julianday('now') rather than unixepoch('subsec'): the same instant in ms, without needing SQLite 3.42's subsec modifier
// (D1's SQL docs name no SQLite version). SQLite keeps 'now' fixed for the whole statement.
export const D1_NOW_MS = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)"
