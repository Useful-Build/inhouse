// A thin D1 layer: statements are plain `{ sql, params }` values, so the same builders run on D1 (one `DB.batch`, one
// transaction) and render as a SQL file for `wrangler d1 execute --file` (server/seed/first-admin.ts).
// D1 runs a batch as one transaction, statements in order, and rolls the whole batch back when one fails:
// https://developers.cloudflare.com/d1/worker-api/d1-database/ (batch), read 2026-11-20.

import type { Stmt } from './sql-statement.ts'
export { renderStmt, sqlLiteral, stmt, type SqlValue, type Stmt } from './sql-statement.ts'

/**
 * A D1 or R2 call that failed (p2-design section 4: 503 `unavailable`). The stores' one boundary to storage throws it,
 * so api.ts can tell a storage failure from a bug in the code (500 `unknown`). `message` keeps the storage error's own
 * message (a constraint name, never a value); `cause` keeps the error.
 */
export class StoreUnavailableError extends Error {
  constructor(what: string, cause: unknown) {
    super(`${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'StoreUnavailableError'
  }
}

/** Runs `call`, turning any failure into a `StoreUnavailableError`. */
export async function storage<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    throw err instanceof StoreUnavailableError ? err : new StoreUnavailableError(what, err)
  }
}

const prepare = (db: D1Database, s: Stmt): D1PreparedStatement => db.prepare(s.sql).bind(...s.params)

/** Runs the statements as one batch (one transaction). Returns each statement's result, in order. */
export async function runBatch(db: D1Database, stmts: readonly Stmt[]): Promise<D1Result[]> {
  return storage('D1', () => db.batch(stmts.map(s => prepare(db, s))))
}

export async function first<T>(db: D1Database, s: Stmt): Promise<T | null> {
  return storage('D1', () => prepare(db, s).first<T>())
}

export async function all<T>(db: D1Database, s: Stmt): Promise<T[]> {
  return storage('D1', async () => (await prepare(db, s).all<T>()).results)
}
